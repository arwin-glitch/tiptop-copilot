import 'server-only';
import { NextResponse } from 'next/server';
import { authOrError, requireRole, type AuthContext } from '@/lib/auth/session';
import type { EventOwner } from '@/lib/services/events';
import { rateLimit } from '@/lib/security/limits';
import { statusForError, type AppError, type Result } from '@/lib/util/result';

/**
 * Shared by the signed-in Events API routes (/api/events/**). The public
 * /api/e/** routes do NOT use these: they resolve a grant, a guest token or
 * nobody, never a Copilot session.
 */

export const fail = (error: AppError, status?: number) =>
  NextResponse.json(
    { ok: false, error },
    { status: status ?? statusForError(error.code), headers: { 'Cache-Control': 'no-store' } },
  );

export const done = (value: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: true, ...value }, { headers: { 'Cache-Control': 'no-store' } });

export function respond<T>(result: Result<T>, shape: (value: T) => Record<string, unknown>) {
  return result.ok ? done(shape(result.value)) : fail(result.error);
}

/** The signed-in member as an event owner (Nick, Arwin: any member). */
export function ownerOf(auth: AuthContext): EventOwner {
  return {
    userId: auth.userId,
    organizationId: auth.organizationId,
    name: auth.profile.full_name?.trim() || auth.profile.email || 'TipTop',
  };
}

/** A signed-in member (viewers may read, not change), within a rate limit. */
export async function eventsAuth(
  bucket: string,
  options: { max?: number; write?: boolean } = {},
): Promise<
  { ok: true; auth: AuthContext; owner: EventOwner } | { ok: false; response: NextResponse }
> {
  const auth = await authOrError();
  if (!auth.ok) return { ok: false, response: fail(auth.error) };
  if (options.write !== false) {
    const allowed = requireRole(auth.value, 'member');
    if (!allowed.ok) return { ok: false, response: fail(allowed.error) };
  }
  const limited = rateLimit(`events-${bucket}:${auth.value.userId}`, options.max ?? 120, 60_000);
  if (!limited.ok) return { ok: false, response: fail(limited.error) };
  return { ok: true, auth: auth.value, owner: ownerOf(auth.value) };
}
