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
  daysOf,
  furthestMonth,
  hoursFor,
  keepRolling,
  lastDayOf,
  lastOpenDay,
  lastOpenMonth,
  monthGrid,
  monthLabel,
  monthState,
  monthStrip,
  monthsBetween,
  openThroughLabelMonth,
  openThroughPassed,
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
 * The booking link's month planner (D-078): which months are open (rolling
 * by default, this month and next; never past six months ahead), each month
 * on its own switch, closed days and runs, shorter hours on a day, and how
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
    openThrough: null,
    rollingMonths: 1,
    closedMonths: [],
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
    config: { ...structuredClone(DEFAULT_BOOKING_CONFIG), homeCity: 'Harbor City', ...config },
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

  it('shows this month and the next six, and never opens past them', () => {
    expect(MAX_MONTHS_AHEAD).toBe(6);
    expect(monthStrip(TODAY)).toEqual([
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
      '2027-03',
      '2027-04',
    ]);
    expect(furthestMonth(TODAY)).toBe('2027-04');
    expect(lastOpenMonth(planner({ openThrough: '2028-01' }), TODAY)).toBe('2027-04');
    expect(lastOpenMonth(planner({ rollingMonths: 99 }), TODAY)).toBe('2027-04');
  });
});

describe('the open window', () => {
  it('rolls by default: this month and next', () => {
    expect(lastOpenMonth(planner(), TODAY)).toBe('2026-11');
    expect(lastOpenDay(planner(), TODAY)).toBe('2026-11-30');
    // A month later it has moved on by itself.
    expect(lastOpenMonth(planner(), '2026-11-02')).toBe('2026-12');
    expect(monthState(planner(), '2026-10', TODAY)).toBe('open');
    expect(monthState(planner(), '2026-11', TODAY)).toBe('open');
    expect(monthState(planner(), '2026-12', TODAY)).toBe('not_open');
    expect(monthState(planner(), '2026-09', TODAY)).toBe('not_open');
  });

  it('a fixed month stays put, and once it passes nothing is open', () => {
    const fixed = planner({ openThrough: '2026-12' });
    expect(lastOpenDay(fixed, TODAY)).toBe('2026-12-31');
    expect(openThroughPassed(fixed, '2027-01-05')).toBe(true);
    expect(monthState(fixed, '2027-01', '2027-01-05')).toBe('not_open');
    expect(openThroughLabelMonth(fixed, '2027-01-05')).toBeNull();
  });

  it('says "open through" the last month that really takes bookings', () => {
    expect(openThroughLabelMonth(planner({ closedMonths: ['2026-11'] }), TODAY)).toBe('2026-10');
    expect(openThroughLabelMonth(planner({ closedMonths: ['2026-10', '2026-11'] }), TODAY)).toBe(
      null,
    );
  });
});

describe('the month switch, each month on its own', () => {
  it('closes an open month and opens it again', () => {
    const closed = toggleMonth(planner(), '2026-11', TODAY);
    expect(closed).toEqual({ openThrough: null, closedMonths: ['2026-11'] });
    expect(monthState(planner(closed), '2026-11', TODAY)).toBe('closed');
    const back = toggleMonth(planner(closed), '2026-11', TODAY);
    expect(back.closedMonths).toEqual([]);
  });

  it('opens just the month tapped past the window, the ones between stay closed', () => {
    const next = toggleMonth(planner(), '2027-02', TODAY);
    expect(next.openThrough).toBe('2027-02');
    expect(next.closedMonths).toEqual(['2026-12', '2027-01']);
    const p = planner(next);
    expect(monthState(p, '2026-11', TODAY)).toBe('open');
    expect(monthState(p, '2026-12', TODAY)).toBe('closed');
    expect(monthState(p, '2027-02', TODAY)).toBe('open');
    expect(monthState(p, '2027-03', TODAY)).toBe('not_open');
  });

  it('opens a month after a fixed window has passed, keeping the months before it closed', () => {
    const passed = planner({ openThrough: '2026-09' });
    const next = toggleMonth(passed, '2026-11', TODAY);
    expect(next).toEqual({ openThrough: '2026-11', closedMonths: ['2026-10'] });
  });

  it('changes nothing for a month off the strip', () => {
    expect(toggleMonth(planner(), '2027-05', TODAY)).toEqual({
      openThrough: null,
      closedMonths: [],
    });
    expect(toggleMonth(planner(), '2026-09', TODAY).openThrough).toBeNull();
  });

  it('"keep rolling" turns a fixed window into the same rolling one', () => {
    expect(keepRolling(planner({ openThrough: '2027-01' }), TODAY)).toEqual({
      openThrough: null,
      rollingMonths: 3,
    });
    expect(keepRolling(planner({ openThrough: '2026-08' }), TODAY).rollingMonths).toBe(0);
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

  it('names a closed month before a closed day', () => {
    expect(
      plannerClosure(
        planner({ closedMonths: ['2026-11'], closedDates: ['2026-11-04'] }),
        '2026-11-04',
      )?.code,
    ).toBe('month_closed');
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
        closedMonths: ['2026-09', '2026-10'],
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
    expect(kept.closedMonths).toEqual(['2026-10']);
    expect(kept.closedDates).toEqual(['2026-10-27']);
    expect(kept.closedRanges).toEqual([{ from: '2026-10-20', to: '2026-10-28', label: '' }]);
    expect(kept.dateHours.map((d) => d.date)).toEqual(['2026-10-29']);
  });
});

describe('the planner in the engine: rules always win', () => {
  it('offers nothing in a closed month, on a closed day, or past the open months', () => {
    expect(openSlots(input({ closedMonths: ['2026-11'] }), CALL).at(-1)!.date).toBe('2026-10-29');
    expect(
      openSlots(input({ closedDates: ['2026-10-27'] }), CALL).some((s) => s.date === '2026-10-27'),
    ).toBe(false);
    expect(
      slotProblemDetail(input({ closedDates: ['2026-10-27'] }), CALL, iso('2026-10-27', 10)),
    ).toEqual({ code: 'date_closed', text: 'That day is closed on the booking link.' });
    expect(slotProblemDetail(input(), CALL, iso('2026-12-01', 10))?.code).toBe('not_open');
    expect(
      slotProblemDetail(input({ openThrough: '2026-09' }), CALL, iso('2026-10-27', 10)),
    ).toEqual({
      code: 'not_open',
      text: 'The booking link is not open for any month right now.',
    });
  });

  it('opens a month up to six ahead, and no further', () => {
    const slots = openSlots(input({ openThrough: '2027-04' }), CALL);
    expect(slots.at(-1)!.date).toBe('2027-04-29');
    expect(openSlots(input({ openThrough: '2027-06' }), CALL).at(-1)!.date).toBe('2027-04-29');
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
        { closedDates: ['2026-11-04'], closedMonths: [] },
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
    openThrough: '2026-11',
    rolling: true,
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
    expect(state({ openThrough: null }).months).toBe('warn');
    // A fixed window ending inside two weeks needs the next month opened.
    expect(
      state({ rolling: false, openThrough: '2026-10', lastOpenDay: '2026-10-31' }).months,
    ).toBe('warn');
    expect(
      state({ rolling: false, openThrough: '2026-12', lastOpenDay: '2026-12-31' }).months,
    ).toBe('ok');
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

  it('counts by default his main one, his own, the ticked ones and Copilot-shown ones', () => {
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
