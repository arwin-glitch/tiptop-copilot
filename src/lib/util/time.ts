/**
 * All date handling goes through here so that "today" always means today in the
 * user's configured timezone, not the server's. No date library: Intl covers
 * every case we need and ships with the runtime.
 */

export const DEFAULT_TIMEZONE = 'America/Chicago';

export const SUPPORTED_TIMEZONES = [
  'America/Chicago',
  'America/New_York',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Toronto',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Zurich',
  'Europe/Stockholm',
  'Asia/Dubai',
  // IANA has no Asia/Bengaluru zone; India is Asia/Kolkata.
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
] as const;

export function isSupportedTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function partsIn(date: Date, timeZone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return out;
}

/** Calendar date in a zone, as `YYYY-MM-DD`. */
export function localDateKey(date: Date, timeZone: string): string {
  const p = partsIn(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** How far `timeZone` is ahead of UTC at a specific instant, in milliseconds. */
function offsetAt(instant: Date, timeZone: string): number {
  const p = partsIn(instant, timeZone);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - instant.getTime();
}

/**
 * The instant at which the given calendar day begins in `timeZone`.
 *
 * Two passes, because one is wrong twice a year: the offset at noon is not
 * necessarily the offset at midnight on a day the clocks change. The first
 * pass probes at noon UTC — safely clear of any transition — and the second
 * re-measures at the instant that guess landed on, which is the one whose
 * offset actually applies.
 */
export function startOfDayUtc(dateKey: string, timeZone: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`Invalid date key: ${dateKey}`);

  const localMidnight = Date.UTC(y, m - 1, d, 0, 0, 0);
  const noonProbe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

  const firstGuess = localMidnight - offsetAt(noonProbe, timeZone);
  return new Date(localMidnight - offsetAt(new Date(firstGuess), timeZone));
}

export interface DayWindow {
  dateKey: string;
  start: Date;
  end: Date;
}

/** [start, end) covering the whole of `dateKey` in `timeZone`. */
export function dayWindow(dateKey: string, timeZone: string): DayWindow {
  const start = startOfDayUtc(dateKey, timeZone);
  const nextKey = addDaysToKey(dateKey, 1);
  const end = startOfDayUtc(nextKey, timeZone);
  return { dateKey, start, end };
}

export function todayWindow(timeZone: string, now: Date = new Date()): DayWindow {
  return dayWindow(localDateKey(now, timeZone), timeZone);
}

export function addDaysToKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function formatTime(date: Date | string, timeZone: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

export function formatDate(date: Date | string, timeZone: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

export function formatDateTime(date: Date | string, timeZone: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

export function formatWeekdayLong(date: Date | string, timeZone: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(d);
}

/** "3d ago", "in 2h", "just now". Deterministic given `now`. */
export function relativeTime(date: Date | string, now: Date = new Date()): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const diffMs = d.getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (abs < minute) return 'just now';
  const sign = diffMs < 0 ? 'ago' : 'from now';
  if (abs < hour) return `${Math.round(abs / minute)}m ${sign}`;
  if (abs < day) return `${Math.round(abs / hour)}h ${sign}`;
  if (abs < 30 * day) return `${Math.round(abs / day)}d ${sign}`;
  const months = Math.round(abs / (30 * day));
  if (months < 12) return `${months}mo ${sign}`;
  return `${Math.round(months / 12)}y ${sign}`;
}

export function isOverdue(dueAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!dueAt) return false;
  return new Date(dueAt).getTime() < now.getTime();
}

export function daysBetween(a: Date | string, b: Date | string): number {
  const da = typeof a === 'string' ? new Date(a) : a;
  const db = typeof b === 'string' ? new Date(b) : b;
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}
