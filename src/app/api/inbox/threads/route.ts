import { NextResponse, type NextRequest } from 'next/server';
import { getStore } from '@/lib/runtime';
import { INBOX_TABS, listLiveThreads, type InboxTab } from '@/lib/services/inbox-live';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';

export const dynamic = 'force-dynamic';

/** A page of the live inbox: a tab, or a search across all mail. */
export async function GET(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const params = request.nextUrl.searchParams;
  const tab = params.get('tab') ?? 'primary';
  if (!INBOX_TABS.includes(tab as InboxTab)) {
    return fail({ code: 'invalid_input', message: 'Unknown tab.' });
  }
  const q = (params.get('q') ?? '').slice(0, 300);
  const pageToken = params.get('pageToken');
  const list = await listLiveThreads(getStore(), s.auth.organizationId, {
    tab: tab as InboxTab,
    q,
    pageToken: pageToken && /^[0-9A-Za-z_-]{1,200}$/.test(pageToken) ? pageToken : null,
  });
  return NextResponse.json({ ok: true, ...list }, { headers: { 'Cache-Control': 'no-store' } });
}
