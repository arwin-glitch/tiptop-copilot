import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyMeeting, toMeetingEvent } from '@/lib/calendar/meetings';
import {
  createMockCalendarState,
  MOCK_DEALS_CALENDAR,
  MOCK_HIDDEN_CALENDAR,
  MOCK_HOLIDAY_CALENDAR,
  MOCK_OWN_EMAIL,
  MOCK_PERSONAL_CALENDAR,
  MOCK_TEAM_CALENDAR,
  type MockCalendarState,
} from '@/lib/calendar/mock-calendar';
import { checkCalendarParity, diffDay, eventsOnDay } from '@/lib/calendar/parity';
import { GoogleCalendarProvider, MockCalendarProvider } from '@/lib/calendar/provider';
import {
  invalidateCalendarCache,
  readCalendarRange,
  resetCalendarRangeCache,
  type CalendarSource,
} from '@/lib/calendar/range-reader';
import { storeTokens } from '@/lib/google/oauth';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import {
  DEFAULT_CALENDAR_PREFS,
  readCalendarPrefs,
  saveCalendarPrefs,
} from '@/lib/services/calendar-prefs';
import { ok } from '@/lib/util/result';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The new views' reader, over the mock calendar (and Google's own pages,
 * with fetch stubbed): any range, every visible calendar, Google's names and
 * colours, recurring series as their instances, and the same verdict the day
 * list gives. Then the parity check that compares the two readers, and the
 * per-person settings behind the switch.
 */

const NOW = new Date('2026-10-21T15:00:00Z'); // Wednesday, 10:00 in Chicago
const TZ = 'America/Chicago';

let harness: Harness;
let state: MockCalendarState;
let source: CalendarSource;

beforeEach(async () => {
  harness = await createHarness({ now: NOW });
  resetCalendarRangeCache();
  state = createMockCalendarState(NOW);
  source = {
    provider: new MockCalendarProvider(NOW, state),
    integration: null,
    ownEmails: [MOCK_OWN_EMAIL],
    demo: true,
  };
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await harness.dispose();
});

const read = (
  from: string,
  to: string,
  extra: Partial<Parameters<typeof readCalendarRange>[2]> = {},
) =>
  readCalendarRange(harness.store, harness.auth.organizationId, {
    from,
    to,
    timeZone: TZ,
    ownEmail: MOCK_OWN_EMAIL,
    source,
    ...extra,
  });

describe('the calendar list', () => {
  it('lists every calendar but Google’s hidden ones: main first, then writable, then the rest', async () => {
    const data = await read('2026-10-18', '2026-10-25');
    expect(data.state).toBe('ok');
    expect(data.calendars.map((c) => c.id)).toEqual([
      MOCK_OWN_EMAIL,
      MOCK_PERSONAL_CALENDAR,
      MOCK_TEAM_CALENDAR,
      MOCK_DEALS_CALENDAR,
      MOCK_HOLIDAY_CALENDAR,
    ]);
    expect(data.calendars.some((c) => c.id === MOCK_HIDDEN_CALENDAR)).toBe(false);
    // Google's labels: the person's own name for a calendar wins over its summary.
    expect(data.calendars.find((c) => c.id === MOCK_PERSONAL_CALENDAR)?.name).toBe('Personal');
    expect(data.calendars.find((c) => c.id === MOCK_TEAM_CALENDAR)).toMatchObject({
      writable: true,
      accessRole: 'writer',
      color: { background: '#16a765', foreground: '#1d1d1d' },
    });
    expect(data.calendars.find((c) => c.id === MOCK_HOLIDAY_CALENDAR)?.writable).toBe(false);
  });

  it('reads the calendars ticked in Google, and the person’s own toggles over them', async () => {
    const plain = await read('2026-10-18', '2026-10-25');
    expect(plain.loaded).not.toContain(MOCK_DEALS_CALENDAR); // unticked in Google
    expect(plain.loaded).toContain(MOCK_TEAM_CALENDAR);
    const toggled = await read('2026-10-18', '2026-10-25', {
      shown: { [MOCK_DEALS_CALENDAR]: true, [MOCK_TEAM_CALENDAR]: false },
    });
    expect(toggled.loaded).toContain(MOCK_DEALS_CALENDAR);
    expect(toggled.loaded).not.toContain(MOCK_TEAM_CALENDAR);
  });

  it('asks Google once per visible calendar for the whole range, a month included', async () => {
    await read('2026-09-27', '2026-11-08');
    const ranges = state.reads.filter((r) => r.op === 'range').map((r) => r.calendarId);
    expect(ranges.sort()).toEqual(
      [MOCK_OWN_EMAIL, MOCK_PERSONAL_CALENDAR, MOCK_TEAM_CALENDAR, MOCK_HOLIDAY_CALENDAR].sort(),
    );
  });
});

describe('the events in a range', () => {
  it('expands a repeating event into its instances, any week ahead', async () => {
    const data = await read('2026-11-08', '2026-11-15');
    const partner = data.events.filter((e) => e.title === 'Partner meeting');
    expect(partner).toHaveLength(1);
    expect(partner[0]).toMatchObject({
      recurringEventId: 'demoteampartners',
      calendarId: MOCK_TEAM_CALENDAR,
      startsAt: '2026-11-09T16:00:00.000Z', // 10:00 CST, after the clocks changed
      canModify: true,
      meetUrl: 'https://meet.google.com/dmo-prtn-mtg',
    });
    expect(partner[0]!.id).toMatch(/^demoteampartners_20261109T160000Z$/);
  });

  it('reads the past as well as the future', async () => {
    const data = await read('2026-10-14', '2026-10-21');
    expect(data.state).toBe('ok');
    expect(data.events.some((e) => e.title === 'Partner meeting')).toBe(false); // starts on the 26th
  });

  it('keeps all-day events on their own dates, and multi-day ones across them', async () => {
    const data = await read('2026-10-25', '2026-11-08');
    const trip = data.events.find((e) => e.title === 'Family trip');
    expect(trip).toMatchObject({
      allDay: true,
      startDate: '2026-10-29',
      endDate: '2026-11-01',
      startsAt: null,
    });
    expect(eventsOnDay(data.events, '2026-10-31', TZ).some((e) => e.title === 'Family trip')).toBe(
      true,
    );
    expect(eventsOnDay(data.events, '2026-11-01', TZ).some((e) => e.title === 'Family trip')).toBe(
      false,
    );
  });

  it('colours each event from Google: its colorId’s colour, else its calendar’s', async () => {
    const data = await read('2026-10-18', '2026-10-25');
    expect(data.events.find((e) => e.title === 'Gym')?.color).toEqual({
      background: '#51b749',
      foreground: '#1d1d1d',
    });
    expect(data.events.find((e) => e.title === 'Hold: dentist')?.color.background).toBe('#f691b2');
    expect(data.palette).toHaveLength(11);
    expect(data.palette[10]).toMatchObject({ id: '11', name: 'Tomato' });
  });

  it('gives every event the verdict classifyMeeting gives it, holds as tagged blocks', async () => {
    const data = await read('2026-10-18', '2026-10-25');
    for (const calendarId of data.loaded) {
      const listed = await source.provider.listRange(calendarId, {
        timeMin: '2026-10-18T05:00:00.000Z',
        timeMax: '2026-10-25T05:00:00.000Z',
      });
      if (!listed.ok) throw new Error('read failed');
      for (const google of listed.value) {
        const event = data.events.find((e) => e.id === google.id && e.calendarId === calendarId)!;
        const verdict = classifyMeeting(toMeetingEvent(google), [MOCK_OWN_EMAIL]);
        expect(event.verdict, google.summary).toEqual(verdict);
      }
    }
    const hold = data.events.find((e) => e.title === 'Hold: dentist')!;
    expect(hold).toMatchObject({
      hold: true,
      verdict: { meeting: false, reason: 'A hold, not confirmed' },
    });
    expect(data.events.find((e) => e.title === 'Founder office hours')?.verdict.meeting).toBe(true);
  });

  it('marks what cannot be changed here, and says why', async () => {
    const data = await read('2026-10-18', '2026-11-01');
    expect(data.events.find((e) => e.title === 'Ledgerly board meeting')).toMatchObject({
      canModify: false,
      readOnlyReason: 'Only the organizer (Maya Chen) can change this event.',
    });
    expect(data.events.find((e) => e.title === 'Founders Day (demo)')).toMatchObject({
      canModify: false,
      readOnlyReason: 'This calendar is view-only for this account.',
    });
  });

  it('passes only https links to the page, whatever an invite carried', async () => {
    state.events.get(MOCK_TEAM_CALENDAR)!.push({
      id: 'oddlinks',
      summary: 'Odd links',
      start: { dateTime: '2026-10-22T20:00:00Z' },
      end: { dateTime: '2026-10-22T20:30:00Z' },
      organizer: { email: MOCK_TEAM_CALENDAR, self: true },
      hangoutLink: 'javascript:alert(1)',
      htmlLink: 'http://calendar.example/event',
    });
    const data = await read('2026-10-18', '2026-10-25');
    expect(data.events.find((e) => e.id === 'oddlinks')).toMatchObject({
      joinUrl: null,
      meetUrl: null,
      htmlLink: null,
    });
  });

  it('leaves out a cancelled instance, as Google does', async () => {
    await source.provider.deleteEvent(MOCK_TEAM_CALENDAR, 'demoteampartners_20261102T160000Z', {
      sendUpdates: 'none',
    });
    const data = await read('2026-11-01', '2026-11-08');
    expect(data.events.some((e) => e.title === 'Partner meeting')).toBe(false);
  });

  it('refuses a range longer than two months', async () => {
    const data = await read('2026-01-01', '2026-06-01');
    expect(data.state).toBe('error');
  });
});

describe('reading Google’s own pages', () => {
  it('follows nextPageToken, asks for single events, and drops cancelled ones', async () => {
    const integration = (await getPrimaryIntegration(harness.store, harness.auth.organizationId))!;
    await storeTokens(harness.store, integration, {
      accessToken: 'test-token',
      expiresInSeconds: 3600,
    });
    const fetchMock = vi.fn(async (url: string) => {
      const page = new URL(url).searchParams.get('pageToken');
      const items = page
        ? [
            { id: 'b', status: 'cancelled' },
            {
              id: 'c',
              summary: 'Third',
              start: { date: '2026-10-22' },
              end: { date: '2026-10-23' },
            },
          ]
        : [
            {
              id: 'a',
              summary: 'First',
              start: { dateTime: '2026-10-21T15:00:00Z' },
              end: { dateTime: '2026-10-21T16:00:00Z' },
            },
          ];
      return new Response(JSON.stringify({ items, ...(page ? {} : { nextPageToken: 'p2' }) }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GoogleCalendarProvider(harness.store, integration);
    const res = await provider.listRange('team@group.calendar.google.com', {
      timeMin: '2026-10-18T05:00:00.000Z',
      timeMax: '2026-10-25T05:00:00.000Z',
    });
    expect(res.ok && res.value.map((e) => e.id)).toEqual(['a', 'c']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(first.pathname).toBe('/calendar/v3/calendars/team%40group.calendar.google.com/events');
    expect(Object.fromEntries(first.searchParams)).toEqual({
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
      timeMin: '2026-10-18T05:00:00.000Z',
      timeMax: '2026-10-25T05:00:00.000Z',
    });
    expect(new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('pageToken')).toBe('p2');
  });

  it('keeps a live read for a minute, and drops it when a write changes that calendar', async () => {
    const listRange = vi.fn(async () => ok([]));
    const google = {
      ...new MockCalendarProvider(NOW, state),
      kind: 'google' as const,
      listCalendars: async () => ok(state.calendars),
      getColors: async () => ok(state.colors),
      listRange,
    } as unknown as CalendarSource['provider'];
    source = { provider: google, integration: null, ownEmails: [MOCK_OWN_EMAIL], demo: false };
    const at = NOW.getTime();
    await read('2026-10-18', '2026-10-25', { now: at, calendarIds: [MOCK_TEAM_CALENDAR] });
    await read('2026-10-18', '2026-10-25', { now: at + 30_000, calendarIds: [MOCK_TEAM_CALENDAR] });
    expect(listRange).toHaveBeenCalledTimes(1);
    invalidateCalendarCache(harness.auth.organizationId, [MOCK_TEAM_CALENDAR]);
    await read('2026-10-18', '2026-10-25', { now: at + 31_000, calendarIds: [MOCK_TEAM_CALENDAR] });
    expect(listRange).toHaveBeenCalledTimes(2);
    await read('2026-10-18', '2026-10-25', {
      now: at + 120_000,
      calendarIds: [MOCK_TEAM_CALENDAR],
    });
    expect(listRange).toHaveBeenCalledTimes(3);
  });
});

describe('the parity check', () => {
  it('finds the day list and the new views in step on the demo calendar, and writes nothing', async () => {
    const report = await checkCalendarParity(harness.store, harness.auth.organizationId, {
      from: '2026-10-20',
      days: 3,
      timeZone: TZ,
      ownEmail: MOCK_OWN_EMAIL,
      source,
    });
    expect(report.state).toBe('ok');
    expect(report.totals).toMatchObject({
      current: 4,
      next: 4,
      matched: 4,
      differences: 0,
      failedDays: 0,
    });
    expect(state.writes).toEqual([]);
  });

  it('lists an event missing from one side, an extra one, and a changed title or time', async () => {
    const primary = state.events.get(MOCK_OWN_EMAIL)!;
    primary[0]!.summary = 'Renamed in Google';
    primary[1]!.start = { dateTime: '2026-10-21T16:30:00Z' };
    primary.splice(2, 1);
    primary.push({
      id: 'newinmock',
      summary: 'Only in the new reader',
      start: { dateTime: '2026-10-21T20:00:00Z' },
      end: { dateTime: '2026-10-21T20:30:00Z' },
      organizer: { email: MOCK_OWN_EMAIL, self: true },
    });
    const report = await checkCalendarParity(harness.store, harness.auth.organizationId, {
      from: '2026-10-21',
      days: 1,
      timeZone: TZ,
      ownEmail: MOCK_OWN_EMAIL,
      source,
    });
    const kinds = report.dayReports[0]!.differences.map(
      (d) => `${d.kind}:${d.fields.map((f) => f.field).join('+')}`,
    );
    expect(kinds.sort()).toEqual(['changed:start', 'changed:title', 'extra:', 'missing:'].sort());
  });

  it('compares verdicts too', () => {
    const base = {
      id: 'e',
      title: 'Call',
      startsAt: '2026-10-21T15:00:00Z',
      endsAt: '2026-10-21T15:30:00Z',
      allDay: false,
    };
    const diff = diffDay(
      '2026-10-21',
      [{ ...base, meeting: true, reason: 'With Pat' }],
      [{ ...base, meeting: false, reason: 'No one else is on it' }],
      TZ,
    );
    expect(diff).toEqual([
      {
        dateKey: '2026-10-21',
        kind: 'changed',
        id: 'e',
        title: 'Call',
        startsAt: base.startsAt,
        fields: [
          { field: 'verdict', current: 'Meeting: With Pat', next: 'Block: No one else is on it' },
        ],
      },
    ]);
  });
});

describe('each person’s calendar settings', () => {
  it('start with the day list, and remember the switch, the view and the toggles', async () => {
    const { organizationId, userId } = harness.auth;
    expect(await readCalendarPrefs(harness.store, organizationId, userId)).toEqual(
      DEFAULT_CALENDAR_PREFS,
    );
    await saveCalendarPrefs(harness.store, organizationId, userId, {
      preview: true,
      view: 'month',
    });
    await saveCalendarPrefs(harness.store, organizationId, userId, {
      shown: { [MOCK_DEALS_CALENDAR]: true },
    });
    await saveCalendarPrefs(harness.store, organizationId, userId, {
      shown: { [MOCK_TEAM_CALENDAR]: false },
    });
    expect(await readCalendarPrefs(harness.store, organizationId, userId)).toEqual({
      preview: true,
      view: 'month',
      shown: { [MOCK_DEALS_CALENDAR]: true, [MOCK_TEAM_CALENDAR]: false },
    });
  });
});
