import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventDraft } from '@/lib/calendar/edit-rules';
import { calendarEditAccess, canEditCalendar } from '@/lib/calendar/edit-access';
import {
  createMockCalendarState,
  MOCK_HOLIDAY_CALENDAR,
  MOCK_OWN_EMAIL,
  MOCK_PERSONAL_CALENDAR,
  MOCK_TEAM_CALENDAR,
  type MockCalendarState,
} from '@/lib/calendar/mock-calendar';
import { MockCalendarProvider } from '@/lib/calendar/provider';
import { resetCalendarRangeCache, type CalendarSource } from '@/lib/calendar/range-reader';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  updateCalendarEvent,
  type WriteContext,
} from '@/lib/calendar/write';
import { CALENDAR_EDIT_SCOPES, SEND_SCOPES } from '@/lib/google/send-scopes';
import type { AuditEvent, Integration } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Changing events, against the mock calendar, which records every write as
 * Google would receive it. Outside demo mode, as on the real calendar: the
 * connection must carry the calendar-editing grant, the calendar must be
 * writable and the event one this account may change, and guests are emailed
 * (sendUpdates 'all') only when the person chose Send.
 */

const NOW = new Date('2026-10-21T15:00:00Z');
const TZ = 'America/Chicago';

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

const READ_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];

function context(scopes: string[] = [...READ_SCOPES, ...CALENDAR_EDIT_SCOPES]): WriteContext {
  const source: CalendarSource = {
    provider: new MockCalendarProvider(NOW, state),
    integration: integration(scopes),
    ownEmails: [MOCK_OWN_EMAIL],
    demo: false,
  };
  return {
    store: harness.store,
    organizationId: harness.auth.organizationId,
    userId: harness.auth.userId,
    source,
  };
}

const draft = (over: Partial<EventDraft> = {}): EventDraft => ({
  title: 'Founder call',
  allDay: false,
  start: '2026-10-22T15:00:00.000Z',
  end: '2026-10-22T15:30:00.000Z',
  timeZone: TZ,
  description: '',
  location: '',
  guests: [],
  meet: false,
  colorId: null,
  ...over,
});

beforeEach(async () => {
  harness = await createHarness({ now: NOW });
  resetCalendarRangeCache();
  state = createMockCalendarState(NOW);
});

afterEach(async () => {
  await harness.dispose();
});

describe('creating an event', () => {
  it('with guests and a Meet link, sending invitations only because Send was chosen', async () => {
    const res = await createCalendarEvent(context(), {
      calendarId: MOCK_OWN_EMAIL,
      draft: draft({ guests: ['pat@example.org', 'lee@example.org'], meet: true }),
      notify: 'send',
    });
    expect(res.ok).toBe(true);
    expect(state.writes).toHaveLength(1);
    const write = state.writes[0]!;
    expect(write).toMatchObject({
      op: 'insert',
      calendarId: MOCK_OWN_EMAIL,
      sendUpdates: 'all',
      conferenceDataVersion: 1,
    });
    expect(write.body?.conferenceData?.createRequest?.conferenceSolutionKey?.type).toBe(
      'hangoutsMeet',
    );
    expect(write.body?.attendees).toEqual([
      { email: 'pat@example.org' },
      { email: 'lee@example.org' },
    ]);
    // A create sends no nulls.
    expect(write.body?.start).toEqual({ dateTime: '2026-10-22T15:00:00.000Z', timeZone: TZ });
    if (res.ok) {
      expect(res.value.event?.meetUrl).toMatch(/^https:\/\/meet\.google\.com\//);
      expect(res.value.event?.attendees.map((a) => a.email)).toEqual([
        'pat@example.org',
        'lee@example.org',
      ]);
      expect(res.value.event?.verdict.meeting).toBe(true);
    }
  });

  it('with guests and Don’t send: nobody is emailed', async () => {
    await createCalendarEvent(context(), {
      calendarId: MOCK_OWN_EMAIL,
      draft: draft({ guests: ['pat@example.org'] }),
      notify: 'dont_send',
    });
    expect(state.writes[0]).toMatchObject({
      op: 'insert',
      sendUpdates: 'none',
      conferenceDataVersion: 0,
    });
    expect(state.writes[0]!.body?.conferenceData).toBeUndefined();
  });

  it('refuses a calendar this account can only read, and bad times, before asking Google', async () => {
    const reader = await createCalendarEvent(context(), {
      calendarId: MOCK_HOLIDAY_CALENDAR,
      draft: draft(),
      notify: 'dont_send',
    });
    expect(reader.ok).toBe(false);
    if (!reader.ok) expect(reader.error.code).toBe('forbidden');
    const backwards = await createCalendarEvent(context(), {
      calendarId: MOCK_OWN_EMAIL,
      draft: draft({ start: '2026-10-22T16:00:00.000Z', end: '2026-10-22T15:00:00.000Z' }),
      notify: 'dont_send',
    });
    expect(backwards.ok).toBe(false);
    expect(state.writes).toEqual([]);
  });
});

describe('without the calendar-editing grant', () => {
  it('refuses every write, and Google is never asked', async () => {
    const noGrant = context([...READ_SCOPES, ...SEND_SCOPES]);
    const results = await Promise.all([
      createCalendarEvent(noGrant, {
        calendarId: MOCK_OWN_EMAIL,
        draft: draft(),
        notify: 'dont_send',
      }),
      updateCalendarEvent(noGrant, {
        calendarId: MOCK_TEAM_CALENDAR,
        eventId: 'demoteamportfolio',
        scope: 'this',
        notify: 'dont_send',
        changes: { title: 'Changed' },
      }),
      deleteCalendarEvent(noGrant, {
        calendarId: MOCK_TEAM_CALENDAR,
        eventId: 'demoteamportfolio',
        scope: 'this',
        notify: 'dont_send',
      }),
    ]);
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('forbidden');
        expect(r.error.message).toMatch(/Calendar editing is off/);
      }
    }
    expect(state.writes).toEqual([]);
    expect(state.reads.filter((r) => r.op === 'get')).toEqual([]);
  });

  it('is view-only, and says how to turn editing on', () => {
    const access = calendarEditAccess(context([...READ_SCOPES]).source);
    expect(access).toMatchObject({ allowed: false, demo: false });
    expect(access.reason).toMatch(/Turn on calendar editing/);
    expect(canEditCalendar(integration([...READ_SCOPES, ...CALENDAR_EDIT_SCOPES]))).toBe(true);
    expect(canEditCalendar(null)).toBe(false);
  });

  it('demo mode edits only the in-memory calendar', () => {
    const mock = new MockCalendarProvider(NOW, state);
    expect(calendarEditAccess({ provider: mock, integration: null, demo: true }).allowed).toBe(
      true,
    );
    const google = { ...mock, kind: 'google' as const } as unknown as CalendarSource['provider'];
    expect(calendarEditAccess({ provider: google, integration: null, demo: true }).allowed).toBe(
      false,
    );
  });
});

describe('changing an event', () => {
  it('moves it (a drag) and tells its guests only on Send', async () => {
    const res = await updateCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamportfolio',
      scope: 'this',
      notify: 'dont_send',
      changes: {
        allDay: false,
        start: '2026-10-21T17:00:00.000Z',
        end: '2026-10-21T18:00:00.000Z',
        timeZone: TZ,
      },
    });
    expect(res.ok).toBe(true);
    expect(state.writes).toEqual([
      expect.objectContaining({
        op: 'patch',
        calendarId: MOCK_TEAM_CALENDAR,
        eventId: 'demoteamportfolio',
        sendUpdates: 'none',
        body: {
          start: { dateTime: '2026-10-21T17:00:00.000Z', timeZone: TZ, date: null },
          end: { dateTime: '2026-10-21T18:00:00.000Z', timeZone: TZ, date: null },
        },
      }),
    ]);
    if (res.ok) expect(res.value.event?.startsAt).toBe('2026-10-21T17:00:00.000Z');
  });

  it('resizes it (the bottom edge): the start stays, the end moves', async () => {
    await updateCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamofficehours',
      scope: 'this',
      notify: 'send',
      changes: {
        allDay: false,
        start: '2026-10-21T14:15:00Z',
        end: '2026-10-21T16:00:00Z',
        timeZone: TZ,
      },
    });
    const write = state.writes[0]!;
    expect(write.sendUpdates).toBe('all');
    expect(write.body?.start?.dateTime).toBe('2026-10-21T14:15:00.000Z');
    expect(write.body?.end?.dateTime).toBe('2026-10-21T16:00:00.000Z');
  });

  it('adds guests, keeping the existing ones and their answers', async () => {
    await updateCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamportfolio',
      scope: 'this',
      notify: 'send',
      changes: { guests: ['riley@tiptop.demo', 'new.person@example.org'] },
    });
    expect(state.writes[0]!.body?.attendees).toEqual([
      expect.objectContaining({ email: MOCK_OWN_EMAIL, self: true, responseStatus: 'accepted' }),
      expect.objectContaining({ email: 'riley@tiptop.demo', responseStatus: 'accepted' }),
      { email: 'new.person@example.org' },
    ]);
  });

  it('moves it to another of the account’s calendars', async () => {
    const res = await updateCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamportfolio',
      scope: 'this',
      notify: 'dont_send',
      changes: {},
      destinationCalendarId: MOCK_PERSONAL_CALENDAR,
    });
    expect(res.ok).toBe(true);
    expect(state.writes).toEqual([
      expect.objectContaining({
        op: 'move',
        calendarId: MOCK_TEAM_CALENDAR,
        destinationId: MOCK_PERSONAL_CALENDAR,
        sendUpdates: 'none',
      }),
    ]);
    if (res.ok) expect(res.value.event?.calendarId).toBe(MOCK_PERSONAL_CALENDAR);
  });

  it('refuses an event only its organizer can change, and a calendar it can only read', async () => {
    const board = await updateCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamboard',
      scope: 'this',
      notify: 'dont_send',
      changes: { title: 'Mine now' },
    });
    expect(board.ok).toBe(false);
    if (!board.ok) {
      expect(board.error.code).toBe('forbidden');
      expect(board.error.message).toBe('Only the organizer (Maya Chen) can change this event.');
    }
    const holiday = await deleteCalendarEvent(context(), {
      calendarId: MOCK_HOLIDAY_CALENDAR,
      eventId: 'demoholidayfounders',
      scope: 'this',
      notify: 'dont_send',
    });
    expect(holiday.ok).toBe(false);
    expect(state.writes).toEqual([]);
  });

  it('a repeating event: "This event" changes the instance, "All events" shifts the series', async () => {
    const instance = 'demoteampartners_20261102T160000Z';
    await updateCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: instance,
      scope: 'this',
      notify: 'dont_send',
      changes: { title: 'Partner meeting (short)' },
    });
    expect(state.writes[0]).toMatchObject({ op: 'patch', eventId: instance });

    const res = await updateCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteampartners_20261109T160000Z',
      scope: 'all',
      notify: 'dont_send',
      changes: {
        allDay: false,
        start: '2026-11-09T16:30:00.000Z',
        end: '2026-11-09T17:30:00.000Z',
        timeZone: TZ,
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ event: null, reload: true });
    // The series (first on Oct 26, 10:00 CDT) moves by the same 30 minutes.
    expect(state.writes[1]).toMatchObject({
      op: 'patch',
      eventId: 'demoteampartners',
      body: {
        start: { dateTime: '2026-10-26T15:30:00.000Z', timeZone: TZ, date: null },
        end: { dateTime: '2026-10-26T16:30:00.000Z', timeZone: TZ, date: null },
      },
    });
  });

  it('"All events" will not move a series to another day, and writes nothing', async () => {
    // Monday Nov 9, 10:00 CST, dragged to Wednesday Nov 11: the weekly rule would fall out of step.
    const res = await updateCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteampartners_20261109T160000Z',
      scope: 'all',
      notify: 'dont_send',
      changes: {
        allDay: false,
        start: '2026-11-11T16:00:00.000Z',
        end: '2026-11-11T17:00:00.000Z',
        timeZone: TZ,
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/another day/);
    expect(state.writes).toEqual([]);
  });

  it('refuses a series named by its own id, so "This event" can never reach the whole series', async () => {
    const update = await updateCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteampartners',
      scope: 'this',
      notify: 'dont_send',
      changes: { title: 'Renamed' },
    });
    const remove = await deleteCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteampartners',
      scope: 'this',
      notify: 'dont_send',
    });
    expect(update.ok).toBe(false);
    expect(remove.ok).toBe(false);
    expect(state.writes).toEqual([]);
  });

  it('"All events" guest edits add and remove only the people changed on that event', async () => {
    // Riley comes off one event on its own first.
    const instance = 'demoteampartners_20261102T160000Z';
    await updateCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: instance,
      scope: 'this',
      notify: 'dont_send',
      changes: { guests: ['jordan@tiptop.demo'] },
    });
    // Then a guest is added on that event, for every event in the series.
    const res = await updateCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: instance,
      scope: 'all',
      notify: 'dont_send',
      changes: { guests: ['jordan@tiptop.demo', 'pat@example.org'] },
    });
    expect(res.ok).toBe(true);
    const write = state.writes[1]!;
    expect(write).toMatchObject({ op: 'patch', eventId: 'demoteampartners', sendUpdates: 'none' });
    expect(write.body?.attendees?.map((a) => a.email)).toEqual([
      MOCK_OWN_EMAIL,
      'jordan@tiptop.demo',
      'riley@tiptop.demo',
      'pat@example.org',
    ]);
  });

  it('will not move one instance of a series to another calendar', async () => {
    const res = await updateCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteampartners_20261102T160000Z',
      scope: 'this',
      notify: 'dont_send',
      changes: {},
      destinationCalendarId: MOCK_PERSONAL_CALENDAR,
    });
    expect(res.ok).toBe(false);
    expect(state.writes).toEqual([]);
  });

  it('turns Meet on for an event that has none, with conference version 1', async () => {
    const res = await updateCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamportfolio',
      scope: 'this',
      notify: 'dont_send',
      changes: { meet: true },
    });
    expect(state.writes[0]).toMatchObject({ conferenceDataVersion: 1 });
    if (res.ok) expect(res.value.event?.meetUrl).toMatch(/^https:\/\/meet\.google\.com\//);
  });
});

describe('deleting an event', () => {
  it('with cancellations, when Send was chosen', async () => {
    const res = await deleteCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamofficehours',
      scope: 'this',
      notify: 'send',
    });
    expect(res.ok).toBe(true);
    expect(state.writes).toEqual([
      expect.objectContaining({ op: 'delete', eventId: 'demoteamofficehours', sendUpdates: 'all' }),
    ]);
  });

  it('without cancellations, when Don’t send was chosen', async () => {
    await deleteCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamofficehours',
      scope: 'this',
      notify: 'dont_send',
    });
    expect(state.writes[0]).toMatchObject({ op: 'delete', sendUpdates: 'none' });
  });

  it('"All events" deletes the series', async () => {
    const res = await deleteCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteampartners_20261102T160000Z',
      scope: 'all',
      notify: 'dont_send',
    });
    expect(res.ok && res.value.reload).toBe(true);
    expect(state.writes[0]).toMatchObject({ op: 'delete', eventId: 'demoteampartners' });
  });
});

describe('the audit trail', () => {
  it('records each change with ids and counts, never a title or an address', async () => {
    await createCalendarEvent(context(), {
      calendarId: MOCK_OWN_EMAIL,
      draft: draft({ title: 'Secret plans', guests: ['pat@example.org'] }),
      notify: 'send',
    });
    const rows = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'calendar.event_created' },
    })) as AuditEvent[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toEqual({
      primary: true,
      notified: true,
      guests: 1,
      meet: false,
      demo: false,
    });
    expect(JSON.stringify(rows[0])).not.toMatch(/Secret plans|pat@example\.org/);
  });
});
