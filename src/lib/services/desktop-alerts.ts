import 'server-only';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hasRole, type AuthContext } from '@/lib/auth/session';
import type { DataStore, Filter } from '@/lib/db/store';
import {
  compareVersions,
  FIRST_ASK_ALERTS_VERSION,
  isInAppAlertPath,
  type DesktopComputer,
  type InstallerPlatform,
} from '@/lib/desktop/shared';
import { recordAudit } from '@/lib/security/audit';
import { rateLimit } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import type { AuditEvent } from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';
import { addDaysToKey, isSupportedTimezone, localClock, wallTimeToUtc } from '@/lib/util/time';
import {
  askRepliesFor,
  askReplyKey,
  askReplyWords,
  ASK_WAIT_POLL_SECONDS,
  NO_ASK_REPLIES,
} from './ask-reply-alerts';
import { feedNoticeFor } from './feed-health';
import { feedbackAlertFor } from './feedback';
import {
  alertsFromInputs,
  meetingAlerts,
  principalTimeZone,
  readAlertInputs,
  type AlertInputs,
  type PushAlert,
} from './push-alerts';

/**
 * Desktop alerts: the alerts phones get (push-alerts.ts), shown by the
 * desktop app from 0.4.0 as Windows toasts and macOS notifications (D-057).
 * From desktop 0.4.1 also Ask Arwin answers, to the asker's own computers
 * only (ask-reply-alerts.ts, D-058). New in-app feedback, to the computers
 * of whoever turned feedback alerts on (feedback.ts, D-060). And to anyone
 * who turned feed notices on for themselves, a notice when a feed looks
 * stopped (feed-health.ts, D-061).
 *
 *   page ── POST /api/push/desktop ──> token for this computer (once)
 *   page ── IPC alerts_turn_on(token) ──> shell keeps it in its app data
 *   shell ── GET  /api/desktop/alerts ──> due alerts + when to ask again
 *   shell ── POST /api/desktop/alerts ──> "showed these" (this computer's ledger)
 *
 * The shell asks for itself, about once a minute (every 30 seconds while its
 * owner's Ask Arwin question waits), because a hidden window's page cannot
 * be relied on to run (WebKit suspends it on a Mac). Nothing is
 * queued: each ask works the alerts out from the same inputs as the phone job
 * (cached per organization, so many computers cost no more Calendar or Slack
 * reads than one), then leaves out what this computer already showed.
 *
 * No schema change, like phone alerts: a computer is an `audit_events` row
 * (`push.desktop`, entity_id = the shell's device id, user_id = who turned it
 * on, metadata = platform, version and the token's SHA-256), and its ledger is
 * `push.desktop_alerted` rows with the device in metadata. Rows are never
 * updated in place: turning a computer on again replaces its row.
 *
 * Each computer is its own device, as two phones are: it pings for anything
 * that comes up after it was turned on, whether or not a phone (or another
 * computer) pinged too. Items a phone was alerted about before then stay
 * quiet, as on a phone added later.
 */

export const DEVICE_ACTION = 'push.desktop';
export const DELIVERED_ACTION = 'push.desktop_alerted';
export const DESKTOP_TOKEN_PREFIX = 'tcdsk_';
/** Computers an organization may have with desktop alerts on at once. */
export const DESKTOP_DEVICE_LIMIT = 20;
/** Of those, how many one person may have turned on, so nobody can fill the rest. */
export const DESKTOP_DEVICES_PER_USER = 5;
/**
 * The shell asks from 6am to 9pm in the principal's timezone, as the phone job
 * runs; at night only while the computer's owner waits for an Ask Arwin
 * answer (ask-reply-alerts.ts), or when the page asks it to after a question.
 */
export const POLL_FROM_HOUR = 6;
export const POLL_UNTIL_HOUR = 21;
/** How often the shell asks during the day. */
export const POLL_EVERY_SECONDS = 60;
/** How long one read of the alert inputs serves every computer of an organization. */
const INPUTS_TTL_MS = 5 * 60_000;
const TIMEZONE_TTL_MS = 5 * 60_000;
/** Ledger rows one computer may add in a day; real use is a few dozen. */
export const LEDGER_DAILY_CAP = 300;
const LEDGER_DAYS = 60;
/**
 * Keys one notification may cover: the shell skips a larger one
 * (desktop/src-tauri/src/alerts.rs). Items past it come back as the next
 * notification of their kind on the next ask.
 */
export const ALERT_KEYS_MAX = 50;
/**
 * The kinds of key push-alerts.ts makes, Ask Arwin answers
 * (ask-reply-alerts.ts) and feedback notes (feedback.ts). Anything else a
 * computer reports is ignored. Feed notices (feed-health.ts) are the `feed`
 * kind; the booking link's changes (booking-alerts.ts, D-078) the `booking` kind.
 */
const KEY_PREFIXES = /^(meeting|money|top3|wait|risk|docsend|campaign|ask|feedback|feed|booking):/;

const DEVICE_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^tcdsk_([0-9a-f]{32})_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

/* ------------------------------------------------------------ token shape */

/**
 * A fresh token for one computer: `tcdsk_<organization id as 32 hex>_<device
 * id>_<43 random base64url chars>`. The organization and device are not
 * secrets; they let a request with no session find its row. 256 bits of
 * randomness; only the SHA-256 of the whole string is stored.
 */
export function mintDesktopToken(organizationId: string, device: string): string {
  const orgHex = organizationId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(orgHex)) throw new Error('Organization id is not a uuid.');
  if (!DEVICE_RE.test(device)) throw new Error('Device id is not 32 hex characters.');
  return `${DESKTOP_TOKEN_PREFIX}${orgHex}_${device}_${randomBytes(32).toString('base64url')}`;
}

/** The organization and device a well-formed token names, or null for anything else. */
export function parseDesktopToken(
  token: string,
): { organizationId: string; device: string } | null {
  const match = TOKEN_RE.exec(token);
  if (!match) return null;
  const hex = match[1] as string;
  const organizationId = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
  return { organizationId, device: match[2] as string };
}

export function hashDesktopToken(token: string): string {
  return sha256(token);
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function isDesktopDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_RE.test(value);
}

/* ---------------------------------------------------------------- devices */

interface DeviceMetadata {
  platform: InstallerPlatform;
  version: string;
  token_hash: string;
}

function deviceMetadata(row: AuditEvent): DeviceMetadata | null {
  const { platform, version, token_hash } = row.metadata as Record<string, unknown>;
  if (platform !== 'mac' && platform !== 'windows') return null;
  if (typeof version !== 'string' || typeof token_hash !== 'string') return null;
  return { platform, version, token_hash };
}

async function findDevice(
  store: DataStore,
  organizationId: string,
  device: string,
): Promise<AuditEvent | null> {
  return (await store.findOne('audit_events', organizationId, {
    eq: { action: DEVICE_ACTION, entity_id: device },
  })) as AuditEvent | null;
}

export interface DesktopDeviceInput {
  device: string;
  platform: InstallerPlatform;
  version: string;
}

/**
 * Turn desktop alerts on for one computer and return its token, the only
 * time it exists in the clear: not stored, logged or audited. Turning the
 * same computer on again replaces its token. A computer someone else turned
 * on can be taken over only by an admin, so a member cannot knock a
 * colleague's computer off. One person may have DESKTOP_DEVICES_PER_USER
 * computers on, so nobody can use up the organization's
 * DESKTOP_DEVICE_LIMIT with made-up ids.
 */
export async function registerDesktopDevice(
  store: DataStore,
  auth: AuthContext,
  input: DesktopDeviceInput,
  now: Date = new Date(),
): Promise<Result<{ token: string }>> {
  const organizationId = auth.organizationId;
  const existing = await findDevice(store, organizationId, input.device);
  if (existing && existing.user_id !== auth.userId && !hasRole(auth, 'admin')) {
    return err(
      'forbidden',
      'Someone else turned on alerts for this computer. Ask them, or an admin, to turn them off first.',
    );
  }
  if (existing?.user_id !== auth.userId) {
    const mine = await store.count('audit_events', organizationId, {
      eq: { action: DEVICE_ACTION, user_id: auth.userId },
    });
    if (mine >= DESKTOP_DEVICES_PER_USER) {
      return err(
        'conflict',
        `You already have ${DESKTOP_DEVICES_PER_USER} computers with desktop alerts. Turn one off first.`,
      );
    }
  }
  if (!existing) {
    const count = await store.count('audit_events', organizationId, {
      eq: { action: DEVICE_ACTION },
    });
    if (count >= DESKTOP_DEVICE_LIMIT) {
      return err(
        'conflict',
        `There are already ${DESKTOP_DEVICE_LIMIT} computers with desktop alerts. Turn one off first.`,
      );
    }
  }
  const token = mintDesktopToken(organizationId, input.device);
  await store.removeWhere('audit_events', organizationId, {
    eq: { action: DEVICE_ACTION, entity_id: input.device },
  });
  // Written directly, like a phone subscription: recordAudit's redaction is
  // for free text, and this row is state the endpoint reads back.
  const row: AuditEvent = {
    id: newId(),
    organization_id: organizationId,
    user_id: auth.userId,
    action: DEVICE_ACTION,
    entity_type: 'push',
    entity_id: input.device,
    metadata: {
      platform: input.platform,
      version: input.version,
      token_hash: hashDesktopToken(token),
      hint: token.slice(-4),
    },
    ip_hash: null,
    created_at: now.toISOString(),
  };
  await store.insert('audit_events', row);
  await recordAudit(store, {
    organizationId,
    userId: auth.userId,
    action: 'push.desktop_enabled',
    entityType: 'push',
    entityId: input.device,
    metadata: { platform: input.platform, version: input.version },
  });
  return ok({ token });
}

export type DesktopOffReason = 'settings' | 'app' | 'member_removed';

/**
 * Turn desktop alerts off for one computer: its token stops working at once.
 * Audited only when there was something to remove, since Turn off and
 * signing out reach this twice (the page, and the shell for itself).
 */
export async function removeDesktopDevice(
  store: DataStore,
  organizationId: string,
  device: string,
  actor: { userId: string | null } | null,
  reason: DesktopOffReason,
): Promise<number> {
  const removed = await store.removeWhere('audit_events', organizationId, {
    eq: { action: DEVICE_ACTION, entity_id: device },
  });
  if (removed > 0) {
    await recordAudit(store, {
      organizationId,
      userId: actor?.userId ?? null,
      action: 'push.desktop_disabled',
      entityType: 'push',
      entityId: device,
      metadata: { reason },
    });
  }
  return removed;
}

/** Who turned this computer on, if anyone; for the Settings check before turning it off. */
export async function desktopDeviceOwner(
  store: DataStore,
  organizationId: string,
  device: string,
): Promise<{ found: boolean; userId: string | null }> {
  const row = await findDevice(store, organizationId, device);
  return { found: row !== null, userId: row?.user_id ?? null };
}

/**
 * The organization's computers with desktop alerts on, oldest first, for
 * Settings: which are the viewer's own, and which they may turn off (their
 * own, or any if they are an admin). A computer's full id goes only to
 * those who may turn it off: once that computer is turned off, anyone who
 * knew it could turn it on in their own name first.
 */
export async function listDesktopDevices(
  store: DataStore,
  organizationId: string,
  viewer: { userId: string; admin: boolean },
): Promise<DesktopComputer[]> {
  const rows = (await store.list(
    'audit_events',
    organizationId,
    { eq: { action: DEVICE_ACTION } },
    { orderBy: [{ field: 'created_at', direction: 'asc' }], limit: DESKTOP_DEVICE_LIMIT * 2 },
  )) as AuditEvent[];
  const out: DesktopComputer[] = [];
  for (const row of rows) {
    const meta = deviceMetadata(row);
    if (!meta || !isDesktopDeviceId(row.entity_id)) continue;
    const mine = row.user_id === viewer.userId;
    const canTurnOff = mine || viewer.admin;
    out.push({
      id: row.id,
      device: canTurnOff ? row.entity_id : null,
      shortId: row.entity_id.slice(-4),
      platform: meta.platform,
      version: meta.version,
      enabledAt: row.created_at,
      mine,
      canTurnOff,
    });
  }
  return out;
}

/* ------------------------------------------------------------ the endpoint */

/** Who an authenticated desktop request is. */
export interface DesktopCaller {
  organizationId: string;
  device: string;
  /** Who turned this computer on. */
  userId: string;
  enabledAt: string;
}

/**
 * Who presented this token, or why not.
 *
 * Every refusal is `unauthenticated`, and the shell forgets its token on one,
 * so a store that fails to answer is never a refusal: it is
 * `provider_unavailable`, which the endpoint answers 503 (try again). The
 * person who turned the computer on must still be a member of the
 * organization; when a membership read that worked says they are not, the
 * computer is removed. Only that case is told apart (details.reason =
 * 'revoked'), so the endpoint's failed-token brake does not count it: the
 * token's secret matched. A computer turned off elsewhere has no row left
 * to match, so its token is refused like any other and counts.
 */
export async function authenticateDesktopToken(
  store: DataStore,
  token: string,
): Promise<Result<DesktopCaller>> {
  const invalid = () => err('unauthenticated', 'That token is not valid for this Copilot.');
  const parsed = parseDesktopToken(token ?? '');
  if (!parsed) return invalid();
  const unavailable = () =>
    err('provider_unavailable', 'Desktop alerts could not be checked just now.', {
      retryable: true,
    });

  let row: AuditEvent | null;
  try {
    row = await findDevice(store, parsed.organizationId, parsed.device);
  } catch {
    return unavailable();
  }
  const meta = row ? deviceMetadata(row) : null;
  if (!row || !meta || !row.user_id) return invalid();
  if (!sameHash(meta.token_hash, hashDesktopToken(token))) return invalid();

  let member: boolean;
  try {
    const memberships = await store.membershipsForUser(row.user_id);
    member = memberships.some((m) => m.organization_id === parsed.organizationId);
  } catch {
    return unavailable();
  }
  if (!member) {
    try {
      await removeDesktopDevice(
        store,
        parsed.organizationId,
        parsed.device,
        null,
        'member_removed',
      );
    } catch {
      return unavailable();
    }
    return err('unauthenticated', 'Desktop alerts were turned off for this computer.', {
      details: { reason: 'revoked' },
    });
  }
  return ok({
    organizationId: parsed.organizationId,
    device: parsed.device,
    userId: row.user_id,
    enabledAt: row.created_at,
  });
}

/* ----------------------------------------------------------------- ledger */

async function ledgerKeys(
  store: DataStore,
  organizationId: string,
  filter: Filter,
): Promise<string[]> {
  const rows = (await store.list('audit_events', organizationId, filter, {
    orderBy: [{ field: 'created_at', direction: 'desc' }],
    limit: 2000,
  })) as AuditEvent[];
  return rows.map((r) => r.entity_id).filter((k): k is string => Boolean(k));
}

/** What this computer has already shown, by its own ledger, in the last 60 days. */
async function deviceLedger(
  store: DataStore,
  organizationId: string,
  device: string,
  now: Date,
): Promise<Set<string>> {
  const since = new Date(now.getTime() - LEDGER_DAYS * 86_400_000).toISOString();
  return new Set(
    await ledgerKeys(store, organizationId, {
      eq: { action: DELIVERED_ACTION, 'metadata->>device': device },
      gte: { created_at: since },
    }),
  );
}

/**
 * The keys this computer must not alert: its own ledger, plus whatever the
 * phones were alerted about before this one was turned on (so turning it on
 * does not replay what has already pinged). Only the phone job writes the
 * phones' ledger; other computers' ledgers are what their tokens reported,
 * so they never quiet this one.
 */
export async function desktopSentKeys(
  store: DataStore,
  organizationId: string,
  device: string,
  enabledAt: string,
  now: Date,
): Promise<Set<string>> {
  const since = new Date(now.getTime() - LEDGER_DAYS * 86_400_000).toISOString();
  const [own, phones] = await Promise.all([
    deviceLedger(store, organizationId, device, now),
    ledgerKeys(store, organizationId, {
      eq: { action: 'push.alerted' },
      gte: { created_at: since },
      lt: { created_at: enabledAt },
    }),
  ]);
  for (const key of phones) own.add(key);
  return own;
}

/**
 * Ledger what this computer reports it showed. Keys are kept only if they
 * look like ours and are new for this computer, and at most LEDGER_DAILY_CAP
 * a day are written, so a stolen token cannot fill the table. The cap is per
 * organization and computer: a device id is unique only within one
 * organization, and a token from another must not use up this one's.
 */
export async function recordDesktopDelivery(
  store: DataStore,
  organizationId: string,
  device: string,
  keys: readonly string[],
  now: Date = new Date(),
): Promise<{ recorded: number }> {
  const wanted = [...new Set(keys.map((k) => k.slice(0, 200)))].filter((k) => KEY_PREFIXES.test(k));
  if (!wanted.length) return { recorded: 0 };
  const known = await deviceLedger(store, organizationId, device, now);
  const bucket = `desktop-ledger:${organizationId}:${device}`;
  const fresh: string[] = [];
  for (const key of wanted) {
    if (known.has(key)) continue;
    if (!rateLimit(bucket, LEDGER_DAILY_CAP, 86_400_000, now.getTime()).ok) break;
    fresh.push(key);
  }
  if (!fresh.length) return { recorded: 0 };
  const created_at = now.toISOString();
  await store.insertMany(
    'audit_events',
    fresh.map((key): AuditEvent => ({
      id: newId(),
      organization_id: organizationId,
      user_id: null,
      action: DELIVERED_ACTION,
      entity_type: 'push',
      entity_id: key,
      metadata: { device },
      ip_hash: null,
      created_at,
    })),
  );
  return { recorded: fresh.length };
}

/* ----------------------------------------------------------- what is due */

/** One notification, as the shell shows it. */
export interface DesktopAlert {
  /** Ledger keys it covers; the shell reports them back once shown. */
  keys: string[];
  title: string;
  body: string;
  /** In-app path a click opens. */
  url: string;
  /** A meeting about to start: kept on screen longer. */
  urgent: boolean;
  /**
   * Something the page shows whoever is looking (an Ask Arwin answer's
   * "Arwin replied" pop-up): no notification while the app's main window is
   * in front on the live site, and it counts as shown. From desktop 0.4.1.
   */
  quietWhenFocused: boolean;
}

/** A phone alert worded for a computer. Pure. */
export function toDesktopAlert(alert: PushAlert): DesktopAlert {
  return {
    keys: alert.keys.slice(0, ALERT_KEYS_MAX),
    title: alert.title,
    body: alert.body.replace('Tap to join', 'Click to join'),
    url: isInAppAlertPath(alert.url) ? alert.url : '/today',
    urgent: alert.tag.startsWith('meeting-'),
    quietWhenFocused: false,
  };
}

const SHELL_AGENT = /^TipTopCopilot\/(\d{1,4}\.\d{1,5}\.\d{1,6}) desktop-alerts$/;

/**
 * Whether the shell that sent this User-Agent (alerts.rs USER_AGENT) takes
 * Ask Arwin answers: from FIRST_ASK_ALERTS_VERSION, which holds back an alert
 * marked quietWhenFocused while its window is in front. A compatibility hint,
 * never a permission: anyone can send any User-Agent; the token decides what
 * is read.
 */
export function shellTakesAskReplies(userAgent: string | null): boolean {
  const version = userAgent ? SHELL_AGENT.exec(userAgent.trim())?.[1] : undefined;
  return version !== undefined && compareVersions(version, FIRST_ASK_ALERTS_VERSION) >= 0;
}

/** Whether the shell asks at this hour: 6am to 9pm in the principal's timezone. */
export function inDesktopPollWindow(now: Date, timeZone: string): boolean {
  const { hour } = localClock(now, timeZone);
  return hour >= POLL_FROM_HOUR && hour < POLL_UNTIL_HOUR;
}

/**
 * When the shell should ask again, in seconds: every minute during the day,
 * and at night not until 6am, so the server (free plan) can sleep. Pure.
 */
export function desktopPollAfterSeconds(now: Date, timeZone: string): number {
  if (inDesktopPollWindow(now, timeZone)) return POLL_EVERY_SECONDS;
  const clock = localClock(now, timeZone);
  const day = clock.hour >= POLL_UNTIL_HOUR ? addDaysToKey(clock.dateKey, 1) : clock.dateKey;
  const wake = wallTimeToUtc(day, POLL_FROM_HOUR, 0, timeZone);
  if (!wake) return POLL_EVERY_SECONDS;
  return Math.max(POLL_EVERY_SECONDS, Math.ceil((wake.getTime() - now.getTime()) / 1000));
}

const inputsCache = processWide(
  'desktop-alert-inputs',
  () => new Map<string, { at: number; inputs: AlertInputs }>(),
);
const timeZoneCache = processWide(
  'desktop-alert-timezone',
  () => new Map<string, { at: number; timeZone: string }>(),
);

/** Test hook. */
export function resetDesktopAlertCaches(): void {
  inputsCache.clear();
  timeZoneCache.clear();
}

async function cachedTimeZone(store: DataStore, organizationId: string, now: Date) {
  const hit = timeZoneCache.get(organizationId);
  if (hit && Math.abs(now.getTime() - hit.at) < TIMEZONE_TTL_MS) return hit.timeZone;
  const stored = await principalTimeZone(store, organizationId);
  // An unknown zone would make every clock read throw, all night long.
  const timeZone = isSupportedTimezone(stored) ? stored : 'America/Chicago';
  timeZoneCache.set(organizationId, { at: now.getTime(), timeZone });
  return timeZone;
}

const NO_INPUTS: AlertInputs = { followUps: null, readers: [], finished: [] };

async function cachedInputs(
  store: DataStore,
  organizationId: string,
  now: Date,
  timeZone: string,
): Promise<AlertInputs> {
  const hit = inputsCache.get(organizationId);
  if (hit && Math.abs(now.getTime() - hit.at) < INPUTS_TTL_MS) return hit.inputs;
  try {
    const inputs = await readAlertInputs(store, organizationId, now, timeZone, { force: false });
    inputsCache.set(organizationId, { at: now.getTime(), inputs });
    return inputs;
  } catch (error) {
    log.warn('Desktop alert inputs could not be read', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return NO_INPUTS;
  }
}

/** Ask Arwin's answers for this computer's owner; none when they cannot be read. */
async function askReplies(store: DataStore, caller: DesktopCaller, now: Date) {
  try {
    return await askRepliesFor(store, caller, now);
  } catch (error) {
    // Without this the answers and the 30-second cadence would go quietly.
    log.warn('Ask Arwin answers could not be read for desktop alerts', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return NO_ASK_REPLIES;
  }
}

/** New feedback for this computer's owner, if they asked for it; none when it cannot be read. */
async function feedbackAlerts(
  store: DataStore,
  caller: DesktopCaller,
  sent: ReadonlySet<string>,
  now: Date,
): Promise<DesktopAlert[]> {
  try {
    const words = await feedbackAlertFor(store, caller, sent, now);
    if (!words) return [];
    return [
      {
        ...words,
        keys: words.keys.slice(0, ALERT_KEYS_MAX),
        url: isInAppAlertPath(words.url) ? words.url : '/ask',
        urgent: false,
        quietWhenFocused: false,
      },
    ];
  } catch (error) {
    log.warn('Feedback could not be read for desktop alerts', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * What one computer should show now, and when to ask again. Outside 6am-9pm
 * only Ask Arwin answers are worked out. Meetings first, then Ask Arwin
 * answers, then new feedback, then campaigns, then the rest, then a feed
 * notice (only when the computer's owner turned feed notices on), each
 * without the keys this computer must not alert.
 *
 * Ask Arwin answers (`askReplies`, for a shell from 0.4.1 only: the endpoint
 * decides by its User-Agent) come at any hour, to whoever asked, with a
 * 30-second cadence while the caller's own question waits. Off unless asked
 * for, so a caller cannot skip that check by leaving it out.
 */
export async function desktopAlertsFor(
  store: DataStore,
  caller: DesktopCaller,
  now: Date = new Date(),
  options: { askReplies?: boolean } = {},
): Promise<{ alerts: DesktopAlert[]; pollAfterSeconds: number }> {
  const timeZone = await cachedTimeZone(store, caller.organizationId, now);
  const inWindow = inDesktopPollWindow(now, timeZone);
  let pollAfterSeconds = desktopPollAfterSeconds(now, timeZone);
  // No quiet hours for these: the person just asked.
  const replies = options.askReplies ? await askReplies(store, caller, now) : NO_ASK_REPLIES;
  if (replies.waiting) pollAfterSeconds = Math.min(pollAfterSeconds, ASK_WAIT_POLL_SECONDS);
  if (!inWindow && !replies.arrivals.length) return { alerts: [], pollAfterSeconds };
  const sent = inWindow
    ? await desktopSentKeys(store, caller.organizationId, caller.device, caller.enabledAt, now)
    : await deviceLedger(store, caller.organizationId, caller.device, now);
  const words = askReplyWords(replies.arrivals.filter((a) => !sent.has(askReplyKey(a.answerId))));
  const asked: DesktopAlert[] = words ? [{ ...words, urgent: false, quietWhenFocused: true }] : [];
  if (!inWindow) return { alerts: asked, pollAfterSeconds };
  const meetings = await meetingAlerts(store, caller.organizationId, sent, now, timeZone).catch(
    () => [],
  );
  const inputs = await cachedInputs(store, caller.organizationId, now, timeZone);
  // Daytime only, like the phone alerts: feedback can wait for the morning.
  const feedback = await feedbackAlerts(store, caller, sent, now);
  const feeds = await feedNoticeFor(store, caller, sent, now, timeZone);
  return {
    alerts: [
      ...meetings.map(toDesktopAlert),
      ...asked,
      ...feedback,
      ...alertsFromInputs(inputs, sent, now, timeZone).map(toDesktopAlert),
      ...(feeds ? [{ ...feeds, urgent: false, quietWhenFocused: false }] : []),
    ],
    pollAfterSeconds,
  };
}
