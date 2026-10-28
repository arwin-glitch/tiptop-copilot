import 'server-only';
import { NextResponse } from 'next/server';
import { isSameOrigin } from '@/lib/auth/desktop-handoff';
import { addressBucket, addressKey, clientAddress } from '@/lib/security/client-address';
import { hashIp } from '@/lib/security/crypto';
import { rateLimit } from '@/lib/security/limits';
import { statusForError, type AppError } from '@/lib/util/result';
import { boardHosts, requestHosts } from './host';
import { boardRequestAllowed } from './rate-limit';

/**
 * Shared by the board assistant's public routes (/api/jobs-board/ask...).
 * Nobody is signed in there: each request counts against the board's own
 * per-address allowance (lib/jobs-board/rate-limit.ts) and a smaller one of
 * its own (a hashed key, never the address itself), and a question must
 * come from the board's own page (the Origin check). No cookie is read or
 * set. JSON out, never cached.
 */

const NO_STORE = { 'Cache-Control': 'no-store' };

export const jobsChatFail = (error: AppError, status?: number) =>
  NextResponse.json(
    { ok: false, error: { code: error.code, message: error.message } },
    { status: status ?? statusForError(error.code), headers: NO_STORE },
  );

export const jobsChatDone = (value: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: true, ...value }, { headers: NO_STORE });

export interface JobsVisitor {
  ipHash: string | null;
  /** '' on the board's own host, '/jobs' on Kraken's: where the answer's links point. */
  base: string;
}

/** The board's path prefix for this request's host (never read from the request body). */
export function boardBaseFor(headers: Headers): string {
  return requestHosts(headers).some((host) => boardHosts(process.env).includes(host))
    ? ''
    : '/jobs';
}

export function jobsChatGate(
  request: Request,
  options: { write?: boolean; bucket: string; max: number; windowMs: number },
): { ok: true; visitor: JobsVisitor } | { ok: false; response: NextResponse } {
  if (options.write && !isSameOrigin(request)) {
    return {
      ok: false,
      response: jobsChatFail({
        code: 'forbidden',
        message: 'That request did not come from the job board.',
      }),
    };
  }
  const tooMany = () =>
    jobsChatFail(
      { code: 'rate_limited', message: 'Too many questions. Try again in a minute.' },
      429,
    );
  if (!boardRequestAllowed(request.headers, new URL(request.url).pathname)) {
    return { ok: false, response: tooMany() };
  }
  const key = addressKey(request.headers);
  if (!rateLimit(`${options.bucket}:${key}`, options.max, options.windowMs).ok) {
    return { ok: false, response: tooMany() };
  }
  return {
    ok: true,
    visitor: {
      // The /64 an IPv6 visitor controls, not the one address they used: the
      // per-address daily AI cap would otherwise be fresh for every address
      // in it, and one visitor could spend everyone's daily total.
      ipHash: hashIp(addressBucket(clientAddress(request.headers))),
      base: boardBaseFor(request.headers),
    },
  };
}

/** A JSON body of at most `maxBytes`, or null. */
export async function readSmallJson(request: Request, maxBytes: number): Promise<unknown> {
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
