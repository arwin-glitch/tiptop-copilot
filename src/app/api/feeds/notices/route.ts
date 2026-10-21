import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/desktop-handoff';
import { authOrError } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import { setFeedNotices } from '@/lib/services/feed-health';
import { err, statusForError, type AppError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(error: AppError): NextResponse {
  return NextResponse.json(
    { ok: false, error },
    { status: statusForError(error.code), headers: NO_STORE },
  );
}

const BODY = z.object({ on: z.boolean() });

/**
 * Diagnostics > Feeds: turn feed notices on or off for the signed-in person's
 * own computers (lib/services/feed-health.ts). Nobody can turn them on for
 * anyone else. Same-origin only, on top of the session.
 */
export async function POST(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  if (!isSameOrigin(request)) return fail(err('forbidden', 'Not allowed from here.').error);
  const limited = rateLimit(`feed-notices:${auth.value.userId}`, 30, 3_600_000);
  if (!limited.ok) return fail(limited.error);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(err('invalid_input', 'Say on or off.').error);
  try {
    await setFeedNotices(getStore(), auth.value, parsed.data.on);
  } catch (error) {
    log.warn('Feed notices could not be saved', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return fail(
      err('provider_unavailable', 'Feed notices could not be saved just now. Try again.', {
        retryable: true,
      }).error,
    );
  }
  return NextResponse.json({ ok: true, on: parsed.data.on }, { headers: NO_STORE });
}
