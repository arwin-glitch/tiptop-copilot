import 'server-only';
import { NextResponse } from 'next/server';
import { authOrError, requireRole, type AuthContext } from '@/lib/auth/session';
import { isSameOrigin } from '@/lib/auth/desktop-handoff';
import { rateLimit } from '@/lib/security/limits';
import { statusForError, type AppError } from '@/lib/util/result';

/** Shared by the Calendar tab's API routes: JSON out, never cached. */
export const fail = (error: AppError, status?: number) =>
  NextResponse.json(
    { ok: false, error },
    { status: status ?? statusForError(error.code), headers: { 'Cache-Control': 'no-store' } },
  );

export const done = (value: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: true, ...value }, { headers: { 'Cache-Control': 'no-store' } });

/**
 * Signed in, within a rate limit; for a change also a member or above and a
 * request from this site's own pages (the Origin check Next applies to Server
 * Actions, applied here by hand).
 */
export async function calendarAuth(
  request: Request,
  options: { bucket: string; max: number; write?: boolean },
): Promise<{ ok: true; auth: AuthContext } | { ok: false; response: NextResponse }> {
  if (options.write && !isSameOrigin(request)) {
    return {
      ok: false,
      response: fail({ code: 'forbidden', message: 'That request did not come from Kraken.' }),
    };
  }
  const auth = await authOrError();
  if (!auth.ok) return { ok: false, response: fail(auth.error) };
  if (options.write) {
    const allowed = requireRole(auth.value, 'member');
    if (!allowed.ok) return { ok: false, response: fail(allowed.error) };
  }
  const limited = rateLimit(`calendar-${options.bucket}:${auth.value.userId}`, options.max, 60_000);
  if (!limited.ok) return { ok: false, response: fail(limited.error) };
  return { ok: true, auth: auth.value };
}
