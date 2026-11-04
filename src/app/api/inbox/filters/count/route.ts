import { NextResponse, type NextRequest } from 'next/server';
import { criteriaFromSearch } from '@/lib/email/inbox-filters';
import { EMPTY_SEARCH } from '@/lib/email/inbox-folders';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { countMatching } from '@/lib/services/inbox-filters';

export const dynamic = 'force-dynamic';

/**
 * How many conversations the Create filter dialog's criteria match now (the
 * "Also apply filter to N matching conversations" line). Read-only: one
 * Gmail list of a single result, or the demo's count.
 */
export async function GET(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-filter-count:${s.auth.userId}`, 60, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const p = request.nextUrl.searchParams;
  const text = (key: string) => (p.get(key) ?? '').slice(0, 500);
  const criteria = criteriaFromSearch({
    ...EMPTY_SEARCH,
    from: text('from'),
    to: text('to'),
    subject: text('subject'),
    hasWords: text('hasWords'),
    doesntHave: text('doesntHave'),
    hasAttachment: p.get('hasAttachment') === '1',
  });
  const count = await countMatching(
    getStore(),
    s.auth.organizationId,
    s.auth.isDemo,
    s.integration,
    criteria,
  ).catch(() => null);
  return NextResponse.json({ ok: true, count }, { headers: { 'Cache-Control': 'no-store' } });
}
