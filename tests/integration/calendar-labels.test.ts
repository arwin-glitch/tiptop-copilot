import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CitationRegistry } from '@/lib/ai/citations';
import { executeTool, type ToolContext } from '@/lib/ai/tools/registry';
import { colorRequest } from '@/lib/calendar/event-actions';
import {
  createMockCalendarState,
  MOCK_HOLIDAY_CALENDAR,
  MOCK_LABELS,
  MOCK_OWN_EMAIL,
  MOCK_PERSONAL_CALENDAR,
  MOCK_TEAM_CALENDAR,
  type MockCalendarState,
} from '@/lib/calendar/mock-calendar';
import { GoogleCalendarProvider, MockCalendarProvider } from '@/lib/calendar/provider';
import {
  LABELS_TTL_MS,
  readCalendarLabels,
  readCalendarRange,
  resetCalendarRangeCache,
  type CalendarSource,
} from '@/lib/calendar/range-reader';
import type { RangeEvent } from '@/lib/calendar/range-types';
import {
  createCalendarEvent,
  recolorCalendarEvent,
  relabelCalendarEvent,
  updateCalendarEvent,
  type WriteContext,
} from '@/lib/calendar/write';
import { storeTokens } from '@/lib/google/oauth';
import { CALENDAR_EDIT_SCOPES } from '@/lib/google/send-scopes';
import {
  labelReport,
  listEventsWithLabels,
  resetLabelKnowledgeCache,
  suggestedLabelFor,
} from '@/lib/services/calendar-labels';
import { findEventOrigin, resetOriginCache } from '@/lib/services/calendar-origin';
import {
  CALENDAR_PREFS_PATCH,
  readCalendarPrefs,
  saveCalendarPrefs,
} from '@/lib/services/calendar-prefs';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import type { Integration } from '@/lib/types/domain';
import { todayWindow } from '@/lib/util/time';
import { ok } from '@/lib/util/result';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Google Calendar's colour labels over the mock calendar (which records
 * every request as Google would receive it) and Google's own endpoints
 * (fetch stubbed): reads ask for eventLabelVersion=1 and come back with each
 * event's label; a label write is eventLabelId alone, with
 * eventLabelVersion=1 and sendUpdates none, under the colour's rules; a
 * colour write never carries the version. Then Ask's calendar tool, the
 * suggested label, "How you got here" and the Diagnostics readout. Nothing
 * here reaches Google.
 */

const NOW = new Date('2026-10-21T15:00:00Z');
const TZ = 'America/Chicago';
const READ_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];

let harness: Harness;
let state: MockCalendarState;

function integration(scopes: string[]): Integration {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    organization_id: harness.auth.organizationId,
    user_id: harness.auth.userId,
    provider: 'google',
    kinds: ['gmail', 'calendar'],
    account_email: MOCK_OWN_EMAIL,
    scopes,
    status: 'connected',
    status_detail: null,
    last_sync_at: null,
    last_sync_error: null,
    sync_cursor: null,
    watch_expires_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function source(scopes: string[] = [...READ_SCOPES, ...CALENDAR_EDIT_SCOPES]): CalendarSource {
  return {
    provider: new MockCalendarProvider(NOW, state),
    integration: integration(scopes),
    ownEmails: [MOCK_OWN_EMAIL],
    demo: false,
  };
}

function context(scopes?: string[]): WriteContext {
  return {
    store: harness.store,
    organizationId: harness.auth.organizationId,
    userId: harness.auth.userId,
    source: source(scopes),
  };
}

async function read(calendarIds: string[], from = '2026-10-18', to = '2026-11-08') {
  return readCalendarRange(harness.store, harness.auth.organizationId, {
    from,
    to,
    timeZone: TZ,
    ownEmail: MOCK_OWN_EMAIL,
    calendarIds,
    source: source(),
    now: NOW.getTime(),
  });
}

async function eventTitled(title: string, calendarIds: string[]): Promise<RangeEvent> {
  const found = (await read(calendarIds)).events.find((e) => e.title === title);
  if (!found) throw new Error(`No event titled ${title}`);
  return found;
}

beforeEach(async () => {
  harness = await createHarness({ now: NOW });
  resetCalendarRangeCache();
  resetLabelKnowledgeCache();
  resetOriginCache();
  state = createMockCalendarState(NOW);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await harness.dispose();
});

/* --------------------------------------------------------------- reading */

describe('reading labels with a range', () => {
  it('gives each shown calendar its labels, and each event its label and colour', async () => {
    const data = await read([MOCK_OWN_EMAIL, MOCK_PERSONAL_CALENDAR, MOCK_TEAM_CALENDAR]);
    const main = data.calendars.find((c) => c.id === MOCK_OWN_EMAIL)!;
    expect(main.labels.map((l) => l.name)).toEqual([
      'Portfolio',
      'LPs',
      'Founders',
      'Diligence',
      'VCs',
      'Internal',
      'Travel',
      'Event',
      'Personal',
    ]);
    expect(data.calendars.find((c) => c.id === MOCK_TEAM_CALENDAR)!.labels).toEqual([]);
    // Not read this time: no labels yet.
    expect(data.calendars.find((c) => c.id === MOCK_HOLIDAY_CALENDAR)!.labels).toEqual([]);

    const board = data.events.find((e) => e.title === 'Ledgerly board prep')!;
    expect(board).toMatchObject({
      labelId: MOCK_LABELS.portfolio.id,
      label: { name: 'Portfolio', color: { background: '#33b679' } },
      color: { background: '#33b679' },
    });
    const flight = data.events.find((e) => e.title === 'Travel: flight to Denver')!;
    expect(flight.label?.name).toBe('Travel');
    expect(flight.color.background).toBe('#0b8043');
    // No label: the calendar's colour, as before.
    expect(data.events.find((e) => e.title === 'Hold: dentist')).toMatchObject({
      labelId: null,
      label: null,
      color: { background: '#f691b2' },
    });
  });

  it('asks the mock for each calendar’s labels once per range read', async () => {
    await read([MOCK_OWN_EMAIL, MOCK_TEAM_CALENDAR]);
    expect(
      state.reads
        .filter((r) => r.op === 'calendar')
        .map((r) => r.calendarId)
        .sort(),
    ).toEqual([MOCK_OWN_EMAIL, MOCK_TEAM_CALENDAR].sort());
  });

  it('keeps Google’s labels under a minute, so a rename shows within one', async () => {
    const getCalendar = vi.fn(async (id: string) =>
      ok({
        id,
        labelProperties: { eventLabels: [{ id: 'x', name: 'Before', backgroundColor: '#123456' }] },
      }),
    );
    const google: CalendarSource = {
      provider: {
        ...source().provider,
        kind: 'google',
        getCalendar,
      } as unknown as CalendarSource['provider'],
      integration: null,
      ownEmails: [MOCK_OWN_EMAIL],
      demo: false,
    };
    const org = harness.auth.organizationId;
    const at = NOW.getTime();
    expect((await readCalendarLabels(google, org, 'cal', at))[0]?.name).toBe('Before');
    getCalendar.mockImplementation(async (id: string) =>
      ok({
        id,
        labelProperties: { eventLabels: [{ id: 'x', name: 'After', backgroundColor: '#123456' }] },
      }),
    );
    expect((await readCalendarLabels(google, org, 'cal', at + 30_000))[0]?.name).toBe('Before');
    expect(LABELS_TTL_MS).toBeLessThanOrEqual(60_000);
    expect((await readCalendarLabels(google, org, 'cal', at + LABELS_TTL_MS + 1))[0]?.name).toBe(
      'After',
    );
    expect(getCalendar).toHaveBeenCalledTimes(2);
  });

  it('a calendar whose labels cannot be read still draws, in Google’s colours', async () => {
    const failing: CalendarSource = {
      ...source(),
      provider: Object.assign(Object.create(MockCalendarProvider.prototype), source().provider, {
        getCalendar: async () => ({
          ok: false,
          error: { code: 'provider_unavailable', message: 'down' },
        }),
      }),
    };
    const data = await readCalendarRange(harness.store, harness.auth.organizationId, {
      from: '2026-10-18',
      to: '2026-10-25',
      timeZone: TZ,
      ownEmail: MOCK_OWN_EMAIL,
      calendarIds: [MOCK_OWN_EMAIL],
      source: failing,
      now: NOW.getTime(),
    });
    expect(data.state).toBe('ok');
    expect(data.calendars.find((c) => c.id === MOCK_OWN_EMAIL)!.labels).toEqual([]);
    const board = data.events.find((e) => e.title === 'Ledgerly board prep')!;
    expect(board.labelId).toBe(MOCK_LABELS.portfolio.id);
    expect(board.label).toBeNull();
    expect(board.color.background).toBe('#9fe1e7');
  });
});

describe('Google’s endpoints (fetch stubbed)', () => {
  async function google() {
    const record = (await getPrimaryIntegration(harness.store, harness.auth.organizationId))!;
    await storeTokens(harness.store, record, { accessToken: 'test-token', expiresInSeconds: 3600 });
    return new GoogleCalendarProvider(harness.store, record);
  }

  it('reads a calendar and one event with eventLabelVersion=1', async () => {
    const fetchMock = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/events/')
              ? { id: 'e1', eventLabelId: 'l1' }
              : { id: 'team@group.calendar.google.com', labelProperties: { eventLabels: [] } },
          ),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = await google();
    await provider.getCalendar('team@group.calendar.google.com');
    const event = await provider.getEvent('team@group.calendar.google.com', 'e1');
    const urls = fetchMock.mock.calls.map((c) => new URL(String(c[0])));
    expect(urls[0]!.pathname).toBe('/calendar/v3/calendars/team%40group.calendar.google.com');
    expect(urls[0]!.searchParams.get('eventLabelVersion')).toBe('1');
    expect(urls[1]!.pathname).toBe(
      '/calendar/v3/calendars/team%40group.calendar.google.com/events/e1',
    );
    expect(urls[1]!.searchParams.get('eventLabelVersion')).toBe('1');
    expect(event.ok && event.value.eventLabelId).toBe('l1');
  });

  it('asks once more without the switch if calendars.get ever refuses it', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      new URL(url).searchParams.has('eventLabelVersion')
        ? new Response('{}', { status: 400 })
        : new Response(JSON.stringify({ id: 'cal' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await (await google()).getCalendar('cal');
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends eventLabelVersion=1 on a label write, never on a colour write', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 'e1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = await google();
    await provider.patchEvent(
      'cal',
      'e1',
      { eventLabelId: 'l1' },
      { sendUpdates: 'none', eventLabelVersion: 1 },
    );
    const colour = colorRequest('11');
    await provider.patchEvent('cal', 'e1', colour.body, {
      sendUpdates: colour.sendUpdates,
      conferenceDataVersion: colour.conferenceDataVersion,
    });
    const [label, color] = fetchMock.mock.calls.map((c) => ({
      url: new URL(String((c as unknown[])[0])),
      body: JSON.parse(String(((c as unknown[])[1] as RequestInit).body)) as unknown,
    }));
    expect(Object.fromEntries(label!.url.searchParams)).toEqual({
      sendUpdates: 'none',
      eventLabelVersion: '1',
    });
    expect(label!.body).toEqual({ eventLabelId: 'l1' });
    expect(Object.fromEntries(color!.url.searchParams)).toEqual({ sendUpdates: 'none' });
    expect(color!.body).toEqual({ colorId: '11' });
  });
});

/* -------------------------------------------------------------- writing */

describe('a label from the card', () => {
  it('patches eventLabelId alone, with eventLabelVersion=1 and sendUpdates none', async () => {
    const coffee = await eventTitled('Coffee — Elena Ward (Marchmont)', [MOCK_OWN_EMAIL]);
    const res = await relabelCalendarEvent(context(), {
      calendarId: MOCK_OWN_EMAIL,
      eventId: coffee.id,
      scope: 'this',
      labelId: MOCK_LABELS.lps.id,
    });
    expect(res.ok).toBe(true);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({
      op: 'patch',
      calendarId: MOCK_OWN_EMAIL,
      eventId: coffee.id,
      sendUpdates: 'none',
      conferenceDataVersion: 0,
      eventLabelVersion: 1,
    });
    // The label and nothing else (toMatchObject would let other fields through).
    expect(state.writes[0]!.body).toEqual({ eventLabelId: MOCK_LABELS.lps.id });
    if (res.ok) {
      expect(res.value.event).toMatchObject({
        labelId: MOCK_LABELS.lps.id,
        label: { name: 'LPs' },
        color: { background: '#8e24aa' },
      });
    }
    // Google has it: the next read shows it.
    expect(
      (await eventTitled('Coffee — Elena Ward (Marchmont)', [MOCK_OWN_EMAIL])).label?.name,
    ).toBe('LPs');
  });

  it('No label clears it with an empty eventLabelId', async () => {
    const board = await eventTitled('Ledgerly board prep', [MOCK_OWN_EMAIL]);
    const res = await relabelCalendarEvent(context(), {
      calendarId: MOCK_OWN_EMAIL,
      eventId: board.id,
      scope: 'this',
      labelId: null,
    });
    expect(res.ok && res.value.event?.label).toBeNull();
    expect(state.writes[0]!.body).toEqual({ eventLabelId: '' });
    expect(state.writes[0]!.eventLabelVersion).toBe(1);
  });

  it('is refused without calendar editing, on a view-only calendar, and for a label it does not have', async () => {
    const coffee = await eventTitled('Coffee — Elena Ward (Marchmont)', [MOCK_OWN_EMAIL]);
    const off = await relabelCalendarEvent(context(READ_SCOPES), {
      calendarId: MOCK_OWN_EMAIL,
      eventId: coffee.id,
      scope: 'this',
      labelId: MOCK_LABELS.lps.id,
    });
    expect(!off.ok && off.error.code).toBe('forbidden');
    const viewOnly = await relabelCalendarEvent(context(), {
      calendarId: MOCK_HOLIDAY_CALENDAR,
      eventId: 'demoholidayfounders',
      scope: 'this',
      labelId: MOCK_LABELS.lps.id,
    });
    expect(!viewOnly.ok && viewOnly.error.code).toBe('forbidden');
    // Personal's own labels are not the main calendar's.
    const wrong = await relabelCalendarEvent(context(), {
      calendarId: MOCK_OWN_EMAIL,
      eventId: coffee.id,
      scope: 'this',
      labelId: MOCK_LABELS.personalTravel.id,
    });
    expect(!wrong.ok && wrong.error.code).toBe('invalid_input');
    // A calendar without labels keeps Google's colours.
    const none = await relabelCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamofficehours',
      scope: 'this',
      labelId: MOCK_LABELS.lps.id,
    });
    expect(!none.ok && none.error.code).toBe('invalid_input');
    expect(state.writes).toEqual([]);
  });

  it('is allowed on Nick’s copy of an invitation, as a colour is', async () => {
    const mixer = await eventTitled('Harborlight Founders Mixer', [MOCK_PERSONAL_CALENDAR]);
    expect(mixer.canModify).toBe(false);
    const res = await relabelCalendarEvent(context(), {
      calendarId: MOCK_PERSONAL_CALENDAR,
      eventId: mixer.id,
      scope: 'this',
      labelId: MOCK_LABELS.personalEvent.id,
    });
    expect(res.ok).toBe(true);
    expect(state.writes[0]).toMatchObject({ sendUpdates: 'none', eventLabelVersion: 1 });
  });

  it('a colour on a calendar with labels still never sends the label switch', async () => {
    const coffee = await eventTitled('Coffee — Elena Ward (Marchmont)', [MOCK_OWN_EMAIL]);
    await recolorCalendarEvent(context(), {
      calendarId: MOCK_OWN_EMAIL,
      eventId: coffee.id,
      scope: 'this',
      colorId: '11',
    });
    expect(state.writes[0]).toMatchObject({ body: { colorId: '11' }, eventLabelVersion: 0 });
  });

  it('from the editor: a label change tells nobody, and a new event can start with one', async () => {
    const coffee = await eventTitled('Coffee — Elena Ward (Marchmont)', [MOCK_OWN_EMAIL]);
    await updateCalendarEvent(context(), {
      calendarId: MOCK_OWN_EMAIL,
      eventId: coffee.id,
      scope: 'this',
      notify: 'send',
      changes: { labelId: MOCK_LABELS.lps.id },
    });
    expect(state.writes[0]).toMatchObject({ sendUpdates: 'none', eventLabelVersion: 1 });
    expect(state.writes[0]!.body).toEqual({ eventLabelId: MOCK_LABELS.lps.id });

    const created = await createCalendarEvent(context(), {
      calendarId: MOCK_OWN_EMAIL,
      draft: {
        title: 'Label check',
        allDay: false,
        start: '2026-10-26T15:00:00.000Z',
        end: '2026-10-26T16:00:00.000Z',
        timeZone: TZ,
        labelId: MOCK_LABELS.travel.id,
      },
      notify: 'dont_send',
    });
    expect(created.ok && created.value.event?.label?.name).toBe('Travel');
    expect(state.writes[1]).toMatchObject({ op: 'insert', eventLabelVersion: 1 });
    // No label picked: no eventLabelId to send.
    await createCalendarEvent(context(), {
      calendarId: MOCK_OWN_EMAIL,
      draft: {
        title: 'Plain',
        allDay: false,
        start: '2026-10-26T17:00:00.000Z',
        end: '2026-10-26T18:00:00.000Z',
        timeZone: TZ,
        labelId: null,
      },
      notify: 'dont_send',
    });
    // The switch still goes along (so the event comes back with its label), with nothing to set.
    expect(state.writes[2]).toMatchObject({ op: 'insert', eventLabelVersion: 1 });
    expect(state.writes[2]!.body).not.toHaveProperty('eventLabelId');
    // A new event with a colour (a calendar without labels) never carries it.
    await createCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      draft: {
        title: 'Coloured',
        allDay: false,
        start: '2026-10-26T19:00:00.000Z',
        end: '2026-10-26T20:00:00.000Z',
        timeZone: TZ,
        colorId: '11',
      },
      notify: 'dont_send',
    });
    expect(state.writes[3]).toMatchObject({ op: 'insert', eventLabelVersion: 0 });
    expect(state.writes[3]!.body).toMatchObject({ colorId: '11' });
  });
});

/* -------------------------------------------------------- Ask's tool */

describe('Ask’s calendar tool', () => {
  // The tool reads today in real time, and the demo's calendar is built for
  // real time too: a store dated the same way, so both agree on any day.
  beforeEach(async () => {
    await harness.dispose();
    harness = await createHarness();
  });

  function ask(): ToolContext {
    return { auth: harness.auth, registry: new CitationRegistry(), scopeDealId: null };
  }

  it('returns each event’s label name, and the labels the calendar has', async () => {
    const outcome = await executeTool({ name: 'list_calendar_events', input: {} }, ask());
    expect(outcome.ok).toBe(true);
    const parsed = JSON.parse(outcome.content) as {
      labels_on_calendar: string[];
      events: { title: string; label: string | null }[];
    };
    expect(parsed.labels_on_calendar).toContain('Portfolio');
    const byTitle = Object.fromEntries(parsed.events.map((e) => [e.title, e.label]));
    expect(byTitle['Ledgerly board prep']).toBe('Portfolio');
    expect(byTitle['TipTop internal — pipeline review']).toBe('Internal');
    expect(byTitle['Coffee — Elena Ward (Marchmont)']).toBeNull();
  });

  it('lists only the events with the label asked for, by any spelling, or none', async () => {
    const run = async (label: string) =>
      (
        JSON.parse(
          (await executeTool({ name: 'list_calendar_events', input: { days: 7, label } }, ask()))
            .content,
        ) as { events: { title: string }[] }
      ).events.map((e) => e.title);
    expect(await run('portfolio meetings')).toEqual(['Ledgerly board prep']);
    expect(await run('PORTFOLIO')).toEqual(['Ledgerly board prep']);
    expect(await run('none')).not.toContain('Ledgerly board prep');
    expect(await run('Travel')).toEqual([]);
  });

  it('still lists the events when the labels cannot be read', async () => {
    const res = await listEventsWithLabels(harness.store, harness.auth.organizationId, {
      window: todayWindow(TZ),
      timeZone: TZ,
      ownEmail: MOCK_OWN_EMAIL,
      source: {
        ...source(),
        provider: {
          ...source().provider,
          listCalendars: async () => ({
            ok: false,
            error: { code: 'provider_unavailable', message: 'down' },
          }),
        } as unknown as CalendarSource['provider'],
      },
    });
    expect(res.labelsRead).toBe(false);
    expect(res.events.length).toBeGreaterThan(0);
    expect(res.events.every((e) => e.label === null)).toBe(true);
  });
});

/* ------------------------------------------------- the suggested label */

describe('the suggested label, from Copilot’s own data', () => {
  it('suggests Diligence for a founder whose deal is in diligence, LPs for an LP', async () => {
    const data = await read([MOCK_OWN_EMAIL]);
    const labels = data.calendars.find((c) => c.id === MOCK_OWN_EMAIL)!.labels;
    const girder = data.events.find((e) => e.title === 'Girder AI — reference call debrief')!;
    const coffee = data.events.find((e) => e.title === 'Coffee — Elena Ward (Marchmont)')!;
    const board = data.events.find((e) => e.title === 'Ledgerly board prep')!;
    const org = harness.auth.organizationId;
    const own = [MOCK_OWN_EMAIL];
    expect((await suggestedLabelFor(harness.store, org, girder, labels, own))?.name).toBe(
      'Diligence',
    );
    expect((await suggestedLabelFor(harness.store, org, coffee, labels, own))?.name).toBe('LPs');
    // Already labelled: nothing to suggest.
    expect(await suggestedLabelFor(harness.store, org, board, labels, own)).toBeNull();
    // Suggestions write nothing.
    expect(state.writes).toEqual([]);
  });

  it('suggests Event for a registration on a calendar with an Event label', async () => {
    const data = await read([MOCK_PERSONAL_CALENDAR]);
    const labels = data.calendars.find((c) => c.id === MOCK_PERSONAL_CALENDAR)!.labels;
    const mixer = data.events.find((e) => e.title === 'Harborlight Founders Mixer')!;
    const s = await suggestedLabelFor(harness.store, harness.auth.organizationId, mixer, labels, [
      MOCK_OWN_EMAIL,
    ]);
    expect(s).toMatchObject({ labelId: MOCK_LABELS.personalEvent.id, name: 'Event' });
  });
});

/* ---------------------------------------------------- how you got here */

describe('how you got here, for an event with no other guests', () => {
  const origin = (event: RangeEvent) =>
    findEventOrigin(harness.store, harness.auth.organizationId, {
      event: {
        calendarId: event.calendarId,
        id: event.id,
        title: event.title,
        organizer: event.organizer,
        description: event.description,
        location: event.location,
        startsAt: event.startsAt,
        guests: 0,
      },
      integration: null,
      ownEmails: [MOCK_OWN_EMAIL],
      timeZone: TZ,
      now: NOW.getTime(),
    });

  it('finds the registration email that put it on the calendar, with its thread link', async () => {
    const mixer = await eventTitled('Harborlight Founders Mixer', [MOCK_PERSONAL_CALENDAR]);
    const found = await origin(mixer);
    expect(found.lines).toHaveLength(1);
    expect(found.lines[0]).toMatchObject({
      kind: 'registration',
      subject: 'Your ticket: Harborlight Founders Mixer',
    });
    expect(found.lines[0]!.text).toMatch(/^Registration email from Harborlight Events, Oct \d+$/);
    expect(found.lines[0]!.threadId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('says what it checked, and offers the Inbox search, when nothing turns up', async () => {
    const hotel = await eventTitled('Hotel check-in window', [MOCK_PERSONAL_CALENDAR]);
    const found = await origin(hotel);
    expect(found.lines).toEqual([]);
    expect(found.checked).toMatch(
      /^Copilot looked for a dossier note, .*and found nothing that explains it\.$/,
    );
    expect(found.search).toEqual({ query: 'Hotel window', href: '/inbox?q=Hotel%20window' });
  });
});

/* -------------------------------------------------------- Diagnostics */

describe('Diagnostics › Event labels', () => {
  it('lists each calendar’s labels with how many events in the next week carry each', async () => {
    const report = await labelReport(harness.store, harness.auth.organizationId, {
      timeZone: TZ,
      ownEmail: MOCK_OWN_EMAIL,
      now: NOW,
      source: source(),
    });
    expect(report.state).toBe('ok');
    const main = report.calendars.find((c) => c.id === MOCK_OWN_EMAIL)!;
    const count = (name: string) => main.labels.find((l) => l.label.name === name)?.count;
    expect(count('Portfolio')).toBe(1);
    expect(count('Internal')).toBe(1);
    expect(count('LPs')).toBe(0);
    expect(main.unlabelled).toBeGreaterThan(0);
    expect(report.calendars.find((c) => c.id === MOCK_TEAM_CALENDAR)!.labels).toEqual([]);
    expect(state.writes).toEqual([]);
  });
});

describe('the legend’s filter', () => {
  it('is remembered per person, like the other calendar choices', async () => {
    const { organizationId, userId } = harness.auth;
    await saveCalendarPrefs(harness.store, organizationId, userId, {
      labelFilter: ['name:portfolio', '__none__'],
    });
    await saveCalendarPrefs(harness.store, organizationId, userId, { view: 'month' });
    expect(await readCalendarPrefs(harness.store, organizationId, userId)).toMatchObject({
      view: 'month',
      labelFilter: ['name:portfolio', '__none__'],
    });
    await saveCalendarPrefs(harness.store, organizationId, userId, { labelFilter: [] });
    expect((await readCalendarPrefs(harness.store, organizationId, userId)).labelFilter).toEqual(
      [],
    );
    expect(
      CALENDAR_PREFS_PATCH.safeParse({ labelFilter: Array.from({ length: 51 }, (_, i) => `k${i}`) })
        .success,
    ).toBe(false);
  });
});
