import type { NextRequest } from 'next/server';
import { calendarSource, readCalendarList } from '@/lib/calendar/range-reader';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/**
 * A repeating event's rule, for its card's "Weekly on Monday, 12 times": the
 * views list single events, which do not carry the rule, so the card reads
 * the series itself (one events.get) when it opens. Read-only, and only for
 * a calendar on the account's list.
 */
export async function GET(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'context', max: 120 });
  if (!gate.ok) return gate.response;
  const params = request.nextUrl.searchParams;
  const calendarId = params.get('calendarId') ?? '';
  const eventId = params.get('eventId') ?? '';
  if (!calendarId || calendarId.length > 320 || !/^[A-Za-z0-9_\-.@]{1,1024}$/.test(eventId)) {
    return fail({ code: 'invalid_input', message: 'That series could not be found.' });
  }
  const { auth } = gate;
  const found = await calendarSource(getStore(), auth.organizationId, auth.profile.email);
  if (!found.ok) return fail({ code: 'not_configured', message: 'No calendar is connected.' });
  const list = await readCalendarList(found.source, auth.organizationId);
  if (!list.ok) return fail(list.error);
  if (!list.value.calendars.some((c) => c.id === calendarId)) {
    return fail({ code: 'not_found', message: 'That calendar is not on your list.' });
  }
  const series = await found.source.provider.getEvent(calendarId, eventId);
  if (!series.ok) return fail(series.error);
  return done({
    recurrence: series.value.recurrence ?? [],
    start: series.value.start ?? null,
  });
}
