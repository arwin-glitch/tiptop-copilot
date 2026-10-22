import 'server-only';
import { NextResponse } from 'next/server';
import { isSameOrigin } from '@/lib/auth/desktop-handoff';
import { addressKey, clientAddress } from '@/lib/security/client-address';
import { hashIp } from '@/lib/security/crypto';
import { rateLimit } from '@/lib/security/limits';
import { statusForError, type AppError } from '@/lib/util/result';
import { rememberCookieName } from './public';

/**
 * Shared by the public booking routes (/api/meet/...). Nobody is signed in
 * there, so each route brakes per visitor address (a hashed key, never the
 * address itself) and every write must come from the booking page itself
 * (the Origin check Next applies to Server Actions, applied by hand). JSON
 * out, never cached.
 */

const NO_STORE = { 'Cache-Control': 'no-store' };

export const publicFail = (
  error: AppError,
  status?: number,
  /** Plain data to send alongside, such as the next open times after a clash. */
  extra: Record<string, unknown> = {},
) =>
  NextResponse.json(
    { ok: false, error: { code: error.code, message: error.message }, ...extra },
    { status: status ?? statusForError(error.code), headers: NO_STORE },
  );

export const publicDone = (value: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: true, ...value }, { headers: NO_STORE });

export interface Visitor {
  key: string;
  ipHash: string | null;
}

/** The visitor's brake key, after each named limit: { bucket, max, windowMs }. */
export function visitorGate(
  request: Request,
  options: { write?: boolean; limits: { bucket: string; max: number; windowMs: number }[] },
): { ok: true; visitor: Visitor } | { ok: false; response: NextResponse } {
  if (options.write && !isSameOrigin(request)) {
    return {
      ok: false,
      response: publicFail({
        code: 'forbidden',
        message: 'That request did not come from the booking page.',
      }),
    };
  }
  const key = addressKey(request.headers);
  for (const limit of options.limits) {
    const limited = rateLimit(`${limit.bucket}:${key}`, limit.max, limit.windowMs);
    if (!limited.ok) return { ok: false, response: publicFail(limited.error) };
  }
  return { ok: true, visitor: { key, ipHash: hashIp(clientAddress(request.headers)) } };
}

/** A JSON body of at most `maxBytes`, or null. */
export async function readJson(request: Request, maxBytes = 16_000): Promise<unknown> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > maxBytes) return null;
  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** How long a device remembers a booking: well past any time the link can offer. */
const REMEMBER_MAX_AGE_S = 300 * 24 * 60 * 60;

/**
 * Keep (or, with null, forget) the device's latest booking on a link (D-078):
 * the booking page's token in an httpOnly cookie sent only to /meet/<slug>,
 * so the booking page can say "You have a meeting with Nick". Page scripts
 * never see it, and it is never stored on the server.
 */
export function rememberBookingCookie(
  response: NextResponse,
  request: Request,
  slug: string,
  token: string | null,
): NextResponse {
  const secure =
    request.headers.get('x-forwarded-proto') === 'https' ||
    new URL(request.url).protocol === 'https:';
  response.cookies.set(rememberCookieName(slug), token ?? '', {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: `/meet/${slug}`,
    maxAge: token ? REMEMBER_MAX_AGE_S : 0,
  });
  return response;
}

/** The token at the end of a booking page path, or null. */
export function tokenOfManagePath(path: string | null | undefined): string | null {
  return /\/b\/([A-Za-z0-9_-]{43})$/.exec(path ?? '')?.[1] ?? null;
}
