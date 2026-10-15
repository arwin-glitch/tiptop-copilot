import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { sign } from '@/lib/security/crypto';

/**
 * The token in a campaign email's tracking links: which recipient (and which
 * organization, since the endpoints run with no session) plus a signature.
 *
 * `<base64url(organization id ‖ recipient id)>.<first 16 bytes of the HMAC>`,
 * 66 characters. The HMAC is the session secret's (SESSION_SECRET), over a
 * purpose-tagged payload, so a tracking token can never pass for a session
 * cookie or any other signed value and nobody can mint one for a recipient
 * id they guessed. It never expires: a link in an email from last year still
 * opens, and still counts.
 */

const PURPOSE = 'campaign-track/v1';
const MAC_CHARS = 22; // 16 bytes of base64url, rounded up
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mac(organizationId: string, recipientId: string): string {
  return sign(`${PURPOSE}|${organizationId.toLowerCase()}|${recipientId.toLowerCase()}`).slice(
    0,
    MAC_CHARS,
  );
}

export interface TrackingTarget {
  organizationId: string;
  recipientId: string;
}

export function trackingToken(organizationId: string, recipientId: string): string {
  if (!UUID_RE.test(organizationId) || !UUID_RE.test(recipientId)) {
    throw new Error('Tracking tokens need uuid ids.');
  }
  const ids = Buffer.concat([uuidBytes(organizationId), uuidBytes(recipientId)]);
  return `${ids.toString('base64url')}.${mac(organizationId, recipientId)}`;
}

/** The recipient a token names, or null for anything not minted here. */
export function readTrackingToken(token: string | null | undefined): TrackingTarget | null {
  if (!token || token.length > 100) return null;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra !== undefined || signature.length !== MAC_CHARS) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  const ids = Buffer.from(encoded, 'base64url');
  if (ids.length !== 32) return null;
  const organizationId = bytesUuid(ids.subarray(0, 16));
  const recipientId = bytesUuid(ids.subarray(16));
  let expected: string;
  try {
    expected = mac(organizationId, recipientId);
  } catch {
    return null;
  }
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { organizationId, recipientId };
}

export interface TrackingUrls {
  open: string;
  click: (href: string) => string;
  unsubscribe: string;
}

function urlsFor(appUrl: string, token: string): TrackingUrls {
  const base = appUrl.replace(/\/+$/, '');
  return {
    open: `${base}/t/o/${token}`,
    click: (href) => `${base}/t/c/${token}?u=${encodeURIComponent(href)}`,
    unsubscribe: `${base}/t/u/${token}`,
  };
}

/** The three public URLs for one recipient, on the app's own origin (APP_URL). */
export function trackingUrls(appUrl: string, target: TrackingTarget): TrackingUrls {
  return urlsFor(appUrl, trackingToken(target.organizationId, target.recipientId));
}

/* ------------------------------------------------------------- test sends */
//
// "Send test to me" carries the same tracked links as the real email, so the
// test proves they work from outside (APP_URL reachable, the redirect lands).
// Its token names the campaign, not a recipient, under its own purpose tag,
// so it can never pass for a recipient's: the endpoints serve it (the pixel,
// the redirect to one of the campaign's own links, a "this was a test" page)
// and record nothing.

const TEST_PURPOSE = 'campaign-test/v1';

function testMac(organizationId: string, campaignId: string): string {
  return sign(`${TEST_PURPOSE}|${organizationId.toLowerCase()}|${campaignId.toLowerCase()}`).slice(
    0,
    MAC_CHARS,
  );
}

export interface TestTrackingTarget {
  organizationId: string;
  campaignId: string;
}

export function testTrackingToken(organizationId: string, campaignId: string): string {
  if (!UUID_RE.test(organizationId) || !UUID_RE.test(campaignId)) {
    throw new Error('Tracking tokens need uuid ids.');
  }
  const ids = Buffer.concat([uuidBytes(organizationId), uuidBytes(campaignId)]);
  return `${ids.toString('base64url')}.${testMac(organizationId, campaignId)}`;
}

/** The campaign a test token names, or null for anything else (a recipient token included). */
export function readTestTrackingToken(token: string | null | undefined): TestTrackingTarget | null {
  if (!token || token.length > 100) return null;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra !== undefined || signature.length !== MAC_CHARS) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  const ids = Buffer.from(encoded, 'base64url');
  if (ids.length !== 32) return null;
  const organizationId = bytesUuid(ids.subarray(0, 16));
  const campaignId = bytesUuid(ids.subarray(16));
  let expected: string;
  try {
    expected = testMac(organizationId, campaignId);
  } catch {
    return null;
  }
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { organizationId, campaignId };
}

/** A test send's URLs: the real endpoints, recording nothing. */
export function testTrackingUrls(appUrl: string, target: TestTrackingTarget): TrackingUrls {
  return urlsFor(appUrl, testTrackingToken(target.organizationId, target.campaignId));
}

/* ------------------------------------------------------------------ origin */

/** Whether an origin is this machine, where links in an email can never work. */
export function isLocalOrigin(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
}

export const LOCAL_ORIGIN_MESSAGE =
  'APP_URL is a local address, so the tracking and unsubscribe links in these emails would not work. Set it to the app’s public address, or turn tracking off for this campaign. Nothing was sent.';
