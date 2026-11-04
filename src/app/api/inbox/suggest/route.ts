import { NextResponse, type NextRequest } from 'next/server';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { inboxSuggestions } from '@/lib/services/inbox-suggest';

export const dynamic = 'force-dynamic';

/**
 * The search box's type-ahead: matching people (Kraken's contacts and
 * recent senders) and a few matching conversations. Read-only; one light
 * Gmail list at most, cached briefly (lib/services/inbox-suggest.ts).
 */
export async function GET(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  // Generous: the box asks at most once per pause in typing.
  const limited = rateLimit(`inbox-suggest:${s.auth.userId}`, 240, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const q = (request.nextUrl.searchParams.get('q') ?? '').slice(0, 120);
  const suggestions = await inboxSuggestions(getStore(), s.auth.organizationId, s.integration, q);
  return NextResponse.json(
    { ok: true, ...suggestions },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
