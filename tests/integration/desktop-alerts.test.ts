import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import {
  authenticateDesktopToken,
  DESKTOP_DEVICE_LIMIT,
  DESKTOP_DEVICES_PER_USER,
  desktopAlertsFor,
  desktopSentKeys,
  LEDGER_DAILY_CAP,
  listDesktopDevices,
  mintDesktopToken,
  recordDesktopDelivery,
  registerDesktopDevice,
  removeDesktopDevice,
  type DesktopCaller,
} from '@/lib/services/desktop-alerts';
import {
  buildOutbox,
  meetingAlerts,
  recordDelivery,
  saveSubscription,
} from '@/lib/services/push-alerts';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import type { AuditEvent, CalendarEvent, UserProfile } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Desktop alerts on the demo store: turning a computer on (one token, shown
 * once, never stored), who may take a computer over, the cap, every way a
 * token is refused, the per-computer ledger beside the phones', the 6am-9pm
 * window, and demo meetings that never reach Google. All data is fictional.
 */

// 15:00 UTC = 10:00 in Chicago (daylight time), the demo owner's timezone.
const NOON_ISH = new Date('2026-10-07T15:00:00Z');
const NIGHT = new Date('2026-10-08T04:00:00Z'); // 23:00 Chicago
const EVENING = new Date('2026-10-08T01:30:00Z'); // 20:30 Chicago
const TOKEN_RE = /^tcdsk_[0-9a-f]{32}_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/;

const DEVICE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_DEVICE = '0123456789abcdef0123456789abcdef';
const device = (n: number) => n.toString(16).padStart(32, '0');

const SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/desktop-test',
  keys: {
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
};

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

async function turnOn(
  who: AuthContext = auth,
  id: string = DEVICE,
  now: Date = NOON_ISH,
): Promise<string> {
  const result = await registerDesktopDevice(
    store,
    who,
    { device: id, platform: 'mac', version: '0.4.0' },
    now,
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value.token;
}

async function caller(token: string): Promise<DesktopCaller> {
  const result = await authenticateDesktopToken(store, token);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** A colleague in the demo organization, with the given role. */
async function colleague(role: 'member' | 'admin', n = 1): Promise<AuthContext> {
  const userId = `00000000-0000-4000-8000-0000000c0${role === 'admin' ? 'a' : 'b'}${n}`;
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
    id: `member-${role}-${n}`,
    organization_id: auth.organizationId,
    user_id: userId,
    role,
    created_at: at,
  });
  return { ...auth, userId, role, profile };
}

async function auditRows(action?: string): Promise<AuditEvent[]> {
  return (await store.list(
    'audit_events',
    auth.organizationId,
    action ? { eq: { action } } : {},
  )) as AuditEvent[];
}

describe('turning a computer on', () => {
  it('answers a token once, stores only its hash, and audits without it', async () => {
    const token = await turnOn();
    expect(token).toMatch(TOKEN_RE);
    expect(JSON.stringify(await auditRows())).not.toContain('tcdsk_');
    const [enabled] = await auditRows('push.desktop_enabled');
    expect(enabled).toMatchObject({
      entity_type: 'push',
      entity_id: DEVICE,
      user_id: auth.userId,
      metadata: { platform: 'mac', version: '0.4.0' },
    });
    const computers = await listDesktopDevices(store, auth.organizationId, {
      userId: auth.userId,
      admin: true,
    });
    expect(computers).toEqual([
      {
        id: expect.any(String),
        device: DEVICE,
        shortId: '8f90',
        platform: 'mac',
        version: '0.4.0',
        enabledAt: NOON_ISH.toISOString(),
        mine: true,
        canTurnOff: true,
      },
    ]);
    expect(JSON.stringify(computers)).not.toMatch(/hash|hint/);
  });

  it('again replaces the token: the old one stops working', async () => {
    const first = await turnOn();
    const second = await turnOn();
    expect(second).not.toBe(first);
    expect((await authenticateDesktopToken(store, first)).ok).toBe(false);
    expect((await caller(second)).device).toBe(DEVICE);
    expect(await auditRows('push.desktop')).toHaveLength(1);
  });

  it('a member cannot take over a colleague’s computer; an admin can', async () => {
    await turnOn();
    const member = await colleague('member');
    const refused = await registerDesktopDevice(store, member, {
      device: DEVICE,
      platform: 'windows',
      version: '0.4.0',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('forbidden');
    // Their own computer is fine.
    expect(await turnOn(member, OTHER_DEVICE)).toMatch(TOKEN_RE);

    const admin = await colleague('admin');
    const token = await turnOn(admin, DEVICE);
    expect((await caller(token)).userId).toBe(admin.userId);

    // A member is never sent the id of a computer they cannot turn off, so
    // they cannot turn it on in their own name once it is off; its end
    // still tells the rows apart.
    const asMember = await listDesktopDevices(store, auth.organizationId, {
      userId: member.userId,
      admin: false,
    });
    expect(asMember.map((c) => [c.device, c.shortId, c.mine, c.canTurnOff])).toEqual([
      [OTHER_DEVICE, 'cdef', true, true],
      [null, '8f90', false, false],
    ]);
    const asAdmin = await listDesktopDevices(store, auth.organizationId, {
      userId: admin.userId,
      admin: true,
    });
    expect(asAdmin.map((c) => c.device)).toEqual([OTHER_DEVICE, DEVICE]);
  });

  it(`stops at ${DESKTOP_DEVICE_LIMIT} computers, but a computer already on can turn on again`, async () => {
    const people = [auth];
    for (let n = 1; n < DESKTOP_DEVICE_LIMIT / DESKTOP_DEVICES_PER_USER; n++) {
      people.push(await colleague('member', n));
    }
    let next = 1;
    for (const person of people) {
      for (let i = 0; i < DESKTOP_DEVICES_PER_USER; i++) await turnOn(person, device(next++));
    }
    const admin = await colleague('admin');
    const refused = await registerDesktopDevice(store, admin, {
      device: device(99),
      platform: 'mac',
      version: '0.4.0',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('conflict');
    expect(await turnOn(auth, device(1))).toMatch(TOKEN_RE);
  });

  it(`stops one person at ${DESKTOP_DEVICES_PER_USER} computers, theirs to turn on again`, async () => {
    for (let i = 1; i <= DESKTOP_DEVICES_PER_USER; i++) await turnOn(auth, device(i));
    const refused = await registerDesktopDevice(store, auth, {
      device: device(99),
      platform: 'windows',
      version: '0.4.0',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('conflict');
      expect(refused.error.message).toContain(`${DESKTOP_DEVICES_PER_USER} computers`);
    }
    // Their own computer again is a replacement, and a colleague is not held up.
    expect(await turnOn(auth, device(1))).toMatch(TOKEN_RE);
    expect(await turnOn(await colleague('member'), device(99))).toMatch(TOKEN_RE);
  });
});

describe('a token', () => {
  it('is refused when malformed, for another organization, an unknown computer or a wrong secret', async () => {
    const token = await turnOn();
    const good = await caller(token);
    expect(good).toEqual({
      organizationId: auth.organizationId,
      device: DEVICE,
      userId: auth.userId,
      enabledAt: NOON_ISH.toISOString(),
    });
    const refusals = [
      'not-a-token',
      token.slice(0, -1),
      mintDesktopToken('11111111-1111-4111-8111-111111111111', DEVICE),
      mintDesktopToken(auth.organizationId, OTHER_DEVICE),
      mintDesktopToken(auth.organizationId, DEVICE),
    ];
    for (const bad of refusals) {
      const result = await authenticateDesktopToken(store, bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unauthenticated');
        expect(result.error.details?.reason).toBeUndefined();
      }
    }
  });

  it('stops working when its person leaves the organization, and the computer goes', async () => {
    const member = await colleague('member');
    const token = await turnOn(member, OTHER_DEVICE);
    await store.removeWhere('organization_members', '', { eq: { user_id: member.userId } });
    const result = await authenticateDesktopToken(store, token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthenticated');
      expect(result.error.details?.reason).toBe('revoked');
    }
    expect(await auditRows('push.desktop')).toHaveLength(0);
    const [disabled] = await auditRows('push.desktop_disabled');
    expect(disabled?.metadata).toEqual({ reason: 'member_removed' });
  });

  it('is never refused because the store failed: the computer stays', async () => {
    const token = await turnOn();
    const failing = (method: 'findOne' | 'membershipsForUser') =>
      new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === method) return async () => Promise.reject(new Error('store down'));
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    for (const method of ['findOne', 'membershipsForUser'] as const) {
      const result = await authenticateDesktopToken(failing(method), token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('provider_unavailable');
    }
    expect(await auditRows('push.desktop')).toHaveLength(1);
    expect((await caller(token)).device).toBe(DEVICE);
  });

  it('turned off is gone, and only an actual removal is audited', async () => {
    const token = await turnOn();
    expect(await removeDesktopDevice(store, auth.organizationId, DEVICE, auth, 'settings')).toBe(1);
    expect(await removeDesktopDevice(store, auth.organizationId, DEVICE, auth, 'app')).toBe(0);
    expect((await authenticateDesktopToken(store, token)).ok).toBe(false);
    expect((await auditRows('push.desktop_disabled')).map((r) => r.metadata)).toEqual([
      { reason: 'settings' },
    ]);
  });
});

describe('the ledger', () => {
  it('is per computer: phones before it was turned on count, phones after and other computers do not', async () => {
    const token = await turnOn();
    const me = await caller(token);
    // A phone alerted before this computer was turned on…
    await store.insert('audit_events', {
      id: '00000000-0000-4000-8000-00000000a001',
      organization_id: auth.organizationId,
      user_id: null,
      action: 'push.alerted',
      entity_type: 'push',
      entity_id: 'money:before',
      metadata: {},
      ip_hash: null,
      created_at: new Date(NOON_ISH.getTime() - 3_600_000).toISOString(),
    });
    // …and after (recordDelivery stamps the real time, later than NOON_ISH).
    await recordDelivery(store, auth.organizationId, ['money:after'], []);
    // Another computer, before and after: what its token reported never
    // quiets this one.
    await recordDesktopDelivery(
      store,
      auth.organizationId,
      OTHER_DEVICE,
      ['risk:early'],
      new Date(NOON_ISH.getTime() - 60_000),
    );
    await recordDesktopDelivery(store, auth.organizationId, OTHER_DEVICE, ['risk:late'], NOON_ISH);
    await recordDesktopDelivery(store, auth.organizationId, DEVICE, ['top3:mine'], NOON_ISH);

    const sent = await desktopSentKeys(store, auth.organizationId, DEVICE, me.enabledAt, NOON_ISH);
    expect([...sent].sort()).toEqual(['money:before', 'top3:mine']);
  });

  it('a computer showing an alert changes nothing for phones', async () => {
    await saveSubscription(store, auth.organizationId, auth.userId, SUB);
    const before = await buildOutbox(store, NOON_ISH, 'all');
    const keys = before.flatMap((o) => o.alerts.flatMap((a) => a.keys));
    expect(keys.length).toBeGreaterThan(0);
    await turnOn();
    await recordDesktopDelivery(store, auth.organizationId, DEVICE, keys, NOON_ISH);
    expect(await buildOutbox(store, NOON_ISH, 'all')).toEqual(before);
  });

  it('keeps only our kinds of key, once each, and at most 300 a day', async () => {
    const org = auth.organizationId;
    expect(
      await recordDesktopDelivery(store, org, DEVICE, ['evil:x', 'nothing', 'money:a', 'money:a']),
    ).toEqual({ recorded: 1 });
    expect(await recordDesktopDelivery(store, org, DEVICE, ['money:a'])).toEqual({ recorded: 0 });
    let total = 1;
    for (let batch = 0; batch < 2; batch++) {
      const keys = Array.from({ length: 200 }, (_, i) => `wait:t-${batch}-${i}`);
      total += (await recordDesktopDelivery(store, org, DEVICE, keys)).recorded;
    }
    expect(total).toBe(LEDGER_DAILY_CAP);
    const rows = await auditRows('push.desktop_alerted');
    expect(rows).toHaveLength(LEDGER_DAILY_CAP);
    expect(rows.every((r) => r.metadata.device === DEVICE && r.user_id === null)).toBe(true);
  });
});

describe('what is due', () => {
  it('a reported alert does not come back', async () => {
    const me = await caller(await turnOn());
    const first = await desktopAlertsFor(store, me, NOON_ISH);
    expect(first.pollAfterSeconds).toBe(60);
    expect(first.alerts.length).toBeGreaterThan(0);
    for (const alert of first.alerts) {
      expect(alert.url.startsWith('/')).toBe(true);
      expect(alert.body).not.toContain('Tap to join');
    }
    const keys = first.alerts.flatMap((a) => a.keys);
    await recordDesktopDelivery(store, auth.organizationId, DEVICE, keys, NOON_ISH);
    const again = await desktopAlertsFor(store, me, new Date(NOON_ISH.getTime() + 60_000));
    for (const alert of again.alerts) {
      for (const key of alert.keys) expect(keys).not.toContain(key);
    }
  });

  it('at night: nothing, and not until 6am', async () => {
    const me = await caller(await turnOn());
    expect(await desktopAlertsFor(store, me, NIGHT)).toEqual({
      alerts: [],
      pollAfterSeconds: 7 * 3600,
    });
  });

  it('in the evening: meetings only, still every minute', async () => {
    const me = await caller(await turnOn());
    const evening = await desktopAlertsFor(store, me, EVENING);
    expect(evening.pollAfterSeconds).toBe(60);
    expect(evening.alerts.every((a) => a.urgent)).toBe(true);
  });

  it('a demo meeting five minutes out alerts, without touching the Google connection', async () => {
    const startsAt = new Date(NOON_ISH.getTime() + 5 * 60_000).toISOString();
    const event: CalendarEvent = {
      id: '00000000-0000-4000-8000-00000000e001',
      organization_id: auth.organizationId,
      user_id: auth.userId,
      provider: 'google',
      provider_event_id: 'demo-event-intro',
      title: 'Intro call',
      description: 'https://meet.google.com/abc-defg-hij',
      location: null,
      starts_at: startsAt,
      ends_at: new Date(NOON_ISH.getTime() + 35 * 60_000).toISOString(),
      all_day: false,
      attendees: [
        { name: 'Nick Tippmann', email: 'nick@tiptop.demo', response: 'accepted' },
        { name: 'Jordan Lee', email: 'jordan@founder.example', response: 'accepted' },
      ],
      organizer_email: 'jordan@founder.example',
      is_private: false,
      created_at: NOON_ISH.toISOString(),
      updated_at: NOON_ISH.toISOString(),
    };
    await store.insert('calendar_events', event);
    const before = await getPrimaryIntegration(store, auth.organizationId);

    const alerts = await meetingAlerts(
      store,
      auth.organizationId,
      new Set(),
      NOON_ISH,
      'America/Chicago',
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      keys: [`meeting:demo-event-intro:${startsAt}`],
      title: 'Intro call in 5 min',
      url: '/go/meeting?id=demo-event-intro',
    });

    const me = await caller(await turnOn());
    const due = await desktopAlertsFor(store, me, NOON_ISH);
    const meeting = due.alerts.find((a) => a.urgent);
    expect(meeting?.body).toContain('Click to join');

    const after = await getPrimaryIntegration(store, auth.organizationId);
    expect(after?.status).toBe(before?.status);
    expect(after?.status).toBe('connected');
  });
});
