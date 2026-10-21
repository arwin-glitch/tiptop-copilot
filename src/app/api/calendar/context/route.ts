import type { NextRequest } from 'next/server';
import { isDateKey } from '@/lib/calendar/grid';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';
import { readCalendarDay } from '@/lib/services/calendar-view';

export const dynamic = 'force-dynamic';

/**
 * The meeting context box for one event in the new views: the dossier's "one
 * thing to know", "how you got here" and "worth asking", the week-ahead prep
 * note and the latest emails with the people on it. Read through the day
 * list's own reader for that day, so the box says exactly what the day list
 * says for the same meeting. Main calendar only, which is what the dossier
 * and prep routines read.
 */
export async function GET(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'context', max: 120 });
  if (!gate.ok) return gate.response;
  const params = request.nextUrl.searchParams;
  const date = params.get('date');
  const eventId = params.get('eventId') ?? '';
  if (!isDateKey(date) || !eventId || eventId.length > 1024) {
    return fail({ code: 'invalid_input', message: 'That meeting could not be found.' });
  }
  const { auth } = gate;
  const day = await readCalendarDay(getStore(), auth.organizationId, {
    dateKey: date,
    timeZone: auth.profile.timezone,
    ownEmail: auth.profile.email,
  });
  if (day.state !== 'ok') {
    return done({ found: false, message: day.message ?? null });
  }
  const entry = day.entries.find((e) => e.event.id === eventId);
  if (!entry || !entry.verdict.meeting) return done({ found: false });
  return done({
    found: true,
    context: { dossier: entry.dossier, prep: entry.prep, recent: entry.recent },
  });
}
