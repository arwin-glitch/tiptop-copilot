import 'server-only';
import { buildDemoDb } from '@/lib/demo/fixtures';
import { processWide } from '@/lib/util/process-state';
import { addDaysToKey, localDateKey, wallTimeToUtc } from '@/lib/util/time';
import type {
  GCalColors,
  GCalEvent,
  GCalEventWrite,
  GCalListEntry,
  SendUpdates,
} from './google-types';

/**
 * The demo and test stand-in for Google Calendar: fictional calendars and
 * events, held in memory, that answer the same questions Google does (the
 * calendar list, the colours, a range of single events with recurring ones
 * expanded) and take the same writes. Every write is recorded, with the
 * sendUpdates and conference data it carried, so a test can check exactly
 * what would have gone to Google. Nothing here touches the network.
 *
 * The main calendar holds the demo's own synced events (the ones the current
 * day list reads in demo mode), so the parity check agrees in the demo until
 * something is changed here. The other calendars carry what the new views
 * need to show off: overlaps, a recurring series, holds, a busy day, a
 * conference day of long overlapping blocks under short meetings, an event
 * only its organizer can change, and calendars this account can only read.
 */

export const MOCK_TIME_ZONE = 'America/Chicago';
export const MOCK_OWN_EMAIL = 'nick@tiptop.demo';
export const MOCK_TEAM_CALENDAR = 'c_tiptop-team@group.calendar.google.com';
export const MOCK_PERSONAL_CALENDAR = 'c_personal-demo@group.calendar.google.com';
export const MOCK_HOLIDAY_CALENDAR = 'c_demo-holidays@group.v.calendar.google.com';
export const MOCK_DEALS_CALENDAR = 'c_deal-flow-shared@group.calendar.google.com';
export const MOCK_HIDDEN_CALENDAR = 'c_old-project@group.calendar.google.com';
/**
 * The busy demo day, this many days after today: long overlapping blocks and
 * short meetings. The day after it has the same shape, with a red-eye that
 * runs past midnight into the morning after.
 */
export const BUSY_DAY_OFFSET = 12;

/** Google's colour palettes as its colors endpoint returns them. */
export const MOCK_COLORS: GCalColors = {
  calendar: Object.fromEntries(
    [
      '#ac725e',
      '#d06b64',
      '#f83a22',
      '#fa573c',
      '#ff7537',
      '#ffad46',
      '#42d692',
      '#16a765',
      '#7bd148',
      '#b3dc6c',
      '#fbe983',
      '#fad165',
      '#92e1c0',
      '#9fe1e7',
      '#9fc6e7',
      '#4986e7',
      '#9a9cff',
      '#b99aff',
      '#c2c2c2',
      '#cabdbf',
      '#cca6ac',
      '#f691b2',
      '#cd74e6',
      '#a47ae2',
    ].map((background, i) => [String(i + 1), { background, foreground: '#1d1d1d' }]),
  ),
  event: Object.fromEntries(
    [
      '#a4bdfc',
      '#7ae7bf',
      '#dbadff',
      '#ff887c',
      '#fbd75b',
      '#ffb878',
      '#46d6db',
      '#e1e1e1',
      '#5484ed',
      '#51b749',
      '#dc2127',
    ].map((background, i) => [String(i + 1), { background, foreground: '#1d1d1d' }]),
  ),
};

export type MockWriteOp = 'insert' | 'patch' | 'move' | 'delete';

export interface MockWrite {
  op: MockWriteOp;
  calendarId: string;
  eventId: string | null;
  destinationId?: string;
  sendUpdates: SendUpdates;
  conferenceDataVersion: 0 | 1;
  body: GCalEventWrite | null;
  at: string;
}

interface Series {
  master: GCalEvent;
  /** Changed or cancelled instances, by instance id. */
  exceptions: Map<string, GCalEvent | 'cancelled'>;
}

export interface MockCalendarState {
  calendars: GCalListEntry[];
  colors: GCalColors;
  /** One-off events, per calendar. */
  events: Map<string, GCalEvent[]>;
  /** Recurring series, per calendar. */
  series: Map<string, Series[]>;
  /** Every write, oldest first. */
  writes: MockWrite[];
  /** Every read, so a test can check how often Google would be asked. */
  reads: { op: 'calendars' | 'colors' | 'range' | 'get'; calendarId?: string }[];
  nextId: number;
  timeZone: string;
}

/* ------------------------------------------------------------------ seed */

const at = (dateKey: string, hour: number, minute = 0) =>
  (wallTimeToUtc(dateKey, hour, minute, MOCK_TIME_ZONE) ?? new Date(`${dateKey}T12:00:00Z`))
    .toISOString()
    .replace('.000Z', 'Z');

function timed(dateKey: string, from: [number, number], to: [number, number]) {
  return {
    start: { dateTime: at(dateKey, from[0], from[1]), timeZone: MOCK_TIME_ZONE },
    end: { dateTime: at(dateKey, to[0], to[1]), timeZone: MOCK_TIME_ZONE },
  };
}

const me = (response = 'accepted') => ({
  email: MOCK_OWN_EMAIL,
  displayName: 'Nick Tippmann',
  responseStatus: response,
  self: true,
});

const guest = (email: string, displayName: string, responseStatus = 'accepted') => ({
  email,
  displayName,
  responseStatus,
});

function ownedBy(calendarId: string) {
  return { organizer: { email: calendarId, self: true }, creator: { email: MOCK_OWN_EMAIL } };
}

export function createMockCalendarState(now: Date = new Date()): MockCalendarState {
  const today = localDateKey(now, MOCK_TIME_ZONE);
  const day = (n: number) => addDaysToKey(today, n);
  // The Monday on or after today, for the weekly series.
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const nextMonday = day((8 - weekday) % 7);

  const calendars: GCalListEntry[] = [
    {
      id: MOCK_OWN_EMAIL,
      summary: MOCK_OWN_EMAIL,
      timeZone: MOCK_TIME_ZONE,
      colorId: '14',
      backgroundColor: '#9fe1e7',
      foregroundColor: '#1d1d1d',
      selected: true,
      primary: true,
      accessRole: 'owner',
    },
    {
      id: MOCK_TEAM_CALENDAR,
      summary: 'TipTop team',
      timeZone: MOCK_TIME_ZONE,
      colorId: '8',
      backgroundColor: '#16a765',
      foregroundColor: '#1d1d1d',
      selected: true,
      accessRole: 'writer',
    },
    {
      id: MOCK_PERSONAL_CALENDAR,
      summary: 'Personal (demo)',
      summaryOverride: 'Personal',
      timeZone: MOCK_TIME_ZONE,
      colorId: '22',
      backgroundColor: '#f691b2',
      foregroundColor: '#1d1d1d',
      selected: true,
      accessRole: 'owner',
    },
    {
      id: MOCK_HOLIDAY_CALENDAR,
      summary: 'Demo holidays',
      timeZone: MOCK_TIME_ZONE,
      colorId: '9',
      backgroundColor: '#7bd148',
      foregroundColor: '#1d1d1d',
      selected: true,
      accessRole: 'reader',
    },
    {
      id: MOCK_DEALS_CALENDAR,
      summary: 'Deal flow (shared)',
      timeZone: MOCK_TIME_ZONE,
      colorId: '24',
      backgroundColor: '#a47ae2',
      foregroundColor: '#1d1d1d',
      selected: false,
      accessRole: 'reader',
    },
    {
      id: MOCK_HIDDEN_CALENDAR,
      summary: 'Old project',
      timeZone: MOCK_TIME_ZONE,
      backgroundColor: '#c2c2c2',
      foregroundColor: '#1d1d1d',
      selected: false,
      hidden: true,
      accessRole: 'owner',
    },
  ];

  // The main calendar: the demo's synced events, exactly as the day list reads them.
  const primary: GCalEvent[] = buildDemoDb(now).calendar_events.map((e) => ({
    id: e.provider_event_id,
    status: 'confirmed',
    summary: e.title,
    description: e.description ?? undefined,
    location: e.location ?? undefined,
    eventType: 'default',
    start: e.all_day
      ? { date: localDateKey(new Date(e.starts_at), MOCK_TIME_ZONE) }
      : { dateTime: e.starts_at, timeZone: MOCK_TIME_ZONE },
    end: e.all_day
      ? { date: localDateKey(new Date(e.ends_at), MOCK_TIME_ZONE) }
      : { dateTime: e.ends_at, timeZone: MOCK_TIME_ZONE },
    organizer: e.organizer_email
      ? { email: e.organizer_email, self: e.organizer_email === MOCK_OWN_EMAIL }
      : undefined,
    attendees: e.attendees.map((a) => ({
      email: a.email,
      displayName: a.name ?? undefined,
      responseStatus: a.response ?? undefined,
      ...(a.email === MOCK_OWN_EMAIL ? { self: true } : {}),
    })),
    htmlLink: `https://calendar.google.com/calendar/event?eid=${e.provider_event_id}`,
  }));

  const team: GCalEvent[] = [
    {
      id: 'demoteamofficehours',
      summary: 'Founder office hours',
      ...timed(today, [9, 15], [10, 15]),
      ...ownedBy(MOCK_TEAM_CALENDAR),
      attendees: [me(), guest('jordan@tiptop.demo', 'Jordan Lee')],
      hangoutLink: 'https://meet.google.com/dmo-offc-hrs',
    },
    {
      id: 'demoteamportfolio',
      summary: 'Portfolio check-in',
      ...timed(today, [9, 45], [10, 45]),
      ...ownedBy(MOCK_TEAM_CALENDAR),
      attendees: [me(), guest('riley@tiptop.demo', 'Riley Park')],
    },
    {
      // An invitation Nick has not answered yet: Going? Yes / No / Maybe.
      id: 'demoteamboard',
      summary: 'Ledgerly board meeting',
      ...timed(day(1), [13, 0], [14, 30]),
      organizer: { email: 'maya@ledgerly.demo', displayName: 'Maya Chen', self: false },
      attendees: [
        me('needsAction'),
        guest('maya@ledgerly.demo', 'Maya Chen'),
        guest('sam@ledgerly.demo', 'Sam Ortiz', 'tentative'),
      ],
      guestsCanModify: false,
      location: '500 Example Blvd, Austin',
      description:
        'Q3 review and the 2027 plan.<br>Agenda: <a href="https://docs.google.com/document/d/demo-ledgerly-agenda">board agenda</a>',
      attachments: [
        {
          fileUrl: 'https://drive.google.com/file/d/demo-ledgerly-deck/view',
          title: 'Ledgerly Q3 board deck.pdf',
          mimeType: 'application/pdf',
        },
      ],
    },
    {
      id: 'demoteamdemoday',
      summary: 'Accelerator demo day',
      start: { date: day(3) },
      end: { date: day(4) },
      ...ownedBy(MOCK_TEAM_CALENDAR),
    },
    ...[
      ['demoteamsession1', 'Demo day: fintech block', [9, 0], [10, 0]],
      ['demoteamsession2', 'Demo day: health block', [10, 0], [11, 0]],
      ['demoteamsession3', 'Demo day: lunch with founders', [12, 0], [13, 0]],
      ['demoteamsession4', 'Demo day: AI block', [13, 30], [14, 30]],
      ['demoteamsession5', 'Demo day: closing drinks', [17, 0], [18, 30]],
    ].map(([id, summary, from, to]): GCalEvent => ({
      id: id as string,
      summary: summary as string,
      ...timed(day(3), from as [number, number], to as [number, number]),
      ...ownedBy(MOCK_TEAM_CALENDAR),
      attendees: [me(), guest('casey@tiptop.demo', 'Casey Morgan')],
    })),
  ];

  const personal: GCalEvent[] = [
    {
      id: 'demopersonalhold',
      summary: 'Hold: dentist',
      ...timed(day(1), [8, 0], [9, 0]),
      ...ownedBy(MOCK_PERSONAL_CALENDAR),
    },
    {
      id: 'demopersonalgym',
      summary: 'Gym',
      colorId: '10',
      ...timed(day(2), [7, 0], [8, 0]),
      ...ownedBy(MOCK_PERSONAL_CALENDAR),
    },
    {
      id: 'demopersonaltrip',
      summary: 'Family trip',
      start: { date: day(8) },
      end: { date: day(11) },
      ...ownedBy(MOCK_PERSONAL_CALENDAR),
    },
  ];

  // A conference day twelve days out: long blocks that overlap each other
  // (travel, the conference, holds) under short meetings, some starting
  // together, the way a real busy day stacks up. It is what the overlap
  // layout (cascading, side by side, "+N") is checked and screenshotted on.
  const busy = day(BUSY_DAY_OFFSET);
  const busyBlocks: GCalEvent[] = [
    ['demobusytravel', 'Travel: flight to Denver', [6, 0], [11, 30]],
    ['demobusysummit', 'Demo Summit: conference day', [8, 0], [18, 0]],
    ['demobusybooth', 'Hold: summit booth shifts', [10, 0], [15, 0]],
    ['demobusyhotel', 'Hotel check-in window', [15, 0], [23, 0]],
    ['demobusydinner', 'Hold: investor dinner', [18, 30], [21, 30]],
  ].map(([id, summary, from, to]) => ({
    id: id as string,
    summary: summary as string,
    ...timed(busy, from as [number, number], to as [number, number]),
    ...ownedBy(MOCK_PERSONAL_CALENDAR),
  }));
  const busyMeetings: GCalEvent[] = [
    ['demobusycoffee', 'Coffee with Avery Brooks', [9, 0], [9, 30]],
    ['demobusypitch', 'Founder pitch: Northwind Robotics', [11, 0], [11, 45]],
    ['demobusylp', 'LP check-in: Harborview', [12, 0], [12, 45]],
    ['demobusypanel', 'Panel run-through', [12, 0], [12, 30]],
    ['demobusysync', 'Quick sync: Jordan', [12, 15], [12, 45]],
    ['demobusyroundtable', 'Superconductivityroundtable', [13, 30], [14, 30]],
    ['demobusyintro', 'Intro call: Quinn Labs', [14, 0], [14, 30]],
    ['demobusyriley', 'Call: Riley Park', [16, 0], [16, 30]],
    ['demobusymaple', 'Office hours: Maple founders', [16, 15], [17, 0]],
  ].map(([id, summary, from, to]) => ({
    id: id as string,
    summary: summary as string,
    ...timed(busy, from as [number, number], to as [number, number]),
    ...ownedBy(MOCK_TEAM_CALENDAR),
    attendees: [me(), guest('avery@northwind.demo', 'Avery Brooks')],
  }));
  // The day after it, more of the same shape: blocks of 6 to 12 hours over
  // one another, a red-eye that runs past midnight into the next morning, and
  // short meetings among them, two starting together.
  const busyNext = day(BUSY_DAY_OFFSET + 1);
  const busyAfter = day(BUSY_DAY_OFFSET + 2);
  const busyNextBlocks: GCalEvent[] = [
    ['demobusyday2', 'Demo Summit: day two', [7, 0], [16, 0]],
    ['demobusydealroom', 'Hold: deal room', [9, 30], [21, 30]],
    ['demobusycheckout', 'Hotel: late checkout window', [11, 0], [19, 0]],
  ].map(([id, summary, from, to]) => ({
    id: id as string,
    summary: summary as string,
    ...timed(busyNext, from as [number, number], to as [number, number]),
    ...ownedBy(MOCK_PERSONAL_CALENDAR),
  }));
  busyNextBlocks.push(
    {
      id: 'demobusyredeye',
      summary: 'Travel: red-eye home',
      start: { dateTime: at(busyNext, 22, 0), timeZone: MOCK_TIME_ZONE },
      end: { dateTime: at(busyAfter, 6, 30), timeZone: MOCK_TIME_ZONE },
      ...ownedBy(MOCK_PERSONAL_CALENDAR),
    },
    {
      id: 'demobusyrecover',
      summary: 'Hold: recovery morning',
      ...timed(busyAfter, [6, 30], [12, 30]),
      ...ownedBy(MOCK_PERSONAL_CALENDAR),
    },
  );
  const busyNextMeetings: GCalEvent[] = [
    ['demobusybreakfast', 'Breakfast: Sky Harbor partners', busyNext, [7, 30], [8, 15]],
    ['demobusykestrel', 'Founder pitch: Kestrel Bio', busyNext, [10, 0], [10, 45]],
    ['demobusylumen', 'Diligence call: Lumen Grid', busyNext, [13, 0], [13, 30]],
    ['demobusypinecrest', 'Diligence call: Pinecrest AI', busyNext, [13, 0], [14, 0]],
    ['demobusyrecap', 'Summit recap with Jordan', busyNext, [17, 30], [18, 0]],
    ['demobusydana', 'Call: Dana Whitfield', busyAfter, [9, 0], [9, 30]],
  ].map(([id, summary, date, from, to]) => ({
    id: id as string,
    summary: summary as string,
    ...timed(date as string, from as [number, number], to as [number, number]),
    ...ownedBy(MOCK_TEAM_CALENDAR),
    attendees: [me(), guest('avery@northwind.demo', 'Avery Brooks')],
  }));

  const holidays: GCalEvent[] = [
    {
      id: 'demoholidayfounders',
      summary: 'Founders Day (demo)',
      start: { date: day(5) },
      end: { date: day(6) },
      organizer: { email: MOCK_HOLIDAY_CALENDAR, displayName: 'Demo holidays', self: true },
      transparency: 'transparent',
    },
  ];

  const deals: GCalEvent[] = [
    {
      id: 'demodealspitch',
      summary: 'Pitch: Vetrix follow-up',
      ...timed(day(2), [15, 0], [15, 45]),
      organizer: { email: MOCK_DEALS_CALENDAR, displayName: 'Deal flow (shared)', self: true },
      attendees: [guest('priya@vetrix.demo', 'Priya Raman')],
    },
  ];

  const weekly: Series = {
    master: {
      id: 'demoteampartners',
      summary: 'Partner meeting',
      ...timed(nextMonday, [10, 0], [11, 0]),
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=12'],
      ...ownedBy(MOCK_TEAM_CALENDAR),
      attendees: [
        me(),
        guest('jordan@tiptop.demo', 'Jordan Lee'),
        guest('riley@tiptop.demo', 'Riley Park'),
      ],
      hangoutLink: 'https://meet.google.com/dmo-prtn-mtg',
    },
    exceptions: new Map(),
  };

  const all = (list: GCalEvent[], calendarId: string) =>
    list.map((e) => ({
      status: 'confirmed',
      eventType: 'default',
      htmlLink: `https://calendar.google.com/calendar/event?eid=${e.id}`,
      ...e,
      ...(e.organizer ? {} : ownedBy(calendarId)),
    }));

  return {
    calendars,
    colors: MOCK_COLORS,
    events: new Map([
      [MOCK_OWN_EMAIL, all(primary, MOCK_OWN_EMAIL)],
      [
        MOCK_TEAM_CALENDAR,
        all([...team, ...busyMeetings, ...busyNextMeetings], MOCK_TEAM_CALENDAR),
      ],
      [
        MOCK_PERSONAL_CALENDAR,
        all([...personal, ...busyBlocks, ...busyNextBlocks], MOCK_PERSONAL_CALENDAR),
      ],
      [MOCK_HOLIDAY_CALENDAR, all(holidays, MOCK_HOLIDAY_CALENDAR)],
      [MOCK_DEALS_CALENDAR, all(deals, MOCK_DEALS_CALENDAR)],
      [MOCK_HIDDEN_CALENDAR, []],
    ]),
    series: new Map([
      [
        MOCK_TEAM_CALENDAR,
        [
          {
            ...weekly,
            master: { status: 'confirmed', eventType: 'default', ...weekly.master },
          },
        ],
      ],
    ]),
    writes: [],
    reads: [],
    nextId: 1,
    timeZone: MOCK_TIME_ZONE,
  };
}

/** The demo's one shared mock calendar, per server process. */
export function sharedMockCalendar(): MockCalendarState {
  return processWide('mock-calendar-state', () => createMockCalendarState(new Date()));
}

/* ------------------------------------------------------------- queries */

/** `primary` is Google's alias for the account's own calendar. */
export function resolveCalendarId(state: MockCalendarState, calendarId: string): string | null {
  if (calendarId === 'primary') {
    return state.calendars.find((c) => c.primary)?.id ?? null;
  }
  return state.calendars.some((c) => c.id === calendarId) ? calendarId : null;
}

function bounds(event: GCalEvent, timeZone: string): { start: number; end: number } {
  const edge = (d: GCalEvent['start']) =>
    d?.dateTime
      ? Date.parse(d.dateTime)
      : d?.date
        ? (wallTimeToUtc(d.date, 0, 0, timeZone)?.getTime() ?? NaN)
        : NaN;
  const start = edge(event.start);
  const end = edge(event.end);
  return { start, end: Number.isFinite(end) ? end : start };
}

const compact = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Google's instance id: the series id and the instance's original start. */
export function instanceId(seriesId: string, start: GCalEvent['start']): string {
  if (start?.date) return `${seriesId}_${start.date.replace(/-/g, '')}`;
  return `${seriesId}_${compact(new Date(start!.dateTime!).toISOString())}`;
}

/** Each occurrence of a series, by its RRULE: weekly or daily, with COUNT or UNTIL. */
function occurrences(series: Series, timeZone: string, limit = 400): GCalEvent[] {
  const master = series.master;
  const rule = (master.recurrence ?? []).find((r) => r.startsWith('RRULE:'))?.slice(6) ?? '';
  const parts = Object.fromEntries(
    rule.split(';').map((p) => p.split('=') as [string, string]),
  ) as Record<string, string | undefined>;
  const step = parts.FREQ === 'DAILY' ? 1 : parts.FREQ === 'WEEKLY' ? 7 : 0;
  if (!step || !master.start) return [];
  const count = parts.COUNT ? Number(parts.COUNT) : limit;
  const until = parts.UNTIL
    ? Date.parse(parts.UNTIL.replace(/^(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3T23:59:59Z'))
    : Infinity;
  const { start, end } = bounds(master, timeZone);
  const length = end - start;
  const out: GCalEvent[] = [];
  const allDay = Boolean(master.start.date);
  const startKey = allDay ? master.start.date! : localDateKey(new Date(start), timeZone);
  const clock = allDay
    ? null
    : (() => {
        const d = new Date(start);
        const p = new Intl.DateTimeFormat('en-US', {
          timeZone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).formatToParts(d);
        const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0) % 24;
        return { hour: get('hour'), minute: get('minute') };
      })();
  for (let i = 0; i < Math.min(count, limit); i++) {
    const key = addDaysToKey(startKey, i * step);
    let occ: GCalEvent;
    if (allDay) {
      const days = Math.max(1, Math.round(length / 86_400_000));
      occ = {
        ...master,
        start: { date: key },
        end: { date: addDaysToKey(key, days) },
      };
    } else {
      const s = wallTimeToUtc(key, clock!.hour, clock!.minute, timeZone)!.getTime();
      occ = {
        ...master,
        start: { dateTime: new Date(s).toISOString(), timeZone: master.start.timeZone },
        end: { dateTime: new Date(s + length).toISOString(), timeZone: master.end?.timeZone },
      };
    }
    if (bounds(occ, timeZone).start > until) break;
    const id = instanceId(master.id, occ.start);
    const { recurrence: _recurrence, ...rest } = occ;
    const instance: GCalEvent = {
      ...rest,
      id,
      recurringEventId: master.id,
      originalStartTime: occ.start,
    };
    const exception = series.exceptions.get(id);
    if (exception === 'cancelled') continue;
    out.push(exception ? { ...instance, ...exception, id, recurringEventId: master.id } : instance);
  }
  return out;
}

/** Single events overlapping [timeMin, timeMax), series expanded, in start order. */
export function mockListRange(
  state: MockCalendarState,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): GCalEvent[] {
  const min = Date.parse(timeMin);
  const max = Date.parse(timeMax);
  const list = [
    ...(state.events.get(calendarId) ?? []),
    ...(state.series.get(calendarId) ?? []).flatMap((s) => occurrences(s, state.timeZone)),
  ];
  return list
    .filter((e) => e.status !== 'cancelled')
    .filter((e) => {
      const { start, end } = bounds(e, state.timeZone);
      return start < max && (end > min || (end === start && start >= min));
    })
    .sort((a, b) => bounds(a, state.timeZone).start - bounds(b, state.timeZone).start)
    .map((e) => structuredClone(e));
}

export type Located =
  | { kind: 'single'; event: GCalEvent; list: GCalEvent[] }
  | { kind: 'series'; event: GCalEvent; series: Series; seriesList: Series[] }
  | { kind: 'instance'; event: GCalEvent; series: Series };

/** Find an event by id on a calendar: a one-off, a series, or one instance of a series. */
export function locate(
  state: MockCalendarState,
  calendarId: string,
  eventId: string,
): Located | null {
  const list = state.events.get(calendarId) ?? [];
  const single = list.find((e) => e.id === eventId);
  if (single) return { kind: 'single', event: single, list };
  const seriesList = state.series.get(calendarId) ?? [];
  const series = seriesList.find((s) => s.master.id === eventId);
  if (series) return { kind: 'series', event: series.master, series, seriesList };
  for (const s of seriesList) {
    if (!eventId.startsWith(`${s.master.id}_`)) continue;
    const instance = occurrences(s, state.timeZone).find((o) => o.id === eventId);
    if (instance) return { kind: 'instance', event: instance, series: s };
  }
  return null;
}

/** A patch as Google applies one: named fields replaced, `null` clears. */
export function applyPatch(event: GCalEvent, body: GCalEventWrite): GCalEvent {
  const next: Record<string, unknown> = { ...event };
  // Google's answer-only form: the guests named change their entry, and
  // everyone else on the list stays as they were.
  const answerOnly = body.attendeesOmitted === true && body.attendees !== undefined;
  if (answerOnly) {
    const named = new Map(body.attendees!.map((a) => [a.email?.toLowerCase(), a]));
    next.attendees = (event.attendees ?? []).map((a) => {
      const entry = named.get(a.email?.toLowerCase());
      return entry ? structuredClone({ ...a, responseStatus: entry.responseStatus }) : a;
    });
  }
  for (const [field, value] of Object.entries(body)) {
    if (value === undefined || field === 'attendeesOmitted') continue;
    if (answerOnly && field === 'attendees') continue;
    if (value === null) {
      delete next[field];
      continue;
    }
    if (field === 'start' || field === 'end') {
      const merged = Object.fromEntries(
        Object.entries({ ...(next[field] as object), ...(value as object) }).filter(
          ([, v]) => v !== null && v !== undefined,
        ),
      );
      next[field] = merged;
      continue;
    }
    next[field] = structuredClone(value);
  }
  return next as unknown as GCalEvent;
}

/** What Google does with a Meet request: a link, at once. */
export function fulfilConference(event: GCalEvent, state: MockCalendarState): GCalEvent {
  const request = event.conferenceData?.createRequest;
  if (!request || request.conferenceSolutionKey?.type !== 'hangoutsMeet') return event;
  const n = state.nextId++;
  const code = `dmo-${String(n).padStart(4, '0')}-mtg`;
  const uri = `https://meet.google.com/${code}`;
  return {
    ...event,
    hangoutLink: uri,
    conferenceData: {
      createRequest: { ...request, status: { statusCode: 'success' } },
      entryPoints: [{ entryPointType: 'video', uri, label: uri.replace('https://', '') }],
      conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
      conferenceId: code,
    },
  };
}

export function newMockEventId(state: MockCalendarState): string {
  return `demonew${String(state.nextId++).padStart(5, '0')}`;
}
