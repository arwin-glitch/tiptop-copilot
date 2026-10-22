import { addDaysToKey, localDateKey, wallTimeToUtc } from '@/lib/util/time';
import {
  ALLOWED_WEEKDAYS,
  MEETING_MINUTES,
  type BookingConfig,
  type MeetingKind,
  type MeetingType,
} from './config';

/**
 * The booking link's slot engine: which times the public page may offer, and
 * why any other time is refused. Pure: busy time, travel days and the link's
 * own bookings come in, already reduced to intervals and day keys
 * (lib/booking/busy.ts), so no title, guest or description is ever in reach
 * of this module or of anything it returns.
 *
 * Every candidate start is checked against the same list, in this order, and
 * the first rule it breaks is the reason it is not offered:
 *
 *  1. Tuesday, Wednesday or Thursday only (and only the ones Settings keeps).
 *  2. Inside its window: a call wholly inside the call window; an in-person
 *     meeting starting inside one of its kind's windows. Host time, so a day
 *     the clocks change is right too (wallTimeToUtc).
 *  3. Notice and horizon: at least `noticeHours` ahead, at most `horizonDays`.
 *  4. In person only on a day the host is home: no travel signs that day.
 *  5. The day's caps: at most `maxLinkBookingsPerDay` link bookings (waiting
 *     and approved), and nothing on a day that already has
 *     `maxMeetingsPerDay` meetings.
 *  6. Clear of busy time with a buffer: 15 minutes each side for a call, 30
 *     for an in-person meeting, and 30 around any existing in-person meeting
 *     (travel), whichever is more. An opaque all-day entry makes the whole
 *     day busy.
 *  7. Back-to-back runs: when `stackSize` or more busy entries sit back to
 *     back (gaps under `stackGapMinutes`), nothing touches the run, nothing
 *     starts within `stackCooldownMinutes` after it ends, and nothing ends
 *     within `stackLeadMinutes` before it starts (30 by default, for a call
 *     too: the half hour before a stack stays free). Nor may the time itself
 *     complete such a run (possible only when Settings sets the back-to-back
 *     gap wider than the buffer).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Candidate starts step by half an hour from each window's opening. */
export const SLOT_STEP_MINUTES = 30;

export interface BusyBlock {
  start: number;
  end: number;
  /** Copilot's Meeting verdict: counted toward the day's meeting cap. */
  meeting: boolean;
  /** Face to face: travel time is kept on both sides of it. */
  inPerson: boolean;
  /** An opaque all-day entry, start and end at the host's midnights. Never part of a run. */
  allDay: boolean;
  /** Set on a waiting link request's own time (not a calendar entry), for the plain-words reason. */
  link?: true;
}

/** A request made through the link, waiting or approved. */
export interface LinkBooking {
  id: string;
  start: number;
  end: number;
  type: MeetingType;
  /**
   * Approved, so the host's calendar has it (Copilot made the event, or a
   * person added it by hand) and it is among the busy blocks already.
   */
  onCalendar: boolean;
  /** When it was asked for (ms), for first come, first served on Approve. */
  createdAt?: number;
}

/**
 * The link's bookings an approval is checked against: every approved one,
 * and the waiting ones asked for before this one (first come, first served:
 * the oldest waiting request can always be approved, and a later one is
 * checked against it). Ties go by id, so two requests never block each other.
 */
export function bookingsBefore(
  bookings: readonly LinkBooking[],
  request: { id: string; createdAt: number },
): LinkBooking[] {
  return bookings.filter(
    (b) =>
      b.id !== request.id &&
      (b.onCalendar ||
        (b.createdAt ?? 0) < request.createdAt ||
        ((b.createdAt ?? 0) === request.createdAt && b.id < request.id)),
  );
}

export interface EngineInput {
  now: Date;
  hostZone: string;
  config: BookingConfig;
  busy: readonly BusyBlock[];
  /** Host-zone day keys with a travel sign: no in-person meetings on them. */
  travelDays: ReadonlySet<string>;
  linkBookings: readonly LinkBooking[];
  /** The host's calendar is set to another time zone: in person paused everywhere. */
  inPersonPaused?: boolean;
  /**
   * The approval re-check: notice and horizon are measured from when the
   * request was made, and the slot must still be at least an hour away.
   */
  askedAt?: Date | null;
}

export interface SlotQuery {
  type: MeetingType;
  kind?: MeetingKind | null;
}

export interface OpenSlot {
  /** RFC 3339 instants. */
  start: string;
  end: string;
  /** The host-zone day it falls on, `YYYY-MM-DD`. */
  date: string;
}

/** ISO weekday of a day key: Monday 1 ... Sunday 7. */
export function weekdayOf(dateKey: string): number {
  const d = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

function minutesOf(clock: string): number {
  const [h, m] = clock.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function toInstant(dateKey: string, minuteOfDay: number, zone: string): number | null {
  const at = wallTimeToUtc(dateKey, Math.floor(minuteOfDay / 60), minuteOfDay % 60, zone);
  return at ? at.getTime() : null;
}

/** The starts a day offers before any rule but the window: half-hour steps, host time. */
export function candidateStarts(
  dateKey: string,
  query: SlotQuery,
  config: BookingConfig,
  zone: string,
): number[] {
  const minutes = MEETING_MINUTES[query.type];
  const out = new Set<number>();
  if (query.type === 'call') {
    const from = minutesOf(config.callWindow.from);
    const to = minutesOf(config.callWindow.to);
    for (let t = from; t + minutes <= to; t += SLOT_STEP_MINUTES) {
      const at = toInstant(dateKey, t, zone);
      if (at !== null) out.add(at);
    }
  } else if (query.kind) {
    for (const window of config.kindWindows[query.kind] ?? []) {
      const from = minutesOf(window.from);
      const to = minutesOf(window.to);
      for (let t = from; t <= to; t += SLOT_STEP_MINUTES) {
        const at = toInstant(dateKey, t, zone);
        if (at !== null) out.add(at);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Whether a start is inside its window (the approval re-check of a stored start). */
function inWindow(start: number, query: SlotQuery, config: BookingConfig, zone: string): boolean {
  const day = localDateKey(new Date(start), zone);
  return candidateStarts(day, query, config, zone).includes(start);
}

interface Run {
  start: number;
  end: number;
  count: number;
}

/** Busy entries back to back (gaps under `gapMinutes`), as runs of `minSize` or more. */
export function backToBackRuns(
  blocks: readonly Pick<BusyBlock, 'start' | 'end' | 'allDay'>[],
  gapMinutes: number,
  minSize: number,
): Run[] {
  const timed = blocks.filter((b) => !b.allDay).sort((a, b) => a.start - b.start || a.end - b.end);
  const runs: Run[] = [];
  let current: Run | null = null;
  for (const block of timed) {
    if (current && block.start - current.end < gapMinutes * MINUTE) {
      current.end = Math.max(current.end, block.end);
      current.count += 1;
    } else {
      if (current) runs.push(current);
      current = { start: block.start, end: block.end, count: 1 };
    }
  }
  if (current) runs.push(current);
  return runs.filter((r) => r.count >= minSize);
}

/** Everything the rules read, worked out once for a query. */
interface Prepared {
  input: EngineInput;
  query: SlotQuery;
  minutes: number;
  pad: number;
  /** Busy blocks plus the link's own bookings that are not on the calendar yet. */
  blocks: BusyBlock[];
  runs: Run[];
  linkPerDay: Map<string, number>;
  meetingsPerDay: Map<string, number>;
}

function prepare(input: EngineInput, query: SlotQuery, excludeId?: string): Prepared {
  const { config, hostZone } = input;
  const bookings = input.linkBookings.filter((b) => b.id !== excludeId);
  const pending: BusyBlock[] = bookings
    .filter((b) => !b.onCalendar)
    .map((b) => ({
      start: b.start,
      end: b.end,
      meeting: true,
      inPerson: b.type === 'in_person',
      allDay: false,
      link: true as const,
    }));
  const blocks = [...input.busy, ...pending];
  const linkPerDay = new Map<string, number>();
  for (const b of bookings) {
    const key = localDateKey(new Date(b.start), hostZone);
    linkPerDay.set(key, (linkPerDay.get(key) ?? 0) + 1);
  }
  const meetingsPerDay = new Map<string, number>();
  for (const b of blocks) {
    if (!b.meeting || b.allDay) continue;
    const key = localDateKey(new Date(b.start), hostZone);
    meetingsPerDay.set(key, (meetingsPerDay.get(key) ?? 0) + 1);
  }
  const pad =
    (query.type === 'call' ? config.callBufferMinutes : config.inPersonBufferMinutes) * MINUTE;
  return {
    input,
    query,
    minutes: MEETING_MINUTES[query.type],
    pad,
    blocks,
    runs: backToBackRuns(blocks, config.stackGapMinutes, config.stackSize),
    linkPerDay,
    meetingsPerDay,
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Why a start breaks a rule, in plain words, or null when it may be offered.
 * `known` is set by openSlots, whose starts come from candidateStarts for
 * that day (in their window by construction), so the window is not worked
 * out again for every one of them.
 */
function problemFor(
  p: Prepared,
  start: number,
  known?: { day: string; inWindow: true },
): string | null {
  const { input, query, minutes, pad } = p;
  const { config, hostZone, now } = input;
  const end = start + minutes * MINUTE;
  const day = known?.day ?? localDateKey(new Date(start), hostZone);

  const weekday = weekdayOf(day);
  if (!(ALLOWED_WEEKDAYS as readonly number[]).includes(weekday)) {
    return 'Meetings are only on Tuesday, Wednesday and Thursday.';
  }
  if (!config.weekdays.includes(weekday)) {
    return 'That day is not offered on the booking link any more.';
  }
  if (query.type === 'in_person' && !query.kind) return 'Pick coffee, lunch or dinner.';
  if (!known?.inWindow && !inWindow(start, query, config, hostZone)) {
    return query.type === 'call'
      ? 'That time is outside the hours for calls.'
      : 'That time is outside the hours for this kind of meeting.';
  }

  const from = (input.askedAt ?? now).getTime();
  if (start < from + config.noticeHours * HOUR) {
    return `That time is less than ${config.noticeHours} hours ahead.`;
  }
  if (input.askedAt && start < now.getTime() + HOUR) return 'That time is too close now.';
  if (start > from + config.horizonDays * DAY) {
    return `That time is more than ${config.horizonDays} days ahead.`;
  }

  if (query.type === 'in_person') {
    if (input.inPersonPaused) {
      return 'The calendar is set to another time zone, so in-person meetings are paused.';
    }
    if (input.travelDays.has(day)) return 'The host is away that day.';
  }

  const links = p.linkPerDay.get(day) ?? 0;
  if (links >= config.maxLinkBookingsPerDay) {
    return `That day already has ${plural(links, 'booking')} from the link.`;
  }
  const meetings = p.meetingsPerDay.get(day) ?? 0;
  if (meetings >= config.maxMeetingsPerDay) {
    return `That day already has ${plural(meetings, 'meeting')}.`;
  }

  const travel = config.inPersonBufferMinutes * MINUTE;
  for (const block of p.blocks) {
    const gap = block.allDay ? 0 : Math.max(pad, block.inPerson ? travel : 0);
    if (start - gap < block.end && end + gap > block.start) {
      if (block.allDay) return 'That day is busy all day.';
      return block.link ? WAITING_CLASH : 'That time is too close to another meeting.';
    }
  }

  const cooldown = Math.max(config.stackCooldownMinutes * MINUTE, pad);
  const lead = Math.max(config.stackLeadMinutes * MINUTE, pad);
  for (const run of p.runs) {
    if (start < run.end + cooldown && end + lead > run.start) {
      return `That time is right after ${plural(run.count, 'meeting')} back to back.`;
    }
  }

  // With a back-to-back gap wider than the buffer (Settings allows it), the
  // time itself could close a run: two meetings, a 30-minute gap, then this.
  if (config.stackGapMinutes * MINUTE > pad) {
    const candidate = { start, end, allDay: false };
    const runs = backToBackRuns([...p.blocks, candidate], config.stackGapMinutes, config.stackSize);
    const joined = runs.find((r) => r.start <= start && end <= r.end);
    if (joined) return `That time would make ${plural(joined.count, 'meeting')} back to back.`;
  }
  return null;
}

/** The reason when the time clashes with another waiting link request, not a calendar entry. */
export const WAITING_CLASH =
  'An earlier booking request is waiting for an overlapping time. Approve or decline that one first.';

/** The host-zone day keys the engine walks: today through the horizon. */
export function horizonDays(now: Date, hostZone: string, horizon: number): string[] {
  const today = localDateKey(now, hostZone);
  return Array.from({ length: horizon + 1 }, (_, i) => addDaysToKey(today, i));
}

/** Every start the link may offer for this query, soonest first. */
export function openSlots(input: EngineInput, query: SlotQuery): OpenSlot[] {
  const prepared = prepare(input, query);
  const out: OpenSlot[] = [];
  for (const day of horizonDays(input.now, input.hostZone, input.config.horizonDays)) {
    const known = { day, inWindow: true as const };
    for (const start of candidateStarts(day, query, input.config, input.hostZone)) {
      if (problemFor(prepared, start, known) !== null) continue;
      out.push({
        start: new Date(start).toISOString(),
        end: new Date(start + prepared.minutes * MINUTE).toISOString(),
        date: day,
      });
    }
  }
  return out;
}

/**
 * Why one start cannot be booked now, or null when it still can: the
 * approval re-check, with the request itself left out of the link's own
 * bookings (it would otherwise block its own slot).
 */
export function slotProblem(
  input: EngineInput,
  query: SlotQuery,
  start: string,
  excludeBookingId?: string,
): string | null {
  const at = Date.parse(start);
  if (!Number.isFinite(at)) return 'That time could not be read.';
  return problemFor(prepare(input, query, excludeBookingId), at);
}
