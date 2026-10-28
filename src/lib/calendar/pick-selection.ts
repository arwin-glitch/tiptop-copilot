import {
  MAX_PICK_DAYS_AHEAD,
  MAX_PICK_RANGES,
  mergeRanges,
  PICK_SNAP_MINUTES,
  spansOverlap,
  type PickRange,
} from '@/lib/booking/picks';
import { zoneShortName } from '@/lib/booking/picks-format';
import { dayLabel, distinctZones, timeLabel } from '@/lib/booking/public';
import { localDateKey, SUPPORTED_TIMEZONES } from '@/lib/util/time';
import type { RangeEvent } from './range-types';
import { inAllDayRow, instantAt, MINUTES_PER_DAY, segmentOnDay } from './grid';

/**
 * The Calendar's "Pick times" selection, as pure steps the grid and the pick
 * panel share (components/calendar/pick-panel.tsx). Nick clicks or drags on
 * the Day or Week grid; each range lands here, is kept on the 15-minute grid,
 * never in the past, never more than 60 days ahead, never overlapping
 * another (touching or overlapping ones merge), and at most 20 of them. The
 * server checks the same rules again (lib/booking/picks.ts).
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SNAP = PICK_SNAP_MINUTES * MINUTE;

export type PickStep = { ok: true; ranges: PickRange[] } | { ok: false; problem: string };

/** Minutes floored to the 15-minute grid. */
export function floorToSnap(minutes: number): number {
  return Math.floor(minutes / PICK_SNAP_MINUTES) * PICK_SNAP_MINUTES;
}

/**
 * A click on empty time: a range as long as the meeting from the 15-minute
 * mark at or before the click, moved earlier when it would run past midnight.
 */
export function clickedRange(
  day: string,
  minutes: number,
  durationMinutes: number,
  timeZone: string,
): PickRange {
  const length = Math.min(MINUTES_PER_DAY, durationMinutes);
  const start = Math.min(MINUTES_PER_DAY - length, floorToSnap(minutes));
  return {
    start: instantAt(day, start, timeZone).toISOString(),
    end: instantAt(day, start + length, timeZone).toISOString(),
  };
}

/**
 * A drag across empty time: the minutes between where it began and ended,
 * each rounded to the 15-minute grid, at least 15 minutes, and stretched to
 * the meeting's length (a slot shorter than the meeting offers nothing).
 */
export function draggedRange(
  day: string,
  anchor: number,
  current: number,
  durationMinutes: number,
  timeZone: string,
): PickRange {
  const round = (m: number) => Math.round(m / PICK_SNAP_MINUTES) * PICK_SNAP_MINUTES;
  let a = round(Math.min(anchor, current));
  let b = round(Math.max(anchor, current));
  if (b - a < durationMinutes) b = a + durationMinutes;
  if (b > MINUTES_PER_DAY) {
    b = MINUTES_PER_DAY;
    a = Math.max(0, Math.min(a, b - durationMinutes));
  }
  return {
    start: instantAt(day, a, timeZone).toISOString(),
    end: instantAt(day, b, timeZone).toISOString(),
  };
}

/** The first 15-minute mark after `now`. */
function nextSnapAfter(now: number): number {
  return Math.floor(now / SNAP) * SNAP + SNAP;
}

/**
 * A range kept to the future: one that has ended is dropped, and one under
 * way starts at the next 15-minute mark instead. What is left must still fit
 * the meeting (`durationMinutes`, at least 15): a shorter part is dropped,
 * never kept, as it would offer nothing.
 */
export function futurePart(
  range: PickRange,
  now: Date,
  durationMinutes: number = PICK_SNAP_MINUTES,
): PickRange | null {
  const start = Date.parse(range.start);
  const end = Date.parse(range.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const from = start > now.getTime() ? start : nextSnapAfter(now.getTime());
  if (end - from < Math.max(SNAP, durationMinutes * MINUTE)) return null;
  return { start: new Date(from).toISOString(), end: new Date(end).toISOString() };
}

/** The picked ranges still ahead of `now` that fit the meeting (futurePart), merged. */
export function freshRanges(
  ranges: readonly PickRange[],
  now: Date,
  durationMinutes: number = PICK_SNAP_MINUTES,
): PickRange[] {
  return mergeRanges(
    ranges.map((r) => futurePart(r, now, durationMinutes)).filter((r): r is PickRange => !!r),
  );
}

/**
 * A new range kept whole: one that has already begun moves, all of it, to
 * the next 15-minute mark (a click at 10:05 at 10:07 picks 10:15 to 10:45,
 * never a stub of 10:15 to 10:30). Null when it has ended.
 */
function shiftedAhead(range: PickRange, now: Date): PickRange | null {
  const start = Date.parse(range.start);
  const end = Date.parse(range.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (start > now.getTime()) return range;
  if (end <= now.getTime()) return null;
  const from = nextSnapAfter(now.getTime());
  return {
    start: new Date(from).toISOString(),
    end: new Date(from + (end - start)).toISOString(),
  };
}

/**
 * The selection with one more range: kept to the future (moved whole when it
 * has begun), within 60 days, merged with any it touches, and at most 20 in
 * all. Else the reason in plain words, and the selection stays as it was.
 */
export function addPickRange(ranges: readonly PickRange[], range: PickRange, now: Date): PickStep {
  const part = shiftedAhead(range, now);
  if (!part) return { ok: false, problem: 'That time has already passed.' };
  if (Date.parse(part.end) > now.getTime() + MAX_PICK_DAYS_AHEAD * DAY) {
    return { ok: false, problem: `Pick times within the next ${MAX_PICK_DAYS_AHEAD} days.` };
  }
  const merged = mergeRanges([...ranges, part]);
  if (merged.length > MAX_PICK_RANGES) {
    return { ok: false, problem: `Pick at most ${MAX_PICK_RANGES} times.` };
  }
  return { ok: true, ranges: merged };
}

/**
 * The selection after the meeting's length grows: each range shorter than
 * the meeting is stretched at its end to fit it, then merged with any it now
 * touches, so a longer length never leaves times that offer nothing.
 */
export function stretchRanges(ranges: readonly PickRange[], durationMinutes: number): PickRange[] {
  const length = durationMinutes * MINUTE;
  return mergeRanges(
    ranges.map((r) => {
      const start = Date.parse(r.start);
      const end = Date.parse(r.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end - start >= length) return r;
      return { start: r.start, end: new Date(start + length).toISOString() };
    }),
  );
}

/** The selection without the range that starts at `start`. */
export function removePickRange(ranges: readonly PickRange[], start: string): PickRange[] {
  const at = Date.parse(start);
  return ranges.filter((r) => Date.parse(r.start) !== at);
}

/** The picked range under an instant, if any (a click on it removes it). */
export function pickRangeAt(ranges: readonly PickRange[], at: number): PickRange | null {
  return ranges.find((r) => Date.parse(r.start) <= at && at < Date.parse(r.end)) ?? null;
}

/**
 * Whether an event on the grid takes Nick's time, for the panel's warning
 * dot: timed, not marked free, not declined. All-day entries and events over
 * a day long are left out, as they are on most calendars' free/busy.
 */
export function takesTime(event: RangeEvent): boolean {
  return (
    !inAllDayRow(event) &&
    Boolean(event.startsAt && event.endsAt) &&
    !event.transparent &&
    event.myResponse !== 'declined'
  );
}

/** The events (that take time) a picked range overlaps. */
export function busyOverlaps(range: PickRange, events: readonly RangeEvent[]): RangeEvent[] {
  const span = { start: Date.parse(range.start), end: Date.parse(range.end) };
  return events.filter(
    (e) =>
      takesTime(e) &&
      spansOverlap(span, { start: Date.parse(e.startsAt!), end: Date.parse(e.endsAt!) }),
  );
}

/** A picked range's key, for remembering what it overlapped. */
export function pickRangeKey(range: PickRange): string {
  return `${range.start}|${range.end}`;
}

/**
 * What each picked range was seen to overlap (event titles), kept while
 * Nick moves to weeks where those events are not loaded: picked times keep
 * their warning when they are off screen.
 */
export type BusyMemory = Readonly<Record<string, readonly string[]>>;

/** Whether the events loaded (day keys `from` to `to`, `to` exclusive) cover a range's days. */
export function rangeLoaded(
  range: PickRange,
  loaded: { from: string; to: string } | null,
  timeZone: string,
): boolean {
  if (!loaded) return false;
  const first = localDateKey(new Date(range.start), timeZone);
  const last = localDateKey(new Date(Date.parse(range.end) - 1), timeZone);
  return first >= loaded.from && last < loaded.to;
}

/**
 * The memory brought up to date: ranges whose days are loaded are checked
 * against those events again; the others keep what was seen last. Ranges
 * no longer picked are forgotten. The same object back when nothing changed
 * (so a render can compare it and stop).
 */
export function rememberBusy(
  memory: BusyMemory,
  ranges: readonly PickRange[],
  events: readonly RangeEvent[],
  loaded: { from: string; to: string } | null,
  timeZone: string,
): BusyMemory {
  const next: Record<string, readonly string[]> = {};
  for (const r of ranges) {
    const key = pickRangeKey(r);
    next[key] = rangeLoaded(r, loaded, timeZone)
      ? busyOverlaps(r, events).map((e) => e.title || '(No title)')
      : (memory[key] ?? []);
  }
  const before = Object.keys(memory);
  const same =
    before.length === Object.keys(next).length &&
    before.every((k) => {
      const a = memory[k];
      const b = next[k];
      return !!a && !!b && a.length === b.length && a.every((t, i) => t === b[i]);
    });
  return same ? memory : next;
}

/** A sent pick still holding time, as the Calendar draws it. */
export interface HeldRange {
  start: string;
  end: string;
  /** Who it was picked for, or null. */
  name: string | null;
}

/**
 * Who already holds a picked range, or null: the first open pick holding an
 * overlapping time. Its times are not offered to a new pick (an older pick
 * always comes first), so the panel warns before Copy.
 */
export function heldOverlap(range: PickRange, held: readonly HeldRange[]): HeldRange | null {
  const span = { start: Date.parse(range.start), end: Date.parse(range.end) };
  return (
    held.find((h) => spansOverlap(span, { start: Date.parse(h.start), end: Date.parse(h.end) })) ??
    null
  );
}

/** One picked range as a grid column draws it: minutes past that day's midnight. */
export function rangeOnDay(
  range: PickRange,
  day: string,
  timeZone: string,
): { start: number; end: number } | null {
  const seg = segmentOnDay({ startsAt: range.start, endsAt: range.end }, day, timeZone);
  return seg && seg.end > seg.start ? seg : null;
}

/**
 * The panel's first choice for "Their time zone": Nick's own when the list
 * has it, else a listed zone with the same name ("Central Time"), else the
 * first listed.
 */
export function defaultPickZone(hostZone: string): string {
  const listed = SUPPORTED_TIMEZONES as readonly string[];
  if (listed.includes(hostZone)) return hostZone;
  let name: string;
  try {
    name = zoneShortName(hostZone);
  } catch {
    return listed[0]!;
  }
  return listed.find((z) => zoneShortName(z) === name) ?? listed[0]!;
}

/** The zones "Their time zone" offers: the listed ones, each name once, Nick's first. */
export function pickZoneOptions(hostZone: string): string[] {
  return distinctZones([defaultPickZone(hostZone), ...SUPPORTED_TIMEZONES]);
}

/**
 * When a pick stops holding, in Nick's zone: "Thu 3:00 PM" within the week,
 * "Wed, Nov 4, 3:00 PM" from six days out (a week's hold would otherwise
 * read like today).
 */
export function holdUntilLabel(iso: string, zone: string, nowMs: number): string {
  if (Date.parse(iso) - nowMs >= 6 * DAY) return `${dayLabel(iso, zone)}, ${timeLabel(iso, zone)}`;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}
