import 'server-only';
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/desktop-handoff';
import { authOrError, requireRole, type AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { statusForError, type AppError, type Result } from '@/lib/util/result';
import { notesAccess } from './flag';

/** Shared by the /api/notes routes (D-076): JSON out, never cached. */
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

/** What a route sees when Kraken Notes is off for this person: as if it did not exist. */
export const NOTES_OFF: AppError = {
  code: 'not_found',
  message: 'Kraken Notes is not turned on.',
};

export type NotesGate = { ok: true; auth: AuthContext } | { ok: false; response: NextResponse };

/**
 * Signed in, Kraken Notes on for this person, within a rate limit; for a
 * change also a member or above and a request from Kraken's own pages (the
 * Origin check Next applies to Server Actions, applied here by hand).
 */
export async function notesGate(
  request: Request,
  options: { bucket: string; max: number; windowMs?: number; write?: boolean },
): Promise<NotesGate> {
  if (options.write && !isSameOrigin(request)) {
    return {
      ok: false,
      response: fail({ code: 'forbidden', message: 'That request did not come from Kraken.' }),
    };
  }
  const auth = await authOrError();
  if (!auth.ok) return { ok: false, response: fail(auth.error) };
  const access = await notesAccess(getStore(), auth.value);
  if (!access.enabled) return { ok: false, response: fail(NOTES_OFF) };
  if (options.write) {
    const allowed = requireRole(auth.value, 'member');
    if (!allowed.ok) return { ok: false, response: fail(allowed.error) };
  }
  const limited = rateLimit(
    `notes-${options.bucket}:${auth.value.userId}`,
    options.max,
    options.windowMs ?? 60_000,
  );
  if (!limited.ok) return { ok: false, response: fail(limited.error) };
  return { ok: true, auth: auth.value };
}

/** Parse a JSON body against a schema; a bad body is a 400 with the first problem in words. */
export async function readBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<{ ok: true; value: z.infer<S> } | { ok: false; response: NextResponse }> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (parsed.success) return { ok: true, value: parsed.data };
  const first = parsed.error.issues[0];
  const where = first?.path.length ? ` (${first.path.join('.')})` : '';
  return {
    ok: false,
    response: fail({
      code: 'invalid_input',
      message: `That request was not valid${where}: ${first?.message ?? 'check the fields'}.`,
    }),
  };
}

/** A route parameter, decoded once (cluster keys carry ':' and '#'). */
export function param(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
