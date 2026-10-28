import type { NextRequest } from 'next/server';
import { requireRole } from '@/lib/auth/session';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';
import { createPick, listPicks } from '@/lib/services/booking-picks';

export const dynamic = 'force-dynamic';

/**
 * Pick times, for the Calendar tab. Signed in, a member or above.
 *
 * GET `?from=&to=` (RFC 3339, both optional) -> `{ available, linkReady,
 * slug, picks: PickView[] }`: the open, unexpired picks with a range in the
 * window, for the grid's held overlays and the panel's Open picks.
 * `available` is false until 20261028000000_booking_picks.sql is run.
 *
 * POST (PickCreateInput) -> `{ id, url, text, html, expiresAt, pick }`: the
 * pick made, its absolute link (APP_URL) and the clipboard's text and HTML.
 */
export async function GET(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'booking-picks', max: 60 });
  if (!gate.ok) return gate.response;
  const member = requireRole(gate.auth, 'member');
  if (!member.ok) return fail(member.error);
  const params = request.nextUrl.searchParams;
  const list = await listPicks(getStore(), gate.auth.organizationId, {
    from: params.get('from'),
    to: params.get('to'),
  });
  return done({ ...list });
}

export async function POST(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'booking-pick-create', max: 20, write: true });
  if (!gate.ok) return gate.response;
  const body = (await request.json().catch(() => null)) as unknown;
  const created = await createPick(
    { store: getStore(), organizationId: gate.auth.organizationId, userId: gate.auth.userId },
    body,
  );
  if (!created.ok) return fail(created.error);
  return done({ ...created.value });
}
