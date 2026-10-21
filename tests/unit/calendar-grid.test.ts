import { describe, expect, it } from 'vitest';
import {
  addMonthsToKey,
  daySpan,
  instantAt,
  isDateKey,
  layoutColumns,
  minutesIntoDay,
  monthWeeks,
  packWeek,
  rangeLabel,
  segmentOnDay,
  snap,
  stepDate,
  viewRange,
  type PackItem,
} from '@/lib/calendar/grid';

const TZ = 'America/Chicago';

describe('which days a view shows', () => {
  it('a day, its Sunday-to-Saturday week, or the whole weeks of its month', () => {
    expect(viewRange('day', '2026-10-21')).toEqual({
      from: '2026-10-21',
      to: '2026-10-22',
      days: ['2026-10-21'],
    });
    const week = viewRange('week', '2026-10-21'); // a Wednesday
    expect(week.from).toBe('2026-10-18');
    expect(week.to).toBe('2026-10-25');
    expect(week.days).toHaveLength(7);
    const month = viewRange('month', '2026-10-21');
    expect(month.from).toBe('2026-09-27');
    expect(month.to).toBe('2026-11-01');
    expect(monthWeeks('2026-10-21')).toHaveLength(5);
  });

  it('six weeks when the month needs them, four when it fits exactly', () => {
    expect(monthWeeks('2026-08-10')).toHaveLength(6); // Aug 2026 starts on a Saturday
    expect(monthWeeks('2026-02-10')).toHaveLength(4); // Feb 2026 starts on a Sunday, 28 days
  });

  it('steps a day, a week or a month, keeping the day of the month where it can', () => {
    expect(stepDate('day', '2026-12-31', 1)).toBe('2027-01-01');
    expect(stepDate('week', '2026-10-21', -1)).toBe('2026-10-14');
    expect(stepDate('month', '2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsToKey('2024-01-31', 1)).toBe('2024-02-29');
    expect(stepDate('month', '2026-03-15', -14)).toBe('2025-01-15');
  });

  it('labels the range as Google does', () => {
    expect(rangeLabel('month', '2026-10-21')).toBe('October 2026');
    expect(rangeLabel('week', '2026-10-21')).toBe('Oct 18 – 24, 2026');
    expect(rangeLabel('week', '2026-10-28')).toBe('Oct 25 – 31, 2026');
    expect(rangeLabel('week', '2026-11-03')).toBe('Nov 1 – 7, 2026');
    expect(rangeLabel('week', '2026-09-30')).toBe('Sep 27 – Oct 3, 2026');
    expect(rangeLabel('week', '2026-12-30')).toBe('Dec 27, 2026 – Jan 2, 2027');
    expect(rangeLabel('day', '2026-10-21')).toBe('Wednesday, October 21, 2026');
  });

  it('accepts only real dates', () => {
    expect(isDateKey('2026-02-29')).toBe(false);
    expect(isDateKey('2028-02-29')).toBe(true);
    expect(isDateKey('2026-13-01')).toBe(false);
    expect(isDateKey('nope')).toBe(false);
  });
});

describe('placing events on the time grid', () => {
  it('uses wall-clock minutes, so 10am is on the 10am line on the day the clocks change', () => {
    // 1 Nov 2026: Chicago falls back at 2am.
    const tenAm = Date.parse('2026-11-01T16:00:00Z'); // 10:00 CST
    expect(minutesIntoDay(tenAm, '2026-11-01', TZ)).toBe(600);
    expect(instantAt('2026-11-01', 600, TZ).toISOString()).toBe('2026-11-01T16:00:00.000Z');
    // The next midnight is the end of the day.
    expect(instantAt('2026-11-01', 1440, TZ).toISOString()).toBe('2026-11-02T06:00:00.000Z');
  });

  it('cuts an event that crosses midnight into a piece on each day', () => {
    const late = { startsAt: '2026-10-21T03:00:00Z', endsAt: '2026-10-21T06:30:00Z' }; // 10pm to 1:30am
    expect(segmentOnDay(late, '2026-10-20', TZ)).toEqual({ start: 22 * 60, end: 1440 });
    expect(segmentOnDay(late, '2026-10-21', TZ)).toEqual({ start: 0, end: 90 });
    expect(segmentOnDay(late, '2026-10-22', TZ)).toBeNull();
    // Ending exactly at midnight does not touch the next day.
    const toMidnight = { startsAt: '2026-10-21T03:00:00Z', endsAt: '2026-10-21T05:00:00Z' };
    expect(segmentOnDay(toMidnight, '2026-10-21', TZ)).toBeNull();
  });

  it('knows the days an event covers, all-day dates as Google keeps them', () => {
    expect(
      daySpan(
        {
          allDay: true,
          startDate: '2026-10-29',
          endDate: '2026-11-01',
          startsAt: null,
          endsAt: null,
        },
        TZ,
      ),
    ).toEqual({ startKey: '2026-10-29', endKey: '2026-11-01' });
    expect(
      daySpan(
        {
          allDay: false,
          startDate: null,
          endDate: null,
          startsAt: '2026-10-21T03:00:00Z',
          endsAt: '2026-10-21T05:00:00Z',
        },
        TZ,
      ),
    ).toEqual({ startKey: '2026-10-20', endKey: '2026-10-21' });
  });

  it('snaps to 15 minutes', () => {
    expect(snap(7)).toBe(0);
    expect(snap(8)).toBe(15);
    expect(snap(52)).toBe(45);
  });
});

describe('overlapping events side by side, as Google lays them out', () => {
  const at = (h: number, m = 0) => h * 60 + m;

  it('gives an event on its own the full width', () => {
    const out = layoutColumns([
      { key: 'a', start: at(9), end: at(10) },
      { key: 'b', start: at(10), end: at(11) },
    ]);
    expect(out.get('a')).toEqual({ col: 0, cols: 1, span: 1 });
    expect(out.get('b')).toEqual({ col: 0, cols: 1, span: 1 });
  });

  it('shares the width among a chain of overlaps, reusing a column once it is free', () => {
    const out = layoutColumns([
      { key: 'a', start: at(9), end: at(10) },
      { key: 'b', start: at(9, 30), end: at(10, 30) },
      { key: 'c', start: at(10), end: at(11) },
    ]);
    expect(out.get('a')).toEqual({ col: 0, cols: 2, span: 1 });
    expect(out.get('b')).toEqual({ col: 1, cols: 2, span: 1 });
    expect(out.get('c')).toEqual({ col: 0, cols: 2, span: 1 });
  });

  it('stretches an event across the columns to its right that nothing overlaps', () => {
    const out = layoutColumns([
      { key: 'long', start: at(9), end: at(12) },
      { key: 'b', start: at(9), end: at(10) },
      { key: 'c', start: at(9), end: at(10, 30) },
      { key: 'd', start: at(10, 30), end: at(11) },
    ]);
    expect(out.get('long')).toEqual({ col: 0, cols: 3, span: 1 });
    // Same start: the longer one takes the earlier column.
    expect(out.get('c')).toEqual({ col: 1, cols: 3, span: 1 });
    expect(out.get('b')).toEqual({ col: 2, cols: 3, span: 1 });
    expect(out.get('d')).toEqual({ col: 1, cols: 3, span: 2 });
  });

  it('counts a very short event as the room it takes on screen', () => {
    const out = layoutColumns([
      { key: 'a', start: at(9), end: at(9, 5) },
      { key: 'b', start: at(9, 10), end: at(9, 15) },
    ]);
    expect(out.get('a')?.cols).toBe(2);
    expect(out.get('b')?.col).toBe(1);
  });
});

describe('packing a month week', () => {
  const week = [
    '2026-10-18',
    '2026-10-19',
    '2026-10-20',
    '2026-10-21',
    '2026-10-22',
    '2026-10-23',
    '2026-10-24',
  ];
  const item = (key: string, startKey: string, endKey: string, over: Partial<PackItem> = {}) => ({
    key,
    startKey,
    endKey,
    allDay: true,
    startMs: 0,
    title: key,
    ...over,
  });

  it('shows what fits and "+N more" for the rest of a busy day', () => {
    const timed = (key: string, hour: number) =>
      item(key, '2026-10-21', '2026-10-22', {
        allDay: false,
        startMs: Date.parse(`2026-10-21T${String(hour).padStart(2, '0')}:00:00Z`),
      });
    const packed = packWeek(
      [timed('e1', 14), timed('e2', 15), timed('e3', 16), timed('e4', 17), timed('e5', 18)],
      week,
      3,
    );
    expect(packed.segments.map((s) => s.key)).toEqual(['e1', 'e2']);
    expect(packed.more).toEqual([{ col: 3, count: 3, keys: ['e3', 'e4', 'e5'] }]);
  });

  it('puts longer events first and keeps a multi-day bar in one lane', () => {
    const packed = packWeek(
      [item('short', '2026-10-19', '2026-10-20'), item('long', '2026-10-19', '2026-10-23')],
      week,
      3,
    );
    expect(packed.segments.find((s) => s.key === 'long')).toMatchObject({
      lane: 0,
      startCol: 1,
      endCol: 4,
    });
    expect(packed.segments.find((s) => s.key === 'short')).toMatchObject({ lane: 1 });
  });

  it('draws a bar in pieces round a day where it is hidden', () => {
    const packed = packWeek(
      [
        item('x', '2026-10-18', '2026-10-25'),
        item('w', '2026-10-18', '2026-10-24'),
        item('z', '2026-10-18', '2026-10-23'),
        item('single', '2026-10-20', '2026-10-21', { allDay: false, startMs: 1 }),
      ],
      week,
      3,
    );
    const z = packed.segments.filter((s) => s.key === 'z');
    expect(z).toEqual([
      { key: 'z', lane: 2, startCol: 0, endCol: 1, continuesBefore: false, continuesAfter: true },
      { key: 'z', lane: 2, startCol: 3, endCol: 4, continuesBefore: true, continuesAfter: false },
    ]);
    expect(packed.more).toEqual([{ col: 2, count: 2, keys: ['z', 'single'] }]);
  });

  it('marks a bar that runs on past the week', () => {
    const packed = packWeek([item('trip', '2026-10-23', '2026-10-27')], week, 3);
    expect(packed.segments).toEqual([
      {
        key: 'trip',
        lane: 0,
        startCol: 5,
        endCol: 6,
        continuesBefore: false,
        continuesAfter: true,
      },
    ]);
  });
});
