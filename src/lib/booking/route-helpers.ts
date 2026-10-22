import 'server-only';
import { NextResponse } from 'next/server';
import { isSameOrigin } from '@/lib/auth/desktop-handoff';
import { addressKey, clientAddress } from '@/lib/security/client-address';
import { hashIp } from '@/lib/security/crypto';
import { rateLimit } from '@/lib/security/limits';
import { statusForError, type AppError } from '@/lib/util/result';

/**
 * Shared by the public booking routes (/api/meet/...). Nobody is signed in
 * there, so each route brakes per visitor address (a hashed key, never the
 * address itself) and every write must come from the booking page itself
 * (the Origin check Next applies to Server Actions, applied by hand). JSON
 * out, never cached.
 */

const NO_STORE = { 'Cache-Control': 'no-store' };

export const publicFail = (error: AppError, status?: number) =>
  NextResponse.json(
    { ok: false, error: { code: error.code, message: error.message } },
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
