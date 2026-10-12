import { NextResponse, type NextRequest } from 'next/server';
import { getStore } from '@/lib/runtime';
import { readLiveThread } from '@/lib/services/inbox-live';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';

export const dynamic = 'force-dynamic';

/** One whole conversation, as plain text. Reading never changes anything in Gmail. */
export async function GET(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const id = request.nextUrl.searchParams.get('id') ?? '';
  const thread = await readLiveThread(getStore(), s.auth.organizationId, id);
  if (!thread.ok) return fail(thread.error);
  return NextResponse.json(
    { ok: true, thread: thread.value },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
