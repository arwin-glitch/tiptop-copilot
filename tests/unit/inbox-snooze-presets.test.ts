import { describe, expect, it } from 'vitest';
import {
  checkWakeAt,
  formatWake,
  pickedWakeAt,
  SNOOZE_MAX_DAYS,
  snoozePresets,
  toDateTimeLocal,
} from '@/lib/email/snooze';

/**
 * Snooze's preset menu, worked out on the reader's wall clock: fixed instants
 * in several zones, a day the clocks change, and the hours and weekdays a
 * preset is left out on.
 */

const presets = (iso: string, zone: string) =>
  Object.fromEntries(snoozePresets(new Date(iso), zone).map((p) => [p.id, p.at.toISOString()]));

describe('snoozePresets', () => {
  it('Chicago, Monday morning: all four, later today rounded up to the hour', () => {
    // Mon 2026-11-02 10:15 CST (UTC-6).
    expect(presets('2026-11-02T16:15:00Z', 'America/Chicago')).toEqual({
      later: '2026-11-02T20:00:00.000Z', // 2:00 PM
      tomorrow: '2026-11-03T14:00:00.000Z', // Tue 8:00 AM
      weekend: '2026-11-07T14:00:00.000Z', // Sat 8:00 AM
      nextWeek: '2026-11-09T14:00:00.000Z', // the Monday after, not today
    });
  });

  it('keeps the menu in order', () => {
    const ids = snoozePresets(new Date('2026-11-02T16:15:00Z'), 'America/Chicago').map((p) => p.id);
    expect(ids).toEqual(['later', 'tomorrow', 'weekend', 'nextWeek']);
  });

  it('leaves out later today from 6 PM on', () => {
    // Wed 2026-11-04 19:30 CST.
    const p = presets('2026-11-05T01:30:00Z', 'America/Chicago');
    expect(p.later).toBeUndefined();
    expect(p.tomorrow).toBe('2026-11-05T14:00:00.000Z');
    expect(p.weekend).toBe('2026-11-07T14:00:00.000Z');
    // Wed 17:59 still offers it.
    expect(presets('2026-11-04T23:59:00Z', 'America/Chicago').later).toBe(
      '2026-11-05T03:00:00.000Z',
    );
  });

  it('Tokyo, Saturday: no weekend preset, an exact hour stays put', () => {
    // Sat 2026-11-07 09:00 JST (UTC+9).
    expect(presets('2026-11-07T00:00:00Z', 'Asia/Tokyo')).toEqual({
      later: '2026-11-07T03:00:00.000Z', // 12:00 PM exactly
      tomorrow: '2026-11-07T23:00:00.000Z', // Sun 8:00 AM
      nextWeek: '2026-11-08T23:00:00.000Z', // Mon 8:00 AM
    });
  });

  it('London, Sunday: no weekend preset, next week is tomorrow', () => {
    const p = presets('2026-11-08T10:00:00Z', 'Europe/London');
    expect(p.weekend).toBeUndefined();
    expect(p.tomorrow).toBe('2026-11-09T08:00:00.000Z');
    expect(p.nextWeek).toBe('2026-11-09T08:00:00.000Z');
  });

  it('Kolkata (half-hour offset): rounds on the local hour', () => {
    // Fri 2026-11-06 14:10 IST (UTC+5:30).
    const p = presets('2026-11-06T08:40:00Z', 'Asia/Kolkata');
    expect(p.later).toBe('2026-11-06T12:30:00.000Z'); // 6:00 PM IST
    expect(p.weekend).toBe('2026-11-07T02:30:00.000Z'); // Sat 8:00 AM IST
  });

  it('New York, the day before the clocks go back: 8:00 AM on the new offset', () => {
    // Sat 2026-10-31 12:00 EDT (UTC-4); Sunday is EST (UTC-5).
    const p = presets('2026-10-31T16:00:00Z', 'America/New_York');
    expect(p.later).toBe('2026-10-31T19:00:00.000Z'); // 3:00 PM EDT
    expect(p.tomorrow).toBe('2026-11-01T13:00:00.000Z'); // Sun 8:00 AM EST
    expect(p.nextWeek).toBe('2026-11-02T13:00:00.000Z'); // Mon 8:00 AM EST
    expect(p.weekend).toBeUndefined();
  });

  it('every preset is in the future and passes the wake check', () => {
    for (const [iso, zone] of [
      ['2026-11-02T16:15:00Z', 'America/Chicago'],
      ['2026-11-07T00:00:00Z', 'Asia/Tokyo'],
      ['2026-11-06T08:40:00Z', 'Asia/Kolkata'],
      ['2026-12-31T23:30:00Z', 'Pacific/Auckland'],
    ] as const) {
      const now = new Date(iso);
      for (const p of snoozePresets(now, zone)) {
        expect(checkWakeAt(p.at, now).ok, `${zone} ${p.id}`).toBe(true);
      }
    }
  });
});

describe('pickedWakeAt', () => {
  it('reads a datetime-local value on the wall clock of the zone', () => {
    expect(pickedWakeAt('2026-11-10T09:30', 'America/Chicago')?.toISOString()).toBe(
      '2026-11-10T15:30:00.000Z',
    );
    expect(pickedWakeAt('2026-11-10T09:30:00', 'Asia/Tokyo')?.toISOString()).toBe(
      '2026-11-10T00:30:00.000Z',
    );
  });

  it('refuses anything else', () => {
    expect(pickedWakeAt('', 'America/Chicago')).toBeNull();
    expect(pickedWakeAt('tomorrow', 'America/Chicago')).toBeNull();
    expect(pickedWakeAt('2026-02-30T09:00', 'America/Chicago')).toBeNull();
    expect(pickedWakeAt('2026-11-10T25:00', 'America/Chicago')).toBeNull();
  });

  it('round-trips with toDateTimeLocal', () => {
    const at = new Date('2026-11-10T15:30:00Z');
    expect(toDateTimeLocal(at, 'America/Chicago')).toBe('2026-11-10T09:30');
    expect(pickedWakeAt(toDateTimeLocal(at, 'America/Chicago'), 'America/Chicago')).toEqual(at);
  });
});

describe('checkWakeAt', () => {
  const now = new Date('2026-11-02T16:00:00Z');

  it('takes a future time up to a year ahead', () => {
    expect(checkWakeAt('2026-11-02T16:01:00Z', now).ok).toBe(true);
    const limit = new Date(now.getTime() + SNOOZE_MAX_DAYS * 86_400_000);
    expect(checkWakeAt(limit, now).ok).toBe(true);
  });

  it('refuses now, the past, past a year, and nonsense', () => {
    expect(checkWakeAt(now, now)).toEqual({ ok: false, message: 'Pick a time in the future.' });
    expect(checkWakeAt('2026-11-01T00:00:00Z', now).ok).toBe(false);
    const over = new Date(now.getTime() + SNOOZE_MAX_DAYS * 86_400_000 + 60_000);
    expect(checkWakeAt(over, now)).toEqual({
      ok: false,
      message: 'Snooze can be at most a year ahead.',
    });
    expect(checkWakeAt('not a date', now).ok).toBe(false);
  });
});

describe('formatWake', () => {
  const now = new Date('2026-11-02T16:00:00Z');

  it('says the weekday and time within the week', () => {
    const text = formatWake('2026-11-03T14:00:00Z', 'America/Chicago', now);
    expect(text).toMatch(/^Tue,? 8:00\sAM$/);
  });

  it('adds the date further out', () => {
    const text = formatWake('2026-11-16T14:00:00Z', 'America/Chicago', now);
    expect(text).toMatch(/Mon/);
    expect(text).toMatch(/Nov 16/);
    expect(text).toMatch(/8:00\sAM/);
  });
});
