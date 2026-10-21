import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { readCalendarDayEvents } from '@/lib/services/calendar-view';
import { addDaysToKey, dayWindow, formatTime } from '@/lib/util/time';
import { classifyMeeting } from './meetings';
import {
  calendarSource,
  primaryCalendar,
  readCalendarRange,
  type CalendarSource,
} from './range-reader';
import type { RangeEvent } from './range-types';

/**
 * The parity check: the new views (the default since D-069, after this matched
 * Nick's real calendar) must show the same events as the day list, one
 * switch away, for Nick's main calendar. For each day
 * in a range this reads the day exactly as the day list does
 * (readCalendarDayEvents, the same call the page makes) and the same days
 * through the new range reader, and lists every difference: an event one
 * shows and the other does not, or a changed title, time or verdict.
 *
 * Read-only: it calls list and get endpoints and nothing else, and skips the
 * day list's Gmail lookups (they add context, not events).
 */

export const PARITY_MAX_DAYS = 31;

export interface ParityEvent {
  id: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  meeting: boolean;
  reason: string;
}

export type ParityField = 'title' | 'start' | 'end' | 'all-day' | 'verdict';

export interface ParityDifference {
  dateKey: string;
  kind: 'missing' | 'extra' | 'changed';
  id: string;
  title: string;
  startsAt: string | null;
  fields: { field: ParityField; current: string; next: string }[];
}

export interface ParityDay {
  dateKey: string;
  state: 'ok' | 'error';
  message?: string;
  current: number;
  next: number;
  matched: number;
  differences: ParityDifference[];
}

export interface ParityReport {
  state: 'ok' | 'not_connected' | 'error';
  message?: string;
  from: string;
  days: number;
  timeZone: string;
  calendarName: string | null;
  checkedAt: string;
  totals: {
    current: number;
    next: number;
    matched: number;
    differences: number;
    failedDays: number;
  };
  dayReports: ParityDay[];
}

const instant = (value: string | null) => (value ? Date.parse(value) : null);

function verdictText(e: ParityEvent): string {
  return `${e.meeting ? 'Meeting' : 'Block'}: ${e.reason}`;
}

/** Every difference between what the two readers show for one day. Pure, for tests. */
export function diffDay(
  dateKey: string,
  current: readonly ParityEvent[],
  next: readonly ParityEvent[],
  timeZone: string,
): ParityDifference[] {
  const time = (value: string | null, allDay: boolean) =>
    allDay || !value ? 'all day' : formatTime(value, timeZone);
  const out: ParityDifference[] = [];
  const nextById = new Map(next.map((e) => [e.id, e]));
  const currentIds = new Set(current.map((e) => e.id));
  for (const a of current) {
    const b = nextById.get(a.id);
    if (!b) {
      out.push({
        dateKey,
        kind: 'missing',
        id: a.id,
        title: a.title,
        startsAt: a.startsAt,
        fields: [],
      });
      continue;
    }
    const fields: ParityDifference['fields'] = [];
    if (a.title !== b.title) fields.push({ field: 'title', current: a.title, next: b.title });
    if (a.allDay !== b.allDay) {
      fields.push({ field: 'all-day', current: String(a.allDay), next: String(b.allDay) });
    } else if (!a.allDay) {
      if (instant(a.startsAt) !== instant(b.startsAt)) {
        fields.push({
          field: 'start',
          current: time(a.startsAt, false),
          next: time(b.startsAt, false),
        });
      }
      if (instant(a.endsAt) !== instant(b.endsAt)) {
        fields.push({ field: 'end', current: time(a.endsAt, false), next: time(b.endsAt, false) });
      }
    }
    if (a.meeting !== b.meeting || a.reason !== b.reason) {
      fields.push({ field: 'verdict', current: verdictText(a), next: verdictText(b) });
    }
    if (fields.length) {
      out.push({
        dateKey,
        kind: 'changed',
        id: a.id,
        title: a.title,
        startsAt: a.startsAt,
        fields,
      });
    }
  }
  for (const b of next) {
    if (!currentIds.has(b.id)) {
      out.push({
        dateKey,
        kind: 'extra',
        id: b.id,
        title: b.title,
        startsAt: b.startsAt,
        fields: [],
      });
    }
  }
  return out;
}

/** The new reader's events that the day list's one-day read would return for that day. */
export function eventsOnDay(
  events: readonly RangeEvent[],
  dateKey: string,
  timeZone: string,
): RangeEvent[] {
  const { start, end } = dayWindow(dateKey, timeZone);
  const s = start.getTime();
  const e = end.getTime();
  return events.filter((ev) => {
    if (ev.allDay) {
      if (!ev.startDate) return false;
      const last =
        ev.endDate && ev.endDate > ev.startDate ? ev.endDate : addDaysToKey(ev.startDate, 1);
      return ev.startDate <= dateKey && dateKey < last;
    }
    const from = instant(ev.startsAt);
    const to = instant(ev.endsAt) ?? from;
    if (from === null || to === null) return false;
    // Google's timeMin/timeMax: the event overlaps the window.
    return to > from ? from < e && to > s : from >= s && from < e;
  });
}

export async function checkCalendarParity(
  store: DataStore,
  organizationId: string,
  options: {
    from: string;
    days: number;
    timeZone: string;
    ownEmail: string;
    source?: CalendarSource;
  },
): Promise<ParityReport> {
  const days = Math.max(1, Math.min(PARITY_MAX_DAYS, Math.floor(options.days)));
  const { from, timeZone } = options;
  const to = addDaysToKey(from, days);
  const base = {
    from,
    days,
    timeZone,
    checkedAt: new Date().toISOString(),
    totals: { current: 0, next: 0, matched: 0, differences: 0, failedDays: 0 },
    dayReports: [] as ParityDay[],
  };

  let source = options.source;
  if (!source) {
    const found = await calendarSource(store, organizationId, options.ownEmail);
    if (!found.ok) return { ...base, state: 'not_connected', calendarName: null };
    source = found.source;
  }

  // The new reader, for the main calendar only: one read for the whole range.
  const list = await source.provider.listCalendars();
  if (!list.ok) return { ...base, state: 'error', message: list.error.message, calendarName: null };
  const primaryEntry = list.value.find((c) => c.primary);
  if (!primaryEntry) {
    return {
      ...base,
      state: 'error',
      message: 'Google lists no main calendar for this account.',
      calendarName: null,
    };
  }
  const range = await readCalendarRange(store, organizationId, {
    from,
    to,
    timeZone,
    ownEmail: options.ownEmail,
    calendarIds: [primaryEntry.id],
    source,
  });
  if (range.state !== 'ok') {
    return { ...base, state: 'error', message: range.message, calendarName: null };
  }
  if (range.failed.length) {
    return { ...base, state: 'error', message: range.failed[0]!.message, calendarName: null };
  }
  const calendarName = primaryCalendar(range.calendars)?.name ?? null;

  const dayKeys = Array.from({ length: days }, (_, i) => addDaysToKey(from, i));
  const reports: ParityDay[] = [];
  // A few days at a time: the day list's read is one Google call per day.
  for (let i = 0; i < dayKeys.length; i += 4) {
    const batch = await Promise.all(
      dayKeys.slice(i, i + 4).map(async (dateKey): Promise<ParityDay> => {
        const read = await readCalendarDayEvents(store, organizationId, {
          dateKey,
          timeZone,
          ownEmail: options.ownEmail,
        });
        const next = eventsOnDay(range.events, dateKey, timeZone).map((e): ParityEvent => ({
          id: e.id,
          title: e.title,
          startsAt: e.startsAt,
          endsAt: e.endsAt,
          allDay: e.allDay,
          meeting: e.verdict.meeting,
          reason: e.verdict.reason,
        }));
        if (read.state !== 'ok') {
          return {
            dateKey,
            state: 'error',
            message:
              read.state === 'not_connected'
                ? 'No calendar is connected.'
                : (read.message ?? 'Google Calendar did not answer.'),
            current: 0,
            next: next.length,
            matched: 0,
            differences: [],
          };
        }
        const current = read.events.map((event): ParityEvent => {
          const verdict = classifyMeeting(event, read.own);
          return {
            id: event.id,
            title: event.title,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            allDay: event.allDay,
            meeting: verdict.meeting,
            reason: verdict.reason,
          };
        });
        const differences = diffDay(dateKey, current, next, timeZone);
        const unmatched = new Set(differences.filter((d) => d.kind !== 'extra').map((d) => d.id));
        return {
          dateKey,
          state: 'ok',
          current: current.length,
          next: next.length,
          matched: current.filter((e) => !unmatched.has(e.id)).length,
          differences,
        };
      }),
    );
    reports.push(...batch);
  }

  const totals = reports.reduce(
    (t, d) => ({
      current: t.current + d.current,
      next: t.next + d.next,
      matched: t.matched + d.matched,
      differences: t.differences + d.differences.length,
      failedDays: t.failedDays + (d.state === 'error' ? 1 : 0),
    }),
    base.totals,
  );
  return { ...base, state: 'ok', calendarName, totals, dayReports: reports };
}
