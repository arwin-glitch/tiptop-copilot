import { addDaysToKey } from '@/lib/util/time';
import { MAX_MONTHS_AHEAD, type BookingConfig, type TimeWindow } from './config';

/**
 * The booking link's month planner (D-078), as pure data: which months the
 * link is open for, which days are closed, and which days have shorter
 * hours. The Booking tab's Availability planner edits these; the slot engine
 * (lib/booking/engine.ts) reads them. Rules always win: nothing here can
 * open a day the standing rules close (a Monday, a day inside the notice, a
 * day away), it can only close more or shorten hours.
 *
 * The open window is "this month through <month>": either rolling (this
 * month and the next `rollingMonths`, so a new month opens the next one by
 * itself) or fixed at `openThrough`. Never past this month and the next
 * MAX_MONTHS_AHEAD. Inside it, any month can be closed by hand.
 *
 * Days and months are host-zone keys (`YYYY-MM-DD`, `YYYY-MM`), compared as
 * strings, so no clock is read here.
 */

export type PlannerConfig = Pick<
  BookingConfig,
  'openThrough' | 'rollingMonths' | 'closedMonths' | 'closedDates' | 'closedRanges' | 'dateHours'
>;

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

/** The furthest month the link may ever be opened through, from today. */
export function furthestMonth(todayKey: string): string {
  return addMonths(monthOf(todayKey), MAX_MONTHS_AHEAD);
}

/**
 * The last month of the open window: the month Settings names (never past
 * the strip, never before this month), else this month plus the rolling
 * count.
 */
export function lastOpenMonth(config: PlannerConfig, todayKey: string): string {
  const first = monthOf(todayKey);
  const max = furthestMonth(todayKey);
  const wanted = config.openThrough ?? addMonths(first, config.rollingMonths);
  if (wanted < first) return first;
  return wanted > max ? max : wanted;
}

/** The last day the link may offer: the end of its last open month. */
export function lastOpenDay(config: PlannerConfig, todayKey: string): string {
  return lastDayOf(lastOpenMonth(config, todayKey));
}

/**
 * Whether the link has passed its fixed "open through" month: then it shows
 * nothing until someone opens another one (the Booking tab warns before).
 */
export function openThroughPassed(config: PlannerConfig, todayKey: string): boolean {
  return config.openThrough !== null && config.openThrough < monthOf(todayKey);
}

/** Whether the window moves on by itself each month (no fixed "open through"). */
export function isRolling(config: Pick<PlannerConfig, 'openThrough'>): boolean {
  return config.openThrough === null;
}

export type MonthState = 'open' | 'closed' | 'not_open';

/** A month as the planner shows it: open, closed by hand, or past the open window. */
export function monthState(config: PlannerConfig, month: string, todayKey: string): MonthState {
  if (month < monthOf(todayKey)) return 'not_open';
  if (openThroughPassed(config, todayKey) || month > lastOpenMonth(config, todayKey)) {
    return 'not_open';
  }
  return config.closedMonths.includes(month) ? 'closed' : 'open';
}

/** Whether a month takes bookings: inside the window and not closed by hand. */
export function monthOpen(config: PlannerConfig, month: string, todayKey: string): boolean {
  return monthState(config, month, todayKey) === 'open';
}

/**
 * The last month that really takes bookings (inside the window, not closed
 * by hand), for "Open through <month>"; null when none does.
 */
export function openThroughLabelMonth(config: PlannerConfig, todayKey: string): string | null {
  const months = monthStrip(todayKey).filter((m) => monthOpen(config, m, todayKey));
  return months.at(-1) ?? null;
}

/**
 * The planner's month tap, each month on its own: an open month closes; a
 * closed one opens again; a month past the window opens just that month (the
 * window is fixed through it, and the months between stay closed, so a tap
 * never opens a month nobody tapped). Past the strip, nothing changes.
 */
export function toggleMonth(
  config: PlannerConfig,
  month: string,
  todayKey: string,
): Pick<PlannerConfig, 'openThrough' | 'closedMonths'> {
  const keep = { openThrough: config.openThrough, closedMonths: [...config.closedMonths] };
  if (month < monthOf(todayKey) || month > furthestMonth(todayKey)) return keep;
  const state = monthState(config, month, todayKey);
  if (state === 'open') {
    return { ...keep, closedMonths: [...new Set([...config.closedMonths, month])].sort() };
  }
  if (state === 'closed') {
    return { ...keep, closedMonths: config.closedMonths.filter((m) => m !== month) };
  }
  // Past the window: the months between the window's end and this one stay closed.
  const passed = openThroughPassed(config, todayKey);
  const windowEnd = passed ? null : lastOpenMonth(config, todayKey);
  const between: string[] = [];
  for (
    let m = windowEnd ? addMonths(windowEnd, 1) : monthOf(todayKey);
    m < month;
    m = addMonths(m, 1)
  ) {
    between.push(m);
  }
  return {
    openThrough: month,
    closedMonths: [...new Set([...config.closedMonths, ...between])]
      .filter((m) => m !== month)
      .sort(),
  };
}

/**
 * "Keep rolling": the same window from today, but moving on by itself each
 * month (this month and the same number after it).
 */
export function keepRolling(
  config: PlannerConfig,
  todayKey: string,
): Pick<PlannerConfig, 'openThrough' | 'rollingMonths'> {
  const last = openThroughPassed(config, todayKey)
    ? monthOf(todayKey)
    : lastOpenMonth(config, todayKey);
  return {
    openThrough: null,
    rollingMonths: Math.min(
      MAX_MONTHS_AHEAD,
      Math.max(0, monthsBetween(monthOf(todayKey), last)),
    ),
  };
}

/** Closed months, days and runs that are wholly in the past: dropped on save, so the lists stay short. */
export function withoutPast<T extends PlannerConfig>(config: T, todayKey: string): T {
  const thisMonth = monthOf(todayKey);
  return {
    ...config,
    closedMonths: config.closedMonths.filter((m) => m >= thisMonth),
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
  if (config.closedMonths.includes(monthOf(dateKey))) {
    return { code: 'month_closed', text: 'That month is closed on the booking link.' };
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
