import { describe, expect, it } from 'vitest';
import { checkPickRanges, MAX_PICK_RANGES, type PickRange } from '@/lib/booking/picks';
import {
  addPickRange,
  busyOverlaps,
  clickedRange,
  defaultPickZone,
  draggedRange,
  floorToSnap,
  freshRanges,
  futurePart,
  heldOverlap,
  holdUntilLabel,
  pickRangeAt,
  pickRangeKey,
  rangeLoaded,
  rememberBusy,
  pickZoneOptions,
  rangeOnDay,
  removePickRange,
  stretchRanges,
  takesTime,
} from '@/lib/calendar/pick-selection';
import type { RangeEvent } from '@/lib/calendar/range-types';

const TZ = 'America/Chicago';
// Wed Oct 28 2026, 9:07 AM in Chicago (CDT, UTC-5).
const NOW = new Date('2026-10-28T14:07:00Z');

const range = (start: string, end: string): PickRange => ({
  start: new Date(start).toISOString(),
  end: new Date(end).toISOString(),
});

function event(over: Partial<RangeEvent>): RangeEvent {
  return {
    key: 'cal␟e1',
    id: 'e1',
    calendarId: 'cal',
    title: 'Coffee with Pat Lee',
    allDay: false,
    startsAt: '2026-10-29T15:00:00.000Z',
    endsAt: '2026-10-29T16:00:00.000Z',
    transparent: false,
    myResponse: 'accepted',
    ...over,
  } as RangeEvent;
}

describe('a click picks a slot as long as the meeting', () => {
  it('starts on the 15-minute mark at or before the click', () => {
    // 10:07 AM on Thu Oct 29, 30 minutes.
    expect(clickedRange('2026-10-29', 10 * 60 + 7, 30, TZ)).toEqual(
      range('2026-10-29T15:00:00Z', '2026-10-29T15:30:00Z'),
    );
    expect(clickedRange('2026-10-29', 10 * 60 + 44, 60, TZ)).toEqual(
      range('2026-10-29T15:30:00Z', '2026-10-29T16:30:00Z'),
    );
  });

  it('moves earlier rather than run past midnight', () => {
    expect(clickedRange('2026-10-29', 23 * 60 + 50, 45, TZ)).toEqual(
      range('2026-10-30T04:15:00Z', '2026-10-30T05:00:00Z'),
    );
  });

  it('reads wall time on the day the clocks change (Nov 1 2026)', () => {
    // 9 AM CST is 15:00 UTC after the change.
    expect(clickedRange('2026-11-02', 9 * 60, 30, TZ)).toEqual(
      range('2026-11-02T15:00:00Z', '2026-11-02T15:30:00Z'),
    );
  });

  it('floors minutes to the quarter hour', () => {
    expect(floorToSnap(14)).toBe(0);
    expect(floorToSnap(15)).toBe(15);
    expect(floorToSnap(59)).toBe(45);
  });
});

describe('a drag picks the time dragged over', () => {
  it('rounds both ends to 15 minutes, in either direction', () => {
    expect(draggedRange('2026-10-29', 9 * 60 + 8, 11 * 60 + 52, 30, TZ)).toEqual(
      range('2026-10-29T14:15:00Z', '2026-10-29T16:45:00Z'),
    );
    expect(draggedRange('2026-10-29', 11 * 60 + 52, 9 * 60 + 8, 30, TZ)).toEqual(
      range('2026-10-29T14:15:00Z', '2026-10-29T16:45:00Z'),
    );
  });

  it('is never shorter than the meeting', () => {
    expect(draggedRange('2026-10-29', 9 * 60, 9 * 60 + 10, 45, TZ)).toEqual(
      range('2026-10-29T14:00:00Z', '2026-10-29T14:45:00Z'),
    );
  });

  it('stops at midnight', () => {
    expect(draggedRange('2026-10-29', 23 * 60 + 40, 23 * 60 + 55, 60, TZ)).toEqual(
      range('2026-10-30T04:00:00Z', '2026-10-30T05:00:00Z'),
    );
  });
});

describe('the selection', () => {
  it('adds a range, merging ones that touch or overlap', () => {
    const a = range('2026-10-29T15:00:00Z', '2026-10-29T15:30:00Z');
    const b = range('2026-10-29T15:30:00Z', '2026-10-29T16:00:00Z');
    const c = range('2026-10-29T15:45:00Z', '2026-10-29T16:30:00Z');
    const one = addPickRange([], a, NOW);
    expect(one).toEqual({ ok: true, ranges: [a] });
    const two = addPickRange([a], b, NOW);
    expect(two).toEqual({
      ok: true,
      ranges: [range('2026-10-29T15:00:00Z', '2026-10-29T16:00:00Z')],
    });
    const three = addPickRange(two.ok ? two.ranges : [], c, NOW);
    expect(three).toEqual({
      ok: true,
      ranges: [range('2026-10-29T15:00:00Z', '2026-10-29T16:30:00Z')],
    });
  });

  it('keeps ranges in time order', () => {
    const later = range('2026-10-30T15:00:00Z', '2026-10-30T15:30:00Z');
    const sooner = range('2026-10-29T15:00:00Z', '2026-10-29T15:30:00Z');
    expect(addPickRange([later], sooner, NOW)).toEqual({ ok: true, ranges: [sooner, later] });
  });

  it('refuses a time that has passed, and moves one under way whole', () => {
    expect(addPickRange([], range('2026-10-28T13:00:00Z', '2026-10-28T14:00:00Z'), NOW)).toEqual({
      ok: false,
      problem: 'That time has already passed.',
    });
    // 9:00-10:00 AM while it is 9:07: 9:15-10:15, still an hour.
    expect(addPickRange([], range('2026-10-28T14:00:00Z', '2026-10-28T15:00:00Z'), NOW)).toEqual({
      ok: true,
      ranges: [range('2026-10-28T14:15:00Z', '2026-10-28T15:15:00Z')],
    });
    // Less than 15 minutes left: dropped.
    expect(futurePart(range('2026-10-28T14:00:00Z', '2026-10-28T14:20:00Z'), NOW)).toBeNull();
  });

  it('never makes a click near now shorter than the meeting', () => {
    // 9:07, a click at 9:05 for 30 minutes: 9:00-9:30 moves to 9:15-9:45, not 9:15-9:30.
    const clicked = clickedRange('2026-10-28', 9 * 60 + 5, 30, TZ);
    const added = addPickRange([], clicked, NOW);
    expect(added).toEqual({
      ok: true,
      ranges: [range('2026-10-28T14:15:00Z', '2026-10-28T14:45:00Z')],
    });
    if (added.ok) expect(checkPickRanges(added.ranges, 30, NOW).ok).toBe(true);
  });

  it('drops a part under way that no longer fits the meeting, instead of keeping a stub', () => {
    // 9:00-9:30 while it is 9:07: 9:15-9:30 is left, too short for 30 minutes.
    const underWay = range('2026-10-28T14:00:00Z', '2026-10-28T14:30:00Z');
    expect(futurePart(underWay, NOW, 30)).toBeNull();
    expect(freshRanges([underWay], NOW, 30)).toEqual([]);
    // It fits a 15-minute meeting.
    expect(freshRanges([underWay], NOW, 15)).toEqual([
      range('2026-10-28T14:15:00Z', '2026-10-28T14:30:00Z'),
    ]);
  });

  it('stretches times shorter than a longer meeting, merging what then touches', () => {
    const a = range('2026-10-29T15:00:00Z', '2026-10-29T15:30:00Z');
    const b = range('2026-10-29T16:00:00Z', '2026-10-29T16:30:00Z');
    const long = range('2026-10-30T15:00:00Z', '2026-10-30T17:00:00Z');
    const stretched = stretchRanges([a, b, long], 60);
    expect(stretched).toEqual([range('2026-10-29T15:00:00Z', '2026-10-29T17:00:00Z'), long]);
    expect(checkPickRanges(stretched, 60, NOW).ok).toBe(true);
    // A shorter meeting leaves them as they are.
    expect(stretchRanges([a, b], 15)).toEqual([a, b]);
  });

  it('refuses a time more than 60 days ahead', () => {
    const far = range('2026-12-28T15:00:00Z', '2026-12-28T15:30:00Z');
    expect(addPickRange([], far, NOW)).toEqual({
      ok: false,
      problem: 'Pick times within the next 60 days.',
    });
  });

  it('holds at most 20 ranges, and leaves the selection as it was', () => {
    const many = Array.from({ length: MAX_PICK_RANGES }, (_, i) =>
      range(
        `2026-11-${String(i + 3).padStart(2, '0')}T16:00:00Z`,
        `2026-11-${String(i + 3).padStart(2, '0')}T16:30:00Z`,
      ),
    );
    const full = addPickRange([], many[0]!, NOW);
    expect(full.ok).toBe(true);
    let ranges: PickRange[] = [];
    for (const r of many) {
      const next = addPickRange(ranges, r, NOW);
      if (next.ok) ranges = next.ranges;
    }
    expect(ranges).toHaveLength(MAX_PICK_RANGES);
    const extra = range('2026-11-29T16:00:00Z', '2026-11-29T16:30:00Z');
    expect(addPickRange(ranges, extra, NOW)).toEqual({
      ok: false,
      problem: 'Pick at most 20 times.',
    });
    // One that merges into a range already there is still welcome.
    const touching = range('2026-11-03T16:30:00Z', '2026-11-03T17:00:00Z');
    expect(addPickRange(ranges, touching, NOW).ok).toBe(true);
  });

  it('removes the range a click lands on', () => {
    const a = range('2026-10-29T15:00:00Z', '2026-10-29T15:30:00Z');
    const b = range('2026-10-30T15:00:00Z', '2026-10-30T16:00:00Z');
    expect(pickRangeAt([a, b], Date.parse('2026-10-30T15:20:00Z'))).toEqual(b);
    expect(pickRangeAt([a, b], Date.parse('2026-10-30T16:00:00Z'))).toBeNull();
    expect(removePickRange([a, b], b.start)).toEqual([a]);
  });

  it('drops what has passed before Copy', () => {
    const past = range('2026-10-28T13:00:00Z', '2026-10-28T13:30:00Z');
    const ahead = range('2026-10-29T15:00:00Z', '2026-10-29T15:30:00Z');
    expect(freshRanges([past, ahead], NOW)).toEqual([ahead]);
  });
});

describe('the busy warning', () => {
  const picked = range('2026-10-29T15:30:00Z', '2026-10-29T16:30:00Z');

  it('flags a timed event that takes time', () => {
    expect(busyOverlaps(picked, [event({})])).toHaveLength(1);
  });

  it('ignores free, declined, all-day and touching events', () => {
    expect(takesTime(event({ transparent: true }))).toBe(false);
    expect(takesTime(event({ myResponse: 'declined' }))).toBe(false);
    expect(
      takesTime(
        event({
          allDay: true,
          startsAt: null,
          endsAt: null,
          startDate: '2026-10-29',
          endDate: '2026-10-30',
        }),
      ),
    ).toBe(false);
    const touching = event({
      startsAt: '2026-10-29T16:30:00.000Z',
      endsAt: '2026-10-29T17:00:00.000Z',
    });
    expect(busyOverlaps(picked, [touching])).toHaveLength(0);
  });
});

describe('the busy warning across weeks', () => {
  const picked = range('2026-10-29T15:30:00Z', '2026-10-29T16:30:00Z');
  const thisWeek = { from: '2026-10-25', to: '2026-11-01' };
  const nextWeek = { from: '2026-11-01', to: '2026-11-08' };

  it('knows when a range is in the days loaded', () => {
    expect(rangeLoaded(picked, thisWeek, TZ)).toBe(true);
    expect(rangeLoaded(picked, nextWeek, TZ)).toBe(false);
    expect(rangeLoaded(picked, null, TZ)).toBe(false);
  });

  it('keeps a range overlapping an event flagged after moving to another week', () => {
    const seen = rememberBusy({}, [picked], [event({})], thisWeek, TZ);
    expect(seen[pickRangeKey(picked)]).toEqual(['Coffee with Pat Lee']);
    // Next week is loaded: that event is not in the list any more, the flag stays.
    const later = rememberBusy(seen, [picked], [], nextWeek, TZ);
    expect(later).toBe(seen);
    // Back on its week with the event gone: cleared.
    const cleared = rememberBusy(seen, [picked], [], thisWeek, TZ);
    expect(cleared[pickRangeKey(picked)]).toEqual([]);
    // A range no longer picked is forgotten.
    expect(rememberBusy(cleared, [], [], thisWeek, TZ)).toEqual({});
  });
});

describe('times held by another pick', () => {
  it('names who holds a picked range, and nothing for touching times', () => {
    const picked = range('2026-10-29T15:00:00Z', '2026-10-29T16:00:00Z');
    const held = [
      { start: '2026-10-29T16:00:00.000Z', end: '2026-10-29T17:00:00.000Z', name: 'Sam' },
      { start: '2026-10-29T15:30:00.000Z', end: '2026-10-29T16:00:00.000Z', name: 'Pat' },
    ];
    expect(heldOverlap(picked, held)?.name).toBe('Pat');
    expect(heldOverlap(picked, held.slice(0, 1))).toBeNull();
  });
});

describe('when a pick stops holding', () => {
  it('names the day within the week, and the date from six days out', () => {
    // Wed Oct 28, 9:07 AM Central.
    expect(holdUntilLabel('2026-10-30T20:00:00Z', TZ, NOW.getTime())).toBe('Fri 3:00 PM');
    expect(holdUntilLabel('2026-11-04T21:00:00Z', TZ, NOW.getTime())).toBe('Wed, Nov 4, 3:00 PM');
  });
});

describe('drawing a picked range', () => {
  it('as minutes on its day, and nothing on other days', () => {
    const r = range('2026-10-29T15:00:00Z', '2026-10-29T16:30:00Z');
    expect(rangeOnDay(r, '2026-10-29', TZ)).toEqual({ start: 600, end: 690 });
    expect(rangeOnDay(r, '2026-10-30', TZ)).toBeNull();
  });
});

describe('their time zone', () => {
  it("starts on Nick's zone when it is listed", () => {
    expect(defaultPickZone('America/Chicago')).toBe('America/Chicago');
    expect(pickZoneOptions('America/Chicago')[0]).toBe('America/Chicago');
  });

  it('falls back to a listed zone with the same name, else the first listed', () => {
    expect(defaultPickZone('America/Winnipeg')).toBe('America/Chicago');
    expect(defaultPickZone('Not/A_Zone')).toBe('America/Chicago');
  });

  it('lists each zone once', () => {
    const zones = pickZoneOptions('Asia/Tokyo');
    expect(zones[0]).toBe('Asia/Tokyo');
    expect(new Set(zones).size).toBe(zones.length);
  });
});
