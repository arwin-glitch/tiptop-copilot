import { physicalLocation } from '@/lib/calendar/meetings';
import type { CalendarInfo, RangeEvent } from '@/lib/calendar/range-types';
import { addDaysToKey, localClock, localDateKey, startOfDayUtc } from '@/lib/util/time';
import type { BusyBlock } from './engine';
import {
  arrivesHome,
  homewardSign,
  inTransitSign,
  namesHome,
  sameClock,
  travelSign,
  type HomePlace,
} from './travel';

/**
 * The host's calendar reduced to what the booking link may know: busy
 * intervals, the days he is away and the days a journey lands him home.
 * Nothing else leaves this function — no
 * title, guest, description, place or calendar name — so the slot engine,
 * the public page and the public chatbot can only ever be handed times.
 *
 * Busy is any entry he has not declined and that is not marked free: a
 * meeting, and every block and hold Copilot judges not a meeting, counts. A
 * hold counts even when it is marked free (it is time someone is keeping).
 * Working-location entries never do. An all-day entry counts only when it is
 * opaque (Google's "Busy"), and then the whole day is busy. A journey (a
 * flight, a Gmail booking) holds its time even when marked free, with travel
 * time on both sides. The same invite on two calendars counts once.
 *
 * Travel days: every day a travel-signed entry covers, the day after one
 * that runs into the evening (a late flight, a hotel night: "that day or the
 * night before"), and the days between two travel days at most three days
 * apart (out on Tuesday, back on Thursday) unless the first one took him
 * home or he has something at a home place that day.
 */

/** A timed travel entry ending at or after this host-time hour also marks the next day. */
export const TRAVEL_EVENING_HOUR = 20;

export interface BusyPicture {
  busy: BusyBlock[];
  /** Host-zone day keys with a travel sign. */
  travelDays: Set<string>;
  /**
   * Host-zone days a journey lands him back in his home city (the day it
   * ends: a red-eye counts for the morning it lands), soonest first.
   */
  homeLandings: string[];
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

/** A free-marked entry in transit longer than this is a stay, not a journey: it holds no time. */
const TRANSIT_MAX_MS = 20 * 3_600_000;

/** Travel days this close together (outbound, then back) are one trip: the days between are away. */
export const TRIP_GAP_DAYS = 3;

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

export function toBusyPicture(
  events: readonly RangeEvent[],
  options: { hostZone: string; home: HomePlace; ownEmails: readonly string[] },
): BusyPicture {
  const busy: BusyBlock[] = [];
  const travelDays = new Set<string>();
  /** Days a travel entry itself covers (not the evening's next day), for the trip fill. */
  const tripDays = new Set<string>();
  /** Days whose travel takes him home: the gap after one is not a trip. */
  const homewardDays = new Set<string>();
  /** Days with an entry at a home place: never filled as away. */
  const homeDays = new Set<string>();
  /** Days a journey lands him in the home city (for the in-person pause). */
  const homeLandings = new Set<string>();
  /** The same invite on two calendars is one entry. */
  const seen = new Set<string>();
  const own = new Set(options.ownEmails.map((e) => e.toLowerCase()));
  for (const event of events) {
    const ownEntry =
      !event.organizer || event.organizer.self || own.has(event.organizer.email.toLowerCase());
    // Where it is: the entry's own location when it names a real place, for
    // any entry (a Zoom link next to an address still says where he is).
    const place = physicalLocation({ location: event.location }) ?? event.place;
    const entry = {
      title: event.title,
      allDay: event.allDay,
      place,
      eventType: event.eventType,
      timeZone: event.timeZone,
      ownEntry,
      startsAt: event.startsAt,
      meeting: event.verdict.meeting,
    };
    // A declined entry says nothing about where he will be; a free one still does.
    const declined = event.myResponse === 'declined';
    const travel = !declined && travelSign(entry, options.home, options.hostZone);
    if (travel) {
      for (const day of daysCovered(event, options.hostZone)) {
        travelDays.add(day);
        tripDays.add(day);
      }
      const evening = eveningEnd(event, options.hostZone);
      if (evening) travelDays.add(addDaysToKey(evening, 1));
      if (homewardSign(entry, options.home)) {
        const days = daysCovered(event, options.hostZone);
        if (days.length) homewardDays.add(days[days.length - 1]!);
      }
      if (arrivesHome({ title: event.title, description: event.description }, options.home)) {
        const days = daysCovered(event, options.hostZone);
        if (days.length) homeLandings.add(days[days.length - 1]!);
      }
    } else if (!declined && place && namesHome(place, options.home)) {
      for (const day of daysCovered(event, options.hostZone)) homeDays.add(day);
    }

    const start = event.startsAt ? Date.parse(event.startsAt) : NaN;
    const end = event.endsAt ? Date.parse(event.endsAt) : NaN;
    // On a plane he cannot take a call, even when the flight is marked free
    // so it does not block a shared calendar.
    const transit =
      travel &&
      !event.allDay &&
      event.eventType !== 'workingLocation' &&
      inTransitSign(entry) &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end > start &&
      end - start <= TRANSIT_MAX_MS;
    if (!isBusyEntry(event) && !transit) continue;
    const dupKeys = [
      `id|${event.id}|${event.startsAt ?? event.startDate}`,
      `at|${event.startsAt ?? event.startDate}|${event.endsAt ?? event.endDate}|${event.title.trim().toLowerCase()}`,
    ];
    if (dupKeys.some((k) => seen.has(k))) continue;
    for (const k of dupKeys) seen.add(k);
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
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    busy.push({
      start,
      end,
      meeting: event.verdict.meeting,
      // Travel time on both sides of a journey, as around a face-to-face meeting.
      inPerson: event.inPerson || transit,
      allDay: false,
    });
  }

  // Out on Tuesday, back on Thursday: Wednesday is away too, unless an
  // entry that day is at a home place, or Tuesday's travel brought him home.
  const sorted = [...tripDays].sort();
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const from = sorted[i]!;
    const to = sorted[i + 1]!;
    const gap = dayDiff(from, to);
    if (gap < 2 || gap > TRIP_GAP_DAYS || homewardDays.has(from)) continue;
    for (let d = addDaysToKey(from, 1); d < to; d = addDaysToKey(d, 1)) {
      if (!homeDays.has(d)) travelDays.add(d);
    }
  }
  return { busy, travelDays, homeLandings: [...homeLandings].sort() };
}

/**
 * The host's main calendar set to another time zone than his own: Google
 * Calendar offers that switch when he lands somewhere, so in-person meetings
 * pause while it differs (inPersonPausedThrough says for how long).
 */
export function calendarZoneDiffers(
  calendars: readonly Pick<CalendarInfo, 'primary' | 'timeZone'>[],
  hostZone: string,
  now: Date,
): boolean {
  const zone = calendars.find((c) => c.primary)?.timeZone;
  return Boolean(zone && !sameClock(now, zone, hostZone));
}

/**
 * How long in-person meetings stay paused, per trip rather than for every
 * date: null when his main calendar shows his own zone (nothing paused);
 * while it shows another, through the day his next journey home lands (a
 * host-zone day key, today or later, inside the horizon), and every day
 * after that opens as usual (travel days still apply). With no journey home
 * on the calendar inside the horizon, 'all': every day stays paused, the
 * safe default. A journey home that landed before today (the end of an
 * earlier trip) says nothing about this one.
 */
export function inPersonPausedThrough(
  calendars: readonly Pick<CalendarInfo, 'primary' | 'timeZone'>[],
  homeLandings: readonly string[],
  options: { hostZone: string; now: Date; horizonDays: number },
): string | 'all' | null {
  const { hostZone, now, horizonDays } = options;
  if (!calendarZoneDiffers(calendars, hostZone, now)) return null;
  const today = localDateKey(now, hostZone);
  const last = addDaysToKey(today, horizonDays);
  const next = [...homeLandings].sort().find((d) => d >= today && d <= last);
  return next ?? 'all';
}
