import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { sign, signedValue, verifySignedValue } from '@/lib/security/crypto';

/**
 * Guest tokens for event pages (D-075): the personal invite / ticket link
 * (/e/<slug>/i/<token>) and the check-in QR (/e/<slug>/c/<token>).
 *
 * Stateless HMACs, built the same way as lib/campaigns/tokens.ts:
 *
 *   <base64url(organization id ‖ guest id)>.<first 16 bytes of the HMAC>
 *
 * 66 characters, opaque, no PII. The HMAC is the session secret's, over a
 * purpose-tagged payload that also names the event and the guest's
 * token_version:
 *
 *   event-rsvp/v1|<org>|<event>|<guest>|<token_version>
 *   event-checkin/v1|<org>|<event>|<guest>|<token_version>
 *
 * So an invite token can never pass for a check-in token (or a campaign
 * tracking token, or a session cookie), a token for one event never opens
 * another, and bumping the guest's token_version ("Rotate link") kills every
 * link minted before it. Verification reads the guest row the token names
 * and recomputes the MAC from it, comparing in constant time.
 *
 * GETs carrying these tokens never change anything (the routes enforce it);
 * a token only identifies a guest to the narrow event services.
 */

export const RSVP_TOKEN_PURPOSE = 'event-rsvp/v1';
export const CHECKIN_TOKEN_PURPOSE = 'event-checkin/v1';
export type GuestTokenPurpose = typeof RSVP_TOKEN_PURPOSE | typeof CHECKIN_TOKEN_PURPOSE;

const MAC_CHARS = 22; // 16 bytes of base64url, rounded up
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The whole token, as it appears in a URL segment. */
export const GUEST_TOKEN_RE = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}$/;

export interface GuestTokenSubject {
  organizationId: string;
  eventId: string;
  guestId: string;
  tokenVersion: number;
}

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mac(purpose: GuestTokenPurpose, s: GuestTokenSubject): string {
  return sign(
    `${purpose}|${s.organizationId.toLowerCase()}|${s.eventId.toLowerCase()}|${s.guestId.toLowerCase()}|${s.tokenVersion}`,
  ).slice(0, MAC_CHARS);
}

/** Mint a guest token. Throws on malformed ids (a programming error). */
export function guestToken(purpose: GuestTokenPurpose, subject: GuestTokenSubject): string {
  if (
    !UUID_RE.test(subject.organizationId) ||
    !UUID_RE.test(subject.eventId) ||
    !UUID_RE.test(subject.guestId) ||
    !Number.isInteger(subject.tokenVersion) ||
    subject.tokenVersion < 1
  ) {
    throw new Error('Guest tokens need uuid ids and a token version.');
  }
  const ids = Buffer.concat([uuidBytes(subject.organizationId), uuidBytes(subject.guestId)]);
  return `${ids.toString('base64url')}.${mac(purpose, subject)}`;
}

export const inviteToken = (subject: GuestTokenSubject) => guestToken(RSVP_TOKEN_PURPOSE, subject);
export const checkinToken = (subject: GuestTokenSubject) =>
  guestToken(CHECKIN_TOKEN_PURPOSE, subject);

/**
 * The organization and guest a token NAMES, from its structure only. Nothing
 * here is trusted until verifyGuestToken has checked the MAC against the
 * guest row these ids point at.
 */
export function parseGuestToken(
  token: string | null | undefined,
): { organizationId: string; guestId: string } | null {
  if (!token || !GUEST_TOKEN_RE.test(token)) return null;
  const [encoded] = token.split('.');
  const ids = Buffer.from(encoded!, 'base64url');
  if (ids.length !== 32) return null;
  return { organizationId: bytesUuid(ids.subarray(0, 16)), guestId: bytesUuid(ids.subarray(16)) };
}

/** Whether `token` was minted for exactly this purpose, guest, event and token version. */
export function verifyGuestToken(
  purpose: GuestTokenPurpose,
  token: string | null | undefined,
  subject: GuestTokenSubject,
): boolean {
  const named = parseGuestToken(token);
  if (!named) return false;
  if (
    named.organizationId !== subject.organizationId.toLowerCase() ||
    named.guestId !== subject.guestId.toLowerCase()
  ) {
    return false;
  }
  let expected: string;
  try {
    expected = mac(purpose, subject);
  } catch {
    return false;
  }
  const signature = token!.split('.')[1]!;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* --------------------------------------------------- remembered RSVP cookie */
//
// After an RSVP (or opening a personal link), the browser keeps an httpOnly
// cookie scoped to /e/<slug>, so a later visit to the public page shows
// "You're going ✓ View ticket" and the gated sections the guest qualifies
// for. It names the guest and their token_version (rotation ends it too),
// signed under its own purpose tag.

export const RSVP_COOKIE = 'tiptop_ev_rsvp';
/** How long the remembered RSVP lasts. */
export const RSVP_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
const REMEMBER_PURPOSE = 'event-remember/v1';

interface RememberPayload {
  p: typeof REMEMBER_PURPOSE;
  e: string;
  g: string;
  v: number;
  x: number;
}

export function rememberCookieValue(
  subject: Pick<GuestTokenSubject, 'eventId' | 'guestId' | 'tokenVersion'>,
  now: number = Date.now(),
): string {
  const payload: RememberPayload = {
    p: REMEMBER_PURPOSE,
    e: subject.eventId,
    g: subject.guestId,
    v: subject.tokenVersion,
    x: now + RSVP_COOKIE_MAX_AGE_SECONDS * 1000,
  };
  return signedValue(JSON.stringify(payload));
}

/** The guest a remembered-RSVP cookie names for this event, or null. */
export function readRememberCookie(
  value: string | null | undefined,
  eventId: string,
  now: number = Date.now(),
): { guestId: string; tokenVersion: number } | null {
  if (!value || value.length > 600) return null;
  const raw = verifySignedValue(value);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as Partial<RememberPayload>;
    if (
      payload.p !== REMEMBER_PURPOSE ||
      payload.e !== eventId ||
      typeof payload.g !== 'string' ||
      !UUID_RE.test(payload.g) ||
      typeof payload.v !== 'number' ||
      typeof payload.x !== 'number' ||
      payload.x < now
    ) {
      return null;
    }
    return { guestId: payload.g, tokenVersion: payload.v };
  } catch {
    return null;
  }
}

/** Cookie attributes for the remembered RSVP: scoped to the event's own pages. */
export function rememberCookieOptions(slug: string, secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: `/e/${slug}`,
    maxAge: RSVP_COOKIE_MAX_AGE_SECONDS,
  };
}
