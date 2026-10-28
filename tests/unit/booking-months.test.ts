import { describe, expect, it } from 'vitest';
import {
  calendarCounts,
  chooseCalendar,
  countingCalendarIds,
  countsByDefault,
} from '@/lib/booking/calendar-choices';
import { DEFAULT_BOOKING_CONFIG, MAX_MONTHS_AHEAD, type BookingConfig } from '@/lib/booking/config';
import {
  dayPlans,
  openSlots,
  PREVIEW_QUERIES,
  slotProblemDetail,
  type BusyBlock,
  type EngineInput,
} from '@/lib/booking/engine';
import {
  addClosedRange,
  addMonths,
  closeAllMonths,
  daysOf,
  defaultOpenMonths,
  furthestMonth,
  hoursFor,
  lastDayOf,
  lastOpenDay,
  lastOpenMonth,
  legacyOpenMonths,
  monthGrid,
  monthLabel,
  monthOpen,
  monthStrip,
  monthsBetween,
  openMonthsAhead,
  openNextMonths,
  plannerClosure,
  removeClosedRange,
  setDateHours,
  toggleDate,
  toggleMonth,
  withoutPast,
  type PlannerConfig,
} from '@/lib/booking/months';
import {
  countOpen,
  dayWideReason,
  REASON_CHIP,
  statusChecks,
  type PreviewDay,
  type StatusInput,
} from '@/lib/booking/planner-status';
import { wallTimeToUtc } from '@/lib/util/time';

/**
 * The booking link's month planner (D-078): which months are open (each
 * switched on by itself, any of this month and the next eleven; this month
 * and next with nothing saved), closed days and runs, shorter hours on a day, and how
 * all of it feeds the engine, whose every refusal now carries a rule code
 * for the Booking tab's "Why no times?" list. Plus the Calendars choices and
 * the Overview's checks. Every value is invented.
 */

const TZ = 'America/Chicago';
/** Monday 26 October 2026, 10:00 Central. */
const NOW = new Date('2026-10-26T15:00:00Z');
const TODAY = '2026-10-26';

const at = (day: string, h: number, m = 0) => wallTimeToUtc(day, h, m, TZ)!.getTime();
const iso = (day: string, h: number, m = 0) => new Date(at(day, h, m)).toISOString();

function planner(over: Partial<PlannerConfig> = {}): PlannerConfig {
  return {
    openMonths: ['2026-10', '2026-11'],
    closedDates: [],
    closedRanges: [],
    dateHours: [],
    ...over,
  };
}

function input(config: Partial<BookingConfig> = {}, over: Partial<EngineInput> = {}): EngineInput {
  return {
    now: NOW,
    hostZone: TZ,
    config: {
      ...structuredClone(DEFAULT_BOOKING_CONFIG),
      openMonths: ['2026-10', '2026-11'],
      homeCity: 'Harbor City',
      ...config,
    },
    busy: [],
    travelDays: new Set(),
    linkBookings: [],
    ...over,
  };
}

const CALL = { type: 'call' as const };
const COFFEE = { type: 'in_person' as const, kind: 'coffee' as const };

describe('months as keys', () => {
  it('moves across years and counts the months between', () => {
    expect(addMonths('2026-11', 2)).toBe('2027-01');
    expect(addMonths('2027-01', -1)).toBe('2026-12');
    expect(monthsBetween('2026-10', '2027-04')).toBe(6);
    expect(lastDayOf('2027-02')).toBe('2027-02-28');
    expect(lastDayOf('2028-02')).toBe('2028-02-29');
    expect(daysOf('2026-11')).toHaveLength(30);
    expect(monthLabel('2026-11')).toBe('November 2026');
  });

  it('lays a month out Monday first, seven to a row', () => {
    const rows = monthGrid('2026-11');
    // 1 November 2026 is a Sunday: six blanks, then the 1st.
    expect(rows[0]).toEqual([null, null, null, null, null, null, '2026-11-01']);
    expect(rows.every((r) => r.length === 7)).toBe(true);
    expect(rows.flat().filter(Boolean)).toHaveLength(30);
  });

  it('shows this month and the next eleven, and never opens past them', () => {
    expect(MAX_MONTHS_AHEAD).toBe(11);
    expect(monthStrip(TODAY)).toEqual([
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
      '2027-03',
      '2027-04',
      '2027-05',
      '2027-06',
      '2027-07',
      '2027-08',
      '2027-09',
    ]);
    expect(furthestMonth(TODAY)).toBe('2027-09');
    // A month past the strip on the list offers nothing.
    expect(monthOpen(planner({ openMonths: ['2027-10'] }), '2027-10', TODAY)).toBe(false);
    expect(lastOpenMonth(planner({ openMonths: ['2026-11', '2027-10'] }), TODAY)).toBe('2026-11');
  });
});

describe('the open months, each switched on by itself', () => {
  it('opens this month and the next with nothing saved', () => {
    expect(defaultOpenMonths(TODAY)).toEqual(['2026-10', '2026-11']);
    expect(lastOpenMonth(planner(), TODAY)).toBe('2026-11');
    expect(lastOpenDay(planner(), TODAY)).toBe('2026-11-30');
    expect(monthOpen(planner(), '2026-10', TODAY)).toBe(true);
    expect(monthOpen(planner(), '2026-12', TODAY)).toBe(false);
    // A month already past is never open, whatever the list says.
    expect(monthOpen(planner({ openMonths: ['2026-09'] }), '2026-09', TODAY)).toBe(false);
  });

  it('takes any mix: only December, or January and March', () => {
    const december = planner({ openMonths: ['2026-12'] });
    expect(openMonthsAhead(december, TODAY)).toEqual(['2026-12']);
    expect(lastOpenDay(december, TODAY)).toBe('2026-12-31');
    const gaps = planner({ openMonths: ['2027-03', '2027-01'] });
    expect(openMonthsAhead(gaps, TODAY)).toEqual(['2027-01', '2027-03']);
    expect(monthOpen(gaps, '2027-02', TODAY)).toBe(false);
  });

  it('opens nothing at all once every month is off', () => {
    const none = planner({ openMonths: [] });
    expect(lastOpenMonth(none, TODAY)).toBeNull();
    expect(lastOpenDay(none, TODAY)).toBeNull();
    expect(closeAllMonths()).toEqual({ openMonths: [] });
  });

  it('reads an older saved window as the same months', () => {
    // "This month and the next two", one closed by hand.
    expect(legacyOpenMonths({ rollingMonths: 2, closedMonths: ['2026-11'] }, TODAY)).toEqual([
      '2026-10',
      '2026-12',
    ]);
    // "Open through January".
    expect(legacyOpenMonths({ openThrough: '2027-01', rollingMonths: 1 }, TODAY)).toEqual([
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01',
    ]);
    // A fixed month already past: nothing open.
    expect(legacyOpenMonths({ openThrough: '2026-09' }, TODAY)).toEqual([]);
    // Never past the strip.
    expect(legacyOpenMonths({ openThrough: '2028-05' }, TODAY).at(-1)).toBe('2027-09');
    // Nothing saved about months (a row from before the planner): this month and next.
    expect(legacyOpenMonths({}, TODAY)).toEqual(['2026-10', '2026-11']);
  });
});

describe('the month switch, each month on its own', () => {
  it('switches a month on and off again, leaving the others as they are', () => {
    const on = toggleMonth(planner(), '2027-02', TODAY);
    expect(on).toEqual({ openMonths: ['2026-10', '2026-11', '2027-02'] });
    const off = toggleMonth(planner(on), '2026-11', TODAY);
    expect(off).toEqual({ openMonths: ['2026-10', '2027-02'] });
    expect(toggleMonth(planner(off), '2027-02', TODAY)).toEqual({ openMonths: ['2026-10'] });
  });

  it('changes nothing for a month off the strip, and drops months already past', () => {
    expect(toggleMonth(planner(), '2027-10', TODAY)).toEqual({
      openMonths: ['2026-10', '2026-11'],
    });
    expect(toggleMonth(planner({ openMonths: ['2026-09', '2026-11'] }), '2026-09', TODAY)).toEqual({
      openMonths: ['2026-11'],
    });
  });

  it('"Open next 3 months" switches on this month and the next two, keeping any other', () => {
    expect(openNextMonths(planner({ openMonths: ['2027-05'] }), TODAY)).toEqual({
      openMonths: ['2026-10', '2026-11', '2026-12', '2027-05'],
    });
  });
});

describe('closed days, runs and shorter hours', () => {
  it('closes and opens a single day', () => {
    const closed = toggleDate(planner(), '2026-11-04');
    expect(closed.closedDates).toEqual(['2026-11-04']);
    expect(plannerClosure(planner(closed), '2026-11-04')).toEqual({
      code: 'date_closed',
      text: 'That day is closed on the booking link.',
    });
    expect(toggleDate(planner(closed), '2026-11-04').closedDates).toEqual([]);
  });

  it('closes a run of days with a label, either way round, and removes it', () => {
    const added = addClosedRange(planner(), {
      from: '2026-11-27',
      to: '2026-11-24',
      label: ' Thanksgiving ',
    });
    expect(added.closedRanges).toEqual([
      { from: '2026-11-24', to: '2026-11-27', label: 'Thanksgiving' },
    ]);
    expect(plannerClosure(planner(added), '2026-11-25')).toEqual({
      code: 'date_closed',
      text: 'That day is closed on the booking link (Thanksgiving).',
      label: 'Thanksgiving',
    });
    expect(plannerClosure(planner(added), '2026-11-28')).toBeNull();
    const removed = removeClosedRange(planner(added), { from: '2026-11-24', to: '2026-11-27' });
    expect(removed.closedRanges).toEqual([]);
  });

  it('names a month that is off before a closed day, in plain words', () => {
    expect(
      plannerClosure(
        planner({ openMonths: ['2026-10'], closedDates: ['2026-11-04'] }),
        '2026-11-04',
      ),
    ).toEqual({ code: 'month_closed', text: 'November isn’t open on the link.' });
  });

  it('sets and clears one day’s shorter hours', () => {
    const set = setDateHours(planner(), '2026-11-04', { from: '10:00', to: '12:00' });
    expect(hoursFor(planner(set), '2026-11-04')).toEqual({ from: '10:00', to: '12:00' });
    const replaced = setDateHours(planner(set), '2026-11-04', { from: '13:00', to: '15:00' });
    expect(replaced.dateHours).toHaveLength(1);
    expect(setDateHours(planner(set), '2026-11-04', null).dateHours).toEqual([]);
  });

  it('drops what is wholly past when it saves', () => {
    const kept = withoutPast(
      planner({
        openMonths: ['2026-09', '2026-10', '2026-12'],
        closedDates: ['2026-10-20', '2026-10-27'],
        closedRanges: [
          { from: '2026-10-01', to: '2026-10-10', label: '' },
          { from: '2026-10-20', to: '2026-10-28', label: '' },
        ],
        dateHours: [
          { date: '2026-10-21', from: '10:00', to: '12:00' },
          { date: '2026-10-29', from: '10:00', to: '12:00' },
        ],
      }),
      TODAY,
    );
    expect(kept.openMonths).toEqual(['2026-10', '2026-12']);
    expect(kept.closedDates).toEqual(['2026-10-27']);
    expect(kept.closedRanges).toEqual([{ from: '2026-10-20', to: '2026-10-28', label: '' }]);
    expect(kept.dateHours.map((d) => d.date)).toEqual(['2026-10-29']);
  });
});

describe('the planner in the engine: rules always win', () => {
  it('offers nothing in a month that is off, on a closed day, or with every month off', () => {
    expect(openSlots(input({ openMonths: ['2026-10'] }), CALL).at(-1)!.date).toBe('2026-10-29');
    expect(
      openSlots(input({ closedDates: ['2026-10-27'] }), CALL).some((s) => s.date === '2026-10-27'),
    ).toBe(false);
    expect(
      slotProblemDetail(input({ closedDates: ['2026-10-27'] }), CALL, iso('2026-10-27', 10)),
    ).toEqual({ code: 'date_closed', text: 'That day is closed on the booking link.' });
    expect(slotProblemDetail(input(), CALL, iso('2026-12-01', 10))).toEqual({
      code: 'month_closed',
      text: 'December isn’t open on the link.',
    });
    expect(openSlots(input({ openMonths: [] }), CALL)).toEqual([]);
  });

  it('opens only the month switched on, two months out: only its days offer times', () => {
    const slots = openSlots(input({ openMonths: ['2026-12'] }), CALL);
    expect(slots.length).toBeGreaterThan(0);
    expect(new Set(slots.map((s) => s.date.slice(0, 7)))).toEqual(new Set(['2026-12']));
    // No count of days caps an open month: its last Thursday is offered too.
    expect(slots.at(-1)!.date).toBe('2026-12-31');
    // Switched off again: nothing.
    expect(openSlots(input({ openMonths: [] }), CALL)).toEqual([]);
  });

  it('opens a month up to eleven ahead, and no further', () => {
    const slots = openSlots(input({ openMonths: ['2027-09'] }), CALL);
    expect(slots.at(-1)!.date).toBe('2027-09-30');
    expect(openSlots(input({ openMonths: ['2027-10'] }), CALL)).toEqual([]);
    expect(
      slotProblemDetail(input({ openMonths: ['2027-10'] }), CALL, iso('2027-10-05', 10)),
    ).toEqual({ code: 'not_open', text: 'That month is too far ahead for the booking link.' });
  });

  it('keeps every time on a shorter-hours day wholly inside them', () => {
    const config = { dateHours: [{ date: '2026-10-28', from: '10:00', to: '12:00' }] };
    const wed = openSlots(input(config), CALL).filter((s) => s.date === '2026-10-28');
    expect(wed.map((s) => s.start)).toEqual([
      iso('2026-10-28', 10),
      iso('2026-10-28', 10, 30),
      iso('2026-10-28', 11),
      iso('2026-10-28', 11, 30),
    ]);
    expect(slotProblemDetail(input(config), CALL, iso('2026-10-28', 11, 45))?.code).toBe('hours');
  });

  it('never lets shorter hours open what the rules close', () => {
    // 07:00 to 21:00 on a Wednesday: still 8:00 to 18:00 for calls.
    const config = { dateHours: [{ date: '2026-10-28', from: '07:00', to: '21:00' }] };
    const wed = openSlots(input(config), CALL).filter((s) => s.date === '2026-10-28');
    expect(wed[0]!.start).toBe(iso('2026-10-28', 8));
    expect(wed.at(-1)!.start).toBe(iso('2026-10-28', 17, 30));
    // And a Friday stays shut whatever hours it is given.
    const friday = { dateHours: [{ date: '2026-10-30', from: '09:00', to: '17:00' }] };
    expect(openSlots(input(friday), CALL).some((s) => s.date === '2026-10-30')).toBe(false);
  });
});

describe('why a day offers nothing (the Booking tab’s list)', () => {
  const busy = (day: string, from: number, to: number): BusyBlock => ({
    start: at(day, from),
    end: at(day, to),
    meeting: true,
    inPerson: false,
    allDay: false,
  });

  it('gives each day its rule, with a code', () => {
    const plans = dayPlans(
      input(
        { closedDates: ['2026-11-04'] },
        {
          busy: [busy('2026-10-28', 7, 19)],
          travelDays: new Set(['2026-10-29']),
        },
      ),
      CALL,
      '2026-10-25',
      '2026-11-05',
    );
    const by = Object.fromEntries(plans.map((p) => [p.date, p]));
    expect(by['2026-10-25']!.code).toBe('past');
    expect(by['2026-10-26']!.code).toBe('weekday');
    expect(by['2026-10-27']!.code).toBeNull();
    expect(by['2026-10-27']!.slots.length).toBeGreaterThan(0);
    expect(by['2026-10-28']!).toMatchObject({
      code: 'busy',
      reason: 'That time is too close to another meeting.',
    });
    // A day away still has calls: travel closes in person only.
    expect(by['2026-10-29']!.code).toBeNull();
    expect(by['2026-11-04']!.code).toBe('date_closed');
  });

  it('names travel and the per-trip pause for in person', () => {
    const away = dayPlans(
      input({}, { travelDays: new Set(['2026-10-29']) }),
      COFFEE,
      '2026-10-29',
      '2026-10-29',
    );
    expect(away[0]).toMatchObject({ code: 'away', reason: 'The host is away that day.' });
    const paused = dayPlans(
      input({}, { inPersonPausedThrough: '2026-10-28' }),
      COFFEE,
      '2026-10-27',
      '2026-10-29',
    );
    expect(paused.map((p) => p.code)).toEqual(['in_person_paused', 'in_person_paused', null]);
  });

  it('names the caps, the notice and the stack', () => {
    const notice = dayPlans(input(), CALL, '2026-10-27', '2026-10-27')[0]!;
    // Tuesday before 10:00 is inside the 24 hours; the rest is open.
    expect(notice.code).toBeNull();
    const tight = dayPlans(input({ noticeHours: 24 * 4 }), CALL, '2026-10-27', '2026-10-27')[0]!;
    expect(tight.code).toBe('notice');
    const full = dayPlans(
      input(
        { maxMeetingsPerDay: 2 },
        { busy: [busy('2026-10-27', 8, 9), busy('2026-10-27', 16, 17)] },
      ),
      CALL,
      '2026-10-27',
      '2026-10-27',
    )[0]!;
    expect(full.code).toBe('meeting_cap');
    // Three back to back, 10:00 to 13:00: 13:30 is clear of the buffer, not of the run.
    const run = [
      busy('2026-10-27', 10, 11),
      busy('2026-10-27', 11, 12),
      busy('2026-10-27', 12, 13),
    ];
    expect(slotProblemDetail(input({}, { busy: run }), CALL, iso('2026-10-27', 13, 30))).toEqual({
      code: 'stack',
      text: 'That time is right after 3 meetings back to back.',
    });
    for (const code of Object.keys(REASON_CHIP)) expect(REASON_CHIP[code as never]).toBeTruthy();
  });

  it('runs every kind of meeting through the same rules', () => {
    expect(PREVIEW_QUERIES.map((q) => q.key)).toEqual(['call', 'coffee', 'lunch', 'dinner']);
  });
});

describe('the Overview', () => {
  const day = (
    date: string,
    codes: Partial<Record<string, string | null>>,
    times = 0,
  ): PreviewDay => ({
    date,
    plans: {
      call: {
        times: Array.from({ length: times }, (_, i) => `t${i}`),
        reason: codes.call ? 'why' : null,
        code: (codes.call ?? null) as never,
      },
      coffee: { times: [], reason: 'why', code: (codes.coffee ?? codes.call ?? null) as never },
      lunch: { times: [], reason: 'why', code: (codes.lunch ?? codes.call ?? null) as never },
      dinner: { times: [], reason: 'why', code: (codes.dinner ?? codes.call ?? null) as never },
    },
  });

  it('folds a day closed by one rule into one line', () => {
    expect(dayWideReason(day('2026-10-26', { call: 'weekday' }))?.code).toBe('weekday');
    expect(
      dayWideReason(day('2026-11-04', { call: 'date_closed', coffee: 'in_person_off' }))?.code,
    ).toBe('date_closed');
    expect(dayWideReason(day('2026-10-28', { call: 'busy' }))).toBeNull();
    expect(dayWideReason(day('2026-10-27', {}, 3))).toBeNull();
    expect(countOpen([day('2026-10-27', {}, 3)])).toEqual({ calls: 3, inPerson: 0 });
  });

  const base: StatusInput = {
    enabled: true,
    editing: { allowed: true, demo: false, connected: true },
    profile: { displayName: 'Sam Host', title: 'Partner', bio: '' },
    inPersonOffered: true,
    nextTwoWeeks: { calls: 10, inPerson: 4 },
    openMonths: ['2026-10', '2026-11'],
    today: TODAY,
    lastOpenDay: '2026-11-30',
  };
  const state = (over: Partial<StatusInput>) =>
    Object.fromEntries(statusChecks({ ...base, ...over }).map((c) => [c.key, c.state]));

  it('is all green when the link is set up', () => {
    expect(state({})).toEqual({
      link: 'ok',
      editing: 'ok',
      profile: 'ok',
      places: 'ok',
      times: 'ok',
      months: 'ok',
    });
  });

  it('flags what would leave the page empty or half set up', () => {
    expect(state({ enabled: false }).link).toBe('off');
    expect(state({ editing: { allowed: false, demo: false, connected: true } }).editing).toBe(
      'warn',
    );
    expect(state({ profile: { displayName: '', title: '', bio: '' } }).profile).toBe('warn');
    expect(state({ inPersonOffered: false }).places).toBe('warn');
    expect(state({ nextTwoWeeks: { calls: 0, inPerson: 0 } }).times).toBe('warn');
    expect(state({ nextTwoWeeks: null }).times).toBeUndefined();
    expect(state({ openMonths: [], lastOpenDay: null }).months).toBe('warn');
    // The open months ending inside two weeks need the next one switched on.
    expect(state({ openMonths: ['2026-10'], lastOpenDay: '2026-10-31' }).months).toBe('warn');
    expect(state({ openMonths: ['2026-12'], lastOpenDay: '2026-12-31' }).months).toBe('ok');
    const months = statusChecks({
      ...base,
      openMonths: ['2026-11', '2027-03'],
      lastOpenDay: '2027-03-31',
    }).find((c) => c.key === 'months');
    expect(months?.title).toBe('Open: Nov and Mar 2027');
  });
});

describe('which calendars block his time', () => {
  const cal = (
    id: string,
    over: Partial<{ primary: boolean; accessRole: string; selectedInGoogle: boolean }> = {},
  ) => ({
    id,
    primary: false,
    accessRole: 'reader',
    selectedInGoogle: false,
    ...over,
  });
  const main = cal('host@example.test', {
    primary: true,
    accessRole: 'owner',
    selectedInGoogle: true,
  });
  const family = cal('family@group.example.test', { accessRole: 'owner' });
  const team = cal('team@group.example.test', { accessRole: 'writer', selectedInGoogle: true });
  const shared = cal('shared@group.example.test');
  const mate = cal('assistant@example.test', { accessRole: 'owner', selectedInGoogle: true });
  const teammates = new Set(['assistant@example.test']);

  it('counts by default his main one, his own, the ticked ones and Kraken-shown ones', () => {
    expect(countsByDefault(main, {})).toBe(true);
    expect(countsByDefault(family, {})).toBe(true);
    expect(countsByDefault(team, { [team.id]: false })).toBe(true);
    expect(countsByDefault(shared, {})).toBe(false);
    expect(countsByDefault(shared, { [shared.id]: true })).toBe(true);
  });

  it('lets a choice add or drop one, but never the main one or a teammate’s', () => {
    const context = {
      shown: {},
      choices: [
        { id: shared.id, counts: true },
        { id: team.id, counts: false },
        { id: main.id, counts: false },
        { id: mate.id, counts: true },
      ],
      teammates,
    };
    expect(countingCalendarIds([main, family, team, shared, mate], context)).toEqual([
      main.id,
      family.id,
      shared.id,
    ]);
    expect(calendarCounts(mate, { shown: {}, choices: [], teammates })).toBe(false);
  });

  it('keeps only real overrides in the saved list', () => {
    const on = chooseCalendar([], shared, true, {});
    expect(on).toEqual([{ id: shared.id, counts: true }]);
    expect(chooseCalendar(on, shared, false, {})).toEqual([]);
    expect(chooseCalendar([], main, false, {})).toEqual([]);
  });
});
