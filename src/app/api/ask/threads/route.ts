import { NextResponse } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { rateLimit } from '@/lib/security/limits';
import { listThreadSummaries } from '@/lib/services/chat';
import { statusForError, type AppError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/**
 * The Ask Arwin widget's history list. A GET route rather than a Server
 * Action: the widget polls this while an answer is waiting, and Server Actions
 * are dispatched one at a time, so a poll would queue in front of whatever
 * the page itself is doing.
 */
export async function GET() {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  const limited = rateLimit(`ask-read:${auth.value.userId}`, 120, 60_000);
  if (!limited.ok) return fail(limited.error);

  const result = await listThreadSummaries(auth.value, { limit: 20, settle: true });
  if (!result.ok) return fail(result.error);
  return NextResponse.json(
    { ok: true, threads: result.value },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

function fail(error: AppError) {
  return NextResponse.json(
    { ok: false, error },
    { status: statusForError(error.code), headers: { 'Cache-Control': 'no-store' } },
  );
}
