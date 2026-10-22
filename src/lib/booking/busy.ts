import type { CalendarInfo, RangeEvent } from '@/lib/calendar/range-types';
import { addDaysToKey, localClock, localDateKey, startOfDayUtc } from '@/lib/util/time';
import type { BusyBlock } from './engine';
import { sameClock, travelSign, type HomePlace } from './travel';

/**
 * The host's calendar reduced to what the booking link may know: busy
 * intervals and the days he is away. Nothing else leaves this function — no
 * title, guest, description, place or calendar name — so the slot engine,
 * the public page and the public chatbot can only ever be handed times.
 *
 * Busy is any entry he has not declined and that is not marked free: a
 * meeting, and every block and hold Copilot judges not a meeting, counts. A
 * hold counts even when it is marked free (it is time someone is keeping).
 * Working-location entries never do. An all-day entry counts only when it is
 * opaque (Google's "Busy"), and then the whole day is busy.
 *
 * Travel days: every day a travel-signed entry covers, and the day after one
 * that runs into the evening (a late flight, a hotel night): "that day or the
 * night before".
 */

/** A timed travel entry ending at or after this host-time hour also marks the next day. */
export const TRAVEL_EVENING_HOUR = 20;

export interface BusyPicture {
  busy: BusyBlock[];
  /** Host-zone day keys with a travel sign. */
  travelDays: Set<string>;
}

/** Whether an entry takes the host's time. */
export function isBusyEntry(
  event: Pick<
    RangeEvent,
    | 'myResponse'
    | 'verdict'
    | 'transparent'
    | 'hold'
    | 'eventType'
    | 'allDay'
    | 'startsAt'
    | 'endsAt'
    | 'startDate'
    | 'endDate'
  >,
): boolean {
  if (event.myResponse === 'declined' || event.verdict.reason === 'Nick declined') return false;
  if (event.transparent && !(event.hold && !event.allDay)) return false;
  if (event.eventType === 'workingLocation') return false;
  if (event.allDay) return Boolean(event.startDate && event.endDate);
  return Boolean(event.startsAt && event.endsAt);
}

/** The host-zone days an entry covers: each date of an all-day one, start to end of a timed one. */
export function daysCovered(
  event: Pick<RangeEvent, 'allDay' | 'startsAt' | 'endsAt' | 'startDate' | 'endDate'>,
  hostZone: string,
): string[] {
  const out: string[] = [];
  if (event.allDay) {
    if (!event.startDate || !event.endDate) return out;
    for (let d = event.startDate; d < event.endDate && out.length < 62; d = addDaysToKey(d, 1)) {
      out.push(d);
    }
    return out;
  }
  if (!event.startsAt) return out;
  const start = Date.parse(event.startsAt);
  // An entry ending exactly at midnight does not reach into the next day.
  const end = Math.max(start, Date.parse(event.endsAt ?? event.startsAt) - 1);
  const last = localDateKey(new Date(end), hostZone);
  for (
    let d = localDateKey(new Date(start), hostZone);
    d <= last && out.length < 62;
    d = addDaysToKey(d, 1)
  ) {
    out.push(d);
  }
  return out;
}

/**
 * The host-zone day a timed entry ends on, when it ends in the evening or
 * later (TRAVEL_EVENING_HOUR): the night is spent away, so the next day is
 * too. Null for an all-day entry or one that ends earlier.
 */
export function eveningEnd(
  event: Pick<RangeEvent, 'allDay' | 'endsAt'>,
  hostZone: string,
): string | null {
  if (event.allDay || !event.endsAt) return null;
  const end = new Date(event.endsAt);
  if (!Number.isFinite(end.getTime())) return null;
  const clock = localClock(end, hostZone);
  // Ending at midnight is ending that evening.
  if (clock.hour === 0 && clock.minute === 0) return addDaysToKey(clock.dateKey, -1);
  return clock.hour >= TRAVEL_EVENING_HOUR ? clock.dateKey : null;
}

export function toBusyPicture(
  events: readonly RangeEvent[],
  options: { hostZone: string; home: HomePlace; ownEmails: readonly string[] },
): BusyPicture {
  const busy: BusyBlock[] = [];
  const travelDays = new Set<string>();
  const own = new Set(options.ownEmails.map((e) => e.toLowerCase()));
  for (const event of events) {
    const ownEntry =
      !event.organizer || event.organizer.self || own.has(event.organizer.email.toLowerCase());
    // A declined entry still says where the host will be; a free one too.
    if (
      travelSign(
        {
          title: event.title,
          allDay: event.allDay,
          place: event.place,
          eventType: event.eventType,
          timeZone: event.timeZone,
          ownEntry,
          startsAt: event.startsAt,
        },
        options.home,
        options.hostZone,
      ) &&
      event.myResponse !== 'declined'
    ) {
      for (const day of daysCovered(event, options.hostZone)) travelDays.add(day);
      const evening = eveningEnd(event, options.hostZone);
      if (evening) travelDays.add(addDaysToKey(evening, 1));
    }
    if (!isBusyEntry(event)) continue;
    if (event.allDay) {
      busy.push({
        start: startOfDayUtc(event.startDate!, options.hostZone).getTime(),
        end: startOfDayUtc(event.endDate!, options.hostZone).getTime(),
        meeting: false,
        inPerson: false,
        allDay: true,
      });
      continue;
    }
    const start = Date.parse(event.startsAt!);
    const end = Date.parse(event.endsAt!);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    busy.push({
      start,
      end,
      meeting: event.verdict.meeting,
      inPerson: event.inPerson,
      allDay: false,
    });
  }
  return { busy, travelDays };
}

/**
 * The host's main calendar set to another time zone than his own: Google
 * Calendar offers that switch when he lands somewhere, so in-person meetings
 * pause until it is set back.
 */
export function calendarZoneDiffers(
  calendars: readonly Pick<CalendarInfo, 'primary' | 'timeZone'>[],
  hostZone: string,
  now: Date,
): boolean {
  const zone = calendars.find((c) => c.primary)?.timeZone;
  return Boolean(zone && !sameClock(now, zone, hostZone));
}
