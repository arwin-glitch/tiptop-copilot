import 'server-only';
import { NextResponse } from 'next/server';
import { authOrError, requireRole, type AuthContext } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import { rateLimit } from '@/lib/security/limits';
import { statusForError, type AppError, type Result } from '@/lib/util/result';
import { isLocalOrigin } from './tokens';

/** Shared by the campaign API routes: JSON out, never cached. */
export const fail = (error: AppError, status?: number) =>
  NextResponse.json(
    { ok: false, error },
    { status: status ?? statusForError(error.code), headers: { 'Cache-Control': 'no-store' } },
  );

export const done = (value: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: true, ...value }, { headers: { 'Cache-Control': 'no-store' } });

/** A signed-in member (viewers can read campaigns, not change or send them), within a rate limit. */
export async function campaignAuth(
  bucket: string,
  max = 120,
): Promise<{ ok: true; auth: AuthContext } | { ok: false; response: NextResponse }> {
  const auth = await authOrError();
  if (!auth.ok) return { ok: false, response: fail(auth.error) };
  const allowed = requireRole(auth.value, 'member');
  if (!allowed.ok) return { ok: false, response: fail(allowed.error) };
  const limited = rateLimit(`campaign-${bucket}:${auth.value.userId}`, max, 60_000);
  if (!limited.ok) return { ok: false, response: fail(limited.error) };
  return { ok: true, auth: auth.value };
}

/**
 * The origin the tracking links point at (APP_URL), or null while it is a
 * local address outside demo mode. The campaign service then refuses to start
 * or go on with any campaign whose emails carry Kraken links (tracking or the
 * unsubscribe line): every pixel, link and unsubscribe would be broken for the
 * people receiving them. A campaign with both off carries no Kraken link and
 * needs no public origin.
 */
export function trackingOrigin(): string | null {
  const { appUrl, demoMode } = env();
  return !demoMode && isLocalOrigin(appUrl) ? null : appUrl;
}

/** A Result as a response. */
export function respond<T>(result: Result<T>, shape: (value: T) => Record<string, unknown>) {
  return result.ok ? done(shape(result.value)) : fail(result.error);
}
