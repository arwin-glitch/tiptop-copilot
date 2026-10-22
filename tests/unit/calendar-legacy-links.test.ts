import { describe, expect, it } from 'vitest';
import { legacyCalendarHref } from '@/lib/calendar/legacy-links';

/**
 * The retired day list's addresses (D-072): ?view=list and ?day= open Day on
 * that date, any other parameters kept; every other address is left alone.
 */
describe('old day-list links', () => {
  it('open Day on the day an old ?day= link names', () => {
    expect(legacyCalendarHref({ day: '2026-10-22' })).toBe('/calendar?view=day&date=2026-10-22');
  });

  it('open Day on today for ?view=list, or on its day', () => {
    expect(legacyCalendarHref({ view: 'list' })).toBe('/calendar?view=day');
    expect(legacyCalendarHref({ view: 'list', day: '2026-10-23' })).toBe(
      '/calendar?view=day&date=2026-10-23',
    );
    expect(legacyCalendarHref({ view: 'list', date: '2026-10-24' })).toBe(
      '/calendar?view=day&date=2026-10-24',
    );
  });

  it('keep any other parameters as they were', () => {
    expect(legacyCalendarHref({ view: 'list', tour: 'calendar', x: ['1', '2'] })).toBe(
      '/calendar?view=day&tour=calendar&x=1&x=2',
    );
    expect(legacyCalendarHref({ day: '2026-10-22', tour: 'calendar' })).toBe(
      '/calendar?view=day&date=2026-10-22&tour=calendar',
    );
  });

  it('keep a view the address names, and drop a day that is not a date', () => {
    expect(legacyCalendarHref({ view: 'week', day: '2026-10-22' })).toBe(
      '/calendar?view=week&date=2026-10-22',
    );
    expect(legacyCalendarHref({ day: 'tomorrow' })).toBe('/calendar?view=day');
  });

  it('leave every other address alone', () => {
    expect(legacyCalendarHref({})).toBeNull();
    expect(legacyCalendarHref({ view: 'week', date: '2026-10-22' })).toBeNull();
    expect(legacyCalendarHref({ view: 'month' })).toBeNull();
    expect(legacyCalendarHref({ tour: 'calendar' })).toBeNull();
  });
});
