import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import {
  alertsPreferences,
  apnsSenderReady,
  buildAgeDays,
  deviceIsActive,
  IOS_DEVICE_LIMIT,
  IOS_DEVICES_PER_USER,
  iosAlertsStatusFor,
  iosDeviceKey,
  listIosDevices,
  noteApnsSender,
  pendingTestAlerts,
  registerIosDevice,
  removeGoneIosDevices,
  removeIosDevice,
  requestTestAlert,
  routeChannels,
  setAlertsPreference,
  sweepIosDevices,
  type IosDevice,
  type RoutableSubscription,
} from '@/lib/services/ios-push';
import {
  buildOutbox,
  iosAlertsStatus,
  recordDelivery,
  saveSubscription,
  testAlert,
} from '@/lib/services/push-alerts';
import type { AuditEvent, UserProfile } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * iPhone app alerts (D-058): devices, Apple's answers, and the rule that
 * holds an iPhone's home-screen web push back while the app has the alerts,
 * so nothing pings twice and nothing goes quiet. Fictional tokens only.
 */

// 15:00 UTC = 10:00 in Chicago (daylight time).
const NOON_ISH = new Date('2026-10-07T15:00:00Z');
const DAY = 86_400_000;
const later = (ms: number) => new Date(NOON_ISH.getTime() + ms);

/** A made-up push token: 64 hex characters. */
const token = (n: number) => createHash('sha256').update(`fictional-iphone-${n}`).digest('hex');

const IPHONE_WEB = {
  endpoint: 'https://web.push.apple.com/QFictionalIphoneEndpoint0001',
  keys: {
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
};
const MAC_WEB = { ...IPHONE_WEB, endpoint: 'https://web.push.apple.com/QFictionalMacEndpoint0001' };
const ANDROID_WEB = { ...IPHONE_WEB, endpoint: 'https://fcm.googleapis.com/fcm/send/fictional01' };

let harness: Harness;
let store: DataStore;
let auth: AuthContext;

beforeEach(async () => {
  harness = await createHarness({ now: NOON_ISH });
  store = harness.store;
  auth = harness.auth;
});

afterEach(async () => {
  await harness.dispose();
});

/** A colleague in the demo organization. */
async function colleague(role: 'member' | 'admin', n = 1): Promise<AuthContext> {
  const userId = `00000000-0000-4000-8000-0000000d0${role === 'admin' ? 'a' : 'b'}${n}`;
  const at = NOON_ISH.toISOString();
  const profile: UserProfile = {
    id: userId,
    email: `${role}${n}@fund.example`,
    full_name: `Test ${role}`,
    avatar_url: null,
    timezone: 'America/Chicago',
    theme: 'system',
    created_at: at,
    updated_at: at,
  };
  await store.upsertUserProfile(profile);
  await store.insert('organization_members', {
    id: `ios-member-${role}-${n}`,
    organization_id: auth.organizationId,
    user_id: userId,
    role,
    created_at: at,
  });
  return { ...auth, userId, role, profile };
}

async function turnOn(
  who: AuthContext,
  n: number,
  at: Date = NOON_ISH,
  extra: Partial<{ build: string | null; builtDay: string | null; replaces: string }> = {},
) {
  const result = await registerIosDevice(
    store,
    who,
    { token: token(n), version: '1.0.0', build: '7.1', builtDay: null, ...extra },
    at,
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function rows(action: string): Promise<AuditEvent[]> {
  return (await store.list('audit_events', auth.organizationId, {
    eq: { action },
  })) as AuditEvent[];
}

describe('turning an iPhone on', () => {
  it('keeps one row per iPhone, its token out of the audit, and checks in by replacing it', async () => {
    const first = await turnOn(auth, 1);
    expect(first).toEqual({ key: iosDeviceKey(token(1)), firstTime: true });
    const [enabled] = await rows('push.ios_enabled');
    expect(enabled?.entity_id).toBe(first.key);
    expect(JSON.stringify(await rows('push.ios_enabled'))).not.toContain(token(1));

    // Checking in an hour later, same build: when it was turned on and
    // first ran this build stay; when it was last seen moves.
    const again = await registerIosDevice(
      store,
      auth,
      { token: token(1).toUpperCase(), version: '1.0.0', build: '7.1', builtDay: null },
      later(3_600_000),
    );
    expect(again.ok && again.value).toEqual({ key: first.key, firstTime: false });
    let [device] = await listIosDevices(store, auth.organizationId);
    expect(await listIosDevices(store, auth.organizationId)).toHaveLength(1);
    expect(device).toMatchObject({
      key: first.key,
      userId: auth.userId,
      token: token(1),
      enabledAt: NOON_ISH.toISOString(),
      buildSeenAt: NOON_ISH.toISOString(),
      lastSeenAt: later(3_600_000).toISOString(),
    });
    expect(await rows('push.ios_enabled')).toHaveLength(1);

    // A new build starts its own clock.
    await turnOn(auth, 1, later(DAY), { build: '8.1' });
    [device] = await listIosDevices(store, auth.organizationId);
    expect(device?.buildSeenAt).toBe(later(DAY).toISOString());
    expect(device?.enabledAt).toBe(NOON_ISH.toISOString());
  });

  it('follows a changed token, dropping the old one', async () => {
    const old = await turnOn(auth, 1);
    const fresh = await turnOn(auth, 2, later(60_000), { replaces: old.key });
    expect(fresh.firstTime).toBe(false);
    const devices = await listIosDevices(store, auth.organizationId);
    expect(devices.map((d) => d.key)).toEqual([fresh.key]);
    expect(devices[0]?.enabledAt).toBe(NOON_ISH.toISOString());
  });

  it('refuses what is not a token', async () => {
    for (const bad of ['a'.repeat(63), 'zz'.repeat(40), '']) {
      const result = await registerIosDevice(store, auth, {
        token: bad,
        version: '1.0.0',
        build: null,
        builtDay: null,
      });
      expect(result.ok).toBe(false);
    }
  });

  it('caps iPhones per person and per organization; only an admin takes one over', async () => {
    const member = await colleague('member');
    for (let n = 1; n <= IOS_DEVICES_PER_USER; n++) await turnOn(member, n);
    const sixth = await registerIosDevice(store, member, {
      token: token(99),
      version: '1.0.0',
      build: null,
      builtDay: null,
    });
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) expect(sixth.error.code).toBe('conflict');

    // Someone else's iPhone: a member is refused, an admin may take it over.
    const other = await colleague('member', 2);
    const taken = await registerIosDevice(store, other, {
      token: token(1),
      version: '1.0.0',
      build: null,
      builtDay: null,
    });
    expect(!taken.ok && taken.error.code).toBe('forbidden');
    const admin = await colleague('admin');
    expect((await turnOn(admin, 1)).firstTime).toBe(false);

    // The organization's ceiling.
    let n = 100;
    for (
      let person = 3;
      (await listIosDevices(store, auth.organizationId)).length < IOS_DEVICE_LIMIT;
      person++
    ) {
      const someone = await colleague('member', person);
      for (let i = 0; i < IOS_DEVICES_PER_USER; i++) {
        if ((await listIosDevices(store, auth.organizationId)).length >= IOS_DEVICE_LIMIT) break;
        await turnOn(someone, n++);
      }
    }
    const full = await registerIosDevice(store, auth, {
      token: token(999),
      version: '1.0.0',
      build: null,
      builtDay: null,
    });
    expect(!full.ok && full.error.code).toBe('conflict');
  });
});

describe('Apple says a token is gone', () => {
  it('forgets it, unless the app checked in after Apple stopped taking it', async () => {
    const { key } = await turnOn(auth, 1);
    expect(
      await removeGoneIosDevices(store, auth.organizationId, [{ key, at: NOON_ISH.getTime() - 1 }]),
    ).toBe(0);
    expect(await listIosDevices(store, auth.organizationId)).toHaveLength(1);
    expect(
      await removeGoneIosDevices(store, auth.organizationId, [{ key, at: NOON_ISH.getTime() + 1 }]),
    ).toBe(1);
    expect(await listIosDevices(store, auth.organizationId)).toHaveLength(0);
    const [disabled] = await rows('push.ios_disabled');
    expect(disabled?.metadata).toEqual({ reason: 'gone' });

    // A token that can never work (400 BadDeviceToken) carries no time.
    const second = await turnOn(auth, 2);
    expect(await removeGoneIosDevices(store, auth.organizationId, [{ key: second.key }])).toBe(1);
    expect(await removeGoneIosDevices(store, auth.organizationId, [{ key: 'nope' }])).toBe(0);
  });

  it('through the sender’s report', async () => {
    const { key } = await turnOn(auth, 1);
    const result = await recordDelivery(store, auth.organizationId, ['money:x'], [], [{ key }]);
    expect(result).toEqual({ recorded: 1, removed: 0, removedIphones: 1 });
  });
});

describe('forgetting iPhones', () => {
  it('after 45 days without a word, and when their person leaves', async () => {
    await turnOn(auth, 1, new Date(NOON_ISH.getTime() - 46 * DAY));
    await turnOn(auth, 2);
    const member = await colleague('member');
    await turnOn(member, 3);
    await store.removeWhere('organization_members', '', { eq: { user_id: member.userId } });
    await sweepIosDevices(store, auth.organizationId, NOON_ISH);
    const left = await listIosDevices(store, auth.organizationId);
    expect(left.map((d) => d.key)).toEqual([iosDeviceKey(token(2))]);
    expect((await rows('push.ios_disabled')).map((r) => r.metadata)).toEqual([
      { reason: 'member_removed' },
    ]);
  });

  it('turning off removes it and says why', async () => {
    const { key } = await turnOn(auth, 1);
    expect(await removeIosDevice(store, auth.organizationId, key, auth, 'permission')).toBe(1);
    expect(await removeIosDevice(store, auth.organizationId, key, auth, 'permission')).toBe(0);
    expect((await rows('push.ios_disabled')).map((r) => r.metadata)).toEqual([
      { reason: 'permission' },
    ]);
  });
});

/* ---------------------------------------------------------------- routing */

const NICK = 'user-nick';
const ARWIN = 'user-arwin';

function device(over: Partial<IosDevice> = {}): IosDevice {
  return {
    key: 'a'.repeat(40),
    userId: NICK,
    token: token(1),
    version: '1.0.0',
    build: '7.1',
    builtDay: null,
    buildSeenAt: later(-10 * DAY).toISOString(),
    enabledAt: later(-10 * DAY).toISOString(),
    lastSeenAt: later(-DAY).toISOString(),
    ...over,
  };
}

const sub = (
  endpoint: string,
  userId: string | null,
  platform: RoutableSubscription['platform'],
): RoutableSubscription => ({ endpoint, userId, platform });

const nickIphone = sub(IPHONE_WEB.endpoint, NICK, 'ios');
const nickLegacyIphone = sub('https://web.push.apple.com/QFictionalOld', NICK, null);
const nickMac = sub(MAC_WEB.endpoint, NICK, 'mac');
const nickLegacyAndroid = sub(ANDROID_WEB.endpoint, NICK, null);
const arwinIphone = sub('https://web.push.apple.com/QFictionalArwin', ARWIN, 'ios');
const ALL = [nickIphone, nickLegacyIphone, nickMac, nickLegacyAndroid, arwinIphone];
const none = new Map();

describe('which phones an alert goes to', () => {
  it('web only, or the app only: everything goes', () => {
    expect(routeChannels(ALL, [], none, NOON_ISH, true).subscriptions).toEqual(ALL);
    const app = device();
    expect(routeChannels([], [app], none, NOON_ISH, true)).toEqual({
      subscriptions: [],
      devices: [app],
    });
  });

  it('both, with the app in touch: that person’s iPhone web push waits, nothing else', () => {
    const app = device();
    const routed = routeChannels(ALL, [app], none, NOON_ISH, true);
    expect(routed.devices).toEqual([app]);
    // Held: the iPhone one and an Apple one from before platforms were kept.
    // Kept: the Mac's Safari, an Android one, and someone else's iPhone.
    expect(routed.subscriptions).toEqual([nickMac, nickLegacyAndroid, arwinIphone]);
  });

  it('an app quiet for over 8 days, or on a build 80 days old, holds nothing back', () => {
    const quiet = device({ lastSeenAt: later(-9 * DAY).toISOString() });
    expect(routeChannels(ALL, [quiet], none, NOON_ISH, true).subscriptions).toEqual(ALL);
    // Still sent to until Apple says it is gone.
    expect(routeChannels(ALL, [quiet], none, NOON_ISH, true).devices).toEqual([quiet]);

    const old = device({ builtDay: '2026-07-19' }); // 80 days before Oct 7
    expect(buildAgeDays(old, NOON_ISH)).toBe(80);
    expect(deviceIsActive(old, NOON_ISH)).toBe(false);
    expect(routeChannels(ALL, [old], none, NOON_ISH, true).subscriptions).toEqual(ALL);
    const young = device({ builtDay: '2026-07-20' });
    expect(deviceIsActive(young, NOON_ISH)).toBe(true);
    // Without a build day, from when this iPhone first ran the build.
    const seenLongAgo = device({ buildSeenAt: later(-81 * DAY).toISOString() });
    expect(deviceIsActive(seenLongAgo, NOON_ISH)).toBe(false);
  });

  it('“Send alerts here instead” holds the app back while that web push exists', () => {
    const app = device();
    const prefers = new Map([[NICK, 'web' as const]]);
    const routed = routeChannels(ALL, [app], prefers, NOON_ISH, true);
    expect(routed.devices).toEqual([]);
    expect(routed.subscriptions).toEqual(ALL);
    // With no iPhone web push left, the app gets them after all.
    const onlyMac = routeChannels([nickMac], [app], prefers, NOON_ISH, true);
    expect(onlyMac.devices).toEqual([app]);
  });

  it('a sender without a working APNs key gets no tokens and holds nothing back', () => {
    expect(routeChannels(ALL, [device()], none, NOON_ISH, false)).toEqual({
      subscriptions: ALL,
      devices: [],
    });
  });

  it('a sender whose APNs sends are failing gets the tokens and holds nothing back', () => {
    const app = device();
    expect(routeChannels(ALL, [app], none, NOON_ISH, true, false)).toEqual({
      subscriptions: ALL,
      devices: [app],
    });
    // "Send alerts here instead" still holds the app back.
    const prefers = new Map([[NICK, 'web' as const]]);
    expect(routeChannels(ALL, [app], prefers, NOON_ISH, true, false).devices).toEqual([]);
  });

  it('says what Settings shows', () => {
    expect(iosAlertsStatusFor(NICK, ALL, [device()], none, NOON_ISH, true)).toEqual({
      devices: 1,
      active: true,
      preference: 'app',
      webHeldBack: true,
      appHasAlerts: true,
      senderReady: true,
    });
    // With no alert job holding a working key, nothing is held back.
    expect(iosAlertsStatusFor(NICK, ALL, [device()], none, NOON_ISH, false)).toMatchObject({
      webHeldBack: false,
      senderReady: false,
    });
    expect(
      iosAlertsStatusFor(NICK, ALL, [device()], new Map([[NICK, 'web' as const]]), NOON_ISH, true),
    ).toMatchObject({ preference: 'web', webHeldBack: false, appHasAlerts: false });
    expect(iosAlertsStatusFor(ARWIN, ALL, [device()], none, NOON_ISH, true)).toMatchObject({
      devices: 0,
      active: false,
      webHeldBack: false,
      appHasAlerts: false,
    });
  });

  it('knows whether an alert job with a working key asked lately', async () => {
    const org = auth.organizationId;
    expect(await apnsSenderReady(store, org, NOON_ISH)).toBe(false);
    await buildOutbox(store, NOON_ISH, 'meetings');
    expect(await apnsSenderReady(store, org, NOON_ISH)).toBe(false);
    await buildOutbox(store, NOON_ISH, 'meetings', { apnsReady: true });
    expect(await apnsSenderReady(store, org, later(25 * 3_600_000))).toBe(true);
    expect(await apnsSenderReady(store, org, later(27 * 3_600_000))).toBe(false);
    // Written at most every half hour.
    await noteApnsSender(store, org, later(10 * 60_000));
    expect(await rows('push.apns_sender')).toHaveLength(1);
    expect((await rows('push.apns_sender'))[0]?.created_at).toBe(NOON_ISH.toISOString());
  });
});

describe('the outbox', () => {
  it('serves an organization whose only phone is the iPhone app', async () => {
    const { key } = await turnOn(auth, 1);
    const ready = await buildOutbox(store, NOON_ISH, 'meetings', { apnsReady: true });
    const entry = ready.find((e) => e.organizationId === auth.organizationId);
    expect(entry?.subscriptions).toEqual([]);
    expect(entry?.apns).toEqual([{ key, token: token(1), userId: auth.userId }]);
    // An older sender, or one without a key: no tokens.
    const plain = await buildOutbox(store, NOON_ISH, 'meetings');
    expect(plain.find((e) => e.organizationId === auth.organizationId)?.apns).toEqual([]);
  });

  it('holds the iPhone’s web push back only for a sender that can reach the app, and brings it back when the app is turned off', async () => {
    const org = auth.organizationId;
    await saveSubscription(store, org, auth.userId, IPHONE_WEB, 'ios');
    await saveSubscription(store, org, auth.userId, MAC_WEB, 'mac');
    const { key } = await turnOn(auth, 1);
    const endpoints = async (apnsReady: boolean) =>
      (await buildOutbox(store, NOON_ISH, 'meetings', { apnsReady }))
        .find((e) => e.organizationId === org)
        ?.subscriptions.map((s) => s.endpoint);
    expect(await endpoints(true)).toEqual([MAC_WEB.endpoint]);
    expect(await endpoints(false)).toEqual([IPHONE_WEB.endpoint, MAC_WEB.endpoint]);
    // A sender whose APNs sends are failing: both ways, the token included.
    const failing = (
      await buildOutbox(store, NOON_ISH, 'meetings', { apnsReady: true, holdBack: false })
    ).find((e) => e.organizationId === org);
    expect(failing?.subscriptions.map((s) => s.endpoint)).toEqual([
      IPHONE_WEB.endpoint,
      MAC_WEB.endpoint,
    ]);
    expect(failing?.apns.map((d) => d.key)).toEqual([key]);
    expect(await iosAlertsStatus(store, org, auth.userId, NOON_ISH)).toMatchObject({
      webHeldBack: true,
    });

    // Notifications switched off in iOS Settings: the app turns itself off.
    await removeIosDevice(store, org, key, auth, 'permission');
    expect(await endpoints(true)).toEqual([IPHONE_WEB.endpoint, MAC_WEB.endpoint]);

    // "Send alerts here instead", with the app back on.
    await turnOn(auth, 1);
    await setAlertsPreference(store, auth, 'web');
    expect((await alertsPreferences(store, org)).get(auth.userId)).toBe('web');
    const entry = (await buildOutbox(store, NOON_ISH, 'meetings', { apnsReady: true })).find(
      (e) => e.organizationId === org,
    );
    expect(entry?.apns).toEqual([]);
    expect(entry?.subscriptions.map((s) => s.endpoint)).toEqual([
      IPHONE_WEB.endpoint,
      MAC_WEB.endpoint,
    ]);
    await setAlertsPreference(store, auth, 'app');
    expect((await alertsPreferences(store, org)).size).toBe(0);
  });

  it('sends a test alert to the person who asked, once, and drops a stale one', async () => {
    const org = auth.organizationId;
    const arwin = await colleague('member');
    await saveSubscription(store, org, arwin.userId, ANDROID_WEB, 'other');
    const { key } = await turnOn(auth, 1);
    await requestTestAlert(store, auth, NOON_ISH);

    const outbox = await buildOutbox(store, later(60_000), 'meetings', { apnsReady: true });
    const tests = outbox.filter((e) => e.alerts.some((a) => a.tag === 'test'));
    expect(tests).toHaveLength(1);
    const [entry] = tests;
    expect(entry?.subscriptions).toEqual([]);
    expect(entry?.apns.map((d) => d.key)).toEqual([key]);
    const alert = entry!.alerts[0]!;
    expect(alert).toEqual(testAlert(alert.keys[0]!));
    expect(alert.keys[0]).toMatch(/^test:/);
    // Nothing of it in the organization's own entry.
    expect(outbox[0]?.alerts.some((a) => a.tag === 'test')).toBe(false);

    await recordDelivery(store, org, alert.keys, []);
    const sent = new Set(alert.keys);
    expect(await pendingTestAlerts(store, org, sent, later(120_000))).toEqual([]);

    await requestTestAlert(store, auth, NOON_ISH);
    expect(await pendingTestAlerts(store, org, sent, later(11 * 60_000))).toEqual([]);
  });
});
