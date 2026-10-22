import 'server-only';
import { NextResponse } from 'next/server';
import { isSameOrigin } from '@/lib/auth/desktop-handoff';
import { addressKey, clientAddress } from '@/lib/security/client-address';
import { hashIp, signedValue, verifySignedValue } from '@/lib/security/crypto';
import { rateLimit } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import { statusForError, type AppError } from '@/lib/util/result';

/**
 * The public event endpoints' front door (D-075): /api/e/<slug>/rsvp, the
 * personal link's respond, the view beacon and the check-in POSTs. Nobody is
 * signed in there, so every write passes the same layered brakes:
 *
 *   1. same-origin: the Origin (or Sec-Fetch-Site) must be this host — the
 *      check Next applies to Server Actions, applied by hand;
 *   2. a body cap (16 KB by default), read before parsing;
 *   3. per-address-bucket limits (IPv4, or the IPv6 /64), keyed by a short
 *      hash, never the address;
 *   4. for the RSVP forms: a honeypot field and a signed render time (a
 *      submission faster than 2 s, or from a page open over a day, is
 *      refused);
 *   5. Cloudflare Turnstile, only when its keys are set AND the event is
 *      open and public (never for invite-only LP pages).
 *
 * Copied from booking's visitorGate (lib/booking/route-helpers.ts, D-074)
 * rather than imported, so the two public surfaces stay independent.
 * In-process limits reset when a free Render instance sleeps (SECURITY.md);
 * the SQL unique (event, email) and the approval/waitlist states hold
 * regardless.
 */

const NO_STORE = { 'Cache-Control': 'no-store' };

/** JSON error for a public route: code and message only, never details. */
export const publicFail = (error: AppError, status?: number) =>
  NextResponse.json(
    { ok: false, error: { code: error.code, message: error.message } },
    { status: status ?? statusForError(error.code), headers: NO_STORE },
  );

export const publicDone = (value: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: true, ...value }, { headers: NO_STORE });

export interface Visitor {
  /** Hashed address bucket: the limiter key. */
  key: string;
  /** hashIp of the address, for event_guests.ip_hash and audits. */
  ipHash: string | null;
  /** The raw address, for Turnstile's remoteip only; never stored. */
  ip: string;
}

export interface GateLimit {
  bucket: string;
  max: number;
  windowMs: number;
}

/** RSVP: 5 per 10 minutes per event per address bucket (the spec's). */
export const RSVP_LIMIT = (eventId: string): GateLimit => ({
  bucket: `ev-rsvp:${eventId}`,
  max: 5,
  windowMs: 10 * 60_000,
});

/** Same-origin, then each named limit. */
export function publicGate(
  request: Request,
  options: { write?: boolean; limits: GateLimit[] },
): { ok: true; visitor: Visitor } | { ok: false; response: NextResponse } {
  if (options.write !== false && !isSameOrigin(request)) {
    return {
      ok: false,
      response: publicFail({
        code: 'forbidden',
        message: 'That request did not come from the event page.',
      }),
    };
  }
  const key = addressKey(request.headers);
  for (const limit of options.limits) {
    const limited = rateLimit(`${limit.bucket}:${key}`, limit.max, limit.windowMs);
    if (!limited.ok) return { ok: false, response: publicFail(limited.error) };
  }
  const ip = clientAddress(request.headers);
  return { ok: true, visitor: { key, ipHash: hashIp(ip), ip } };
}

export const PUBLIC_BODY_MAX_BYTES = 16 * 1024;

/** A JSON body of at most `maxBytes` (checked before and after reading), or null. */
export async function readJsonBody(
  request: Request,
  maxBytes = PUBLIC_BODY_MAX_BYTES,
): Promise<{ ok: true; body: unknown } | { ok: false; error: AppError }> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > maxBytes) {
    return { ok: false, error: { code: 'too_large', message: 'That form is too large.' } };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, error: { code: 'invalid_input', message: 'That form could not be read.' } };
  }
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { ok: false, error: { code: 'too_large', message: 'That form is too large.' } };
  }
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: { code: 'invalid_input', message: 'That form could not be read.' } };
  }
}

/* ----------------------------------------------------- honeypot + timing */

/** The honeypot field's name: a field people never see or fill. */
export const HONEYPOT_FIELD = 'website';

export function honeypotTripped(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

const FORM_PURPOSE = 'event-form/v1';
/** A person cannot read the form and fill it in under this. */
export const FORM_MIN_MS = 2_000;
/** A page open longer than this asks to be reloaded. */
export const FORM_MAX_MS = 24 * 60 * 60 * 1000;

/** The signed render time the RSVP form carries. */
export function formToken(eventId: string, now: number = Date.now()): string {
  return signedValue(`${FORM_PURPOSE}|${eventId}|${now}`);
}

export type FormTokenProblem = 'invalid' | 'too_fast' | 'expired';

/** Null when the form token is good for this event now, else why not. */
export function formTokenProblem(
  token: string | null | undefined,
  eventId: string,
  now: number = Date.now(),
): FormTokenProblem | null {
  if (!token || token.length > 400) return 'invalid';
  const payload = verifySignedValue(token);
  if (!payload) return 'invalid';
  const [purpose, id, at] = payload.split('|');
  const issued = Number(at);
  if (purpose !== FORM_PURPOSE || id !== eventId || !Number.isFinite(issued)) return 'invalid';
  if (now - issued < FORM_MIN_MS) return 'too_fast';
  if (now - issued > FORM_MAX_MS) return 'expired';
  return null;
}

export function formProblemMessage(problem: FormTokenProblem): string {
  switch (problem) {
    case 'too_fast':
      return 'That was quick. Check your details and send it again.';
    case 'expired':
      return 'This page has been open a long time. Reload it and try again.';
    case 'invalid':
      return 'We could not take that RSVP. Reload the page and try again.';
  }
}

/* -------------------------------------------------------------- Turnstile */

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** The site key, when Turnstile is configured (public; the CSP allows it then). */
export function turnstileSiteKey(): string | null {
  const key = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim();
  return key ? key : null;
}

function turnstileSecret(): string | null {
  const key = process.env.TURNSTILE_SECRET_KEY?.trim();
  return key ? key : null;
}

/** Turnstile runs only on open, public events, and only when both keys are set. */
export function turnstileRequired(event: { access: string; visibility: string }): boolean {
  return (
    Boolean(turnstileSiteKey() && turnstileSecret()) &&
    event.access === 'open' &&
    event.visibility === 'public'
  );
}

/**
 * Verify a Turnstile token with Cloudflare. `fetchImpl` is injectable so
 * tests never call the network. Fails closed: no answer is a refusal.
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  remoteIp: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const secret = turnstileSecret();
  if (!secret) return false;
  if (!token || token.length > 4000) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: unknown };
    return data.success === true;
  } catch (error) {
    log.warn('Turnstile verification failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
}
