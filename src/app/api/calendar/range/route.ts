import type { NextRequest } from 'next/server';
import { isDateKey } from '@/lib/calendar/grid';
import { readCalendarRange } from '@/lib/calendar/range-reader';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';
import { readCalendarPrefs } from '@/lib/services/calendar-prefs';

export const dynamic = 'force-dynamic';

/**
 * The new Calendar views' read: every event on the visible calendars between
 * two dates (`from` inclusive, `to` exclusive, profile time zone), or on the
 * calendars named in `calendars`. Read-only; signed in.
 */
export async function GET(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'range', max: 240 });
  if (!gate.ok) return gate.response;
  const params = request.nextUrl.searchParams;
  const from = params.get('from');
  const to = params.get('to');
  if (!isDateKey(from) || !isDateKey(to) || to <= from) {
    return fail({ code: 'invalid_input', message: 'Pick the dates again.' });
  }
  // Named calendars (possibly none, when every one is toggled off), else the visible ones.
  const calendarIds = params.has('calendars')
    ? (params.get('calendars') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0 && id.length <= 320)
        .slice(0, 50)
    : undefined;
  const store = getStore();
  const { auth } = gate;
  const prefs = calendarIds
    ? null
    : await readCalendarPrefs(store, auth.organizationId, auth.userId);
  const data = await readCalendarRange(store, auth.organizationId, {
    from,
    to,
    timeZone: auth.profile.timezone,
    ownEmail: auth.profile.email,
    shown: prefs?.shown,
    calendarIds,
  });
  return done({ data });
}
