import { addDaysToKey } from '@/lib/util/time';
import type { BookingConfig, TimeWindow } from './config';

/**
 * How far ahead the link may ever be opened (D-078): this month and the next
 * eleven, never more. The Booking tab's month strip shows all twelve, each
 * its own switch.
 */
export const MAX_MONTHS_AHEAD = 11;

/**
 * The booking link's month planner (D-078), as pure data: which months the
 * link is open for, which days are closed, and which days have shorter
 * hours. The Booking tab's Availability planner edits these; the slot engine
 * (lib/booking/engine.ts) reads them. Rules always win: nothing here can
 * open a day the standing rules close (a Monday, a day inside the notice, a
 * day away), it can only close more or shorten hours.
 *
 * Months are switched on one by one (Arwin: "options to turn on schedules
 * for a specific month freely"): `openMonths` lists the months the link
 * offers, any of this month and the next MAX_MONTHS_AHEAD, in any mix (only
 * December; January and March). A month not on the list offers nothing.
 * With nothing saved yet, this month and the next are open.
 *
 * Days and months are host-zone keys (`YYYY-MM-DD`, `YYYY-MM`), compared as
 * strings, so no clock is read here.
 */

export type PlannerConfig = Pick<
  BookingConfig,
  'openMonths' | 'closedDates' | 'closedRanges' | 'dateHours'
>;

const MONTH_SHAPE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `YYYY-MM` of a day key. */
export function monthOf(dateKey: string): string {
  return dateKey.slice(0, 7);
}

/** A month key moved by `n` months. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + n;
  const year = Math.floor(index / 12);
  const mon = (index % 12) + 1;
  return `${year}-${String(mon).padStart(2, '0')}`;
}

/** Whole months from `a` to `b` (`b` later is positive). */
export function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number) as [number, number];
  const [by, bm] = b.split('-').map(Number) as [number, number];
  return by * 12 + bm - (ay * 12 + am);
}

/** The last day of a month, `YYYY-MM-DD`. */
export function lastDayOf(month: string): string {
  return addDaysToKey(`${addMonths(month, 1)}-01`, -1);
}

/** Every day key of a month, first to last. */
export function daysOf(month: string): string[] {
  const out: string[] = [];
  for (let day = `${month}-01`; monthOf(day) === month; day = addDaysToKey(day, 1)) out.push(day);
  return out;
}

/** ISO weekday of a day key: Monday 1 ... Sunday 7. */
function isoWeekday(dateKey: string): number {
  const d = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/**
 * A month as calendar rows, Monday first: each row seven cells, a day key or
 * null for the days of the months either side.
 */
export function monthGrid(month: string): (string | null)[][] {
  const days = daysOf(month);
  const cells: (string | null)[] = [
    ...Array.from({ length: isoWeekday(days[0]!) - 1 }, () => null),
    ...days,
  ];
  while (cells.length % 7) cells.push(null);
  const rows: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

/** This month and the next MAX_MONTHS_AHEAD: the months the planner shows and may open. */
export function monthStrip(todayKey: string): string[] {
  const first = monthOf(todayKey);
  return Array.from({ length: MAX_MONTHS_AHEAD + 1 }, (_, i) => addMonths(first, i));
}

/** The furthest month the link may ever be opened, from today. */
export function furthestMonth(todayKey: string): string {
  return addMonths(monthOf(todayKey), MAX_MONTHS_AHEAD);
}

/** The months open with nothing saved yet: this month and the next. */
export function defaultOpenMonths(todayKey: string): string[] {
  const first = monthOf(todayKey);
  return [first, addMonths(first, 1)];
}

/** Month keys cleaned: well formed, once each, in order. */
export function cleanMonths(months: readonly string[]): string[] {
  return [...new Set(months.filter((m) => MONTH_SHAPE.test(m)))].sort();
}

/**
 * The months a link stored before months were switched one by one, as the
 * same open months: "this month through <openThrough>" or "this month and
 * the next <rollingMonths>", less any month closed by hand. A stored row
 * with none of those fields opens this month and the next.
 */
export function legacyOpenMonths(
  stored: { openThrough?: unknown; rollingMonths?: unknown; closedMonths?: unknown },
  todayKey: string,
): string[] {
  const first = monthOf(todayKey);
  const max = furthestMonth(todayKey);
  const through =
    typeof stored.openThrough === 'string' && MONTH_SHAPE.test(stored.openThrough)
      ? stored.openThrough
      : null;
  const rolling =
    typeof stored.rollingMonths === 'number' && Number.isInteger(stored.rollingMonths)
      ? Math.max(0, stored.rollingMonths)
      : null;
  if (through === null && rolling === null) return defaultOpenMonths(todayKey);
  const closed = new Set(
    Array.isArray(stored.closedMonths)
      ? stored.closedMonths.filter((m): m is string => typeof m === 'string')
      : [],
  );
  let last = through ?? addMonths(first, rolling ?? 1);
  if (last > max) last = max;
  const out: string[] = [];
  for (let m = first; m <= last; m = addMonths(m, 1)) if (!closed.has(m)) out.push(m);
  return out;
}

/** Whether a month takes bookings: on the list, and inside this month and the next eleven. */
export function monthOpen(
  config: Pick<PlannerConfig, 'openMonths'>,
  month: string,
  todayKey: string,
): boolean {
  return (
    month >= monthOf(todayKey) &&
    month <= furthestMonth(todayKey) &&
    config.openMonths.includes(month)
  );
}

/** The open months from this month on, in order (none past the strip). */
export function openMonthsAhead(
  config: Pick<PlannerConfig, 'openMonths'>,
  todayKey: string,
): string[] {
  return cleanMonths(config.openMonths).filter((m) => monthOpen(config, m, todayKey));
}

/** The last open month; null when none is open. */
export function lastOpenMonth(
  config: Pick<PlannerConfig, 'openMonths'>,
  todayKey: string,
): string | null {
  return openMonthsAhead(config, todayKey).at(-1) ?? null;
}

/** The last day the link may offer (the end of its last open month); null when none is open. */
export function lastOpenDay(
  config: Pick<PlannerConfig, 'openMonths'>,
  todayKey: string,
): string | null {
  const last = lastOpenMonth(config, todayKey);
  return last ? lastDayOf(last) : null;
}

/**
 * The planner's month tap, each month on its own: an open month closes, a
 * closed one opens. Months already past drop off; past the strip, nothing
 * changes.
 */
export function toggleMonth(
  config: Pick<PlannerConfig, 'openMonths'>,
  month: string,
  todayKey: string,
): Pick<PlannerConfig, 'openMonths'> {
  const kept = cleanMonths(config.openMonths).filter((m) => m >= monthOf(todayKey));
  if (month < monthOf(todayKey) || month > furthestMonth(todayKey)) return { openMonths: kept };
  return {
    openMonths: kept.includes(month)
      ? kept.filter((m) => m !== month)
      : cleanMonths([...kept, month]),
  };
}

/**
 * "Open next 3 months": this month and the next two open too; any other
 * month already open stays open.
 */
export function openNextMonths(
  config: Pick<PlannerConfig, 'openMonths'>,
  todayKey: string,
  count = 3,
): Pick<PlannerConfig, 'openMonths'> {
  const first = monthOf(todayKey);
  const next = Array.from({ length: Math.min(count, MAX_MONTHS_AHEAD + 1) }, (_, i) =>
    addMonths(first, i),
  );
  return { openMonths: cleanMonths([...config.openMonths.filter((m) => m >= first), ...next]) };
}

/** "Close all": no month open, so the link offers nothing until one is switched on. */
export function closeAllMonths(): Pick<PlannerConfig, 'openMonths'> {
  return { openMonths: [] };
}

/** "November isn't open on the link." */
export function monthClosedText(month: string): string {
  return `${monthName(month)} isn’t open on the link.`;
}

/** Months, days and runs that are wholly in the past: dropped on save, so the lists stay short. */
export function withoutPast<T extends PlannerConfig>(config: T, todayKey: string): T {
  const thisMonth = monthOf(todayKey);
  return {
    ...config,
    openMonths: cleanMonths(config.openMonths).filter((m) => m >= thisMonth),
    closedDates: config.closedDates.filter((d) => d >= todayKey),
    closedRanges: config.closedRanges.filter((r) => r.to >= todayKey),
    dateHours: config.dateHours.filter((d) => d.date >= todayKey),
  };
}

export type PlannerClosureCode = 'month_closed' | 'date_closed';

export interface PlannerClosure {
  code: PlannerClosureCode;
  text: string;
  /** A closed run's label ("Holidays"), when it has one. */
  label?: string;
}

/**
 * Why a day is closed by the planner, in plain words, or null when the
 * planner leaves it open (the standing rules may still close it).
 */
export function plannerClosure(config: PlannerConfig, dateKey: string): PlannerClosure | null {
  if (!config.openMonths.includes(monthOf(dateKey))) {
    return { code: 'month_closed', text: monthClosedText(monthOf(dateKey)) };
  }
  if (config.closedDates.includes(dateKey)) {
    return { code: 'date_closed', text: 'That day is closed on the booking link.' };
  }
  const range = config.closedRanges.find((r) => r.from <= dateKey && dateKey <= r.to);
  if (range) {
    const label = range.label.trim();
    return label
      ? { code: 'date_closed', text: `That day is closed on the booking link (${label}).`, label }
      : { code: 'date_closed', text: 'That day is closed on the booking link.' };
  }
  return null;
}

/** Whether a day is closed on its own (the day itself, not its month or a run). */
export function dateClosed(config: PlannerConfig, dateKey: string): boolean {
  return config.closedDates.includes(dateKey);
}

/** Close a single day, or open it again. */
export function toggleDate(
  config: PlannerConfig,
  dateKey: string,
): Pick<PlannerConfig, 'closedDates'> {
  return {
    closedDates: config.closedDates.includes(dateKey)
      ? config.closedDates.filter((d) => d !== dateKey)
      : [...config.closedDates, dateKey].sort(),
  };
}

/** The shorter hours set for one day, or null for the usual hours. */
export function hoursFor(config: PlannerConfig, dateKey: string): TimeWindow | null {
  const found = config.dateHours.find((d) => d.date === dateKey);
  return found ? { from: found.from, to: found.to } : null;
}

/** Set (or clear, with null) one day's shorter hours. */
export function setDateHours(
  config: PlannerConfig,
  dateKey: string,
  hours: TimeWindow | null,
): Pick<PlannerConfig, 'dateHours'> {
  const rest = config.dateHours.filter((d) => d.date !== dateKey);
  return {
    dateHours: hours
      ? [...rest, { date: dateKey, from: hours.from, to: hours.to }].sort((a, b) =>
          a.date.localeCompare(b.date),
        )
      : rest,
  };
}

/** Add a closed run of days (a holiday, a trip); the list stays sorted by first day. */
export function addClosedRange(
  config: PlannerConfig,
  range: { from: string; to: string; label?: string },
): Pick<PlannerConfig, 'closedRanges'> {
  const from = range.from <= range.to ? range.from : range.to;
  const to = range.from <= range.to ? range.to : range.from;
  const label = (range.label ?? '').trim().slice(0, 60);
  const exists = config.closedRanges.some((r) => r.from === from && r.to === to);
  return {
    closedRanges: exists
      ? config.closedRanges.map((r) => (r.from === from && r.to === to ? { from, to, label } : r))
      : [...config.closedRanges, { from, to, label }].sort((a, b) => a.from.localeCompare(b.from)),
  };
}

/** Remove one closed run of days. */
export function removeClosedRange(
  config: PlannerConfig,
  range: { from: string; to: string },
): Pick<PlannerConfig, 'closedRanges'> {
  return {
    closedRanges: config.closedRanges.filter((r) => !(r.from === range.from && r.to === range.to)),
  };
}

/** "November 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, 15)));
}

/** "November". */
export function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, 15)),
  );
}

/** "Nov". */
export function monthShort(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, 15)),
  );
}

/** "Tue, Nov 24" for a day key (no clock: read at noon UTC). */
export function dateLabel(dateKey: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${dateKey}T12:00:00Z`));
}
