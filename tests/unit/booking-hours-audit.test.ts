import { describe, expect, it } from 'vitest';
import {
  BOOKING_CONFIG_SCHEMA,
  bookingHoursHint,
  bookingIssueText,
  clockLabel,
  DEFAULT_BOOKING_CONFIG,
  dinnerHint,
  parseBookingConfig,
  type BookingConfig,
} from '@/lib/booking/config';
import {
  openSlots,
  openSlotsAndDays,
  slotProblem,
  type BusyBlock,
  type EngineInput,
  type OpenSlot,
} from '@/lib/booking/engine';
import { travelSign, type TravelInput } from '@/lib/booking/travel';
import { localClock, wallTimeToUtc } from '@/lib/util/time';

/**
 * The booking-page audit of 10 November 2026: dinner start windows the host
 * chooses (no longer one fixed 6:00 PM), refused saves in plain words, and a
 * short "Travel" block before a coffee across town not read as a trip. The
 * host's settings as reported (calls 8-6, coffee 8-11 and 2-5, lunch
 * 11:30-1, dinner at 6, Tuesday to Thursday), on a fictional calendar.
 */

const TZ = 'America/Chicago';
/** Tuesday 10 November 2026, 9:00 Central (CST). */
const NOW = new Date('2026-11-10T15:00:00Z');
const THU = '2026-11-19';
const WED = '2026-11-18';

const at = (day: string, h: number, m = 0) => wallTimeToUtc(day, h, m, TZ)!.getTime();
const iso = (day: string, h: number, m = 0) => new Date(at(day, h, m)).toISOString();
const clock = (value: string) => {
  const c = localClock(new Date(value), TZ);
  return `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;
};
const startsOn = (slots: OpenSlot[], day: string) =>
  slots.filter((s) => s.date === day).map((s) => clock(s.start));

function block(day: string, from: [number, number], to: [number, number]): BusyBlock {
  return {
    start: at(day, ...from),
    end: at(day, ...to),
    meeting: true,
    inPerson: false,
    allDay: false,
  };
}

function input(over: Partial<EngineInput> = {}, config: Partial<BookingConfig> = {}): EngineInput {
  return {
    now: NOW,
    hostZone: TZ,
    config: {
      ...structuredClone(DEFAULT_BOOKING_CONFIG),
      openMonths: ['2026-11', '2026-12'],
      homeCity: 'Harbor City',
      ...config,
    },
    busy: [],
    travelDays: new Set(),
    linkBookings: [],
    ...over,
  };
}

const LUNCH = { type: 'in_person' as const, kind: 'lunch' as const };
const DINNER = { type: 'in_person' as const, kind: 'dinner' as const };
const COFFEE = { type: 'in_person' as const, kind: 'coffee' as const };

/** The reported Thursday: 10:00 check-in, 1:00 call, 5:30 call (all calls). */
const THURSDAY = [
  block(THU, [10, 0], [10, 30]),
  block(THU, [13, 0], [13, 30]),
  block(THU, [17, 30], [18, 0]),
];

describe('dinner start windows', () => {
  const evening = { from: '18:00', to: '19:30' };
  const kinds = (dinner: { from: string; to: string }[]) => ({
    kindWindows: { ...structuredClone(DEFAULT_BOOKING_CONFIG.kindWindows), dinner },
  });

  it('offers the single 6:00 PM start by default, an hour long', () => {
    const slots = openSlots(input(), DINNER).filter((s) => s.date === THU);
    expect(slots.map((s) => clock(s.start))).toEqual(['18:00']);
    expect(clock(slots[0]!.end)).toBe('19:00');
  });

  it('offers every half hour of a chosen dinner window, 6:00 to 7:30 PM', () => {
    expect(startsOn(openSlots(input({}, kinds([evening])), DINNER), THU)).toEqual([
      '18:00',
      '18:30',
      '19:00',
      '19:30',
    ]);
    expect(slotProblem(input({}, kinds([evening])), DINNER, iso(THU, 19, 30))).toBeNull();
    expect(slotProblem(input({}, kinds([evening])), DINNER, iso(THU, 20, 0))).toMatch(
      /outside the hours/,
    );
  });

  it('offers several dinner windows, e.g. 5:00-5:30 PM and 7:00-7:30 PM', () => {
    const two = input(
      {},
      kinds([
        { from: '17:00', to: '17:30' },
        { from: '19:00', to: '19:30' },
      ]),
    );
    expect(startsOn(openSlots(two, DINNER), THU)).toEqual(['17:00', '17:30', '19:00', '19:30']);
  });

  it('never starts in person after 9:00 PM (ends by 10:00 PM), whatever is stored', () => {
    const wide = input({}, kinds([{ from: '15:00', to: '23:30' }]));
    const starts = startsOn(openSlots(wide, DINNER), THU);
    expect(starts[0]).toBe('15:00');
    expect(starts.at(-1)).toBe('21:00');
    expect(slotProblem(wide, DINNER, iso(THU, 21, 30))).toMatch(/outside the hours/);
  });

  it('keeps the dinner hours on the Central clock across the 1 November change', () => {
    const before = input(
      { now: new Date('2026-10-26T15:00:00Z') },
      { openMonths: ['2026-10', '2026-11'] },
    );
    const oct = openSlots(before, DINNER).find((s) => s.date === '2026-10-28')!;
    const nov = openSlots(before, DINNER).find((s) => s.date === '2026-11-04')!;
    expect(oct.start).toBe('2026-10-28T23:00:00.000Z'); // 18:00 CDT
    expect(nov.start).toBe('2026-11-05T00:00:00.000Z'); // 18:00 CST
  });

  it('keeps travel time after a 5:30 call: the 6:00 dinner closes, 6:30 stays (intended)', () => {
    const busy = input({ busy: THURSDAY }, kinds([evening]));
    expect(slotProblem(busy, DINNER, iso(THU, 18, 0))).toBe(
      'That time is too close to another meeting.',
    );
    expect(startsOn(openSlots(busy, DINNER), THU)).toEqual(['18:30', '19:00', '19:30']);
    // With the single 6:00 start, that day has no dinner and reads as fully booked.
    const single = openSlotsAndDays(input({ busy: THURSDAY }), DINNER);
    expect(single.days.find((d) => d.date === THU)?.state).toBe('booked');
  });

  it('reads a saved 6:00 to 7:30 PM window back as saved', () => {
    const saved = parseBookingConfig({ kindWindows: kinds([evening]).kindWindows });
    expect(saved.kindWindows.dinner).toEqual([evening]);
  });
});

describe('lunch and coffee on the reported Thursday', () => {
  it('offers lunch at 11:30 when only the 10:00 and 1:00 calls are there', () => {
    // 12:00 to 1:00 ends at the 1:00 call, which needs 30 minutes' travel: closed.
    expect(startsOn(openSlots(input({ busy: THURSDAY }), LUNCH), THU)).toEqual(['11:30']);
  });

  it('offers coffee in both windows around the calls', () => {
    expect(startsOn(openSlots(input({ busy: THURSDAY }), COFFEE), THU)).toEqual([
      '08:00',
      '08:30',
      '11:00',
      '14:00',
      '14:30',
      '15:00',
      '15:30',
      '16:00',
    ]);
  });

  it('keeps Friday to Monday off, whatever the windows', () => {
    const days = openSlotsAndDays(input(), COFFEE).days;
    expect(days.find((d) => d.date === '2026-11-20')?.state).toBe('off');
    expect(days.find((d) => d.date === '2026-11-23')?.state).toBe('off');
    expect(days.find((d) => d.date === THU)?.state).toBe('open');
  });
});

describe('a refused save says what is wrong in plain words', () => {
  const issue = (config: Record<string, unknown>) =>
    BOOKING_CONFIG_SCHEMA.safeParse({ ...structuredClone(DEFAULT_BOOKING_CONFIG), ...config }).error
      ?.issues[0];

  it('shows our own sentence, never a field path', () => {
    const dinner = issue({
      kindWindows: {
        ...DEFAULT_BOOKING_CONFIG.kindWindows,
        dinner: [{ from: '18:00', to: '22:00' }],
      },
    });
    const text = bookingIssueText(dinner);
    expect(text).toBe(
      'Dinner can start between 6:00 AM and 9:00 PM Central, so it ends by 10:00 PM.',
    );
    expect(text).not.toMatch(/kindWindows|dinner 0/);
    const overlap = issue({
      kindWindows: {
        ...DEFAULT_BOOKING_CONFIG.kindWindows,
        dinner: [
          { from: '17:00', to: '19:00' },
          { from: '18:30', to: '20:00' },
        ],
      },
    });
    expect(bookingIssueText(overlap)).toBe('Two dinner windows overlap. Join them or move one.');
    // What Arwin tried saves with no error at all.
    expect(
      issue({
        kindWindows: {
          ...DEFAULT_BOOKING_CONFIG.kindWindows,
          dinner: [{ from: '18:00', to: '19:30' }],
        },
      }),
    ).toBeUndefined();
  });

  it('names the setting in the tab’s words for a check of our own types', () => {
    expect(bookingIssueText(issue({ callBufferMinutes: 5 }))).toBe('Check the call buffer.');
    expect(bookingIssueText(issue({ noticeHours: 'soon' }))).toBe('Check the notice.');
    expect(
      bookingIssueText(
        issue({ kindWindows: { ...DEFAULT_BOOKING_CONFIG.kindWindows, lunch: 'x' } }),
      ),
    ).toBe('Check the lunch hours.');
    expect(bookingIssueText(undefined)).toBe('Check the settings.');
  });
});

describe('the hours hint says the dinner start that is set', () => {
  it('reads the windows', () => {
    expect(clockLabel('18:00')).toBe('6:00 PM');
    expect(clockLabel('08:30')).toBe('8:30 AM');
    expect(clockLabel('12:00')).toBe('12:00 PM');
    expect(dinnerHint([{ from: '18:00', to: '18:00' }])).toBe('Dinner starts at 6:00 PM');
    expect(dinnerHint([{ from: '18:00', to: '19:30' }])).toBe(
      'Dinner starts between 6:00 PM and 7:30 PM',
    );
    expect(dinnerHint([])).toBe('Dinner is not offered');
    expect(bookingHoursHint([{ from: '18:00', to: '19:30' }])).toBe(
      'Calls 8:00 AM to 6:00 PM Central. Dinner starts between 6:00 PM and 7:30 PM.',
    );
  });
});

describe('a short "Travel" block is a drive across town, not a trip', () => {
  const home = {
    city: 'Harbor City',
    aliases: [],
    places: [{ name: 'Blue Kettle', area: 'Southside' }],
    hostName: 'Dana Reyes',
  };
  const timed = (title: string, minutes: number, over: Partial<TravelInput> = {}): TravelInput => ({
    title,
    allDay: false,
    place: null,
    eventType: 'default',
    timeZone: TZ,
    ownEntry: true,
    startsAt: iso(WED, 8, 15),
    endsAt: new Date(at(WED, 8, 15) + minutes * 60_000).toISOString(),
    meeting: false,
    ...over,
  });

  it('does not mark the day away for a half-hour "Travel" before a coffee', () => {
    expect(travelSign(timed('Travel', 30), home, TZ)).toBe(false);
    expect(travelSign(timed('Travel time', 45), home, TZ)).toBe(false);
    expect(travelSign(timed('Drive to Blue Kettle', 20), home, TZ)).toBe(false);
  });

  it('still marks a long one, one going elsewhere, or one with another sign', () => {
    expect(travelSign(timed('Travel', 240), home, TZ)).toBe(true);
    expect(travelSign(timed('Travel to Lakeport', 30), home, TZ)).toBe(true);
    expect(travelSign(timed('Travel', 30, { endsAt: undefined }), home, TZ)).toBe(true);
    expect(travelSign(timed('Travel', 30, { place: 'Lakeport Airport' }), home, TZ)).toBe(true);
    expect(travelSign(timed('Travel', 30, { timeZone: 'America/New_York' }), home, TZ)).toBe(true);
    expect(travelSign(timed('Hotel check-in', 30), home, TZ)).toBe(true);
    expect(travelSign(timed('Flight', 30), home, TZ)).toBe(true);
    expect(travelSign({ ...timed('Travel', 30), allDay: true, startsAt: null }, home, TZ)).toBe(
      true,
    );
  });
});
