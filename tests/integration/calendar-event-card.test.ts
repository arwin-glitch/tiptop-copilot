import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { duplicateDraft, eventOptions } from '@/lib/calendar/event-actions';
import {
  createMockCalendarState,
  MOCK_HOLIDAY_CALENDAR,
  MOCK_OWN_EMAIL,
  MOCK_TEAM_CALENDAR,
  type MockCalendarState,
} from '@/lib/calendar/mock-calendar';
import { MockCalendarProvider } from '@/lib/calendar/provider';
import {
  readCalendarRange,
  resetCalendarRangeCache,
  type CalendarSource,
} from '@/lib/calendar/range-reader';
import type { RangeEvent } from '@/lib/calendar/range-types';
import {
  createCalendarEvent,
  recolorCalendarEvent,
  respondToCalendarEvent,
  updateCalendarEvent,
  type WriteContext,
} from '@/lib/calendar/write';
import { CALENDAR_EDIT_SCOPES } from '@/lib/google/send-scopes';
import type { Integration } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The event card's options against the mock calendar, which records every
 * write as Google would receive it: Duplicate makes a new event, a colour is
 * colorId alone and never emails anyone, Going? tells the organizer only on
 * Send, and an event on a calendar this account can only read offers nothing
 * that writes (and the write module refuses it anyway).
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

function source(scopes: string[]): CalendarSource {
  return {
    provider: new MockCalendarProvider(NOW, state),
    integration: integration(scopes),
    ownEmails: [MOCK_OWN_EMAIL],
    demo: false,
  };
}

function context(scopes: string[] = [...READ_SCOPES, ...CALENDAR_EDIT_SCOPES]): WriteContext {
  return {
    store: harness.store,
    organizationId: harness.auth.organizationId,
    userId: harness.auth.userId,
    source: source(scopes),
  };
}

async function eventTitled(title: string): Promise<RangeEvent> {
  const found = (await eventsTitled(title))[0];
  if (!found) throw new Error(`No event titled ${title}`);
  return found;
}

async function eventsTitled(title: string): Promise<RangeEvent[]> {
  const data = await readCalendarRange(harness.store, harness.auth.organizationId, {
    from: '2026-10-18',
    to: '2026-11-01',
    timeZone: TZ,
    ownEmail: MOCK_OWN_EMAIL,
    calendarIds: [MOCK_OWN_EMAIL, MOCK_TEAM_CALENDAR, MOCK_HOLIDAY_CALENDAR],
    source: source([...READ_SCOPES, ...CALENDAR_EDIT_SCOPES]),
    now: NOW.getTime(),
  });
  return data.events.filter((e) => e.title === title);
}

beforeEach(async () => {
  harness = await createHarness({ now: NOW });
  resetCalendarRangeCache();
  state = createMockCalendarState(NOW);
});

afterEach(async () => {
  await harness.dispose();
});

describe('Duplicate', () => {
  it('saves a new event with its own id, and the original stays as it was', async () => {
    const original = await eventTitled('Founder office hours');
    const draft = duplicateDraft(original, TZ, [MOCK_OWN_EMAIL]);
    const res = await createCalendarEvent(context(), {
      calendarId: original.calendarId,
      draft,
      notify: 'dont_send',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const copy = res.value.event!;
    expect(copy.id).not.toBe(original.id);
    expect(copy.key).not.toBe(original.key);
    expect(copy).toMatchObject({ title: 'Founder office hours', calendarId: MOCK_TEAM_CALENDAR });
    expect(Date.parse(copy.startsAt!)).toBe(Date.parse(original.startsAt!));
    expect(Date.parse(copy.endsAt!)).toBe(Date.parse(original.endsAt!));
    // A fresh Meet link, not the original's.
    expect(copy.meetUrl).toMatch(/^https:\/\/meet\.google\.com\//);
    expect(copy.meetUrl).not.toBe(original.meetUrl);
    expect(state.writes).toEqual([
      expect.objectContaining({
        op: 'insert',
        calendarId: MOCK_TEAM_CALENDAR,
        sendUpdates: 'none',
        conferenceDataVersion: 1,
      }),
    ]);
    expect(state.writes[0]!.body?.attendees).toEqual([{ email: 'jordan@tiptop.demo' }]);
    const both = await eventsTitled('Founder office hours');
    expect(both.map((e) => e.id).sort()).toEqual([copy.id, 'demoteamofficehours'].sort());
  });
});

describe('a colour from the card', () => {
  it('patches colorId alone with sendUpdates none, on an event with guests', async () => {
    const res = await recolorCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamportfolio',
      scope: 'this',
      colorId: '11',
    });
    expect(res.ok).toBe(true);
    expect(state.writes).toEqual([
      expect.objectContaining({
        op: 'patch',
        eventId: 'demoteamportfolio',
        sendUpdates: 'none',
        conferenceDataVersion: 0,
        body: { colorId: '11' },
      }),
    ]);
    if (res.ok) expect(res.value.event?.color.background).toBe('#dc2127');
  });

  it('is allowed on Nick’s copy of an invitation, and back to the calendar colour with null', async () => {
    await recolorCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamboard',
      scope: 'this',
      colorId: '2',
    });
    const reset = await recolorCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamboard',
      scope: 'this',
      colorId: null,
    });
    expect(state.writes.map((w) => [w.body, w.sendUpdates])).toEqual([
      [{ colorId: '2' }, 'none'],
      [{ colorId: null }, 'none'],
    ]);
    if (reset.ok) expect(reset.value.event?.colorId).toBe(null);
  });

  it('a colour-only change from the editor tells nobody, even if Send came along', async () => {
    await updateCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamofficehours',
      scope: 'this',
      notify: 'send',
      changes: { colorId: '7' },
    });
    expect(state.writes[0]).toMatchObject({ body: { colorId: '7' }, sendUpdates: 'none' });
  });

  it('"All events" recolours the series itself', async () => {
    const res = await recolorCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteampartners_20261102T160000Z',
      scope: 'all',
      colorId: '9',
    });
    expect(res.ok && res.value.reload).toBe(true);
    expect(state.writes[0]).toMatchObject({
      eventId: 'demoteampartners',
      body: { colorId: '9' },
      sendUpdates: 'none',
    });
  });

  it('refuses a colour Google does not have', async () => {
    const res = await recolorCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamportfolio',
      scope: 'this',
      colorId: '42',
    });
    expect(res.ok).toBe(false);
    expect(state.writes).toEqual([]);
  });
});

describe('Going? Yes / No / Maybe', () => {
  it('Send tells the organizer; only Nick’s own answer changes', async () => {
    const res = await respondToCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamboard',
      scope: 'this',
      response: 'accepted',
      notify: 'send',
    });
    expect(res.ok).toBe(true);
    const write = state.writes[0]!;
    expect(write).toMatchObject({ op: 'patch', eventId: 'demoteamboard', sendUpdates: 'all' });
    expect(Object.keys(write.body ?? {})).toEqual(['attendees']);
    expect(write.body?.attendees).toEqual([
      expect.objectContaining({ email: MOCK_OWN_EMAIL, self: true, responseStatus: 'accepted' }),
      expect.objectContaining({ email: 'maya@ledgerly.demo', responseStatus: 'accepted' }),
      expect.objectContaining({ email: 'sam@ledgerly.demo', responseStatus: 'tentative' }),
    ]);
    if (res.ok) expect(res.value.event?.myResponse).toBe('accepted');
  });

  it('Don’t send answers without telling anyone', async () => {
    const res = await respondToCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamboard',
      scope: 'this',
      response: 'declined',
      notify: 'dont_send',
    });
    expect(state.writes[0]).toMatchObject({ sendUpdates: 'none' });
    expect(state.writes[0]!.body?.attendees?.[0]).toMatchObject({ responseStatus: 'declined' });
    // Declined: the pings' own verdict makes it a block.
    if (res.ok) {
      expect(res.value.event?.myResponse).toBe('declined');
      expect(res.value.event?.verdict).toMatchObject({ meeting: false, reason: 'Nick declined' });
    }
  });

  it('is not offered on an event Nick organizes, and the write module refuses it', async () => {
    const own = await eventTitled('Portfolio check-in');
    expect(own.canRespond).toBe(false);
    const res = await respondToCalendarEvent(context(), {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamportfolio',
      scope: 'this',
      response: 'accepted',
      notify: 'send',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('forbidden');
      expect(res.error.message).toBe('You organize this event.');
    }
    expect(state.writes).toEqual([]);
  });

  it('the invitation reads as answerable, with Nick’s answer on it', async () => {
    const board = await eventTitled('Ledgerly board meeting');
    expect(board).toMatchObject({ canModify: false, canRespond: true, myResponse: 'needsAction' });
    expect(board.attachments).toEqual([
      {
        title: 'Ledgerly Q3 board deck.pdf',
        url: 'https://drive.google.com/file/d/demo-ledgerly-deck/view',
        mimeType: 'application/pdf',
      },
    ]);
    expect(
      eventOptions(board, { editing: true, calendarWritable: true, ownEmails: [MOCK_OWN_EMAIL] }),
    ).toMatchObject({ edit: false, delete: false, rsvp: true, color: true, duplicate: true });
  });
});

describe('read-only events', () => {
  it('offer no write options, and the write module refuses an answer or a colour', async () => {
    const holiday = await eventTitled('Founders Day (demo)');
    const options = eventOptions(holiday, {
      editing: true,
      calendarWritable: false,
      ownEmails: [MOCK_OWN_EMAIL],
    });
    expect(options).toMatchObject({
      edit: false,
      delete: false,
      duplicate: false,
      color: false,
      rsvp: false,
    });
    const answer = await respondToCalendarEvent(context(), {
      calendarId: MOCK_HOLIDAY_CALENDAR,
      eventId: 'demoholidayfounders',
      scope: 'this',
      response: 'accepted',
      notify: 'dont_send',
    });
    const color = await recolorCalendarEvent(context(), {
      calendarId: MOCK_HOLIDAY_CALENDAR,
      eventId: 'demoholidayfounders',
      scope: 'this',
      colorId: '3',
    });
    for (const r of [answer, color]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('forbidden');
    }
    expect(state.writes).toEqual([]);
  });

  it('without the calendar-editing grant, an answer and a colour are refused before Google is asked', async () => {
    const noGrant = context([...READ_SCOPES]);
    const answer = await respondToCalendarEvent(noGrant, {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamboard',
      scope: 'this',
      response: 'accepted',
      notify: 'send',
    });
    const color = await recolorCalendarEvent(noGrant, {
      calendarId: MOCK_TEAM_CALENDAR,
      eventId: 'demoteamboard',
      scope: 'this',
      colorId: '3',
    });
    for (const r of [answer, color]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/Calendar editing is off/);
    }
    expect(state.writes).toEqual([]);
    expect(state.reads.filter((r) => r.op === 'get')).toEqual([]);
  });
});
