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
 */
export async function GET(request: NextRequest) {
  const fallback = new URL('/calendar', request.url);
  const auth = await getAuthContext();
  if (!auth) return NextResponse.redirect(new URL('/login', request.url));
  const id = request.nextUrl.searchParams.get('id') ?? '';
  if (!/^[\w-]{3,200}$/.test(id)) return NextResponse.redirect(fallback);
  // "Start notes" (D-076): the notes page for this event, guests attached, consent first.
  if (request.nextUrl.searchParams.get('notes') === '1')
    return NextResponse.redirect(
      new URL(`/meetings/new?event=${encodeURIComponent(id)}`, request.url),
    );
  const store = getStore();
  const integration = await getPrimaryIntegration(store, auth.organizationId).catch(() => null);
  if (!integration) return NextResponse.redirect(fallback);
  const event = await readMeetingEvent(store, integration, id);
  const url = event.ok ? event.value.joinUrl : null;
  if (!url || !SAFE_JOIN.test(url)) return NextResponse.redirect(fallback);
  return NextResponse.redirect(url);
}
