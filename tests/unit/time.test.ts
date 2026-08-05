import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  SUPPORTED_TIMEZONES,
  addDaysToKey,
  dayWindow,
  daysBetween,
  formatDate,
  formatDateTime,
  formatTime,
  formatWeekdayLong,
  isOverdue,
  isSupportedTimezone,
  localDateKey,
  relativeTime,
  startOfDayUtc,
  todayWindow,
} from '@/lib/util/time';

/**
 * "Today" must mean today in Nick's timezone, not the server's. The Today
 * page, the daily brief key and the overdue calculation all hang off this, so
 * the DST boundaries are worth pinning explicitly.
 */

describe('localDateKey', () => {
  it('uses the caller’s zone, not UTC', () => {
    // 01:30 UTC on 2 August is still 1 August in Chicago.
    const instant = new Date('2026-08-02T01:30:00.000Z');
    expect(localDateKey(instant, 'UTC')).toBe('2026-08-02');
    expect(localDateKey(instant, 'America/Chicago')).toBe('2026-08-01');
    expect(localDateKey(instant, 'Asia/Tokyo')).toBe('2026-08-02');
  });

  it('handles the far side of the date line', () => {
    const instant = new Date('2026-08-01T14:00:00.000Z');
    expect(localDateKey(instant, 'America/Los_Angeles')).toBe('2026-08-01');
    expect(localDateKey(instant, 'Australia/Sydney')).toBe('2026-08-02');
  });
});

describe('startOfDayUtc', () => {
  it('returns the instant midnight begins in that zone', () => {
    // CDT is UTC-5 in August.
    expect(startOfDayUtc('2026-08-01', 'America/Chicago').toISOString()).toBe(
      '2026-08-01T05:00:00.000Z',
    );
    // CST is UTC-6 in January.
    expect(startOfDayUtc('2026-01-15', 'America/Chicago').toISOString()).toBe(
      '2026-01-15T06:00:00.000Z',
    );
    expect(startOfDayUtc('2026-08-01', 'UTC').toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('is correct on the spring-forward day', () => {
    // US DST begins 8 March 2026. Midnight is still CST that morning.
    expect(startOfDayUtc('2026-03-08', 'America/Chicago').toISOString()).toBe(
      '2026-03-08T06:00:00.000Z',
    );
  });

  it('is correct on the autumn fall-back day', () => {
    // US DST ends 1 November 2026. Midnight is still CDT that morning.
    expect(startOfDayUtc('2026-11-01', 'America/Chicago').toISOString()).toBe(
      '2026-11-01T05:00:00.000Z',
    );
  });

  it('rejects a malformed date key rather than silently returning the epoch', () => {
    expect(() => startOfDayUtc('not-a-date', 'UTC')).toThrow(/Invalid date key/);
  });
});

describe('dayWindow', () => {
  it('is a half-open interval covering exactly one local day', () => {
    const window = dayWindow('2026-08-01', 'America/Chicago');
    expect(window.dateKey).toBe('2026-08-01');
    expect(window.end.getTime() - window.start.getTime()).toBe(86_400_000);
  });

  it('is 23 hours long on the spring-forward day', () => {
    const window = dayWindow('2026-03-08', 'America/Chicago');
    expect(window.end.getTime() - window.start.getTime()).toBe(23 * 3_600_000);
  });

  it('is 25 hours long on the fall-back day', () => {
    const window = dayWindow('2026-11-01', 'America/Chicago');
    expect(window.end.getTime() - window.start.getTime()).toBe(25 * 3_600_000);
  });

  it('contains an event at local 23:00 and excludes the next day’s 00:00', () => {
    const window = dayWindow('2026-08-01', 'America/Chicago');
    const lateEvening = new Date('2026-08-02T04:00:00.000Z'); // 23:00 CDT on the 1st
    const nextMidnight = new Date('2026-08-02T05:00:00.000Z');

    expect(lateEvening >= window.start && lateEvening < window.end).toBe(true);
    expect(nextMidnight < window.end).toBe(false);
  });
});

describe('todayWindow', () => {
  it('derives the key from the supplied instant, not the system clock', () => {
    const window = todayWindow('America/Chicago', new Date('2026-08-02T01:30:00.000Z'));
    expect(window.dateKey).toBe('2026-08-01');
  });
});

describe('addDaysToKey', () => {
  it('crosses month and year boundaries', () => {
    expect(addDaysToKey('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToKey('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(addDaysToKey('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysToKey('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-08-01T12:00:00.000Z');
  const offset = (ms: number) => new Date(now.getTime() + ms);

  it('is deterministic given now', () => {
    expect(relativeTime(offset(-30_000), now)).toBe('just now');
    expect(relativeTime(offset(-5 * 60_000), now)).toBe('5m ago');
    expect(relativeTime(offset(-3 * 3_600_000), now)).toBe('3h ago');
    expect(relativeTime(offset(-3 * 86_400_000), now)).toBe('3d ago');
  });

  it('distinguishes past from future', () => {
    expect(relativeTime(offset(2 * 3_600_000), now)).toBe('2h from now');
    expect(relativeTime(offset(-2 * 3_600_000), now)).toBe('2h ago');
  });

  it('rolls up to months and years', () => {
    expect(relativeTime(offset(-90 * 86_400_000), now)).toBe('3mo ago');
    expect(relativeTime(offset(-800 * 86_400_000), now)).toBe('2y ago');
  });

  it('accepts an ISO string as well as a Date', () => {
    expect(relativeTime('2026-08-01T09:00:00.000Z', now)).toBe('3h ago');
  });
});

describe('isOverdue', () => {
  const now = new Date('2026-08-01T12:00:00.000Z');

  it('is true only for a due date strictly in the past', () => {
    expect(isOverdue('2026-08-01T11:59:00.000Z', now)).toBe(true);
    expect(isOverdue('2026-08-01T12:01:00.000Z', now)).toBe(false);
  });

  it('treats a task with no due date as not overdue', () => {
    expect(isOverdue(null, now)).toBe(false);
    expect(isOverdue(undefined, now)).toBe(false);
  });
});

describe('daysBetween', () => {
  it('counts whole days in either direction', () => {
    expect(daysBetween('2026-08-01T00:00:00.000Z', '2026-08-04T00:00:00.000Z')).toBe(3);
    expect(daysBetween('2026-08-04T00:00:00.000Z', '2026-08-01T00:00:00.000Z')).toBe(-3);
    expect(daysBetween('2026-08-01T00:00:00.000Z', '2026-08-01T06:00:00.000Z')).toBe(0);
  });
});

describe('formatting', () => {
  const instant = new Date('2026-08-01T18:30:00.000Z');

  it('renders in the requested zone', () => {
    expect(formatTime(instant, 'America/Chicago')).toBe('1:30 PM');
    expect(formatTime(instant, 'UTC')).toBe('6:30 PM');
  });

  it('renders dates and weekdays in the requested zone', () => {
    expect(formatDate(instant, 'UTC')).toBe('Aug 1, 2026');
    expect(formatDateTime(instant, 'UTC')).toContain('Aug 1');
    expect(formatWeekdayLong(instant, 'UTC')).toBe('Saturday, August 1');
  });

  it('shifts the rendered day for a zone on the other side of midnight', () => {
    const lateUtc = new Date('2026-08-02T02:00:00.000Z');
    expect(formatDate(lateUtc, 'America/Chicago')).toBe('Aug 1, 2026');
    expect(formatDate(lateUtc, 'UTC')).toBe('Aug 2, 2026');
  });
});

describe('timezone configuration', () => {
  it('defaults to Nick’s zone', () => {
    expect(DEFAULT_TIMEZONE).toBe('America/Chicago');
    expect(SUPPORTED_TIMEZONES).toContain(DEFAULT_TIMEZONE);
  });

  it('accepts every offered timezone', () => {
    for (const tz of SUPPORTED_TIMEZONES) {
      expect(isSupportedTimezone(tz), tz).toBe(true);
    }
  });

  it('rejects an invented timezone rather than throwing later', () => {
    expect(isSupportedTimezone('Mars/Olympus_Mons')).toBe(false);
  });
});
