import type { NextRequest } from 'next/server';
import { isDateKey } from '@/lib/calendar/grid';
import { NICK_ALIASES } from '@/lib/calendar/meetings';
import {
  calendarSource,
  primaryCalendar,
  readCalendarLabels,
  readCalendarList,
  toRangeEvent,
} from '@/lib/calendar/range-reader';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';
import { suggestedLabelFor } from '@/lib/services/calendar-labels';
import { findEventOrigin } from '@/lib/services/calendar-origin';
import { readCalendarDay, recentThreads } from '@/lib/services/calendar-view';

export const dynamic = 'force-dynamic';

/**
 * What an event's card loads once it is open (never the grid):
 *
 * - For a meeting on the main calendar, the day list's context box: the
 *   dossier's "one thing to know", "how you got here" and "worth asking",
 *   the week-ahead prep note and the latest emails with the people on it,
 *   read through the day list's own reader for that day, so both say the
 *   same. For a meeting on another calendar, the latest emails with its guests.
 * - When none of that says anything (no other guests, a registration, a
 *   hold, an invite from a list), where it came from: the email that put it
 *   on the calendar, or what was checked and the Inbox search
 *   (lib/services/calendar-origin.ts).
 * - For an unlabelled event on a calendar with colour labels, a suggested
 *   label (lib/calendar/label-suggest.ts): a suggestion, never applied here.
 *
 * Read-only, signed in.
 */
export async function GET(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'context', max: 120 });
  if (!gate.ok) return gate.response;
  const params = request.nextUrl.searchParams;
  const date = params.get('date');
  const eventId = params.get('eventId') ?? '';
  const calendarId = params.get('calendarId');
  if (
    !isDateKey(date) ||
    !eventId ||
    eventId.length > 1024 ||
    (calendarId !== null && (!calendarId || calendarId.length > 320))
  ) {
    return fail({ code: 'invalid_input', message: 'That event could not be found.' });
  }
  const { auth } = gate;
  const store = getStore();
  const found = await calendarSource(store, auth.organizationId, auth.profile.email);
  if (!found.ok) return done({ found: false });
  const { source } = found;
  const list = await readCalendarList(source, auth.organizationId);
  if (!list.ok) return done({ found: false, message: list.error.message });
  const listed = calendarId
    ? list.value.calendars.find((c) => c.id === calendarId)
    : primaryCalendar(list.value.calendars);
  if (!listed) return done({ found: false });
  const [google, labels] = await Promise.all([
    source.provider.getEvent(listed.id, eventId),
    readCalendarLabels(source, auth.organizationId, listed.id),
  ]);
  if (!google.ok) return done({ found: false, message: google.error.message });
  const calendar = { ...listed, labels };
  const own = source.ownEmails;
  const event = toRangeEvent(google.value, calendar, list.value.colors, own);

  const ownSet = new Set([...own, ...NICK_ALIASES].map((e) => e.toLowerCase()));
  const ownDomain = own[0]?.split('@')[1] ?? '';
  const guests = event.attendees.filter((a) => !a.resource && !a.self && !ownSet.has(a.email));

  let context: {
    dossier: {
      oneThing: string | null;
      howYouGotHere: string | null;
      worthAsking: string[];
    } | null;
    prep: string | null;
    recent: { id: string; subject: string; at: string | null }[];
  } = { dossier: null, prep: null, recent: [] };
  if (event.verdict.meeting && calendar.primary) {
    const day = await readCalendarDay(store, auth.organizationId, {
      dateKey: date,
      timeZone: auth.profile.timezone,
      ownEmail: auth.profile.email,
    });
    const entry = day.state === 'ok' ? day.entries.find((e) => e.event.id === eventId) : null;
    if (entry?.verdict.meeting) {
      context = { dossier: entry.dossier, prep: entry.prep, recent: entry.recent };
    }
  } else if (event.verdict.meeting && source.integration) {
    const outside = guests
      .filter((a) => !a.email.endsWith(`@${ownDomain}`))
      .map((a) => a.email)
      .slice(0, 3);
    context.recent = await recentThreads(store, source.integration, outside).catch(() => []);
  }

  const saysNothing =
    !context.dossier?.howYouGotHere && !context.prep && context.recent.length === 0;
  const [origin, suggestion] = await Promise.all([
    saysNothing
      ? findEventOrigin(store, auth.organizationId, {
          event: {
            calendarId: calendar.id,
            id: event.id,
            title: event.title,
            organizer: event.organizer,
            description: event.description,
            location: event.location,
            startsAt: event.startsAt,
            startDate: event.startDate,
            guests: guests.length,
          },
          integration: source.integration,
          ownEmails: own,
          timeZone: auth.profile.timezone,
        }).catch(() => null)
      : Promise.resolve(null),
    suggestedLabelFor(store, auth.organizationId, event, labels, own).catch(() => null),
  ]);

  return done({ found: true, context, origin, suggestion });
}
