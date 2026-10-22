import { describe, expect, it } from 'vitest';
import {
  addMonthsToKey,
  cascadeIndentPx,
  daySpan,
  instantAt,
  isDateKey,
  layoutColumns,
  layoutOverlaps,
  MIN_CHIP_PX,
  MIN_CHIP_TOLERANCE_PX,
  minutesIntoDay,
  monthWeeks,
  packWeek,
  rangeLabel,
  segmentOnDay,
  SIDE_BY_SIDE_MINUTES,
  snap,
  stepDate,
  viewRange,
  type LayoutItem,
  type OverlapLayout,
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

describe('a busy day laid out as Google Calendar does: cascading, side by side, "+N"', () => {
  const at = (h: number, m = 0) => h * 60 + m;
  const item = (key: string, from: number, to: number): LayoutItem => ({
    key,
    start: from,
    end: to,
  });
  // A week column on a laptop, the same indent and minimum the grid uses.
  const WEEK = { columnPx: 120, minChipPx: 39 };
  const px = (fraction: number, columnPx = WEEK.columnPx) => fraction * columnPx;

  /** Every event exactly once: drawn as a chip or folded into one "+N". */
  function expectAllAccountedFor(items: LayoutItem[], layout: OverlapLayout) {
    const folded = layout.folds.flatMap((f) => f.keys);
    const all = [...layout.chips.keys(), ...folded].sort();
    expect(all).toEqual(items.map((i) => i.key).sort());
  }

  it('gives an event on its own the whole column', () => {
    const layout = layoutOverlaps([item('a', at(9), at(10))], WEEK);
    expect(layout.chips.get('a')).toEqual({ left: 0, width: 1, z: 1, depth: 0, cascaded: false });
    expect(layout.folds).toEqual([]);
  });

  it('puts events that start together side by side, sharing the width', () => {
    const layout = layoutOverlaps(
      [item('long', at(9), at(11)), item('short', at(9, 15), at(10))],
      WEEK,
    );
    expect(layout.chips.get('long')).toMatchObject({ left: 0, width: 0.5, cascaded: false });
    expect(layout.chips.get('short')).toMatchObject({ left: 0.5, width: 0.5, cascaded: false });
  });

  it('draws one that starts later over the earlier one, shifted right and nearly full width', () => {
    const layout = layoutOverlaps(
      [item('conference', at(8), at(18)), item('meeting', at(10), at(10, 30))],
      WEEK,
    );
    const indent = cascadeIndentPx(WEEK.columnPx) / WEEK.columnPx;
    expect(layout.chips.get('conference')).toEqual({
      left: 0,
      width: 1,
      z: 1,
      depth: 0,
      cascaded: false,
    });
    const meeting = layout.chips.get('meeting')!;
    expect(meeting).toMatchObject({ depth: 1, cascaded: true, z: 2 });
    expect(meeting.left).toBeCloseTo(indent);
    expect(meeting.width).toBeCloseTo(1 - indent);
  });

  it('shares the width below the threshold and cascades from it on', () => {
    const near = layoutOverlaps(
      [item('a', at(9), at(10)), item('b', at(9) + SIDE_BY_SIDE_MINUTES - 1, at(10, 30))],
      WEEK,
    );
    expect(near.chips.get('b')).toMatchObject({ left: 0.5, cascaded: false });
    const later = layoutOverlaps(
      [item('a', at(9), at(10)), item('b', at(9) + SIDE_BY_SIDE_MINUTES, at(10, 30))],
      WEEK,
    );
    expect(later.chips.get('a')?.width).toBe(1);
    expect(later.chips.get('b')).toMatchObject({ cascaded: true, depth: 1 });
  });

  it('never squeezes a short meeting into a sliver under long overlapping blocks', () => {
    // Travel, a conference day, two holds: each starts an hour or more after the last.
    const items = [
      item('travel', at(6), at(12)),
      item('conference', at(8), at(18)),
      item('booth', at(10), at(15)),
      item('hotel', at(12), at(23)),
      item('call', at(13), at(13, 30)),
    ];
    const layout = layoutOverlaps(items, WEEK);
    expectAllAccountedFor(items, layout);
    const lefts = ['travel', 'conference', 'booth', 'hotel', 'call'].map(
      (k) => layout.chips.get(k)!.left,
    );
    // A staircase: each one sits a little right of the one beneath it.
    for (let i = 1; i < lefts.length; i++) expect(lefts[i]!).toBeGreaterThan(lefts[i - 1]!);
    for (const chip of layout.chips.values()) {
      expect(px(chip.width)).toBeGreaterThanOrEqual(WEEK.minChipPx);
    }
    // The call stays wide: more than half the column, not a fifth of it.
    expect(layout.chips.get('call')!.width).toBeGreaterThan(0.5);
    // Later starts are drawn on top.
    expect(layout.chips.get('call')!.z).toBeGreaterThan(layout.chips.get('hotel')!.z);
  });

  it('moves a cascade too deep back left rather than drawing it narrower than the minimum', () => {
    const items = Array.from({ length: 12 }, (_, i) => item(`block${i}`, at(6 + i), at(23)));
    const layout = layoutOverlaps(items, { columnPx: 80, minChipPx: 36 });
    expectAllAccountedFor(items, layout);
    for (const chip of layout.chips.values()) {
      expect(px(chip.width, 80)).toBeGreaterThanOrEqual(36 - 1e-9);
      expect(chip.left + chip.width).toBeCloseTo(1);
    }
  });

  it('folds what does not fit beside the others into a "+N" no narrower than the minimum', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((k) => item(k, at(12), at(12, 45)));
    const layout = layoutOverlaps(items, { columnPx: 100, minChipPx: 39 });
    expectAllAccountedFor(items, layout);
    // Two slots fit: one event and a "+4".
    expect([...layout.chips.keys()]).toEqual(['a']);
    expect(layout.chips.get('a')).toMatchObject({ left: 0, width: 0.5 });
    expect(layout.folds).toEqual([
      {
        key: 'fold-b',
        keys: ['b', 'c', 'd', 'e'],
        start: at(12),
        end: at(12, 45),
        left: 0.5,
        width: 0.5,
        z: 5,
      },
    ]);
  });

  it('fits one more chip in a column a hair short of the room, and no further (D-072)', () => {
    // Three meetings at noon in Week at 1440px: a column 115.86px inside,
    // about 1.1px short of three 39px slots (36px and the 3px gap).
    const noon = ['lp', 'panel', 'sync'].map((k) => item(k, at(12), at(12, 45)));
    const slot = MIN_CHIP_PX + 3;
    expect(MIN_CHIP_TOLERANCE_PX).toBe(0.5);
    const fits = (columnPx: number) => layoutOverlaps(noon, { columnPx, minChipPx: slot });

    const at1440 = fits(115.86);
    expect(at1440.folds).toEqual([]);
    expect([...at1440.chips.keys()].sort()).toEqual(['lp', 'panel', 'sync']);
    // Each at most half a pixel under its slot.
    for (const chip of at1440.chips.values()) {
      expect(chip.width * 115.86).toBeGreaterThanOrEqual(slot - MIN_CHIP_TOLERANCE_PX);
    }
    // The boundary: three slots each half a pixel short still fit; any less folds into a "+2".
    expect(fits(3 * (slot - MIN_CHIP_TOLERANCE_PX)).folds).toEqual([]);
    const short = fits(3 * (slot - MIN_CHIP_TOLERANCE_PX) - 0.01);
    expect([...short.chips.keys()]).toEqual(['lp']);
    expect(short.folds.map((f) => f.keys)).toEqual([['panel', 'sync']]);
    // With no tolerance, the hard minimum alone: the 1440 column folds.
    expect(
      layoutOverlaps(noon, { columnPx: 115.86, minChipPx: slot, tolerancePx: 0 }).folds,
    ).toHaveLength(1);
    // A cascade too deep still stops at the minimum itself.
    const deep = Array.from({ length: 12 }, (_, i) => item(`block${i}`, at(6 + i), at(23)));
    for (const chip of layoutOverlaps(deep, { columnPx: 80, minChipPx: 36 }).chips.values()) {
      expect(chip.width * 80).toBeGreaterThanOrEqual(36 - 1e-9);
    }
  });

  it('folds each stretch of crowded time on its own, and shows a lone one as itself', () => {
    // Three at once at 9:15, so the last slot folds ("x" drawn 20 minutes long, to 9:35);
    // at 9:40 only one is left over.
    const items = [
      item('a', at(9), at(11)),
      item('b', at(9, 10), at(9, 30)),
      item('x', at(9, 15), at(9, 25)),
      item('c', at(9, 40), at(10)),
    ];
    const layout = layoutOverlaps(items, { columnPx: 100, minChipPx: 50 });
    expectAllAccountedFor(items, layout);
    expect(layout.folds).toEqual([
      {
        key: 'fold-b',
        keys: ['b', 'x'],
        start: at(9, 10),
        end: at(9, 35),
        left: 0.5,
        width: 0.5,
        z: 3,
      },
    ]);
    // "a" keeps out of the slot the "+2" covers; "c", alone in its stretch, is drawn there.
    expect(layout.chips.get('a')).toMatchObject({ left: 0, width: 0.5 });
    expect(layout.chips.get('c')).toMatchObject({ left: 0.5, width: 0.5, z: 4 });
  });

  it('lays out the same however the events come in', () => {
    const items = [
      item('travel', at(6), at(11, 30)),
      item('summit', at(8), at(18)),
      item('coffee', at(9), at(9, 30)),
      item('booth', at(10), at(15)),
      item('pitch', at(11), at(11, 45)),
      item('lp', at(12), at(12, 45)),
      item('panel', at(12), at(12, 30)),
      item('sync', at(12, 15), at(12, 45)),
      item('word', at(13, 30), at(14, 30)),
      item('intro', at(14), at(14, 30)),
      item('hotel', at(15), at(23)),
      item('riley', at(16), at(16, 30)),
      item('maple', at(16, 15), at(17)),
      item('dinner', at(18, 30), at(21, 30)),
    ];
    const snapshot = (list: LayoutItem[]) => {
      const layout = layoutOverlaps(list, WEEK);
      expectAllAccountedFor(items, layout);
      return JSON.stringify({ chips: [...layout.chips.entries()].sort(), folds: layout.folds });
    };
    const first = snapshot(items);
    const reversed = snapshot([...items].reverse());
    const shuffled = snapshot([...items].sort((a, b) => a.key.localeCompare(b.key)));
    expect(reversed).toBe(first);
    expect(shuffled).toBe(first);
    for (const chip of layoutOverlaps(items, WEEK).chips.values()) {
      expect(px(chip.width)).toBeGreaterThanOrEqual(WEEK.minChipPx - 1e-9);
    }
  });

  it('counts a very short event as the room it takes, and keeps one key once', () => {
    const layout = layoutOverlaps(
      [item('a', at(9), at(9, 5)), item('a', at(15), at(16)), item('b', at(9, 10), at(9, 15))],
      WEEK,
    );
    expect([...layout.chips.keys()]).toEqual(['a', 'b']);
    expect(layout.chips.get('b')).toMatchObject({ left: 0.5, cascaded: false });
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
