import { addDaysToKey } from '@/lib/util/time';
import { MAX_MONTHS_AHEAD, type BookingConfig, type TimeWindow } from './config';

/**
 * The booking link's month planner (D-078), as pure data: which months the
 * link is open for, which days are closed, and which days have shorter
 * hours. The Booking tab's Availability planner edits these; the slot engine
 * (lib/booking/engine.ts) reads them. Rules always win: nothing here can
 * open a day the standing rules close (a Monday, a day past notice, a day
 * away), it can only close more or shorten hours.
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

/** This month and the next `MAX_MONTHS_AHEAD`: the months the planner shows and may open. */
export function monthStrip(todayKey: string): string[] {
  const first = monthOf(todayKey);
  return Array.from({ length: MAX_MONTHS_AHEAD + 1 }, (_, i) => addMonths(first, i));
}

/**
 * The last month the link is open through: the month Settings names (never
 * past the strip, never before this month), else this month plus the rolling
 * count.
 */
export function lastOpenMonth(config: PlannerConfig, todayKey: string): string {
  const first = monthOf(todayKey);
  const max = addMonths(first, MAX_MONTHS_AHEAD);
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
 * nothing until someone opens another one (the planner says so).
 */
export function openThroughPassed(config: PlannerConfig, todayKey: string): boolean {
  return config.openThrough !== null && config.openThrough < monthOf(todayKey);
}

export type MonthState = 'open' | 'closed' | 'not_open';

/** A month as the planner shows it: open, closed by hand, or past the open window. */
export function monthState(config: PlannerConfig, month: string, todayKey: string): MonthState {
  if (openThroughPassed(config, todayKey) || month > lastOpenMonth(config, todayKey)) {
    return 'not_open';
  }
  return config.closedMonths.includes(month) ? 'closed' : 'open';
}

/**
 * The planner's month tap: an open month closes; a closed one opens again;
 * a month past the window opens it through that month (a fixed month, so
 * "which month are we opening" is exactly what was tapped) and any closed
 * months up to it stay as they were.
 */
export function toggleMonth(
  config: PlannerConfig,
  month: string,
  todayKey: string,
): Pick<PlannerConfig, 'openThrough' | 'closedMonths'> {
  const state = monthState(config, month, todayKey);
  if (state === 'open') {
    return {
      openThrough: config.openThrough,
      closedMonths: [...new Set([...config.closedMonths, month])].sort(),
    };
  }
  if (state === 'closed') {
    return {
      openThrough: config.openThrough,
      closedMonths: config.closedMonths.filter((m) => m !== month),
    };
  }
  return {
    openThrough: month,
    closedMonths: config.closedMonths.filter((m) => m !== month),
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

/**
 * Why a day is closed by the planner, in plain words, or null when the
 * planner leaves it open (the standing rules may still close it).
 */
export function plannerClosure(config: PlannerConfig, dateKey: string): string | null {
  if (config.closedMonths.includes(monthOf(dateKey))) {
    return 'That month is closed on the booking link.';
  }
  if (config.closedDates.includes(dateKey)) return 'That day is closed on the booking link.';
  const range = config.closedRanges.find((r) => r.from <= dateKey && dateKey <= r.to);
  if (range) {
    return range.label.trim()
      ? `That day is closed on the booking link (${range.label.trim()}).`
      : 'That day is closed on the booking link.';
  }
  return null;
}

/** The shorter hours set for one day, or null for the usual hours. */
export function hoursFor(config: PlannerConfig, dateKey: string): TimeWindow | null {
  const found = config.dateHours.find((d) => d.date === dateKey);
  return found ? { from: found.from, to: found.to } : null;
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
