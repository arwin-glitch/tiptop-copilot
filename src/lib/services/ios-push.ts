import 'server-only';
import { hasRole, type AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import {
  IOS_BUILD_STALE_DAYS,
  IOS_HOLD_BACK_DAYS,
  IOS_SENDER_FRESH_HOURS,
  isApnsToken,
  isIosDeviceKey,
  type AlertsPreference,
  type IosAlertsStatus,
} from '@/lib/ios/shared';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type { AuditEvent, OrganizationMember } from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * iPhone app alerts: the same alerts phones get by Web Push (push-alerts.ts),
 * sent through Apple's push service (APNs) to the TipTop Copilot iPhone app
 * (ios-app/; D-058).
 *
 *   app page ── POST /api/push/ios ──> this iPhone's push token (per device)
 *   GitHub job ── GET  /api/cron/push?apns=1 ──> due alerts + subscriptions + tokens
 *   GitHub job ── HTTP/2, ES256 token ──> api.push.apple.com ──> the iPhone
 *   GitHub job ── POST /api/cron/push ──> sent keys, gone subscriptions and tokens
 *
 * The APNs key lives only in GitHub, next to the VAPID key: the app never
 * holds a key that can push to a phone.
 *
 * No schema change, like the other alerts: an iPhone is an `audit_events`
 * row (`push.ios`, entity_id = the first 40 hex characters of its token's
 * SHA-256, user_id = who turned it on, metadata = the token, the app's
 * version and build, and when it was turned on, first ran this build and
 * last checked in). Rows are never edited in place: checking in replaces the
 * row, so its created_at is when the app was last in touch. Where someone
 * wants alerts when they have both apps is a `push.prefer` row, and a test
 * alert they asked for a `push.test` row.
 *
 * One ledger for every phone (`push.alerted`): an alert counts as delivered
 * when any phone, web or app, took it, as with two web phones today. A
 * newly added iPhone is not pinged about older items.
 *
 * No double pings: while someone's app is in touch (routeChannels), their
 * iPhone's home-screen web push is held back, not deleted, and comes back on
 * its own when the app goes quiet, gets too old to open, or is deleted.
 */

export const IOS_DEVICE_ACTION = 'push.ios';
export const PREFERENCE_ACTION = 'push.prefer';
export const TEST_ACTION = 'push.test';
/** When the alert job last asked with a working APNs key: one row per organization. */
export const SENDER_SEEN_ACTION = 'push.apns_sender';
/** iPhones an organization may have with app alerts on at once (as for computers). */
export const IOS_DEVICE_LIMIT = 20;
/** Of those, how many one person may have turned on. */
export const IOS_DEVICES_PER_USER = 5;
/** An iPhone not heard from in this many days is forgotten. */
export const IOS_DEVICE_SWEEP_DAYS = 45;
/** A test alert not sent within this long is dropped: it would only confuse. */
export const TEST_ALERT_WINDOW_MS = 10 * 60_000;
/** Ledger key prefix for a test alert. Computers ignore it (desktop-alerts.ts KEY_PREFIXES). */
export const TEST_KEY_PREFIX = 'test:';

const DAY_MS = 86_400_000;

/** The id an iPhone is stored, listed and turned off by: never the token itself. */
export function iosDeviceKey(token: string): string {
  return sha256(token.toLowerCase()).slice(0, 40);
}

export interface IosDevice {
  key: string;
  userId: string | null;
  token: string;
  version: string;
  /** CFBundleVersion, when the app could say. */
  build: string | null;
  /** The day the build was made, when the app said (TipTopBuilt/…). */
  builtDay: string | null;
  /** When this iPhone first checked in with this build. */
  buildSeenAt: string;
  enabledAt: string;
  /** When the app last checked in: the row's own time. */
  lastSeenAt: string;
}

function toDevice(row: AuditEvent): IosDevice | null {
  const meta = row.metadata as Record<string, unknown>;
  if (!isIosDeviceKey(row.entity_id) || !isApnsToken(meta.token)) return null;
  if (typeof meta.version !== 'string') return null;
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    key: row.entity_id,
    userId: row.user_id,
    token: meta.token.toLowerCase(),
    version: meta.version,
    build: text(meta.build),
    builtDay: text(meta.builtDay),
    buildSeenAt: text(meta.buildSeenAt) ?? row.created_at,
    enabledAt: text(meta.enabledAt) ?? row.created_at,
    lastSeenAt: row.created_at,
  };
}

export async function listIosDevices(
  store: DataStore,
  organizationId: string,
): Promise<IosDevice[]> {
  const rows = (await store.list(
    'audit_events',
    organizationId,
    { eq: { action: IOS_DEVICE_ACTION } },
    { orderBy: [{ field: 'created_at', direction: 'asc' }], limit: IOS_DEVICE_LIMIT * 2 },
  )) as AuditEvent[];
  return rows.map(toDevice).filter((d): d is IosDevice => d !== null);
}

async function findDevice(
  store: DataStore,
  organizationId: string,
  key: string,
): Promise<AuditEvent | null> {
  return (await store.findOne('audit_events', organizationId, {
    eq: { action: IOS_DEVICE_ACTION, entity_id: key },
  })) as AuditEvent | null;
}

/** How old the app's build is, in days: from the day it was made when known. Pure. */
export function buildAgeDays(device: Pick<IosDevice, 'builtDay' | 'buildSeenAt'>, now: Date) {
  const from = device.builtDay ? Date.parse(`${device.builtDay}T00:00:00Z`) : NaN;
  const start = Number.isFinite(from) ? from : Date.parse(device.buildSeenAt);
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((now.getTime() - start) / DAY_MS));
}

/**
 * Whether the app on this iPhone can be counted on for someone's alerts:
 * in touch within IOS_HOLD_BACK_DAYS, on a build TestFlight will still open
 * (IOS_BUILD_STALE_DAYS). Pure.
 */
export function deviceIsActive(device: IosDevice, now: Date): boolean {
  const seen = Date.parse(device.lastSeenAt);
  if (!Number.isFinite(seen) || now.getTime() - seen > IOS_HOLD_BACK_DAYS * DAY_MS) return false;
  return buildAgeDays(device, now) < IOS_BUILD_STALE_DAYS;
}

export interface IosDeviceInput {
  token: string;
  version: string;
  build: string | null;
  builtDay: string | null;
  /** This iPhone's previous id, when its token changed: that row goes. */
  replaces?: string | null;
}

/**
 * Turn app alerts on for this iPhone, or check it in again (on launch and
 * resume, at most twice a day). Checking in replaces the row, which keeps
 * when it was turned on and when it first ran this build. An iPhone someone
 * else turned on can be taken over only by an admin. One person may have
 * IOS_DEVICES_PER_USER iPhones on, and an organization IOS_DEVICE_LIMIT.
 */
export async function registerIosDevice(
  store: DataStore,
  auth: AuthContext,
  input: IosDeviceInput,
  now: Date = new Date(),
): Promise<Result<{ key: string; firstTime: boolean }>> {
  const organizationId = auth.organizationId;
  const token = input.token.toLowerCase();
  if (!isApnsToken(token)) return err('invalid_input', 'Not an iPhone push token.');
  const key = iosDeviceKey(token);
  const existingRow = await findDevice(store, organizationId, key);
  const existing = existingRow ? toDevice(existingRow) : null;
  if (existingRow && existingRow.user_id !== auth.userId && !hasRole(auth, 'admin')) {
    return err(
      'forbidden',
      'Someone else turned on alerts for this iPhone. Ask them, or an admin, to turn them off first.',
    );
  }

  const replaced =
    input.replaces && input.replaces !== key && isIosDeviceKey(input.replaces)
      ? await findDevice(store, organizationId, input.replaces)
      : null;
  const replaceable =
    replaced && (replaced.user_id === auth.userId || hasRole(auth, 'admin')) ? replaced : null;

  if (existingRow?.user_id !== auth.userId && !replaceable) {
    const mine = await store.count('audit_events', organizationId, {
      eq: { action: IOS_DEVICE_ACTION, user_id: auth.userId },
    });
    if (mine >= IOS_DEVICES_PER_USER) {
      return err(
        'conflict',
        `You already have ${IOS_DEVICES_PER_USER} iPhones with alerts on. Turn one off first.`,
      );
    }
  }
  if (!existingRow && !replaceable) {
    const count = await store.count('audit_events', organizationId, {
      eq: { action: IOS_DEVICE_ACTION },
    });
    if (count >= IOS_DEVICE_LIMIT) {
      return err(
        'conflict',
        `There are already ${IOS_DEVICE_LIMIT} iPhones with alerts on. Turn one off first.`,
      );
    }
  }

  const before = existing ?? (replaceable ? toDevice(replaceable) : null);
  const sameBuild = before && before.version === input.version && before.build === input.build;
  const nowIso = now.toISOString();
  await store.removeWhere('audit_events', organizationId, {
    eq: { action: IOS_DEVICE_ACTION, entity_id: key },
  });
  if (replaceable) {
    await store.removeWhere('audit_events', organizationId, {
      eq: { action: IOS_DEVICE_ACTION, entity_id: replaceable.entity_id as string },
    });
  }
  // Written directly, like a web subscription: recordAudit's redaction is for
  // free text, and this row is state the sender reads back.
  const row: AuditEvent = {
    id: newId(),
    organization_id: organizationId,
    user_id: auth.userId,
    action: IOS_DEVICE_ACTION,
    entity_type: 'push',
    entity_id: key,
    metadata: {
      token,
      version: input.version,
      build: input.build,
      builtDay: input.builtDay,
      buildSeenAt: sameBuild && before ? before.buildSeenAt : nowIso,
      enabledAt: before?.enabledAt ?? nowIso,
      lastSeenAt: nowIso,
    },
    ip_hash: null,
    created_at: nowIso,
  };
  await store.insert('audit_events', row);
  const firstTime = !before;
  if (firstTime) {
    await recordAudit(store, {
      organizationId,
      userId: auth.userId,
      action: 'push.ios_enabled',
      entityType: 'push',
      entityId: key,
      metadata: { version: input.version },
    });
  }
  return ok({ key, firstTime });
}

export type IosOffReason = 'settings' | 'permission' | 'sign_out' | 'gone' | 'member_removed';

/** Turn app alerts off for one iPhone. Audited only when there was something to remove. */
export async function removeIosDevice(
  store: DataStore,
  organizationId: string,
  key: string,
  actor: { userId: string | null } | null,
  reason: IosOffReason,
): Promise<number> {
  const removed = await store.removeWhere('audit_events', organizationId, {
    eq: { action: IOS_DEVICE_ACTION, entity_id: key },
  });
  if (removed > 0) {
    await recordAudit(store, {
      organizationId,
      userId: actor?.userId ?? null,
      action: 'push.ios_disabled',
      entityType: 'push',
      entityId: key,
      metadata: { reason },
    });
  }
  return removed;
}

/** Who turned this iPhone on, if anyone, and its build's age; for the app's own Settings. */
export async function iosDeviceState(
  store: DataStore,
  organizationId: string,
  key: string,
  now: Date = new Date(),
): Promise<{ found: boolean; userId: string | null; buildAgeDays: number | null }> {
  const row = await findDevice(store, organizationId, key);
  const device = row ? toDevice(row) : null;
  return {
    found: row !== null,
    userId: row?.user_id ?? null,
    buildAgeDays: device ? buildAgeDays(device, now) : null,
  };
}

/** One token Apple says is gone: its id, and when Apple stopped taking it (410 only). */
export interface GoneIosDevice {
  key: string;
  /** Milliseconds since the epoch, from the 410 answer's `timestamp`. */
  at?: number;
}

/**
 * Forget the iPhones the sender says Apple no longer takes. A 410 carries
 * when Apple confirmed the token stopped working; an app that checked in
 * after that has the token back (Apple: "unless your application retrieves
 * the same device token"), so it stays.
 */
export async function removeGoneIosDevices(
  store: DataStore,
  organizationId: string,
  gone: readonly GoneIosDevice[],
): Promise<number> {
  let removed = 0;
  for (const entry of gone.slice(0, 50)) {
    if (!isIosDeviceKey(entry.key)) continue;
    const row = await findDevice(store, organizationId, entry.key);
    if (!row) continue;
    if (
      typeof entry.at === 'number' &&
      Number.isFinite(entry.at) &&
      Date.parse(row.created_at) > entry.at
    ) {
      continue;
    }
    removed += await removeIosDevice(store, organizationId, entry.key, null, 'gone');
  }
  return removed;
}

/**
 * Forget iPhones not heard from in IOS_DEVICE_SWEEP_DAYS, and those of
 * people no longer in the organization, so a removed member's phone stops
 * getting its alerts. Best effort.
 */
export async function sweepIosDevices(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    await store.removeWhere('audit_events', organizationId, {
      eq: { action: IOS_DEVICE_ACTION },
      lt: { created_at: new Date(now.getTime() - IOS_DEVICE_SWEEP_DAYS * DAY_MS).toISOString() },
    });
    await store.removeWhere('audit_events', organizationId, {
      eq: { action: TEST_ACTION },
      lt: { created_at: new Date(now.getTime() - DAY_MS).toISOString() },
    });
    const members = (await store.list(
      'organization_members',
      organizationId,
      {},
    )) as OrganizationMember[];
    const current = new Set(members.map((m) => m.user_id));
    for (const device of await listIosDevices(store, organizationId)) {
      if (device.userId && !current.has(device.userId)) {
        await removeIosDevice(store, organizationId, device.key, null, 'member_removed');
      }
    }
  } catch (error) {
    log.warn('Could not sweep iPhone alert devices', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/* ---------------------------------------------------------------- sender */

/** How often the "sender with a working key" row is written again. */
const SENDER_NOTE_EVERY_MS = 30 * 60_000;

const senderNoted = processWide('push-apns-sender', () => new Map<string, number>());

/** Test hook. */
export function resetIosPushCaches(): void {
  senderNoted.clear();
}

/**
 * The alert job asked with a working APNs key (`?apns=1`). Kept, at most
 * every half hour, so Settings can say whether the app can be reached at
 * all: after the key is first added, the job only picks it up when its
 * current run ends. Best effort.
 */
export async function noteApnsSender(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<void> {
  const last = senderNoted.get(organizationId);
  if (last !== undefined && Math.abs(now.getTime() - last) < SENDER_NOTE_EVERY_MS) return;
  senderNoted.set(organizationId, now.getTime());
  try {
    await store.removeWhere('audit_events', organizationId, {
      eq: { action: SENDER_SEEN_ACTION },
    });
    await store.insert('audit_events', {
      id: newId(),
      organization_id: organizationId,
      user_id: null,
      action: SENDER_SEEN_ACTION,
      entity_type: 'push',
      entity_id: null,
      metadata: {},
      ip_hash: null,
      created_at: now.toISOString(),
    } satisfies AuditEvent);
  } catch (error) {
    senderNoted.delete(organizationId);
    log.warn('Could not note the APNs sender', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Whether a sender with a working APNs key asked within IOS_SENDER_FRESH_HOURS. */
export async function apnsSenderReady(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const row = (await store.findOne('audit_events', organizationId, {
    eq: { action: SENDER_SEEN_ACTION },
  })) as AuditEvent | null;
  if (!row) return false;
  return now.getTime() - Date.parse(row.created_at) <= IOS_SENDER_FRESH_HOURS * 3_600_000;
}

/* ------------------------------------------------------------ preference */

/** Everyone's choice of app or web app, by user id; 'app' unless they chose the web app. */
export async function alertsPreferences(
  store: DataStore,
  organizationId: string,
): Promise<Map<string, AlertsPreference>> {
  const rows = (await store.list(
    'audit_events',
    organizationId,
    { eq: { action: PREFERENCE_ACTION } },
    { limit: 200 },
  )) as AuditEvent[];
  const out = new Map<string, AlertsPreference>();
  for (const row of rows) {
    const to = (row.metadata as Record<string, unknown>).to;
    if (row.user_id && to === 'web') out.set(row.user_id, 'web');
  }
  return out;
}

/**
 * "Send alerts here instead" in the home-screen web app, and its way back in
 * the iPhone app: where this person's alerts go when both are set up.
 */
export async function setAlertsPreference(
  store: DataStore,
  auth: Pick<AuthContext, 'organizationId' | 'userId'>,
  to: AlertsPreference,
  now: Date = new Date(),
): Promise<void> {
  await store.removeWhere('audit_events', auth.organizationId, {
    eq: { action: PREFERENCE_ACTION, user_id: auth.userId },
  });
  if (to === 'app') return;
  const row: AuditEvent = {
    id: newId(),
    organization_id: auth.organizationId,
    user_id: auth.userId,
    action: PREFERENCE_ACTION,
    entity_type: 'push',
    entity_id: auth.userId,
    metadata: { to },
    ip_hash: null,
    created_at: now.toISOString(),
  };
  await store.insert('audit_events', row);
}

/* --------------------------------------------------------------- routing */

/** A web subscription as routing sees it. */
export interface RoutableSubscription {
  endpoint: string;
  userId: string | null;
  /** From the browser that subscribed; null for rows from before it was kept. */
  platform: 'ios' | 'mac' | 'other' | null;
}

/**
 * A web subscription on an iPhone: one that said so, or an Apple one from
 * before platforms were kept (a Mac's Safari subscription made since says
 * mac, and is never held back).
 */
export function isIphoneSubscription(sub: RoutableSubscription): boolean {
  if (sub.platform) return sub.platform === 'ios';
  try {
    return new URL(sub.endpoint).hostname === 'web.push.apple.com';
  } catch {
    return false;
  }
}

/**
 * Which channels an organization's alerts go to now. Pure.
 *
 * For each person with both: their iPhone's home-screen web push is held
 * back while their app is active (deviceIsActive), unless they chose the web
 * app ("Send alerts here instead"), which holds the app back instead while
 * that web push exists. Apple keeps taking pushes for a deleted app for a
 * while, so the app is still sent to until Apple says it is gone, even when
 * it is not active. Without `apnsReady` (a sender with no APNs key, or one
 * whose key is failing) nothing is held back and no token is listed. With
 * `holdBack` false (a sender whose APNs sends are failing right now) the
 * tokens are listed but no web push is held back, so an alert goes both ways
 * until Apple answers again.
 */
export function routeChannels<S extends RoutableSubscription>(
  subscriptions: readonly S[],
  devices: readonly IosDevice[],
  preferences: ReadonlyMap<string, AlertsPreference>,
  now: Date,
  apnsReady: boolean,
  holdBack: boolean = true,
): { subscriptions: S[]; devices: IosDevice[] } {
  if (!apnsReady) return { subscriptions: [...subscriptions], devices: [] };
  const people = new Set(devices.map((d) => d.userId).filter((u): u is string => Boolean(u)));
  const heldWeb = new Set<string>();
  const heldApp = new Set<string>();
  for (const userId of people) {
    const theirWeb = subscriptions.filter((s) => s.userId === userId && isIphoneSubscription(s));
    if (preferences.get(userId) === 'web' && theirWeb.length) heldApp.add(userId);
    else if (holdBack && devices.some((d) => d.userId === userId && deviceIsActive(d, now))) {
      heldWeb.add(userId);
    }
  }
  return {
    subscriptions: subscriptions.filter(
      (s) => !(s.userId && heldWeb.has(s.userId) && isIphoneSubscription(s)),
    ),
    devices: devices.filter((d) => !(d.userId && heldApp.has(d.userId))),
  };
}

/** The signed-in person's iPhone app alerts, for Settings. */
export function iosAlertsStatusFor(
  userId: string,
  subscriptions: readonly RoutableSubscription[],
  devices: readonly IosDevice[],
  preferences: ReadonlyMap<string, AlertsPreference>,
  now: Date,
  senderReady: boolean,
): IosAlertsStatus {
  const mine = devices.filter((d) => d.userId === userId);
  const iphoneWeb = subscriptions.filter((s) => s.userId === userId && isIphoneSubscription(s));
  const preference = preferences.get(userId) ?? 'app';
  const active = mine.some((d) => deviceIsActive(d, now));
  const webChosen = preference === 'web' && iphoneWeb.length > 0;
  return {
    devices: mine.length,
    active,
    preference,
    webHeldBack: active && !webChosen && senderReady,
    appHasAlerts: mine.length > 0 && !webChosen,
    senderReady,
  };
}

/* ----------------------------------------------------------- test alerts */

/**
 * "Send a test alert": queued for the sender, which picks it up on its next
 * pass (about a minute, from 6am to 9pm Central) and sends it to this
 * person's phones only, the way their real alerts would go.
 */
export async function requestTestAlert(
  store: DataStore,
  auth: Pick<AuthContext, 'organizationId' | 'userId'>,
  now: Date = new Date(),
): Promise<Result<{ id: string }>> {
  const id = newId();
  await store.insert('audit_events', {
    id: newId(),
    organization_id: auth.organizationId,
    user_id: auth.userId,
    action: TEST_ACTION,
    entity_type: 'push',
    entity_id: id,
    metadata: {},
    ip_hash: null,
    created_at: now.toISOString(),
  } satisfies AuditEvent);
  return ok({ id });
}

/** Test alerts asked for in the last TEST_ALERT_WINDOW_MS and not sent yet. */
export async function pendingTestAlerts(
  store: DataStore,
  organizationId: string,
  sent: ReadonlySet<string>,
  now: Date,
): Promise<{ userId: string; key: string }[]> {
  const rows = (await store.list(
    'audit_events',
    organizationId,
    {
      eq: { action: TEST_ACTION },
      gte: { created_at: new Date(now.getTime() - TEST_ALERT_WINDOW_MS).toISOString() },
    },
    { orderBy: [{ field: 'created_at', direction: 'asc' }], limit: 20 },
  )) as AuditEvent[];
  return rows
    .filter((r): r is AuditEvent & { user_id: string; entity_id: string } =>
      Boolean(r.user_id && r.entity_id),
    )
    .map((r) => ({ userId: r.user_id, key: `${TEST_KEY_PREFIX}${r.entity_id}` }))
    .filter(({ key }) => !sent.has(key));
}
