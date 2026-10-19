import { NextResponse, type NextRequest } from 'next/server';
import { getAuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { readMeetingEvent } from '@/lib/calendar/meetings';
import { getPrimaryIntegration } from '@/lib/services/inbox';

export const dynamic = 'force-dynamic';

/** Only real video-call hosts; anything else falls back to the Calendar tab. */
const SAFE_JOIN =
  /^https:\/\/((?:[\w-]+\.)?zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|[\w-]+\.webex\.com|whereby\.com|around\.co)\//i;

/**
 * Tap a meeting alert, land in the call: looks the event up live and
 * redirects to its video link. Signed-in only.
 *
 * `?format=json` answers `{ url }` instead (null: open the Calendar tab), for
 * the iPhone app (components/ios/ios-app-bridge.tsx). There a redirect that
 * leaves Copilot is cut off half-way, which would show the app's offline
 * page; the page sends the app to the join link itself, which the app hands
 * to the meeting app or Safari.
 */
export async function GET(request: NextRequest) {
  const json = request.nextUrl.searchParams.get('format') === 'json';
  const answer = (url: string | null) =>
    NextResponse.json({ ok: true, url }, { headers: { 'Cache-Control': 'no-store' } });
  const fallback = () =>
    json ? answer(null) : NextResponse.redirect(new URL('/calendar', request.url));
  const auth = await getAuthContext();
  if (!auth) {
    return json
      ? NextResponse.json(
          { ok: false, error: { code: 'unauthenticated', message: 'Sign in to continue.' } },
          { status: 401 },
        )
      : NextResponse.redirect(new URL('/login', request.url));
  }
  const id = request.nextUrl.searchParams.get('id') ?? '';
  if (!/^[\w-]{3,200}$/.test(id)) return fallback();
  const store = getStore();
  const integration = await getPrimaryIntegration(store, auth.organizationId).catch(() => null);
  if (!integration) return fallback();
  const event = await readMeetingEvent(store, integration, id);
  const url = event.ok ? event.value.joinUrl : null;
  if (!url || !SAFE_JOIN.test(url)) return fallback();
  return json ? answer(url) : NextResponse.redirect(url);
}
