import { compareVersions, MATCH_CODE_RE } from '@/lib/desktop/shared';

/**
 * The iPhone app (ios-app/ in this repository) is a Capacitor shell that
 * loads this site, like the desktop app is a Tauri one. What the page and
 * the server need to agree on about it lives here, and is safe to import
 * from a client component.
 *
 * The shell appends `TipTopCopilotiOS/<version>` to its web view's user
 * agent, so every request and the page itself can tell it apart from Safari
 * and from the home-screen web app. Like the desktop app's global and
 * cookie, that is a layout hint only: anyone can send it, so nothing is ever
 * granted because of it.
 */

export const IOS_UA_TOKEN = 'TipTopCopilotiOS';

/**
 * The shell's version in its user agent: `TipTopCopilotiOS/1.0.0`, a whole
 * word. lib/desktop/frame-boot.ts repeats this pattern before first paint (a
 * unit test holds the two together).
 */
export const IOS_UA_RE = /(?:^|\s)TipTopCopilotiOS\/(\d{1,4}\.\d{1,5}\.\d{1,6})(?=\s|$)/;

/**
 * Optional: the day the installed build was made, `TipTopBuilt/2026-10-19`,
 * which the build can append after the version. TestFlight builds stop
 * opening 90 days after upload, so the server stops counting on the app
 * once its build is old (IOS_BUILD_STALE_DAYS). Without it the server counts
 * from the first day it saw this build.
 */
const IOS_BUILT_RE = /(?:^|\s)TipTopBuilt\/(\d{4}-\d{2}-\d{2})(?=\s|$)/;

/** The iPhone app's version from a user agent, or null for anything else. */
export function iosAppVersionFromUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  return IOS_UA_RE.exec(userAgent)?.[1] ?? null;
}

/** The build day the app put in its user agent (YYYY-MM-DD), or null. */
export function iosBuiltDayFromUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const day = IOS_BUILT_RE.exec(userAgent)?.[1];
  if (!day) return null;
  const parsed = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day
    ? day
    : null;
}

/** The iPhone app's version when this page is open inside it; null elsewhere and on the server. */
export function iosAppVersion(): string | null {
  if (typeof navigator === 'undefined') return null;
  return iosAppVersionFromUserAgent(navigator.userAgent);
}

/** An iPhone or iPod browser of any kind (Safari, the home-screen web app, the app). */
export function isIphoneUserAgent(userAgent: string | null | undefined): boolean {
  return Boolean(userAgent && /\b(iPhone|iPod)\b/.test(userAgent));
}

/**
 * The first app version that registers for alerts through Apple's push
 * service (lib/services/ios-push.ts). Its Settings card offers them; an
 * older app (there is none yet) would be told to update in TestFlight.
 */
export const FIRST_IOS_PUSH_VERSION = '1.0.0';

export function iosPushShell(version: string | null): boolean {
  return version !== null && compareVersions(version, FIRST_IOS_PUSH_VERSION) >= 0;
}

/**
 * The first app version that can save a file the page downloads (an export,
 * the deal memo, a mail attachment): a web view saves nothing on its own, so
 * the shell turns each download into a file and offers it to the share sheet
 * (ios-app/, WebViewProxies.swift). In an app before it, or with this set to
 * null should that ever fail on a phone, the page hides those controls and
 * says to use a computer (html[data-ios-no-downloads], set before first
 * paint).
 */
export const FIRST_IOS_DOWNLOADS_VERSION: string | null = '1.0.0';

export function iosDownloadsShell(version: string | null): boolean {
  return (
    version !== null &&
    FIRST_IOS_DOWNLOADS_VERSION !== null &&
    compareVersions(version, FIRST_IOS_DOWNLOADS_VERSION) >= 0
  );
}

/* ------------------------------------------------------------ sign-in */

/**
 * The app's own URL scheme, registered by the shell. The desktop sign-in
 * page in Safari offers `vc.tiptop.copilot://signin?code=XXXX` on an iPhone,
 * so a tap carries the code back instead of the person typing it.
 */
export const IOS_APP_SCHEME = 'vc.tiptop.copilot';

export function iosSignInReturnUrl(code: string): string {
  return `${IOS_APP_SCHEME}://signin?code=${encodeURIComponent(code)}`;
}

/**
 * The code a sign-in return link carries, or null for any other link. The
 * code is only ever typed into the sign-in the app has open (DesktopSignIn),
 * which /api/auth/desktop/verify checks against that app's own poll cookie,
 * so a link from anywhere else can at worst use up one of three tries.
 */
export function parseIosSignInReturn(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 200) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${IOS_APP_SCHEME}:`) return null;
  // `vc.tiptop.copilot://signin?…` parses with `signin` as the host.
  const target = parsed.host || parsed.pathname.replace(/^\/+/, '');
  if (target !== 'signin') return null;
  const code = parsed.searchParams.get('code');
  return code && MATCH_CODE_RE.test(code) ? code : null;
}

/* ------------------------------------------------------------- alerts */

/** An APNs device token as the app reports it: hex, never assumed to be 64 characters. */
const APNS_TOKEN_RE = /^[0-9a-f]{64,200}$/i;
/** A registered iPhone's id: the first 40 hex characters of its token's SHA-256. */
const IOS_DEVICE_KEY_RE = /^[0-9a-f]{40}$/;

export function isApnsToken(value: unknown): value is string {
  return typeof value === 'string' && APNS_TOKEN_RE.test(value);
}

export function isIosDeviceKey(value: unknown): value is string {
  return typeof value === 'string' && IOS_DEVICE_KEY_RE.test(value);
}

/**
 * While someone's app has been in touch within this many days (it checks in
 * on launch and resume, at most twice a day), their iPhone's home-screen
 * web push is held back so nothing pings twice. Apple keeps accepting
 * pushes for a deleted app for an unpredictable time, so going quiet is the
 * only reliable sign it is gone: after this, the web push comes back.
 */
export const IOS_HOLD_BACK_DAYS = 8;
/** TestFlight builds stop opening after 90 days: from 80 the app is not counted on. */
export const IOS_BUILD_STALE_DAYS = 80;
/** From this age the app's Settings card asks for the update in TestFlight. */
export const IOS_BUILD_WARN_DAYS = 60;

/** Where someone's alerts go when they have both the app and the home-screen web app. */
export type AlertsPreference = 'app' | 'web';

/** The signed-in person's iPhone app alerts, for Settings. Never a token. */
export interface IosAlertsStatus {
  /** Their iPhones with alerts on in the app. */
  devices: number;
  /** One of them has been in touch lately, on a build young enough to count on. */
  active: boolean;
  preference: AlertsPreference;
  /** Their iPhone's home-screen web push is being held back for the app now. */
  webHeldBack: boolean;
  /** The app has the alerts now: active, and not sent to the web app instead. */
  appHasAlerts: boolean;
  /**
   * The alert job has asked with a working APNs key lately (within
   * IOS_SENDER_FRESH_HOURS): without that nothing reaches the app, and
   * nothing is held back for it.
   */
  senderReady: boolean;
}

/** How long one ask from a sender with a working APNs key counts (a night and a bit). */
export const IOS_SENDER_FRESH_HOURS = 26;
