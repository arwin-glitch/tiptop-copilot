import { addDaysToKey, localClock, wallTimeToUtc } from '@/lib/util/time';
import { cleanGuestList, guestEmails, type EventDraft } from './edit-rules';
import { findLabel } from './labels';
import type { CalendarInfo, EventPaletteEntry, RangeEvent } from './range-types';

/**
 * The event editor's arithmetic, pure so the page and the tests share it:
 * an event as an editable draft, what a draft changed, the editor's date and
 * time fields as Google's instants, and the event as it will look once Google
 * has it, for the page to show while the change is on its way.
 */

/** The editor's starting point for an event already on the calendar. */
export function draftFromEvent(
  event: RangeEvent,
  profileTimeZone: string,
  ownEmails: readonly string[],
): EventDraft {
  return {
    title: event.title === '(no title)' ? '' : event.title,
    allDay: event.allDay,
    start: (event.allDay ? event.startDate : event.startsAt) ?? '',
    end: (event.allDay ? event.endDate : event.endsAt) ?? '',
    timeZone: event.timeZone ?? profileTimeZone,
    description: event.description ?? '',
    location: event.location ?? '',
    guests: guestEmails(event.attendees, ownEmails),
    meet: Boolean(event.meetUrl),
    colorId: event.colorId,
    labelId: event.labelId,
  };
}

/** A new event on a slot: a timed one by default, in the profile's zone. */
export function newDraft(start: Date, end: Date, timeZone: string): EventDraft {
  return {
    title: '',
    allDay: false,
    start: start.toISOString(),
    end: end.toISOString(),
    timeZone,
    description: '',
    location: '',
    guests: [],
    meet: false,
    colorId: null,
  };
}

/** A new all-day event on one or more days (`endKey` exclusive). */
export function newAllDayDraft(startKey: string, endKey: string, timeZone: string): EventDraft {
  return {
    ...newDraft(new Date(0), new Date(0), timeZone),
    allDay: true,
    start: startKey,
    end: endKey,
  };
}

const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

function timesChanged(before: EventDraft, after: EventDraft): boolean {
  if (before.allDay !== after.allDay) return true;
  if (after.allDay) return before.start !== after.start || before.end !== after.end;
  return !sameInstant(before.start, after.start) || !sameInstant(before.end, after.end);
}

/**
 * Only what the person changed, for a patch: untouched fields are left out,
 * so nothing they did not touch is rewritten. Times travel together.
 */
export function changedFields(before: EventDraft, after: EventDraft): Partial<EventDraft> {
  const out: Partial<EventDraft> = {};
  if (after.title.trim() !== before.title.trim()) out.title = after.title;
  if ((after.description ?? '') !== (before.description ?? '')) out.description = after.description;
  if ((after.location ?? '').trim() !== (before.location ?? '').trim())
    out.location = after.location;
  if ((after.colorId ?? null) !== (before.colorId ?? null)) out.colorId = after.colorId ?? null;
  if ((after.labelId ?? null) !== (before.labelId ?? null)) out.labelId = after.labelId ?? null;
  if (after.meet && !before.meet) out.meet = true;
  const was = cleanGuestList(before.guests ?? []);
  const now = cleanGuestList(after.guests ?? []);
  if (was.length !== now.length || was.some((g) => !now.includes(g))) out.guests = now;
  if (timesChanged(before, after)) {
    out.allDay = after.allDay;
    out.start = after.start;
    out.end = after.end;
    out.timeZone = after.timeZone;
  }
  return out;
}

/* ------------------------------------------------- the editor's fields */

/** "2026-10-21" and "09:30" for an instant, in a zone. */
export function wallFields(instant: string, timeZone: string): { date: string; time: string } {
  const clock = localClock(new Date(instant), timeZone);
  return {
    date: clock.dateKey,
    time: `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
  };
}

/** The instant a date and "HH:MM" read in a zone; null if either is not a real one. */
export function instantFromFields(date: string, time: string, timeZone: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const at = wallTimeToUtc(date, Number(match[1]), Number(match[2]), timeZone);
  return at ? at.toISOString() : null;
}

/** The last day an all-day event covers, as the editor shows it (Google keeps it exclusive). */
export function inclusiveLastDay(exclusiveEnd: string): string {
  return addDaysToKey(exclusiveEnd, -1);
}

/* --------------------------------------------------- the event, early */

/**
 * The event as it will look once Google takes the change, so the grid moves
 * at once. Google's answer replaces it; a refusal puts the old one back.
 */
export function optimisticEvent(
  base: RangeEvent | null,
  draft: Partial<EventDraft>,
  calendar: Pick<CalendarInfo, 'id' | 'color'> & Partial<Pick<CalendarInfo, 'labels'>>,
  palette: readonly EventPaletteEntry[],
  key: string,
): RangeEvent {
  const event: RangeEvent = base
    ? { ...base }
    : {
        key,
        id: key,
        calendarId: calendar.id,
        recurringEventId: null,
        title: '',
        allDay: false,
        startsAt: null,
        endsAt: null,
        startDate: null,
        endDate: null,
        timeZone: null,
        location: null,
        place: null,
        description: null,
        joinUrl: null,
        meetUrl: null,
        meetPending: false,
        colorId: null,
        labelId: null,
        label: null,
        color: calendar.color,
        organizer: null,
        attendees: [],
        guestsCanModify: false,
        canModify: true,
        readOnlyReason: null,
        canRespond: false,
        myResponse: null,
        attachments: [],
        verdict: { meeting: false, reason: 'Saving…', with: [] },
        hold: false,
        inPerson: false,
        transparent: false,
        eventType: 'default',
        htmlLink: null,
      };
  if (draft.title !== undefined) event.title = draft.title.trim() || '(no title)';
  if (draft.location !== undefined) event.location = draft.location.trim() || null;
  if (draft.description !== undefined) event.description = draft.description || null;
  if (draft.colorId !== undefined) event.colorId = draft.colorId;
  if (draft.labelId !== undefined) {
    event.labelId = draft.labelId;
    event.label = findLabel(calendar.labels, draft.labelId);
  }
  if (draft.colorId !== undefined || draft.labelId !== undefined) {
    // Google's order: the label's colour, else the event's own, else its calendar's.
    const own = palette.find((p) => p.id === event.colorId);
    event.color = event.label?.color ?? (own ? { ...own } : null) ?? calendar.color;
  }
  if (draft.allDay !== undefined && draft.start !== undefined && draft.end !== undefined) {
    event.allDay = draft.allDay;
    event.startsAt = draft.allDay ? null : draft.start;
    event.endsAt = draft.allDay ? null : draft.end;
    event.startDate = draft.allDay ? draft.start : null;
    event.endDate = draft.allDay ? draft.end : null;
  }
  if (draft.guests !== undefined) {
    const kept = event.attendees.filter(
      (a) => a.self || a.resource || draft.guests!.includes(a.email),
    );
    const have = new Set(kept.map((a) => a.email));
    event.attendees = [
      ...kept,
      ...draft.guests
        .filter((g) => !have.has(g))
        .map((email) => ({
          email,
          name: null,
          response: 'needsAction',
          self: false,
          resource: false,
          organizer: false,
          optional: false,
        })),
    ];
  }
  return event;
}
