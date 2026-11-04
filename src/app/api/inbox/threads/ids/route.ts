import { NextResponse, type NextRequest } from 'next/server';
import { getStore } from '@/lib/runtime';
import { parseCategory, parseFolder } from '@/lib/email/inbox-folders';
import { rateLimit } from '@/lib/security/limits';
import { matchingThreadIds } from '@/lib/services/inbox-live';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';

export const dynamic = 'force-dynamic';

/**
 * Gmail's "Select all N conversations in Inbox": the ids of every
 * conversation in a folder or search, capped (SELECT_ALL_MAX). Read-only;
 * changing them is the modify route's, a chunk at a time, from a tap.
 */
export async function GET(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-select-all:${s.auth.userId}`, 20, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const params = request.nextUrl.searchParams;
  const folder = parseFolder(params.get('folder'));
  if (!folder) return fail({ code: 'invalid_input', message: 'Unknown folder.' });
  const res = await matchingThreadIds(getStore(), s.auth.organizationId, {
    folder,
    category: parseCategory(params.get('category')),
    q: (params.get('q') ?? '').slice(0, 300),
  });
  if (!res.ok) return fail(res.error);
  return NextResponse.json(
    { ok: true, ...res.value },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
