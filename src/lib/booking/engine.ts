import { addDaysToKey, localClock, localDateKey, wallTimeToUtc } from '@/lib/util/time';
import {
  ALLOWED_WEEKDAYS,
  CALL_BOUNDS,
  clockMinutes,
  firstName,
  KIND_LABEL,
  KIND_START_BOUNDS,
  MEETING_KINDS,
  MEETING_MINUTES,
  type BookingConfig,
  type MeetingKind,
  type MeetingType,
} from './config';
import { furthestMonth, hoursFor, lastOpenDay, monthOf, plannerClosure } from './months';

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
 *  2. The month planner (D-078, lib/booking/months.ts): in a month that is
 *     switched on (`openMonths`, any of this month and the next eleven), not
 *     on a closed day or in a closed run of days.
 *  3. Inside its window: a call wholly inside the call window; an in-person
 *     meeting starting inside one of its kind's windows; and, on a day with
 *     shorter hours, wholly inside those too. Host time, so a day the clocks
 *     change is right too (wallTimeToUtc). And inside the hard bounds
 *     whatever Settings holds (config.ts): nothing starts before 8:00,
 *     calls, coffee and lunch end by 18:00, dinner is 18:00 to 19:00.
 *  4. Notice: at least `noticeHours` ahead.
 *  5. In person only on a day the host is home: no travel signs that day,
 *     and not while his calendar shows another zone, through the day his
 *     flight home lands (inPersonPausedThrough).
 *  6. The day's caps: at most `maxLinkBookingsPerDay` link bookings (waiting,
 *     held or booked), and nothing on a day that already has
 *     `maxMeetingsPerDay` meetings.
 *  7. Clear of busy time with a buffer: 15 minutes each side for a call, 30
 *     for an in-person meeting, and 30 around any existing in-person meeting
 *     (travel), whichever is more. An opaque all-day entry makes the whole
 *     day busy.
 *     Times an open pick holds (Pick times, PickHold) are kept clear with
 *     the same buffer, but they are not meetings: no cap, no run.
 *  8. Back-to-back runs: when `stackSize` or more busy entries sit back to
 *     back (gaps under `stackGapMinutes`), nothing touches the run, nothing
 *     starts within `stackCooldownMinutes` after it ends, and nothing ends
 *     within `stackLeadMinutes` before it starts (30 by default, for a call
 *     too: the half hour before a stack stays free). Nor may the time itself
 *     complete such a run (possible only when Settings sets the back-to-back
 *     gap wider than the buffer).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Candidate starts step by half an hour from each window's opening. */
export const SLOT_STEP_MINUTES = 30;

export interface BusyBlock {
  start: number;
  end: number;
  /** Kraken's Meeting verdict: counted toward the day's meeting cap. */
  meeting: boolean;
  /** Face to face: travel time is kept on both sides of it. */
  inPerson: boolean;
  /** An opaque all-day entry, start and end at the host's midnights. Never part of a run. */
  allDay: boolean;
  /** Set on a waiting link request's own time (not a calendar entry), for the plain-words reason. */
  link?: true;
}

/** A booking made through the link: waiting, held, approved or booked. */
export interface LinkBooking {
  id: string;
  start: number;
  end: number;
  type: MeetingType;
  /**
   * On the host's calendar (Kraken made the event, or a person added it by
   * hand), so it is among the busy blocks already. A booking made in the
   * last few minutes is not: Google may not list a new event at once, so it
   * holds its own time until then (an entry at exactly its time stands in
   * for it, so it is never counted twice).
   */
  onCalendar: boolean;
  /** When it was asked for (ms), for first come, first served on Approve. */
  createdAt?: number;
  /**
   * Booked from times the host picked himself ("Pick times"): it holds its
   * time like any booking, but it is not one of the link's own, so it never
   * counts toward `maxLinkBookingsPerDay`.
   */
  picked?: boolean;
}

/**
 * Times the host picked and sent someone ("Pick times", booking_picks), held
 * while that pick is open: the public link does not offer them (with its
 * usual buffer), but they are not meetings. They count toward no cap and no
 * back-to-back run, and their clash reads as plain busy time.
 */
export interface PickHold {
  pickId: string;
  start: number;
  end: number;
  /** When the pick was made (ms): a re-check of an older booking leaves newer holds out. */
  createdAt?: number;
}

/** The holds made before a booking was asked for: newer picks never release an older booking. */
export function holdsBefore(holds: readonly PickHold[], createdAt: number): PickHold[] {
  return holds.filter((h) => (h.createdAt ?? 0) < createdAt);
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
  /**
   * The host's main calendar is set to another time zone
   * (lib/booking/busy.ts inPersonPausedThrough): in person is paused through
   * this host-zone day (the day his flight home lands), or on every day
   * ('all', no flight home on the calendar). Null or absent: not paused.
   */
  inPersonPausedThrough?: string | 'all' | null;
  /**
   * The approval re-check: notice and horizon are measured from when the
   * request was made, and the slot must still be at least an hour away.
   */
  askedAt?: Date | null;
  /** Open picks' held times (see PickHold). Absent: none. */
  pickHolds?: readonly PickHold[];
  /** Leave this pick's own holds out (its guest is booking one of them). */
  ignorePickId?: string | null;
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

function toInstant(dateKey: string, minuteOfDay: number, zone: string): number | null {
  const at = wallTimeToUtc(dateKey, Math.floor(minuteOfDay / 60), minuteOfDay % 60, zone);
  return at ? at.getTime() : null;
}

/**
 * The starts a day offers before any rule but the window: half-hour steps,
 * host time, each window first cut to the hard bounds (config.ts), so no
 * saved setting can open a time before 8:00, past 18:00 or a dinner off 18:00.
 */
export function candidateStarts(
  dateKey: string,
  query: SlotQuery,
  config: BookingConfig,
  zone: string,
): number[] {
  const minutes = MEETING_MINUTES[query.type];
  const out = new Set<number>();
  if (query.type === 'call') {
    const from = Math.max(clockMinutes(config.callWindow.from), clockMinutes(CALL_BOUNDS.from));
    const to = Math.min(clockMinutes(config.callWindow.to), clockMinutes(CALL_BOUNDS.to));
    for (let t = from; t + minutes <= to; t += SLOT_STEP_MINUTES) {
      const at = toInstant(dateKey, t, zone);
      if (at !== null) out.add(at);
    }
  } else if (query.kind) {
    const bounds = KIND_START_BOUNDS[query.kind];
    for (const window of config.kindWindows[query.kind] ?? []) {
      const from = Math.max(clockMinutes(window.from), clockMinutes(bounds.from));
      const to = Math.min(clockMinutes(window.to), clockMinutes(bounds.to));
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

/**
 * Whether a start keeps to the hard bounds on the host's own clock, read
 * straight off the instant (not off the windows): checked on every offer and
 * every re-check, whatever Settings holds.
 */
export function withinBookingHours(start: number, query: SlotQuery, zone: string): boolean {
  const clock = localClock(new Date(start), zone);
  const from = clock.hour * 60 + clock.minute;
  const to = from + MEETING_MINUTES[query.type];
  if (query.type === 'call') {
    return from >= clockMinutes(CALL_BOUNDS.from) && to <= clockMinutes(CALL_BOUNDS.to);
  }
  if (!query.kind) return false;
  const bounds = KIND_START_BOUNDS[query.kind];
  return from >= clockMinutes(bounds.from) && from <= clockMinutes(bounds.to);
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "Sat 24 Oct" for a day key. */
export function shortDayLabel(dateKey: string): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  return `${WEEKDAY_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`;
}

/**
 * Why in person is paused, in plain words: until the day after his flight
 * home lands, or (no flight home on the calendar) while his calendar shows
 * another zone.
 */
export function inPersonPauseReason(through: string | 'all', displayName: string): string {
  const who = firstName(displayName) || 'the host';
  if (through === 'all') {
    return `In person is paused while ${who}'s calendar is set to another time zone.`;
  }
  return `In person is paused until ${who} is back (from ${shortDayLabel(addDaysToKey(through, 1))}).`;
}

/** Whether the pause covers a host-zone day. */
export function inPersonPausedOn(day: string, through: string | 'all' | null | undefined): boolean {
  return through === 'all' || (typeof through === 'string' && day <= through);
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
  /** Open picks' held times: an overlap (with the buffer) only, never a meeting or a run. */
  pickBlocks: { start: number; end: number }[];
  runs: Run[];
  linkPerDay: Map<string, number>;
  meetingsPerDay: Map<string, number>;
}

function prepare(input: EngineInput, query: SlotQuery, excludeId?: string): Prepared {
  const { config, hostZone } = input;
  const bookings = input.linkBookings.filter((b) => b.id !== excludeId);
  const same = new Set(input.busy.map((b) => `${b.start}:${b.end}`));
  const pending: BusyBlock[] = bookings
    .filter((b) => !b.onCalendar && !same.has(`${b.start}:${b.end}`))
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
    if (b.picked) continue;
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
    pickBlocks: (input.pickHolds ?? [])
      .filter((h) => !input.ignorePickId || h.pickId !== input.ignorePickId)
      .map((h) => ({ start: h.start, end: h.end })),
    runs: backToBackRuns(blocks, config.stackGapMinutes, config.stackSize),
    linkPerDay,
    meetingsPerDay,
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Which rule closes a time, as a short code (the Booking tab groups and
 * colours by it, D-078). The plain-words reason travels with it.
 */
export const REASON_CODES = [
  'past',
  'weekday',
  'month_closed',
  'date_closed',
  'not_open',
  'hours',
  'notice',
  'in_person_paused',
  'away',
  'link_cap',
  'meeting_cap',
  'busy',
  'waiting',
  'stack',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface Problem {
  code: ReasonCode;
  text: string;
}

const problem = (code: ReasonCode, text: string): Problem => ({ code, text });

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
): Problem | null {
  const { input, query, minutes, pad } = p;
  const { config, hostZone, now } = input;
  const end = start + minutes * MINUTE;
  const day = known?.day ?? localDateKey(new Date(start), hostZone);

  const weekday = weekdayOf(day);
  if (!(ALLOWED_WEEKDAYS as readonly number[]).includes(weekday)) {
    return problem('weekday', 'Meetings are only on Tuesday, Wednesday and Thursday.');
  }
  if (!config.weekdays.includes(weekday)) {
    return problem('weekday', 'That day is not offered on the booking link any more.');
  }
  const closed = plannerClosure(config, day);
  if (closed) return problem(closed.code, closed.text);
  const today = localDateKey(input.askedAt ?? now, hostZone);
  if (monthOf(day) > furthestMonth(today)) {
    return problem('not_open', 'That month is too far ahead for the booking link.');
  }
  if (query.type === 'in_person' && !query.kind) {
    return problem('hours', 'Pick coffee, lunch or dinner.');
  }
  if (
    !withinBookingHours(start, query, hostZone) ||
    (!known?.inWindow && !inWindow(start, query, config, hostZone))
  ) {
    return problem(
      'hours',
      query.type === 'call'
        ? 'That time is outside the hours for calls.'
        : 'That time is outside the hours for this kind of meeting.',
    );
  }
  const hours = hoursFor(config, day);
  if (hours) {
    const opens = toInstant(day, clockMinutes(hours.from), hostZone);
    const closes = toInstant(day, clockMinutes(hours.to), hostZone);
    if (opens === null || closes === null || start < opens || end > closes) {
      return problem('hours', 'That time is outside the shorter hours set for that day.');
    }
  }

  const asked = (input.askedAt ?? now).getTime();
  if (start < asked + config.noticeHours * HOUR) {
    return problem('notice', `That time is less than ${config.noticeHours} hours ahead.`);
  }
  if (input.askedAt && start < now.getTime() + HOUR) {
    return problem('notice', 'That time is too close now.');
  }

  if (query.type === 'in_person') {
    const paused = input.inPersonPausedThrough;
    if (paused && inPersonPausedOn(day, paused)) {
      return problem('in_person_paused', inPersonPauseReason(paused, config.displayName));
    }
    if (input.travelDays.has(day)) return problem('away', 'The host is away that day.');
  }

  const links = p.linkPerDay.get(day) ?? 0;
  if (links >= config.maxLinkBookingsPerDay) {
    return problem('link_cap', `That day already has ${plural(links, 'booking')} from the link.`);
  }
  const meetings = p.meetingsPerDay.get(day) ?? 0;
  if (meetings >= config.maxMeetingsPerDay) {
    return problem('meeting_cap', `That day already has ${plural(meetings, 'meeting')}.`);
  }

  const travel = config.inPersonBufferMinutes * MINUTE;
  for (const block of p.blocks) {
    const gap = block.allDay ? 0 : Math.max(pad, block.inPerson ? travel : 0);
    if (start - gap < block.end && end + gap > block.start) {
      if (block.allDay) return problem('busy', 'That day is busy all day.');
      return block.link
        ? problem('waiting', WAITING_CLASH)
        : problem('busy', 'That time is too close to another meeting.');
    }
  }
  // Times picked for someone else: kept clear with the link's own buffer,
  // and said as busy time (never as a waiting request).
  for (const hold of p.pickBlocks) {
    if (start - pad < hold.end && end + pad > hold.start) {
      return problem('busy', 'That time is too close to another meeting.');
    }
  }

  const cooldown = Math.max(config.stackCooldownMinutes * MINUTE, pad);
  const lead = Math.max(config.stackLeadMinutes * MINUTE, pad);
  for (const run of p.runs) {
    if (start < run.end + cooldown && end + lead > run.start) {
      return problem(
        'stack',
        `That time is right after ${plural(run.count, 'meeting')} back to back.`,
      );
    }
  }

  // With a back-to-back gap wider than the buffer (Settings allows it), the
  // time itself could close a run: two meetings, a 30-minute gap, then this.
  if (config.stackGapMinutes * MINUTE > pad) {
    const candidate = { start, end, allDay: false };
    const runs = backToBackRuns([...p.blocks, candidate], config.stackGapMinutes, config.stackSize);
    const joined = runs.find((r) => r.start <= start && end <= r.end);
    if (joined) {
      return problem(
        'stack',
        `That time would make ${plural(joined.count, 'meeting')} back to back.`,
      );
    }
  }
  return null;
}

/** The reason when the time clashes with another waiting link request, not a calendar entry. */
export const WAITING_CLASH =
  'An earlier booking request is waiting for an overlapping time. Approve or decline that one first.';

/**
 * The host-zone day keys the engine walks: the days of the open months from
 * today on (none when no month is open). A month switched off is skipped
 * whole, and no count of days caps an open one (the notice still applies).
 */
export function openDays(now: Date, hostZone: string, config: BookingConfig): string[] {
  const today = localDateKey(now, hostZone);
  const last = lastOpenDay(config, today);
  if (!last) return [];
  const open = new Set(config.openMonths);
  const out: string[] = [];
  for (let day = today; day <= last; day = addDaysToKey(day, 1)) {
    if (open.has(monthOf(day))) out.push(day);
  }
  return out;
}

/**
 * A day as the public page's calendar card shows it (D-078): open (it has
 * times), fully booked (a meeting day whose times are all taken: busy, the
 * day's caps, the back-to-back rule, an earlier booking), or not offered
 * (anything else: not a meeting day, a closed month or day, inside the
 * notice, away, in person paused). Only these three words leave the server:
 * never a title, a guest, a place or why a day is closed.
 */
export type PublicDayState = 'open' | 'booked' | 'off';

const FULL_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'busy',
  'link_cap',
  'meeting_cap',
  'stack',
  'waiting',
]);

export interface OpenDayPlan {
  slots: OpenSlot[];
  /** Every day of the open months from today on (host-zone keys), with its state. */
  days: { date: string; state: PublicDayState }[];
}

/**
 * The open times and the calendar card's day states in one pass over the
 * same rules: exactly the times openSlots gives, and for each day of an open
 * month whether it is open, fully booked or not offered.
 */
export function openSlotsAndDays(input: EngineInput, query: SlotQuery): OpenDayPlan {
  const days = openDays(input.now, input.hostZone, input.config);
  if (days.length === 0) return { slots: [], days: [] };
  const open = new Set(days);
  const plans = dayPlans(input, query, days[0]!, days[days.length - 1]!).filter((p) =>
    open.has(p.date),
  );
  return {
    slots: plans.flatMap((p) => p.slots),
    days: plans.map((p) => ({
      date: p.date,
      state: p.slots.length ? 'open' : p.code && FULL_CODES.has(p.code) ? 'booked' : 'off',
    })),
  };
}

/** Every start the link may offer for this query, soonest first. */
export function openSlots(input: EngineInput, query: SlotQuery): OpenSlot[] {
  const prepared = prepare(input, query);
  const out: OpenSlot[] = [];
  for (const day of openDays(input.now, input.hostZone, input.config)) {
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
  return slotProblemDetail(input, query, start, excludeBookingId)?.text ?? null;
}

/** The same check with the rule's code: which rule refuses it, and why. */
export function slotProblemDetail(
  input: EngineInput,
  query: SlotQuery,
  start: string,
  excludeBookingId?: string,
): Problem | null {
  const at = Date.parse(start);
  if (!Number.isFinite(at)) return problem('hours', 'That time could not be read.');
  return problemFor(prepare(input, query, excludeBookingId), at);
}

/* ------------------------------------------------------- the planner's view */

/** One day for one kind of meeting: the times it offers, or why it offers none. */
export interface DayPlan {
  date: string;
  slots: OpenSlot[];
  /** Why nothing is offered, in plain words; null when something is. */
  reason: string | null;
  /** The rule behind `reason`; null when something is offered. */
  code: ReasonCode | null;
}

export type PreviewKey = 'call' | MeetingKind;

/** The kinds of meeting a preview shows, in order: a call, then each in-person kind. */
export const PREVIEW_QUERIES: { key: PreviewKey; label: string; query: SlotQuery }[] = [
  { key: 'call', label: 'Call', query: { type: 'call' } },
  ...MEETING_KINDS.map((kind) => ({
    key: kind,
    label: KIND_LABEL[kind],
    query: { type: 'in_person' as const, kind },
  })),
];

/**
 * Why a day offers nothing for a query: the reason most of its times break,
 * which for a day-wide rule (a Monday, a closed month, a day away) is every
 * one of them. A tie goes to the earliest time's reason.
 */
function dayReason(problems: readonly Problem[]): Problem {
  // By rule, not by wording: the back-to-back rule and busy time each say
  // it several ways, and a day mostly closed by one rule is said to be.
  const counts = new Map<ReasonCode, { n: number; p: Problem }>();
  for (const p of problems) {
    const seen = counts.get(p.code);
    counts.set(p.code, { n: (seen?.n ?? 0) + 1, p: seen?.p ?? p });
  }
  let best: { n: number; p: Problem } | null = null;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  return best?.p ?? problem('hours', 'No hours are set for this.');
}

/**
 * Every day from `from` to `to` (host-zone keys, inclusive) for one query,
 * through the same rules as the public page: the planner's preview and its
 * "why no times" list show exactly what a visitor would see. A day before
 * today has passed.
 */
export function dayPlans(
  input: EngineInput,
  query: SlotQuery,
  from: string,
  to: string,
): DayPlan[] {
  const prepared = prepare(input, query);
  const today = localDateKey(input.now, input.hostZone);
  const out: DayPlan[] = [];
  for (let day = from; day <= to; day = addDaysToKey(day, 1)) {
    if (day < today) {
      out.push({ date: day, slots: [], reason: 'That day has passed.', code: 'past' });
      continue;
    }
    const starts = candidateStarts(day, query, input.config, input.hostZone);
    const slots: OpenSlot[] = [];
    const problems: Problem[] = [];
    const known = { day, inWindow: true as const };
    for (const start of starts) {
      const found = problemFor(prepared, start, known);
      if (found === null) {
        slots.push({
          start: new Date(start).toISOString(),
          end: new Date(start + prepared.minutes * MINUTE).toISOString(),
          date: day,
        });
      } else {
        problems.push(found);
      }
    }
    if (starts.length === 0) {
      const weekday = weekdayOf(day);
      problems.push(
        !(ALLOWED_WEEKDAYS as readonly number[]).includes(weekday)
          ? problem('weekday', 'Meetings are only on Tuesday, Wednesday and Thursday.')
          : problem(
              'hours',
              query.type === 'call'
                ? 'No hours are set for calls.'
                : `No hours are set for ${query.kind ? KIND_LABEL[query.kind].toLowerCase() : 'this'}.`,
            ),
      );
    }
    const why = slots.length ? null : dayReason(problems);
    out.push({ date: day, slots, reason: why?.text ?? null, code: why?.code ?? null });
  }
  return out;
}
