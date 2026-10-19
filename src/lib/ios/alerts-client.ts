import {
  iosAlertPermission,
  iosAppBuild,
  iosPushToken,
  hasIosPlugin,
  requestIosAlertPermission,
} from './native';
import { iosAppVersion, iosBuiltDayFromUserAgent, iosPushShell } from './shared';

/**
 * The iPhone app's side of app alerts (lib/services/ios-push.ts): turning
 * them on and off from Settings, and checking in on launch and resume so the
 * server knows the app is still there (which is what holds the iPhone's web
 * push back). Client-only; every step is a no-op outside the app.
 *
 * The device's push token goes to Copilot and nowhere else. This page keeps
 * only a convenience record in localStorage (the iPhone's id, the SHA-256
 * prefix the server lists it by, whether it was on, and when it last checked
 * in) so a launch costs nothing most of the time. Copilot decides: a record
 * that says on is checked against the server before checking in, and the
 * server's "not on" (turned off elsewhere, or forgotten) wins.
 */

const RECORD_KEY = 'tiptop-ios-alerts';
/** Check in at most this often; the server holds web push back for 8 days after the last one. */
export const CHECK_IN_EVERY_MS = 12 * 3_600_000;

interface AlertsRecord {
  key: string;
  at: number;
  on: boolean;
  /**
   * Why it is off: `permission` (notifications were switched off in iOS
   * Settings, so they come back on with permission), or `user` (turned off
   * here or elsewhere, or never on: only Turn on brings it back).
   */
  why?: 'permission' | 'user';
}

function readRecord(): AlertsRecord | null {
  try {
    const raw = window.localStorage.getItem(RECORD_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AlertsRecord>;
    if (typeof value.key !== 'string' || !/^[0-9a-f]{40}$/.test(value.key)) return null;
    if (typeof value.at !== 'number' || typeof value.on !== 'boolean') return null;
    return {
      key: value.key,
      at: value.at,
      on: value.on,
      why: value.why === 'permission' ? 'permission' : value.on ? undefined : 'user',
    };
  } catch {
    return null;
  }
}

function writeRecord(record: AlertsRecord | null): void {
  try {
    if (record) window.localStorage.setItem(RECORD_KEY, JSON.stringify(record));
    else window.localStorage.removeItem(RECORD_KEY);
  } catch {
    // A convenience only: the next launch asks Copilot again.
  }
}

/** The id the server lists this token by: the first 40 hex characters of its SHA-256. */
export async function iosDeviceKeyFor(token: string): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(token.toLowerCase()),
    );
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 40);
  } catch {
    return null;
  }
}

/** Whether this page is in an iPhone app that can get alerts. */
export function iosAlertsAvailable(): boolean {
  return hasIosPlugin('PushNotifications') && iosPushShell(iosAppVersion());
}

interface ServerState {
  on: boolean;
  mine: boolean;
  buildAgeDays: number | null;
}

/** Copilot's view of this iPhone; null when it could not say. Never throws. */
async function serverState(key: string): Promise<ServerState | null> {
  try {
    const res = await fetch(`/api/push/ios?key=${key}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as Partial<ServerState> | null;
    if (typeof body?.on !== 'boolean') return null;
    return {
      on: body.on,
      mine: body.mine === true,
      buildAgeDays: typeof body.buildAgeDays === 'number' ? body.buildAgeDays : null,
    };
  } catch {
    return null;
  }
}

async function postDevice(
  token: string,
  replaces: string | null,
): Promise<{ ok: boolean; message: string | null }> {
  try {
    const res = await fetch('/api/push/ios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        version: iosAppVersion(),
        build: await iosAppBuild(),
        builtDay: iosBuiltDayFromUserAgent(navigator.userAgent),
        replaces,
      }),
    });
    if (res.ok) return { ok: true, message: null };
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return { ok: false, message: body?.error?.message ?? null };
  } catch {
    return { ok: false, message: null };
  }
}

async function deleteDevice(key: string, reason: 'settings' | 'permission' | 'sign_out') {
  try {
    const res = await fetch('/api/push/ios', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, reason }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Where this iPhone's app alerts stand, for its Settings card. */
export type IosAlertsState =
  | { kind: 'unavailable' }
  | { kind: 'prompt' }
  | { kind: 'denied' }
  | { kind: 'off' }
  | { kind: 'theirs' }
  | { kind: 'on'; buildAgeDays: number | null }
  | { kind: 'unknown' };

/** Reads permission, this iPhone's token and Copilot's view. Never asks for permission. */
export async function readIosAlertsState(): Promise<IosAlertsState> {
  if (!iosAlertsAvailable()) return { kind: 'unavailable' };
  const permission = await iosAlertPermission();
  if (!permission) return { kind: 'unavailable' };
  if (permission === 'prompt') return { kind: 'prompt' };
  if (permission === 'denied') return { kind: 'denied' };
  const token = await iosPushToken();
  const key = token ? await iosDeviceKeyFor(token) : null;
  if (!key) return { kind: 'unknown' };
  const state = await serverState(key);
  if (!state) return { kind: 'unknown' };
  if (!state.on) return { kind: 'off' };
  return state.mine ? { kind: 'on', buildAgeDays: state.buildAgeDays } : { kind: 'theirs' };
}

/**
 * Turn on: iOS asks for permission the first time (never at launch), then
 * the token goes to Copilot. Answers the new state, and Copilot's message
 * when it refused.
 */
export async function turnOnIosAlerts(): Promise<{
  state: IosAlertsState;
  message: string | null;
}> {
  if (!iosAlertsAvailable()) return { state: { kind: 'unavailable' }, message: null };
  const permission = await requestIosAlertPermission();
  if (permission !== 'granted') {
    return { state: { kind: permission === 'denied' ? 'denied' : 'prompt' }, message: null };
  }
  const token = await iosPushToken();
  const key = token ? await iosDeviceKeyFor(token) : null;
  if (!token || !key) {
    return {
      state: { kind: 'off' },
      message: 'This iPhone couldn’t reach Apple’s push service. Try again in a minute.',
    };
  }
  const before = readRecord();
  const result = await postDevice(token, before?.on && before.key !== key ? before.key : null);
  if (!result.ok) return { state: { kind: 'off' }, message: result.message };
  writeRecord({ key, at: Date.now(), on: true });
  return { state: { kind: 'on', buildAgeDays: 0 }, message: null };
}

/** Turn off (Settings, or signing out). Answers whether Copilot confirmed it. */
export async function turnOffIosAlerts(
  reason: 'settings' | 'sign_out' = 'settings',
): Promise<boolean> {
  if (!iosAlertsAvailable()) return false;
  let key = readRecord()?.key ?? null;
  if (!key) {
    const token = await iosPushToken();
    key = token ? await iosDeviceKeyFor(token) : null;
  }
  if (!key) return false;
  const done = await deleteDevice(key, reason);
  writeRecord(reason === 'sign_out' ? null : { key, at: Date.now(), on: false, why: 'user' });
  return done;
}

let checkingIn = false;

/**
 * On launch and resume: tell Copilot the app is still here (at most every
 * CHECK_IN_EVERY_MS), follow a changed token, and turn alerts off when
 * notifications were switched off in iOS Settings, so the iPhone's web push
 * comes back at once (and on again when they are allowed again). Quiet:
 * any failure waits for the next launch.
 */
export async function checkInIosAlerts(now: number = Date.now()): Promise<void> {
  if (checkingIn || !iosAlertsAvailable()) return;
  checkingIn = true;
  try {
    const permission = await iosAlertPermission();
    if (!permission || permission === 'prompt') return;
    const record = readRecord();

    if (permission === 'denied') {
      if (record && !record.on) return;
      let key = record?.key ?? null;
      if (!record) {
        const token = await iosPushToken();
        key = token ? await iosDeviceKeyFor(token) : null;
        if (!key) return;
        const state = await serverState(key);
        if (!state) return;
        if (!state.on || !state.mine) {
          writeRecord({ key, at: now, on: false, why: 'user' });
          return;
        }
      }
      if (key && (await deleteDevice(key, 'permission'))) {
        writeRecord({ key, at: now, on: false, why: 'permission' });
      }
      return;
    }

    // Allowed.
    if (record?.on && now - record.at < CHECK_IN_EVERY_MS) return;
    if (record && !record.on && record.why === 'user') return;
    const token = await iosPushToken();
    const key = token ? await iosDeviceKeyFor(token) : null;
    if (!token || !key) return;

    if (!record?.on && record?.why !== 'permission') {
      // No record (a first launch, or the record was cleared): ask Copilot.
      const state = await serverState(key);
      if (!state) return;
      if (!state.on || !state.mine) {
        writeRecord({ key, at: now, on: false, why: 'user' });
        return;
      }
    } else if (record?.on) {
      // On here: still on at Copilot? Turned off elsewhere stays off.
      const state = await serverState(record.key);
      if (!state) return;
      if (!state.on || !state.mine) {
        writeRecord({ key: record.key, at: now, on: false, why: 'user' });
        return;
      }
    }
    const replaces = record?.on && record.key !== key ? record.key : null;
    if ((await postDevice(token, replaces)).ok) writeRecord({ key, at: now, on: true });
  } finally {
    checkingIn = false;
  }
}

/** "Send a test alert": Copilot's message when it refused, or null once it is on its way. */
export async function sendTestAlert(): Promise<string | null> {
  try {
    const res = await fetch('/api/push/test', { method: 'POST' });
    if (res.ok) return null;
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return body?.error?.message ?? 'Couldn’t send a test alert just now. Try again.';
  } catch {
    return 'Couldn’t reach Copilot. Try again.';
  }
}
