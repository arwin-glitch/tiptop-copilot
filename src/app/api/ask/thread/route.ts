import { NextResponse, type NextRequest } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { rateLimit } from '@/lib/security/limits';
import { readThreadView } from '@/lib/services/chat';
import { statusForError, type AppError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * One Ask conversation for the Ask Arwin widget (`?id=`), or the deal a new
 * one would be scoped to (`?deal=`). Polled every few seconds while an answer
 * is on its way; each poll is also the moment the Slack relay is checked for
 * it, exactly as the Ask page's refresh does.
 */
export async function GET(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  const limited = rateLimit(`ask-read:${auth.value.userId}`, 120, 60_000);
  if (!limited.ok) return fail(limited.error);

  const threadId = request.nextUrl.searchParams.get('id');
  const dealId = request.nextUrl.searchParams.get('deal');
  if ((!threadId && !dealId) || (threadId && !ID.test(threadId)) || (dealId && !ID.test(dealId))) {
    return fail({ code: 'invalid_input', message: 'Name a conversation or a deal.' });
  }

  const result = await readThreadView(auth.value, { threadId, dealId });
  if (!result.ok) return fail(result.error);
  return NextResponse.json(
    { ok: true, ...result.value },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

function fail(error: AppError) {
  return NextResponse.json(
    { ok: false, error },
    { status: statusForError(error.code), headers: { 'Cache-Control': 'no-store' } },
  );
}
