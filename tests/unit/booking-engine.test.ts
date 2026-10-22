import { describe, expect, it } from 'vitest';
import { DEFAULT_BOOKING_CONFIG, type BookingConfig } from '@/lib/booking/config';
import {
  backToBackRuns,
  bookingsBefore,
  candidateStarts,
  openSlots,
  slotProblem,
  weekdayOf,
  type BusyBlock,
  type EngineInput,
  type LinkBooking,
  type OpenSlot,
  WAITING_CLASH,
} from '@/lib/booking/engine';
import { dayKeyIn, slotLabel, timeLabel } from '@/lib/booking/public';
import { localClock, wallTimeToUtc } from '@/lib/util/time';

/**
 * The booking link's slot engine against every rule (D-074): Tuesday to
 * Thursday only, the windows, notice and horizon, buffers (15 minutes for a
 * call, 30 for in person and around anyone else's in-person meeting), the
 * back-to-back stack rule, travel days, the daily caps, the link's own
 * waiting requests, the approval re-check, the clock change weeks, and the
 * visitor's own time zone. Times are the host's (Central) unless named.
 */

const TZ = 'America/Chicago';
/** Monday 26 October 2026, 10:00 Central (CDT). The clocks go back on Sunday 1 November. */
const NOW = new Date('2026-10-26T15:00:00Z');

const TUE = '2026-10-27';
const WED = '2026-10-28';
const THU = '2026-10-29';
const FRI = '2026-10-30';

const at = (day: string, h: number, m = 0) => wallTimeToUtc(day, h, m, TZ)!.getTime();
const iso = (day: string, h: number, m = 0) => new Date(at(day, h, m)).toISOString();

function block(
  day: string,
  from: [number, number],
  to: [number, number],
  over: Partial<BusyBlock> = {},
): BusyBlock {
  return {
    start: at(day, ...from),
    end: at(day, ...to),
    meeting: true,
    inPerson: false,
    allDay: false,
    ...over,
  };
}

function allDay(day: string, nextDay: string): BusyBlock {
  return { start: at(day, 0), end: at(nextDay, 0), meeting: false, inPerson: false, allDay: true };
}

function input(over: Partial<EngineInput> = {}, config: Partial<BookingConfig> = {}): EngineInput {
  return {
    now: NOW,
    hostZone: TZ,
    config: { ...structuredClone(DEFAULT_BOOKING_CONFIG), homeCity: 'Harbor City', ...config },
    busy: [],
    travelDays: new Set(),
    linkBookings: [],
    ...over,
  };
}

const CALL = { type: 'call' as const };
const COFFEE = { type: 'in_person' as const, kind: 'coffee' as const };
const LUNCH = { type: 'in_person' as const, kind: 'lunch' as const };
const DINNER = { type: 'in_person' as const, kind: 'dinner' as const };

const clock = (value: string, zone = TZ) => {
  const c = localClock(new Date(value), zone);
  return `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;
};

const startsOn = (slots: OpenSlot[], day: string) =>
  slots.filter((s) => s.date === day).map((s) => clock(s.start));

describe('days', () => {
  it('offers Tuesday, Wednesday and Thursday, never Monday, Friday or the weekend', () => {
    const slots = openSlots(input(), CALL);
    const days = [...new Set(slots.map((s) => s.date))];
    expect(days.length).toBeGreaterThan(5);
    for (const day of days) expect([2, 3, 4]).toContain(weekdayOf(day));
    expect(days).toContain(TUE);
    expect(days).toContain(WED);
    expect(days).toContain(THU);
    expect(days).not.toContain(FRI);
    expect(days).not.toContain('2026-11-02');
    expect(slotProblem(input(), CALL, iso(FRI, 10))).toBe(
      'Meetings are only on Tuesday, Wednesday and Thursday.',
    );
    expect(slotProblem(input(), CALL, iso('2026-11-02', 10))).toMatch(/Tuesday/);
  });

  it('keeps to the days Settings leaves on, and never adds one outside Tuesday to Thursday', () => {
    const slots = openSlots(input({}, { weekdays: [3] }), CALL);
    expect(new Set(slots.map((s) => weekdayOf(s.date)))).toEqual(new Set([3]));
    // Even a stored list that names Monday or Friday offers neither.
    const sneaky = openSlots(input({}, { weekdays: [1, 3, 5] }), CALL);
    expect(new Set(sneaky.map((s) => weekdayOf(s.date)))).toEqual(new Set([3]));
  });
});

describe('windows', () => {
  it('fits a whole call inside 9:00 to 17:00', () => {
    const wed = startsOn(openSlots(input(), CALL), WED);
    expect(wed[0]).toBe('09:00');
    expect(wed.at(-1)).toBe('16:30');
    expect(wed).toHaveLength(16);
    expect(slotProblem(input(), CALL, iso(WED, 17, 0))).toBe(
      'That time is outside the hours for calls.',
    );
    expect(slotProblem(input(), CALL, iso(WED, 8, 30))).toMatch(/outside the hours/);
    // A start off the half-hour grid is not one the page offered.
    expect(slotProblem(input(), CALL, iso(WED, 10, 15))).toMatch(/outside the hours/);
  });

  it('starts coffee, lunch and dinner inside their own windows', () => {
    expect(startsOn(openSlots(input(), COFFEE), WED)).toEqual([
      '08:30',
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
      '14:00',
      '14:30',
      '15:00',
      '15:30',
      '16:00',
    ]);
    expect(startsOn(openSlots(input(), LUNCH), WED)).toEqual(['11:30', '12:00', '12:30', '13:00']);
    expect(startsOn(openSlots(input(), DINNER), WED)).toEqual(['18:00', '18:30', '19:00', '19:30']);
    expect(slotProblem(input(), COFFEE, iso(WED, 12, 0))).toBe(
      'That time is outside the hours for this kind of meeting.',
    );
    expect(slotProblem(input(), { type: 'in_person' }, iso(WED, 9, 0))).toBe(
      'Pick coffee, lunch or dinner.',
    );
  });

  it('lasts 30 minutes for a call and an hour in person', () => {
    const call = openSlots(input(), CALL)[0]!;
    expect(Date.parse(call.end) - Date.parse(call.start)).toBe(30 * 60_000);
    const coffee = openSlots(input(), COFFEE)[0]!;
    expect(Date.parse(coffee.end) - Date.parse(coffee.start)).toBe(60 * 60_000);
  });

  it('reads the windows from Settings', () => {
    const slots = openSlots(input({}, { callWindow: { from: '13:00', to: '15:00' } }), CALL);
    expect(startsOn(slots, WED)).toEqual(['13:00', '13:30', '14:00', '14:30']);
    expect(candidateStarts(WED, CALL, input().config, TZ)).toHaveLength(16);
  });
});

describe('notice and horizon', () => {
  it('needs at least 24 hours of notice', () => {
    const tue = startsOn(openSlots(input(), CALL), TUE);
    expect(tue[0]).toBe('10:00');
    expect(slotProblem(input(), CALL, iso(TUE, 9, 30))).toBe(
      'That time is less than 24 hours ahead.',
    );
    expect(slotProblem(input(), CALL, iso(TUE, 10, 0))).toBeNull();
  });

  it('looks at most 21 days ahead', () => {
    const slots = openSlots(input(), CALL);
    expect(slots.at(-1)!.date).toBe('2026-11-12');
    expect(slotProblem(input(), CALL, iso('2026-11-17', 10))).toBe(
      'That time is more than 21 days ahead.',
    );
    expect(openSlots(input({}, { horizonDays: 3 }), CALL).at(-1)!.date).toBe(THU);
  });
});

describe('the clock change weeks', () => {
  it('keeps 10:00 Central at 10:00 on both sides of the November change', () => {
    const slots = openSlots(input(), CALL);
    const before = slots.find((s) => s.date === TUE && clock(s.start) === '10:00');
    const after = slots.find((s) => s.date === '2026-11-03' && clock(s.start) === '10:00');
    // 10:00 CDT is 15:00 UTC; a week later 10:00 CST is 16:00 UTC.
    expect(before?.start).toBe('2026-10-27T15:00:00.000Z');
    expect(after?.start).toBe('2026-11-03T16:00:00.000Z');
    expect(startsOn(slots, '2026-11-04')).toHaveLength(16);
  });

  it('and on both sides of the March change', () => {
    const now = new Date('2027-03-08T16:00:00Z'); // Monday 10:00 CST; clocks go forward 14 March.
    const slots = openSlots(input({ now }), CALL);
    expect(slots.find((s) => s.date === '2027-03-09' && clock(s.start) === '10:00')?.start).toBe(
      '2027-03-09T16:00:00.000Z',
    );
    expect(slots.find((s) => s.date === '2027-03-16' && clock(s.start) === '10:00')?.start).toBe(
      '2027-03-16T15:00:00.000Z',
    );
    expect(startsOn(slots, '2027-03-17')).toHaveLength(16);
  });

  it('keeps in-person windows on the wall clock too', () => {
    const slots = openSlots(input(), DINNER);
    expect(slots.find((s) => s.date === TUE)?.start).toBe('2026-10-27T23:00:00.000Z');
    expect(slots.find((s) => s.date === '2026-11-03')?.start).toBe('2026-11-04T00:00:00.000Z');
  });
});

describe('buffers', () => {
  it('keeps 15 minutes free on each side of a call', () => {
    const busy = [block(WED, [10, 10], [11, 0]), block(WED, [13, 0], [13, 50])];
    const wed = startsOn(openSlots(input({ busy }), CALL), WED);
    expect(wed).toContain('09:00');
    expect(wed).not.toContain('09:30'); // ends 10:00, 10 minutes before
    expect(wed).not.toContain('11:00'); // starts right after
    expect(wed).toContain('11:30'); // 30 minutes after
    expect(wed).toContain('12:00'); // ends 12:30, 30 minutes before 13:00
    expect(wed).not.toContain('14:00'); // starts 10 minutes after 13:50
    expect(wed).toContain('14:30');
    expect(slotProblem(input({ busy }), CALL, iso(WED, 9, 30))).toBe(
      'That time is too close to another meeting.',
    );
  });

  it('keeps 30 minutes free on each side of an in-person meeting, for travel', () => {
    const busy = [block(WED, [10, 20], [10, 50])];
    const coffee = startsOn(openSlots(input({ busy }), COFFEE), WED);
    expect(coffee).toContain('08:30'); // ends 9:30, 50 minutes before
    expect(coffee).not.toContain('09:00'); // ends 10:00, 20 minutes before
    expect(coffee).not.toContain('11:00'); // starts 10 minutes after
    expect(coffee).toContain('14:00');
    // The same 20 minutes is enough for a call.
    expect(startsOn(openSlots(input({ busy }), CALL), WED)).toContain('09:30');
  });

  it('keeps 30 minutes around anyone’s in-person meeting, even for a call', () => {
    const busy = [block(WED, [11, 0], [12, 0], { inPerson: true })];
    const wed = startsOn(openSlots(input({ busy }), CALL), WED);
    expect(wed).not.toContain('10:30');
    expect(wed).toContain('10:00');
    expect(wed).not.toContain('12:00');
    expect(wed).toContain('12:30');
  });

  it('reads the buffers from Settings', () => {
    const busy = [block(WED, [11, 0], [12, 0])];
    const wed = startsOn(openSlots(input({ busy }, { callBufferMinutes: 45 }), CALL), WED);
    expect(wed).not.toContain('10:00');
    expect(wed).toContain('09:30');
    expect(wed).not.toContain('12:30');
    expect(wed).toContain('13:00');
  });

  it('treats an opaque all-day entry as the whole day busy', () => {
    const busy = [allDay(WED, THU)];
    expect(startsOn(openSlots(input({ busy }), CALL), WED)).toEqual([]);
    expect(startsOn(openSlots(input({ busy }), COFFEE), WED)).toEqual([]);
    expect(startsOn(openSlots(input({ busy }), CALL), THU)).toHaveLength(16);
    expect(slotProblem(input({ busy }), CALL, iso(WED, 10))).toBe('That day is busy all day.');
  });
});

describe('back-to-back stacks', () => {
  // 13:20-13:50, 13:50-14:20, 14:25-14:55: three with gaps under 15 minutes.
  const stack = [
    block(THU, [13, 20], [13, 50]),
    block(THU, [13, 50], [14, 20]),
    block(THU, [14, 25], [14, 55]),
  ];

  it('finds runs of three or more with gaps under 15 minutes', () => {
    expect(backToBackRuns(stack, 15, 3)).toEqual([
      { start: at(THU, 13, 20), end: at(THU, 14, 55), count: 3 },
    ]);
    expect(backToBackRuns(stack.slice(0, 2), 15, 3)).toEqual([]);
    // A gap of exactly 15 minutes is not back to back.
    const split = [
      block(THU, [13, 20], [13, 50]),
      block(THU, [14, 5], [14, 35]),
      block(THU, [14, 35], [15, 5]),
    ];
    expect(backToBackRuns(split, 15, 3)).toEqual([]);
    // All-day entries are never part of a run.
    expect(backToBackRuns([...stack.slice(0, 2), allDay(THU, FRI)], 15, 3)).toEqual([]);
  });

  it('offers nothing touching the run, the hour after it, or the half hour before it', () => {
    const thu = startsOn(openSlots(input({ busy: stack }), CALL), THU);
    expect(thu).toContain('12:00');
    // Ends 13:00, 20 minutes before the run: fine for a lone meeting, not before a stack.
    expect(thu).not.toContain('12:30');
    // The run ends 14:55: nothing starts before 15:55.
    expect(thu).not.toContain('15:00');
    expect(thu).not.toContain('15:30');
    expect(thu).toContain('16:00');
    expect(slotProblem(input({ busy: stack }), CALL, iso(THU, 15, 30))).toBe(
      'That time is right after 3 meetings back to back.',
    );
  });

  it('leaves the same times open around two meetings', () => {
    const thu = startsOn(openSlots(input({ busy: stack.slice(0, 2) }), CALL), THU);
    expect(thu).toContain('12:30');
    expect(thu).toContain('15:00');
  });

  it('counts the link’s own waiting requests in a run', () => {
    const linkBookings: LinkBooking[] = [
      { id: 'r1', start: at(THU, 14, 25), end: at(THU, 14, 55), type: 'call', onCalendar: false },
    ];
    const thu = startsOn(openSlots(input({ busy: stack.slice(0, 2), linkBookings }), CALL), THU);
    expect(thu).not.toContain('15:30');
  });

  it('reads the run size, gap, cooldown and lead from Settings', () => {
    const relaxed = startsOn(openSlots(input({ busy: stack }, { stackSize: 4 }), CALL), THU);
    expect(relaxed).toContain('12:30');
    expect(relaxed).toContain('15:30');
    const longer = startsOn(
      openSlots(input({ busy: stack }, { stackCooldownMinutes: 90 }), CALL),
      THU,
    );
    expect(longer).not.toContain('16:00');
    expect(longer).toContain('16:30');
  });
});

describe('travel days', () => {
  it('offers no in-person meeting on a day away, and calls as usual', () => {
    const travelDays = new Set([WED]);
    expect(startsOn(openSlots(input({ travelDays }), COFFEE), WED)).toEqual([]);
    expect(startsOn(openSlots(input({ travelDays }), COFFEE), THU).length).toBeGreaterThan(0);
    expect(startsOn(openSlots(input({ travelDays }), CALL), WED)).toHaveLength(16);
    expect(slotProblem(input({ travelDays }), LUNCH, iso(WED, 12))).toBe(
      'The host is away that day.',
    );
  });

  it('pauses in person everywhere while the calendar is set to another time zone', () => {
    expect(openSlots(input({ inPersonPaused: true }), COFFEE)).toEqual([]);
    expect(openSlots(input({ inPersonPaused: true }), CALL).length).toBeGreaterThan(0);
  });
});

describe('daily caps', () => {
  const pending = (id: string, day: string, h: number): LinkBooking => ({
    id,
    start: at(day, h),
    end: at(day, h, 30),
    type: 'call',
    onCalendar: false,
  });

  it('takes at most two link bookings a day, waiting and approved', () => {
    const one = startsOn(openSlots(input({ linkBookings: [pending('a', WED, 9)] }), CALL), WED);
    expect(one.length).toBeGreaterThan(0);
    const approved: LinkBooking = { ...pending('b', WED, 15), onCalendar: true };
    const two = openSlots(
      input({
        linkBookings: [pending('a', WED, 9), approved],
        busy: [block(WED, [15, 0], [15, 30])],
      }),
      CALL,
    );
    expect(startsOn(two, WED)).toEqual([]);
    expect(startsOn(two, THU)).toHaveLength(16);
    expect(
      slotProblem(input({ linkBookings: [pending('a', WED, 9), approved] }), CALL, iso(WED, 13)),
    ).toBe('That day already has 2 bookings from the link.');
  });

  it('offers nothing on a day that already has five meetings', () => {
    const evening = [17, 18, 19, 20, 21].map((h) => block(WED, [h, 0], [h, 30]));
    expect(startsOn(openSlots(input({ busy: evening }), CALL), WED)).toEqual([]);
    expect(slotProblem(input({ busy: evening }), CALL, iso(WED, 10))).toBe(
      'That day already has 5 meetings.',
    );
    // Four is fine, and blocks and holds are not meetings.
    expect(
      startsOn(openSlots(input({ busy: evening.slice(1) }), CALL), WED).length,
    ).toBeGreaterThan(0);
    const holds = evening.map((b) => ({ ...b, meeting: false }));
    expect(startsOn(openSlots(input({ busy: holds }), CALL), WED).length).toBeGreaterThan(0);
  });

  it('reads both caps from Settings', () => {
    const one = openSlots(
      input({ linkBookings: [pending('a', WED, 9)] }, { maxLinkBookingsPerDay: 1 }),
      CALL,
    );
    expect(startsOn(one, WED)).toEqual([]);
    const two = openSlots(
      input({ busy: [block(WED, [7, 0], [7, 30])] }, { maxMeetingsPerDay: 1 }),
      CALL,
    );
    expect(startsOn(two, WED)).toEqual([]);
  });
});

describe('the link’s own waiting requests', () => {
  it('hold their time like a meeting until someone decides', () => {
    const linkBookings: LinkBooking[] = [
      { id: 'r1', start: at(WED, 10), end: at(WED, 10, 30), type: 'call', onCalendar: false },
    ];
    const wed = startsOn(openSlots(input({ linkBookings }), CALL), WED);
    expect(wed).not.toContain('10:00');
    expect(wed).not.toContain('10:30');
    expect(wed).toContain('11:00');
  });
});

describe('the approval re-check', () => {
  const request: LinkBooking = {
    id: 'mine',
    start: at(TUE, 10),
    end: at(TUE, 10, 30),
    type: 'call',
    onCalendar: false,
  };

  it('leaves the request itself out, so it never blocks its own time', () => {
    expect(slotProblem(input({ linkBookings: [request] }), CALL, iso(TUE, 10))).not.toBeNull();
    expect(slotProblem(input({ linkBookings: [request] }), CALL, iso(TUE, 10), 'mine')).toBeNull();
  });

  it('measures notice from when it was asked, and still wants an hour', () => {
    const asked = { askedAt: NOW, linkBookings: [request] };
    const tuesdayMorning = new Date(at(TUE, 8));
    expect(
      slotProblem(input({ ...asked, now: tuesdayMorning }), CALL, iso(TUE, 10), 'mine'),
    ).toBeNull();
    const tooLate = new Date(at(TUE, 9, 30));
    expect(slotProblem(input({ ...asked, now: tooLate }), CALL, iso(TUE, 10), 'mine')).toBe(
      'That time is too close now.',
    );
  });

  it('refuses a time that a new meeting now overlaps', () => {
    const busy = [block(TUE, [10, 0], [11, 0])];
    expect(slotProblem(input({ busy, askedAt: NOW }), CALL, iso(TUE, 10), 'mine')).toBe(
      'That time is too close to another meeting.',
    );
    expect(slotProblem(input(), CALL, 'not a time')).toBe('That time could not be read.');
  });
});

describe('the visitor’s time zone', () => {
  it('labels the same instants on the visitor’s own days and clocks', () => {
    const dinner = openSlots(input(), DINNER).find((s) => s.date === TUE)!;
    expect(dinner.start).toBe('2026-10-27T23:00:00.000Z');
    // 18:00 Tuesday in Central is 07:00 Wednesday in Manila, 23:00 Tuesday in London.
    expect(dayKeyIn(dinner.start, 'Asia/Manila')).toBe(WED);
    expect(slotLabel(dinner.start, 'Asia/Manila')).toBe('Wed, Oct 28, 7:00 AM');
    expect(dayKeyIn(dinner.start, 'Europe/London')).toBe(TUE);
    expect(timeLabel(dinner.start, 'Europe/London')).toBe('11:00 PM');
    expect(slotLabel(dinner.start, TZ)).toBe('Tue, Oct 27, 6:00 PM');
  });

  it('falls back to UTC for a zone it does not know, rather than failing', () => {
    expect(timeLabel('2026-10-27T15:00:00.000Z', 'Not/AZone')).toBe('3:00 PM');
  });
});

describe('review fixes', () => {
  it('says a day was taken off the link, rather than Tuesday-to-Thursday, for a dropped Tuesday', () => {
    expect(slotProblem(input({}, { weekdays: [3, 4] }), CALL, iso(TUE, 10))).toBe(
      'That day is not offered on the booking link any more.',
    );
  });

  it('never lets a time complete a back-to-back run when the gap is wider than the buffer', () => {
    // Two meetings 10:00-11:00 back to back; a call at 11:30 would be the third (gap 30 < 45).
    const busy = [block(WED, [10, 0], [10, 30]), block(WED, [10, 30], [11, 0])];
    const wide = input({ busy }, { stackGapMinutes: 45 });
    expect(slotProblem(wide, CALL, iso(WED, 11, 30))).toBe(
      'That time would make 3 meetings back to back.',
    );
    expect(startsOn(openSlots(wide, CALL), WED)).not.toContain('11:30');
    // Far enough away, it is no run at all.
    expect(slotProblem(wide, CALL, iso(WED, 12, 30))).toBeNull();
    // The defaults (gap 15, buffer 15) never needed this, and still offer 11:30.
    expect(startsOn(openSlots(input({ busy }), CALL), WED)).toContain('11:30');
  });

  it('names a waiting request, not a meeting, when that is what is in the way', () => {
    const linkBookings: LinkBooking[] = [
      { id: 'r1', start: at(WED, 10), end: at(WED, 10, 30), type: 'call', onCalendar: false },
    ];
    expect(slotProblem(input({ linkBookings }), CALL, iso(WED, 10))).toBe(WAITING_CLASH);
  });

  it('checks an approval against approved bookings and older waiting ones only', () => {
    const older: LinkBooking = {
      id: 'b-older',
      start: at(WED, 10),
      end: at(WED, 10, 30),
      type: 'call',
      onCalendar: false,
      createdAt: 1000,
    };
    const newer: LinkBooking = { ...older, id: 'a-newer', createdAt: 2000 };
    const approved: LinkBooking = {
      ...older,
      id: 'c-approved',
      start: at(THU, 10),
      end: at(THU, 10, 30),
      onCalendar: true,
      createdAt: 3000,
    };
    const all = [older, newer, approved];
    expect(bookingsBefore(all, { id: older.id, createdAt: 1000 }).map((b) => b.id)).toEqual([
      'c-approved',
    ]);
    expect(bookingsBefore(all, { id: newer.id, createdAt: 2000 }).map((b) => b.id)).toEqual([
      'b-older',
      'c-approved',
    ]);
    // The same instant: the id decides, so exactly one of the two goes first.
    const twin: LinkBooking = { ...older, id: 'a-twin', createdAt: 1000 };
    expect(bookingsBefore([older, twin], { id: 'a-twin', createdAt: 1000 })).toEqual([]);
    expect(bookingsBefore([older, twin], { id: 'b-older', createdAt: 1000 })).toEqual([twin]);
    // So the older one approves, and the newer one is checked against it.
    const forOlder = input({
      linkBookings: bookingsBefore(all, { id: older.id, createdAt: 1000 }),
    });
    expect(slotProblem(forOlder, CALL, iso(WED, 10))).toBeNull();
    const forNewer = input({
      linkBookings: bookingsBefore(all, { id: newer.id, createdAt: 2000 }),
    });
    expect(slotProblem(forNewer, CALL, iso(WED, 10))).toBe(WAITING_CLASH);
  });
});
