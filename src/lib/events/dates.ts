/**
 * Date shifting for "Duplicate" and "Duplicate as next year" (D-075). Pure
 * and isomorphic.
 *
 * Shifting by whole days keeps the WALL-CLOCK time in the event's time zone:
 * a 6:00 PM reception in Chicago stays at 6:00 PM a year later even when
 * daylight saving moved the UTC offset in between.
 */

const MS_DAY = 24 * 60 * 60 * 1000;

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function wallClock(ms: number, timeZone: string): WallClock {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    ms: ((ms % 1000) + 1000) % 1000,
  };
}

/** The zone's offset from UTC at an instant, in ms (Chicago in January: -6 h). */
function offsetAt(ms: number, timeZone: string): number {
  const w = wallClock(ms, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.ms) - ms;
}

/**
 * `iso` moved by `days` whole days, keeping its wall-clock time in
 * `timeZone`. Null stays null; an unknown zone shifts in plain UTC days.
 */
export function shiftDays(iso: string | null, days: number, timeZone: string): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  if (days === 0) return new Date(ms).toISOString();
  let w: WallClock;
  try {
    w = wallClock(ms, timeZone);
  } catch {
    return new Date(ms + days * MS_DAY).toISOString();
  }
  const localTarget = Date.UTC(w.year, w.month - 1, w.day + days, w.hour, w.minute, w.second, w.ms);
  // Two passes settle the offset on either side of a DST change.
  let guess = localTarget - offsetAt(localTarget, timeZone);
  guess = localTarget - offsetAt(guess, timeZone);
  return new Date(guess).toISOString();
}
