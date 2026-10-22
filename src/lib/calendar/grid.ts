import { addDaysToKey, localClock, localDateKey, wallTimeToUtc } from '@/lib/util/time';
import type { CalendarViewKind, RangeEvent } from './range-types';

/**
 * The arithmetic behind the Day, Week and Month views, kept pure so it can
 * be tested apart from the page: which days a view shows, where an event sits
 * on the time grid, how overlapping events share a column the way Google
 * Calendar lays them out, and how a month week packs its bars with "+N more".
 *
 * Weeks start on Sunday, Google Calendar's default in the US. Every date is a
 * `YYYY-MM-DD` key in the profile's time zone, so a day is the profile's day
 * whatever zone the browser or the server is in.
 */

export const MINUTES_PER_DAY = 24 * 60;
export const SNAP_MINUTES = 15;
/** The shortest an event is drawn (and counted for overlaps), as Google does. */
export const MIN_DRAWN_MINUTES = 20;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

/** 0 for Sunday to 6 for Saturday. */
export function weekdayOf(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

export function weekStartOf(dateKey: string): string {
  return addDaysToKey(dateKey, -weekdayOf(dateKey));
}

export function monthStartOf(dateKey: string): string {
  return `${dateKey.slice(0, 7)}-01`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The same day of the month `delta` months away, clamped (Jan 31 + 1 month is Feb 28). */
export function addMonthsToKey(dateKey: string, delta: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const index = y! * 12 + (m! - 1) + delta;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const day = Math.min(d!, daysInMonth(year, month));
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Every day key from `from` up to (not including) `to`. */
export function daysBetweenKeys(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d < to && out.length < 400; d = addDaysToKey(d, 1)) out.push(d);
  return out;
}

export interface ViewRange {
  /** First day shown. */
  from: string;
  /** The day after the last one shown. */
  to: string;
  days: string[];
}

/**
 * The days a view shows around a date: the day itself, its Sunday-to-Saturday
 * week, or the whole weeks that cover its month (four to six of them).
 */
export function viewRange(view: CalendarViewKind, dateKey: string): ViewRange {
  if (view === 'day') {
    return { from: dateKey, to: addDaysToKey(dateKey, 1), days: [dateKey] };
  }
  if (view === 'week') {
    const from = weekStartOf(dateKey);
    const to = addDaysToKey(from, 7);
    return { from, to, days: daysBetweenKeys(from, to) };
  }
  const first = monthStartOf(dateKey);
  const [y, m] = first.split('-').map(Number);
  const last = `${first.slice(0, 8)}${String(daysInMonth(y!, m!)).padStart(2, '0')}`;
  const from = weekStartOf(first);
  const to = addDaysToKey(weekStartOf(last), 7);
  return { from, to, days: daysBetweenKeys(from, to) };
}

/** The date one step back or ahead: a day, a week or a month. */
export function stepDate(view: CalendarViewKind, dateKey: string, delta: number): string {
  if (view === 'day') return addDaysToKey(dateKey, delta);
  if (view === 'week') return addDaysToKey(dateKey, delta * 7);
  return addMonthsToKey(dateKey, delta);
}

/** The month weeks of a month view, seven day keys each. */
export function monthWeeks(dateKey: string): string[][] {
  const { days } = viewRange('month', dateKey);
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

const utcNoon = (dateKey: string) => new Date(`${dateKey}T12:00:00Z`);

function fmt(dateKey: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(utcNoon(dateKey));
}

/** "October 2026", "Oct 18 – 24, 2026", "Wednesday, October 21, 2026". */
export function rangeLabel(view: CalendarViewKind, dateKey: string): string {
  if (view === 'day') {
    return fmt(dateKey, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }
  if (view === 'month') return fmt(dateKey, { month: 'long', year: 'numeric' });
  const { from, to } = viewRange('week', dateKey);
  const last = addDaysToKey(to, -1);
  const sameYear = from.slice(0, 4) === last.slice(0, 4);
  const sameMonth = sameYear && from.slice(0, 7) === last.slice(0, 7);
  const start = fmt(from, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  const end = sameMonth
    ? `${Number(last.slice(8))}, ${last.slice(0, 4)}`
    : fmt(last, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${start} – ${end}`;
}

export function weekdayShort(dateKey: string): string {
  return fmt(dateKey, { weekday: 'short' });
}

export function dayNumber(dateKey: string): number {
  return Number(dateKey.slice(8));
}

/** "9 AM", "12 PM": the hour gutter. */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "9:30", "10am"-style short times for a grid chip, in the profile's zone. */
export function shortTime(instant: string | number | Date, timeZone: string): string {
  const d = instant instanceof Date ? instant : new Date(instant);
  const { hour, minute } = localClock(d, timeZone);
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour < 12 ? 'am' : 'pm';
  return minute === 0
    ? `${twelve}${suffix}`
    : `${twelve}:${String(minute).padStart(2, '0')}${suffix}`;
}

/* ------------------------------------------------------------ time grid */

/**
 * Minutes past local midnight of `dateKey` at which `instant` falls, clamped
 * to the day: 0 if it is earlier, 1440 if later. Wall-clock minutes, so a 9am
 * event sits on the 9am line on the days the clocks change too.
 */
export function minutesIntoDay(instant: number, dateKey: string, timeZone: string): number {
  const clock = localClock(new Date(instant), timeZone);
  if (clock.dateKey < dateKey) return 0;
  if (clock.dateKey > dateKey) return MINUTES_PER_DAY;
  return clock.hour * 60 + clock.minute;
}

/** The instant a wall-clock minute of a day reads in the zone (1440 is next midnight). */
export function instantAt(dateKey: string, minutes: number, timeZone: string): Date {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY, Math.round(minutes)));
  if (clamped === MINUTES_PER_DAY) {
    return instantAt(addDaysToKey(dateKey, 1), 0, timeZone);
  }
  const at = wallTimeToUtc(dateKey, Math.floor(clamped / 60), clamped % 60, timeZone);
  // A wall time the clocks skip (2:30am on the spring change): an hour later.
  return at ?? new Date(instantAt(dateKey, clamped + 60, timeZone).getTime() - 3_600_000);
}

export function snap(minutes: number, step = SNAP_MINUTES): number {
  return Math.round(minutes / step) * step;
}

/** A timed event that runs 24 hours or more sits in the all-day row, as in Google. */
export function isLongTimed(event: Pick<RangeEvent, 'allDay' | 'startsAt' | 'endsAt'>): boolean {
  if (event.allDay || !event.startsAt || !event.endsAt) return false;
  return Date.parse(event.endsAt) - Date.parse(event.startsAt) >= 24 * 3_600_000;
}

/** In the all-day row (or a month bar) rather than on the time grid. */
export function inAllDayRow(event: Pick<RangeEvent, 'allDay' | 'startsAt' | 'endsAt'>): boolean {
  return event.allDay || isLongTimed(event);
}

/**
 * The days an event covers, `[startKey, endKey)`, in the profile's zone. An
 * all-day event keeps its own dates; a timed one covers each day it touches
 * (an event ending at midnight does not touch the next day).
 */
export function daySpan(
  event: Pick<RangeEvent, 'allDay' | 'startsAt' | 'endsAt' | 'startDate' | 'endDate'>,
  timeZone: string,
): { startKey: string; endKey: string } | null {
  if (event.allDay) {
    if (!event.startDate) return null;
    const endKey =
      event.endDate && event.endDate > event.startDate
        ? event.endDate
        : addDaysToKey(event.startDate, 1);
    return { startKey: event.startDate, endKey };
  }
  if (!event.startsAt) return null;
  const start = Date.parse(event.startsAt);
  const end = event.endsAt ? Math.max(start, Date.parse(event.endsAt)) : start;
  const startKey = localDateKey(new Date(start), timeZone);
  const lastKey = end > start ? localDateKey(new Date(end - 1), timeZone) : startKey;
  return { startKey, endKey: addDaysToKey(lastKey, 1) };
}

export function coversDay(span: { startKey: string; endKey: string }, dateKey: string): boolean {
  return span.startKey <= dateKey && dateKey < span.endKey;
}

/** Where a timed event sits on one day's column, in minutes; null if not on that day. */
export function segmentOnDay(
  event: Pick<RangeEvent, 'startsAt' | 'endsAt'>,
  dateKey: string,
  timeZone: string,
): { start: number; end: number } | null {
  if (!event.startsAt) return null;
  const startMs = Date.parse(event.startsAt);
  const endMs = event.endsAt ? Math.max(startMs, Date.parse(event.endsAt)) : startMs;
  const start = minutesIntoDay(startMs, dateKey, timeZone);
  const end = minutesIntoDay(endMs, dateKey, timeZone);
  const startDay = localDateKey(new Date(startMs), timeZone);
  if (startDay > dateKey) return null;
  // Started on an earlier day and over by this day's midnight: not on this day.
  if (startDay < dateKey && end === 0) return null;
  return { start, end: Math.max(end, start) };
}

export interface LayoutItem {
  key: string;
  start: number;
  end: number;
}

export interface Placement {
  /** Column within its group of overlapping events, from 0. */
  col: number;
  /** Columns in that group. */
  cols: number;
  /** Columns it stretches across (into free ones to its right), at least 1. */
  span: number;
}

const overlaps = (a: LayoutItem, b: LayoutItem) => a.start < b.end && b.start < a.end;

/**
 * Overlapping events side by side, the way Google Calendar draws them: events
 * that overlap (directly or through a chain) form a group; each takes the
 * first column free at its start, earlier and longer events first; the group
 * shares the width evenly; and an event stretches right across any column
 * with nothing overlapping it. Very short events count as MIN_DRAWN_MINUTES,
 * since that is how much room they take on screen.
 */
export function layoutColumns(
  items: readonly LayoutItem[],
  minDuration = MIN_DRAWN_MINUTES,
): Map<string, Placement> {
  const sorted = items
    .map((i) => ({ ...i, end: Math.max(i.end, i.start + minDuration) }))
    .sort((a, b) => a.start - b.start || b.end - a.end || a.key.localeCompare(b.key));
  const out = new Map<string, Placement>();

  let group: (LayoutItem & { col: number })[] = [];
  let columnsEnd: number[] = [];
  let groupEnd = -Infinity;

  const flush = () => {
    const cols = columnsEnd.length;
    for (const item of group) {
      let span = 1;
      for (let c = item.col + 1; c < cols; c++) {
        const blocked = group.some((other) => other.col === c && overlaps(item, other));
        if (blocked) break;
        span++;
      }
      out.set(item.key, { col: item.col, cols, span });
    }
    group = [];
    columnsEnd = [];
    groupEnd = -Infinity;
  };

  for (const item of sorted) {
    if (item.start >= groupEnd) flush();
    let col = columnsEnd.findIndex((end) => end <= item.start);
    if (col < 0) {
      col = columnsEnd.length;
      columnsEnd.push(item.end);
    } else {
      columnsEnd[col] = item.end;
    }
    group.push({ ...item, col });
    groupEnd = Math.max(groupEnd, item.end);
  }
  flush();
  return out;
}

/* ------------------------------------------- overlaps, as Google draws them */

/**
 * Events that start less than this far apart share the width side by side;
 * one that starts later is drawn over the earlier one instead, shifted right.
 * Roughly the height of a chip's title, so the earlier title stays readable.
 */
export const SIDE_BY_SIDE_MINUTES = 45;
/** The narrowest an event is drawn on a computer, in px: more than fit fold into "+N". */
export const MIN_CHIP_PX = 36;
/**
 * How far under the minimum a chip may be drawn so that a column a hair too
 * narrow still takes one more side by side, in px per chip (D-072). Columns
 * are measured to fractions of a pixel: at 1440px a Week column is about
 * 116.9px with its border, 115.86px inside, about 1.1px short of three 39px
 * slots (36px and the 3px gap), so three meetings starting together drew one
 * chip and a "+2". With half a pixel each (1.5px across three) they fit,
 * each about 35.6px; a column shorter than that still folds, and a cascade
 * still stops at the minimum itself.
 */
export const MIN_CHIP_TOLERANCE_PX = 0.5;

/** How far a cascaded event sits right of the one beneath it: a tenth of the column, 6 to 40px. */
export function cascadeIndentPx(columnPx: number): number {
  return Math.round(Math.max(6, Math.min(40, columnPx * 0.1)));
}

export interface OverlapOptions {
  /** The day column's width in px. */
  columnPx: number;
  /** The narrowest a chip may be drawn, in px (MIN_CHIP_PX by default). */
  minChipPx?: number;
  /** How far under `minChipPx` a chip may be drawn to fit one more side by side (MIN_CHIP_TOLERANCE_PX). */
  tolerancePx?: number;
  /** How far a cascaded event is shifted right, in px (cascadeIndentPx by default). */
  indentPx?: number;
  sideBySideMinutes?: number;
  minDuration?: number;
}

export interface ChipPlacement {
  /** Left edge and width, as fractions of the day column. */
  left: number;
  width: number;
  /** Stacking order, from 1: an event that starts later is drawn on top. */
  z: number;
  /** How many events it sits on top of in a cascade: 0 for none. */
  depth: number;
  /** Drawn over an earlier event, so it gets a thin outline in the page's colour. */
  cascaded: boolean;
}

/** Events with no room left beside the others, shown as one "+N" that lists them. */
export interface FoldedChips {
  key: string;
  /** The events folded away, earliest first. */
  keys: string[];
  /** Minutes past midnight the "+N" covers: its events' earliest start to latest end. */
  start: number;
  end: number;
  left: number;
  width: number;
  z: number;
}

export interface OverlapLayout {
  chips: Map<string, ChipPlacement>;
  folds: FoldedChips[];
}

/**
 * Where each timed event of a day goes, the way Google Calendar lays out a
 * busy day:
 *
 * - Events that overlap and start less than `sideBySideMinutes` apart (and
 *   any chained to them that way) form a row and share the width side by
 *   side (layoutColumns within the row).
 * - A row that starts later than events already drawn beneath it cascades:
 *   it is drawn on top of the topmost of them, shifted right by an indent,
 *   and runs to the column's right edge. A long block (a conference day,
 *   travel, a hold) therefore never squeezes a short meeting into a sliver:
 *   the meeting sits over it, nearly full width.
 * - No chip is narrower than `minChipPx` (side by side, up to `tolerancePx`
 *   less, so a column a hair too narrow still takes one more): a cascade too
 *   deep moves left again; a row with more side-by-side events than fit
 *   shows what fits and folds the rest into a "+N" in the last slot.
 *
 * Later starts are drawn on top. Every event is either placed or in exactly
 * one fold, and the result does not depend on the order the events come in.
 */
export function layoutOverlaps(
  items: readonly LayoutItem[],
  options: OverlapOptions,
): OverlapLayout {
  const near = options.sideBySideMinutes ?? SIDE_BY_SIDE_MINUTES;
  const minDuration = options.minDuration ?? MIN_DRAWN_MINUTES;
  const columnPx = Math.max(1, options.columnPx);
  const minPx = Math.max(1, options.minChipPx ?? MIN_CHIP_PX);
  const minFrac = Math.min(1, minPx / columnPx);
  const indent = (options.indentPx ?? cascadeIndentPx(columnPx)) / columnPx;
  // How many fit side by side: each may be up to the tolerance under the minimum.
  const tolerancePx = Math.min(
    minPx / 2,
    Math.max(0, options.tolerancePx ?? MIN_CHIP_TOLERANCE_PX),
  );
  const maxCols = Math.max(1, Math.floor(columnPx / (minPx - tolerancePx) + 1e-9));

  const seen = new Set<string>();
  const sorted = items
    .filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)))
    .map((i) => ({ key: i.key, start: i.start, end: Math.max(i.end, i.start + minDuration) }))
    .sort((a, b) => a.start - b.start || b.end - a.end || a.key.localeCompare(b.key));
  const chips = new Map<string, ChipPlacement>();
  const folds: FoldedChips[] = [];

  // Rows: events joined by "overlaps and starts close by", through any chain.
  const root = sorted.map((_, i) => i);
  const find = (i: number): number => {
    while (root[i] !== i) {
      root[i] = root[root[i]!]!;
      i = root[i]!;
    }
    return i;
  };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      // Sorted by start: once one starts too late, every one after it does.
      if (sorted[j]!.start - sorted[i]!.start >= near) break;
      if (sorted[j]!.start < sorted[i]!.end) {
        const a = find(i);
        const b = find(j);
        if (a !== b) root[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  const rows = new Map<number, number[]>();
  sorted.forEach((_, i) => {
    const r = find(i);
    rows.set(r, [...(rows.get(r) ?? []), i]);
  });

  // What is drawn so far, for the rows that cascade over it.
  const drawn: { start: number; end: number; left: number; depth: number }[] = [];
  const overlapsSpan = (a: { start: number; end: number }, b: { start: number; end: number }) =>
    a.start < b.end && b.start < a.end;

  for (const leader of [...rows.keys()].sort((a, b) => a - b)) {
    const indexes = rows.get(leader)!;
    const members = indexes.map((i) => sorted[i]!);
    const columns = layoutColumns(members, 0);
    const cols = columns.get(members[0]!.key)?.cols ?? 1;

    let base = 0;
    let depth = 0;
    const under = drawn.filter((d) => members.some((m) => overlapsSpan(m, d)));
    if (under.length) {
      // On top of the topmost event beneath it; of equals, the leftmost, so it stays wide.
      const top = under.reduce((best, d) =>
        d.depth > best.depth || (d.depth === best.depth && d.left < best.left) ? d : best,
      );
      depth = top.depth + 1;
      base = top.left + indent;
    }
    const shown = Math.min(cols, maxCols);
    base = Math.max(0, Math.min(base, 1 - shown * minFrac));
    const colWidth = (1 - base) / shown;
    // With more columns than fit, the last slot holds the "+N".
    const chipCols = cols > maxCols ? shown - 1 : shown;

    const hidden = members.filter((m) => columns.get(m.key)!.col >= chipCols);
    members.forEach((m, n) => {
      const place = columns.get(m.key)!;
      if (place.col >= chipCols) return;
      let endCol = Math.min(place.col + place.span, shown);
      if (endCol > chipCols && hidden.some((h) => overlapsSpan(h, m))) endCol = chipCols;
      const left = base + place.col * colWidth;
      chips.set(m.key, {
        left,
        width: (endCol - place.col) * colWidth,
        z: indexes[n]! + 1,
        depth,
        cascaded: depth > 0,
      });
      drawn.push({ start: m.start, end: m.end, left, depth });
    });

    // The folded events, one "+N" per stretch of them that overlaps; one on
    // its own in a stretch has the slot to itself, so it is drawn there.
    let group: typeof hidden = [];
    let groupEnd = -Infinity;
    const flush = () => {
      if (!group.length) return;
      const left = base + chipCols * colWidth;
      const start = group[0]!.start;
      const z = Math.max(...group.map((g) => sorted.indexOf(g))) + 1;
      if (group.length === 1) {
        chips.set(group[0]!.key, { left, width: colWidth, z, depth, cascaded: depth > 0 });
      } else {
        folds.push({
          key: `fold-${group[0]!.key}`,
          keys: group.map((g) => g.key),
          start,
          end: groupEnd,
          left,
          width: colWidth,
          z,
        });
      }
      drawn.push({ start, end: groupEnd, left, depth });
      group = [];
      groupEnd = -Infinity;
    };
    for (const h of hidden) {
      if (h.start >= groupEnd) flush();
      group.push(h);
      groupEnd = Math.max(groupEnd, h.end);
    }
    flush();
  }
  return { chips, folds };
}

/* ---------------------------------------------------------- month weeks */

export interface PackItem {
  key: string;
  startKey: string;
  /** Exclusive. */
  endKey: string;
  allDay: boolean;
  /** Start instant (ms) for timed events, 0 for all-day; orders a day's events. */
  startMs: number;
  title: string;
}

export interface PackSegment {
  key: string;
  lane: number;
  /** First and last column (0 to 6) this piece covers, inclusive. */
  startCol: number;
  endCol: number;
  /** The event goes on past this piece's left or right edge. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface PackedWeek {
  segments: PackSegment[];
  /** Per day with more events than fit: how many are hidden, and which. */
  more: { col: number; count: number; keys: string[] }[];
  /** Lanes drawn, at most maxLanes. */
  lanes: number;
}

/**
 * One week row of the month view (or the week view's all-day row): each
 * event takes the lowest lane free on all of its days in the week, longer
 * events first, then all-day before timed, then by start time, as Google
 * Calendar packs them. A day with more than `maxLanes` lanes in use shows
 * `maxLanes - 1` of them and a "+N more" in the last; an event hidden on some
 * of its days is drawn in pieces on the days where it shows.
 */
export function packWeek(
  items: readonly PackItem[],
  days: readonly string[],
  maxLanes: number,
): PackedWeek {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last || maxLanes < 1) return { segments: [], more: [], lanes: 0 };
  const lastExclusive = addDaysToKey(last, 1);
  const col = (key: string) => days.indexOf(key);

  const inWeek = items
    .filter((i) => i.startKey < lastExclusive && i.endKey > first)
    .map((i) => {
      const s = i.startKey < first ? 0 : col(i.startKey);
      const lastDay = addDaysToKey(i.endKey, -1);
      const e = lastDay > last ? days.length - 1 : col(lastDay);
      return { item: i, s, e };
    })
    .filter((p) => p.s >= 0 && p.e >= p.s)
    .sort(
      (a, b) =>
        a.s - b.s ||
        b.e - b.s - (a.e - a.s) ||
        Number(b.item.allDay) - Number(a.item.allDay) ||
        a.item.startMs - b.item.startMs ||
        a.item.title.localeCompare(b.item.title) ||
        a.item.key.localeCompare(b.item.key),
    );

  const used: boolean[][] = [];
  const placed: { item: PackItem; s: number; e: number; lane: number }[] = [];
  for (const p of inWeek) {
    let lane = 0;
    for (; ; lane++) {
      const row = (used[lane] ??= Array.from({ length: days.length }, () => false));
      let free = true;
      for (let c = p.s; c <= p.e; c++) if (row[c]) free = false;
      if (free) {
        for (let c = p.s; c <= p.e; c++) row[c] = true;
        break;
      }
    }
    placed.push({ ...p, lane });
  }

  // Per day: how many lanes it needs, and so how many it can show.
  const limit = days.map((_, c) => {
    const lanesHere = placed.filter((p) => p.s <= c && c <= p.e).map((p) => p.lane);
    const needed = lanesHere.length ? Math.max(...lanesHere) + 1 : 0;
    return needed <= maxLanes ? maxLanes : maxLanes - 1;
  });

  const segments: PackSegment[] = [];
  for (const p of placed) {
    let runStart = -1;
    for (let c = p.s; c <= p.e + 1; c++) {
      const visible = c <= p.e && p.lane < limit[c]!;
      if (visible && runStart < 0) runStart = c;
      if (!visible && runStart >= 0) {
        const runEnd = c - 1;
        segments.push({
          key: p.item.key,
          lane: p.lane,
          startCol: runStart,
          endCol: runEnd,
          continuesBefore: runStart > p.s || p.item.startKey < first,
          continuesAfter: runEnd < p.e || addDaysToKey(p.item.endKey, -1) > last,
        });
        runStart = -1;
      }
    }
  }

  const more = days.flatMap((_, c) => {
    const hidden = placed.filter((p) => p.s <= c && c <= p.e && p.lane >= limit[c]!);
    return hidden.length
      ? [{ col: c, count: hidden.length, keys: hidden.map((p) => p.item.key) }]
      : [];
  });

  const lanes = Math.min(maxLanes, placed.length ? Math.max(...placed.map((p) => p.lane)) + 1 : 0);
  return { segments, more, lanes };
}

/** A RangeEvent as a month-view item, or null if it has no usable dates. */
export function packItemOf(event: RangeEvent, timeZone: string): PackItem | null {
  const span = daySpan(event, timeZone);
  if (!span) return null;
  return {
    key: event.key,
    startKey: span.startKey,
    endKey: span.endKey,
    allDay: inAllDayRow(event),
    startMs: event.startsAt ? Date.parse(event.startsAt) : 0,
    title: event.title,
  };
}
