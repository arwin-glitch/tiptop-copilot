import { describe, expect, it } from 'vitest';
import { DEFAULT_BOOKING_CONFIG } from '@/lib/booking/config';
import {
  holdsBefore,
  openSlots,
  slotProblem,
  slotProblemDetail,
  type BusyBlock,
  type EngineInput,
  type PickHold,
  WAITING_CLASH,
} from '@/lib/booking/engine';
import {
  checkPickRanges,
  mergeRanges,
  PICK_CREATE_INPUT,
  pickCandidateStarts,
  pickExpiresAt,
  pickOfferedStarts,
  pickStepMinutes,
} from '@/lib/booking/picks';
import {
  formatPickText,
  pickDayLines,
  rangeLabel,
  zoneShortName,
} from '@/lib/booking/picks-format';
import { wallTimeToUtc } from '@/lib/util/time';

/**
 * Pick times (Vimcal-style): the host's picked ranges, the starts they
 * offer, the words copied into his email, and how open picks hold their
 * times off the public link without ever counting as meetings. Pure; every
 * name is invented.
 */

const TZ = 'America/Chicago';
/** Monday 26 October 2026, 10:00 Central (CDT). The clocks go back on Sunday 1 November. */
const NOW = new Date('2026-10-26T15:00:00Z');
const TUE = '2026-10-27';
const WED = '2026-10-28';

const at = (day: string, h: number, m = 0, zone = TZ) => wallTimeToUtc(day, h, m, zone)!.getTime();
const iso = (day: string, h: number, m = 0, zone = TZ) =>
  new Date(at(day, h, m, zone)).toISOString();
const range = (day: string, from: [number, number], to: [number, number], zone = TZ) => ({
  start: iso(day, ...from, zone),
  end: iso(day, ...to, zone),
});

function input(over: Partial<EngineInput> = {}): EngineInput {
  return {
    now: NOW,
    hostZone: TZ,
    config: {
      ...structuredClone(DEFAULT_BOOKING_CONFIG),
      openMonths: ['2026-10', '2026-11'],
      homeCity: 'Harbor City',
    },
    busy: [],
    travelDays: new Set(),
    linkBookings: [],
    ...over,
  };
}

const hold = (
  day: string,
  from: [number, number],
  to: [number, number],
  pickId = 'p1',
): PickHold => ({
  pickId,
  start: at(day, ...from),
  end: at(day, ...to),
  createdAt: NOW.getTime(),
});

const CALL = { type: 'call' as const };

describe('the engine and open picks', () => {
  it('keeps a picked time off the public link, with the link buffer, as plain busy time', () => {
    const holds = [hold(WED, [10, 0], [11, 0])];
    const engine = input({ pickHolds: holds });
    // Inside the hold, and right against it (the 15-minute call buffer).
    expect(slotProblemDetail(engine, CALL, iso(WED, 10, 0))?.code).toBe('busy');
    expect(slotProblemDetail(engine, CALL, iso(WED, 9, 30))?.code).toBe('busy');
    expect(slotProblemDetail(engine, CALL, iso(WED, 11, 0))?.code).toBe('busy');
    expect(slotProblem(engine, CALL, iso(WED, 10, 0))).not.toBe(WAITING_CLASH);
    // Clear of the buffer: offered.
    expect(slotProblem(engine, CALL, iso(WED, 11, 30))).toBeNull();
    expect(slotProblem(engine, CALL, iso(WED, 9, 0))).toBeNull();
    // The day itself stays open: only those times close.
    const wed = openSlots(engine, CALL).filter((s) => s.date === WED);
    expect(wed.length).toBeGreaterThan(5);
    expect(wed.map((s) => s.start)).not.toContain(iso(WED, 10, 0));
  });

  it('counts holds toward no cap and no back-to-back run', () => {
    // Two meetings back to back: a third block touching them would make a run of three.
    const busy: BusyBlock[] = [
      {
        start: at(WED, 13, 0),
        end: at(WED, 13, 30),
        meeting: true,
        inPerson: false,
        allDay: false,
      },
      {
        start: at(WED, 13, 30),
        end: at(WED, 14, 0),
        meeting: true,
        inPerson: false,
        allDay: false,
      },
    ];
    const holds = [hold(WED, [14, 0], [14, 30]), hold(WED, [8, 0], [8, 30], 'p2')];
    const without = openSlots(input({ busy }), CALL).filter((s) => s.date === WED);
    const withHolds = openSlots(input({ busy, pickHolds: holds }), CALL).filter(
      (s) => s.date === WED,
    );
    // Only times near the holds go: nothing later in the day closes for a "run" or a cap.
    const near = (s: { start: string }) => {
      const t = Date.parse(s.start);
      return (
        (t >= at(WED, 7, 45) && t < at(WED, 8, 45)) || (t >= at(WED, 13, 15) && t < at(WED, 14, 45))
      );
    };
    expect(withHolds.map((s) => s.start)).toEqual(
      without.filter((s) => !near(s)).map((s) => s.start),
    );
    // Five holds on a day never reach the meeting cap (5) or the link cap (2).
    const many = [9, 10, 11, 12, 13].map((h, i) => hold(TUE, [h, 0], [h, 15], `m${i}`));
    expect(slotProblem(input({ pickHolds: many }), CALL, iso(WED, 15, 0))).toBeNull();
  });

  it("leaves a pick's own holds out when its guest books (ignorePickId)", () => {
    const holds = [hold(WED, [10, 0], [11, 0], 'mine'), hold(WED, [15, 0], [16, 0], 'other')];
    const engine = input({ pickHolds: holds, ignorePickId: 'mine' });
    expect(slotProblem(engine, CALL, iso(WED, 10, 0))).toBeNull();
    expect(slotProblemDetail(engine, CALL, iso(WED, 15, 0))?.code).toBe('busy');
  });

  it('never lets a newer pick release an older booking (holdsBefore)', () => {
    const older = { ...hold(WED, [10, 0], [11, 0], 'a'), createdAt: 1_000 };
    const newer = { ...hold(WED, [12, 0], [13, 0], 'b'), createdAt: 3_000 };
    expect(holdsBefore([older, newer], 2_000).map((h) => h.pickId)).toEqual(['a']);
  });

  it('does not count a booking made from picked times toward the link cap', () => {
    const booking = (id: string, h: number, picked: boolean) => ({
      id,
      start: at(WED, h, 0),
      end: at(WED, h, 30),
      type: 'call' as const,
      onCalendar: true,
      ...(picked ? { picked: true } : {}),
    });
    const capped = input({ linkBookings: [booking('a', 9, false), booking('b', 10, false)] });
    expect(slotProblemDetail(capped, CALL, iso(WED, 15, 0))?.code).toBe('link_cap');
    const picked = input({ linkBookings: [booking('a', 9, true), booking('b', 10, true)] });
    expect(slotProblem(picked, CALL, iso(WED, 15, 0))).toBeNull();
  });
});

describe('the starts a pick offers', () => {
  it('steps every 30 minutes from the range start, the meeting ending inside', () => {
    const starts = pickCandidateStarts([range(WED, [10, 0], [11, 15])], 30, NOW);
    expect(starts).toEqual([at(WED, 10, 0), at(WED, 10, 30)]);
    expect(pickStepMinutes(45)).toBe(30);
    const long = pickCandidateStarts([range(WED, [10, 0], [11, 30])], 60, NOW);
    expect(long).toEqual([at(WED, 10, 0), at(WED, 10, 30)]);
  });

  it('steps every 15 minutes for a 15-minute meeting, aligned to the range start', () => {
    const starts = pickCandidateStarts([range(WED, [10, 15], [11, 0])], 15, NOW);
    expect(starts).toEqual([at(WED, 10, 15), at(WED, 10, 30), at(WED, 10, 45)]);
  });

  it('drops starts that have passed', () => {
    const today = [range('2026-10-26', [9, 0], [11, 0])];
    expect(pickCandidateStarts(today, 30, NOW)).toEqual([at('2026-10-26', 10, 30)]);
  });

  it('counts wall-clock steps right across the November clock change', () => {
    // Sunday 1 November 2026, 1:00-3:00 AM Central: the 1 AM hour happens twice.
    const sunday = { start: '2026-11-01T06:00:00.000Z', end: '2026-11-01T09:00:00.000Z' };
    const starts = pickCandidateStarts([sunday], 60, NOW).map((t) => new Date(t).toISOString());
    expect(starts).toEqual([
      '2026-11-01T06:00:00.000Z',
      '2026-11-01T06:30:00.000Z',
      '2026-11-01T07:00:00.000Z',
      '2026-11-01T07:30:00.000Z',
      '2026-11-01T08:00:00.000Z',
    ]);
  });

  it('leaves out starts that overlap busy time, a booking or another hold (no buffers)', () => {
    const offered = pickOfferedStarts(
      { ranges: [range(WED, [9, 0], [12, 0])], durationMinutes: 30 },
      NOW,
      {
        busy: [{ start: at(WED, 9, 30), end: at(WED, 10, 0) }],
        bookings: [{ start: at(WED, 10, 30), end: at(WED, 11, 0) }],
        holds: [{ start: at(WED, 11, 30), end: at(WED, 11, 45) }],
      },
    );
    expect(offered.map((s) => s.start)).toEqual([iso(WED, 9, 0), iso(WED, 10, 0), iso(WED, 11, 0)]);
    expect(offered[0]!.end).toBe(iso(WED, 9, 30));
  });
});

describe('checking picked ranges', () => {
  it('merges touching and overlapping ranges', () => {
    const merged = mergeRanges([
      range(WED, [14, 0], [15, 0]),
      range(WED, [10, 0], [11, 0]),
      range(WED, [11, 0], [11, 30]),
      range(WED, [14, 30], [16, 0]),
    ]);
    expect(merged).toEqual([range(WED, [10, 0], [11, 30]), range(WED, [14, 0], [16, 0])]);
  });

  it('refuses the past, off-grid times, short ranges, too many and too far ahead', () => {
    expect(checkPickRanges([range('2026-10-26', [8, 0], [9, 0])], 30, NOW)).toMatchObject({
      ok: false,
    });
    expect(checkPickRanges([range(WED, [10, 5], [11, 0])], 30, NOW)).toMatchObject({ ok: false });
    expect(checkPickRanges([range(WED, [10, 0], [10, 15])], 30, NOW)).toMatchObject({
      ok: false,
      problem: 'Each picked time must be at least as long as the meeting.',
    });
    const far = new Date(NOW.getTime() + 61 * 86_400_000);
    expect(
      checkPickRanges(
        [{ start: far.toISOString(), end: new Date(far.getTime() + 3_600_000).toISOString() }],
        30,
        NOW,
      ),
    ).toMatchObject({ ok: false });
    const many = Array.from({ length: 21 }, (_, i) => ({
      start: new Date(at(WED, 8) + i * 3_600_000).toISOString(),
      end: new Date(at(WED, 8) + i * 3_600_000 + 1_800_000).toISOString(),
    }));
    expect(checkPickRanges(many, 30, NOW)).toMatchObject({
      ok: false,
      problem: 'Pick at most 20 times.',
    });
    expect(checkPickRanges([range(WED, [10, 0], [11, 0])], 30, NOW)).toEqual({
      ok: true,
      ranges: [range(WED, [10, 0], [11, 0])],
    });
  });

  it('holds until the hold ends or the last range ends, whichever is first', () => {
    const ranges = [range(WED, [10, 0], [11, 0])];
    expect(pickExpiresAt(NOW, 24, ranges)).toBe(new Date(NOW.getTime() + 86_400_000).toISOString());
    expect(pickExpiresAt(NOW, 168, ranges)).toBe(iso(WED, 11, 0));
  });

  it('validates the panel input: zones listed, hold lengths, quarter-hour lengths', () => {
    const ok = PICK_CREATE_INPUT.safeParse({
      ranges: [range(WED, [10, 0], [11, 0])],
      durationMinutes: 30,
      recipientTimeZone: 'Europe/London',
      recipientName: '  Pat <Lee>  ',
    });
    expect(ok.success).toBe(true);
    expect(ok.data).toMatchObject({ hold: true, holdHours: 48, meetingType: 'call' });
    expect(ok.data?.recipientName).toBe('Pat Lee');
    for (const bad of [
      { recipientTimeZone: 'Mars/Olympus' },
      { holdHours: 12 },
      { durationMinutes: 20 },
      { durationMinutes: 300 },
    ]) {
      expect(
        PICK_CREATE_INPUT.safeParse({
          ranges: [range(WED, [10, 0], [11, 0])],
          durationMinutes: 30,
          recipientTimeZone: 'America/Chicago',
          ...bad,
        }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
});

describe('the copied text', () => {
  const url = 'https://kraken.example/meet/nick/p/abc';

  it('writes one line per day in their zone, the zone, then the link', () => {
    const ranges = [
      range('2026-11-04', [9, 0], [9, 30]),
      range('2026-11-03', [14, 0], [14, 30]),
      range('2026-11-03', [10, 0], [11, 0]),
    ];
    const { text, html } = formatPickText({ ranges, timeZone: TZ, url });
    expect(text).toBe(
      [
        'Tue, Nov 3: 10:00 – 11:00 AM, 2:00 – 2:30 PM',
        'Wed, Nov 4: 9:00 – 9:30 AM',
        '(Central Time)',
        '',
        `Book one here: ${url}`,
      ].join('\n'),
    );
    expect(html).toContain(`<a href="${url}">${url}</a>`);
    expect(html).toContain('Tue, Nov 3: 10:00 – 11:00 AM, 2:00 – 2:30 PM<br>');
  });

  it('keeps wall-clock times right across the November clock change', () => {
    // Friday 30 October (CDT) and Tuesday 3 November (CST), both 10-11 AM local.
    const ranges = [range('2026-10-30', [10, 0], [11, 0]), range('2026-11-03', [10, 0], [11, 0])];
    expect(ranges[0]!.start.slice(11, 13)).toBe('15');
    expect(ranges[1]!.start.slice(11, 13)).toBe('16');
    expect(pickDayLines(ranges, TZ)).toEqual([
      'Fri, Oct 30: 10:00 – 11:00 AM',
      'Tue, Nov 3: 10:00 – 11:00 AM',
    ]);
  });

  it('writes the times in a non-US zone, and across noon', () => {
    const ranges = [range(WED, [11, 30], [12, 30])];
    // 11:30 AM-12:30 PM Central on 28 October is 4:30-5:30 PM in London (still on GMT).
    expect(pickDayLines(ranges, 'Europe/London')).toEqual(['Wed, Oct 28: 4:30 – 5:30 PM']);
    expect(rangeLabel(ranges[0]!.start, ranges[0]!.end, TZ)).toBe('11:30 AM – 12:30 PM');
    expect(zoneShortName('Asia/Tokyo')).toBe('Japan Standard Time');
    expect(zoneShortName('UTC')).toBe('UTC');
    const tokyo = formatPickText({ ranges, timeZone: 'Asia/Tokyo', url });
    expect(tokyo.text.split('\n')[0]).toBe('Thu, Oct 29: 1:30 – 2:30 AM');
    expect(tokyo.text).toContain('(Japan Standard Time)');
  });

  it('escapes the HTML and stands in for the link before it exists', () => {
    const { text, html } = formatPickText({
      ranges: [range(WED, [10, 0], [11, 0])],
      timeZone: TZ,
      url: 'https://kraken.example/meet/nick/p/a"b',
    });
    expect(html).toContain('a&quot;b');
    expect(text).toContain('Book one here: https://kraken.example');
    expect(formatPickText({ ranges: [], timeZone: TZ, url: null }).text).toContain(
      'Book one here: the link',
    );
  });
});
