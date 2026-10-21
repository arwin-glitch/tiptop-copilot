import { describe, expect, it } from 'vitest';
import {
  changedFields,
  draftFromEvent,
  instantFromFields,
  optimisticEvent,
  wallFields,
} from '@/lib/calendar/draft';
import {
  draftToWrite,
  guestEmails,
  guestPrompt,
  mergeGuests,
  modifyRule,
  RECURRING_SCOPES,
  scopeTarget,
  sendUpdatesFor,
  seriesGuestList,
  shiftSeries,
  timesProblem,
  type EventDraft,
} from '@/lib/calendar/edit-rules';
import type { CalendarInfo, RangeEvent } from '@/lib/calendar/range-types';

const OWN = ['nick@acme.example'];

describe('guests hear about a change only on Send', () => {
  it('maps only an explicit Send to sendUpdates "all"', () => {
    expect(sendUpdatesFor('send')).toBe('all');
    expect(sendUpdatesFor('dont_send')).toBe('none');
    expect(sendUpdatesFor(undefined)).toBe('none');
    expect(sendUpdatesFor(null)).toBe('none');
    expect(sendUpdatesFor('all' as never)).toBe('none');
  });

  it('asks before inviting guests to a new event, and not when there are none', () => {
    expect(guestPrompt('create', [], [])).toBeNull();
    expect(guestPrompt('create', [], ['pat@example.org'])).toMatchObject({
      kind: 'invite',
      title: 'Send invitation emails to guests?',
      added: ['pat@example.org'],
    });
  });

  it('asks on every change to an event with guests: a move, an edit, a guest added or removed', () => {
    const guests = ['pat@example.org'];
    expect(guestPrompt('update', guests, guests)).toMatchObject({
      kind: 'update',
      added: [],
      removed: [],
    });
    expect(guestPrompt('update', guests, [...guests, 'lee@example.org'])).toMatchObject({
      kind: 'update',
      added: ['lee@example.org'],
    });
    expect(guestPrompt('update', guests, [])).toMatchObject({ kind: 'update', removed: guests });
    expect(guestPrompt('update', [], ['lee@example.org'])).toMatchObject({ kind: 'invite' });
    expect(guestPrompt('update', [], [])).toBeNull();
  });

  it('asks whether to send cancellations when deleting an event with guests', () => {
    expect(guestPrompt('delete', ['pat@example.org'], [])).toMatchObject({
      kind: 'cancel',
      title: 'Send cancellation emails to guests?',
    });
    expect(guestPrompt('delete', [], [])).toBeNull();
  });

  it('counts people, not this account, its other addresses or rooms, as guests', () => {
    expect(
      guestEmails(
        [
          { email: 'Nick@Acme.example' },
          { email: 'me@acme.example', self: true },
          { email: 'room-1@resource.calendar.google.com', resource: true },
          { email: 'Pat@Example.org' },
        ],
        OWN,
      ),
    ).toEqual(['pat@example.org']);
  });
});

describe('who may change an event', () => {
  it('this account’s own event on a calendar it can write to', () => {
    expect(modifyRule({ organizer: { email: 'x', self: true } }, 'owner')).toEqual({
      canModify: true,
      reason: null,
    });
    expect(modifyRule({ organizer: { email: 'x', self: true } }, 'writer').canModify).toBe(true);
  });

  it('someone else’s event only when they let guests change it', () => {
    const theirs = { organizer: { email: 'pat@example.org', displayName: 'Pat', self: false } };
    expect(modifyRule(theirs, 'owner')).toEqual({
      canModify: false,
      reason: 'Only the organizer (Pat) can change this event.',
    });
    expect(modifyRule({ ...theirs, guestsCanModify: true }, 'owner').canModify).toBe(true);
  });

  it('nothing on a calendar it can only read, or special entries', () => {
    expect(modifyRule({ organizer: { self: true } }, 'reader').canModify).toBe(false);
    expect(modifyRule({ organizer: { self: true } }, 'freeBusyReader').reason).toMatch(/busy/);
    expect(
      modifyRule({ organizer: { self: true }, eventType: 'outOfOffice' }, 'owner').canModify,
    ).toBe(false);
    expect(modifyRule({ organizer: { self: true }, privateCopy: true }, 'owner').canModify).toBe(
      false,
    );
  });
});

describe('repeating events', () => {
  it('offers this event or all events, never "this and following"', () => {
    expect(RECURRING_SCOPES.map((s) => s.label)).toEqual(['This event', 'All events']);
  });

  it('changes the instance for "This event" and the series for "All events"', () => {
    const instance = { id: 'abc_20261026T150000Z', recurringEventId: 'abc' };
    expect(scopeTarget(instance, 'this')).toEqual({
      eventId: 'abc_20261026T150000Z',
      series: false,
    });
    expect(scopeTarget(instance, 'all')).toEqual({ eventId: 'abc', series: true });
    expect(scopeTarget({ id: 'single' }, 'all')).toEqual({ eventId: 'single', series: false });
  });

  it('gives a whole series the instance’s new time of day, at its new length', () => {
    const shifted = shiftSeries(
      {
        start: { dateTime: '2026-10-05T15:00:00Z', timeZone: 'America/Chicago' },
        end: { dateTime: '2026-10-05T16:00:00Z', timeZone: 'America/Chicago' },
      },
      { start: { dateTime: '2026-10-26T15:00:00Z' }, end: { dateTime: '2026-10-26T16:00:00Z' } },
      { start: { dateTime: '2026-10-26T15:30:00Z' }, end: { dateTime: '2026-10-26T17:00:00Z' } },
    );
    expect(shifted).toEqual({
      start: { dateTime: '2026-10-05T15:30:00.000Z', timeZone: 'America/Chicago' },
      end: { dateTime: '2026-10-05T17:00:00.000Z', timeZone: 'America/Chicago' },
    });
    // An all-day series can change its length; its first day stays.
    expect(
      shiftSeries(
        { start: { date: '2026-10-05' }, end: { date: '2026-10-06' } },
        { start: { date: '2026-10-26' }, end: { date: '2026-10-27' } },
        { start: { date: '2026-10-26' }, end: { date: '2026-10-28' } },
      ),
    ).toEqual({ start: { date: '2026-10-05' }, end: { date: '2026-10-07' } });
  });

  it('keeps the wall-clock time across a daylight-saving change between the series and the event', () => {
    // First on Oct 26 at 10:00 CDT; the instance on Nov 9 is 10:00 CST and moves to 11:00 CST.
    expect(
      shiftSeries(
        {
          start: { dateTime: '2026-10-26T15:00:00Z', timeZone: 'America/Chicago' },
          end: { dateTime: '2026-10-26T16:00:00Z', timeZone: 'America/Chicago' },
        },
        {
          start: { dateTime: '2026-11-09T16:00:00Z', timeZone: 'America/Chicago' },
          end: { dateTime: '2026-11-09T17:00:00Z', timeZone: 'America/Chicago' },
        },
        { start: { dateTime: '2026-11-09T17:00:00Z' }, end: { dateTime: '2026-11-09T18:00:00Z' } },
      ),
    ).toEqual({
      start: { dateTime: '2026-10-26T16:00:00.000Z', timeZone: 'America/Chicago' },
      end: { dateTime: '2026-10-26T17:00:00.000Z', timeZone: 'America/Chicago' },
    });
  });

  it('refuses to move a whole series to another day: its repeat rule would fall out of step', () => {
    // A weekly-on-Monday series dragged to Wednesday, timed and all-day.
    expect(
      shiftSeries(
        {
          start: { dateTime: '2026-10-26T15:00:00Z', timeZone: 'America/Chicago' },
          end: { dateTime: '2026-10-26T16:00:00Z', timeZone: 'America/Chicago' },
        },
        {
          start: { dateTime: '2026-11-02T16:00:00Z', timeZone: 'America/Chicago' },
          end: { dateTime: '2026-11-02T17:00:00Z', timeZone: 'America/Chicago' },
        },
        { start: { dateTime: '2026-11-04T16:00:00Z' }, end: { dateTime: '2026-11-04T17:00:00Z' } },
      ),
    ).toBeNull();
    expect(
      shiftSeries(
        { start: { date: '2026-10-05' }, end: { date: '2026-10-06' } },
        { start: { date: '2026-10-26' }, end: { date: '2026-10-27' } },
        { start: { date: '2026-10-28' }, end: { date: '2026-10-30' } },
      ),
    ).toBeNull();
  });

  it('a guest edit for "All events" adds and removes only the people named on that event', () => {
    const series = [
      { email: 'nick@acme.example', self: true },
      { email: 'pat@example.org' },
      { email: 'lee@example.org' },
    ];
    // This event was changed on its own before: Lee is not on it.
    const instance = [{ email: 'nick@acme.example', self: true }, { email: 'pat@example.org' }];
    expect(
      seriesGuestList(series, instance, ['pat@example.org', 'new.person@example.org'], OWN),
    ).toEqual(['pat@example.org', 'lee@example.org', 'new.person@example.org']);
    expect(seriesGuestList(series, instance, [], OWN)).toEqual(['lee@example.org']);
  });

  it('refuses to turn a whole series between all-day and timed', () => {
    expect(
      shiftSeries(
        { start: { dateTime: '2026-10-05T15:00:00Z' }, end: { dateTime: '2026-10-05T16:00:00Z' } },
        { start: { dateTime: '2026-10-26T15:00:00Z' }, end: { dateTime: '2026-10-26T16:00:00Z' } },
        { start: { date: '2026-10-26' }, end: { date: '2026-10-27' } },
      ),
    ).toBeNull();
  });
});

describe('what a change sends', () => {
  const draft: EventDraft = {
    title: '  Intro call  ',
    allDay: false,
    start: '2026-10-21T15:00:00Z',
    end: '2026-10-21T15:30:00Z',
    timeZone: 'America/Chicago',
    guests: ['pat@example.org'],
    meet: true,
    colorId: '10',
  };

  it('builds a new event with a Google Meet request and conference version 1', () => {
    const { body, conferenceDataVersion } = draftToWrite(draft, {
      requestId: 'req-1',
      ownEmails: OWN,
    });
    expect(conferenceDataVersion).toBe(1);
    expect(body.summary).toBe('Intro call');
    expect(body.conferenceData).toEqual({
      createRequest: { requestId: 'req-1', conferenceSolutionKey: { type: 'hangoutsMeet' } },
    });
    expect(body.attendees).toEqual([{ email: 'pat@example.org' }]);
    expect(body.start).toEqual({
      dateTime: '2026-10-21T15:00:00.000Z',
      timeZone: 'America/Chicago',
      date: null,
    });
  });

  it('never asks for a second Meet link, and never removes one', () => {
    const existing = { id: 'e', hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc' };
    expect(
      draftToWrite({ meet: true }, { existing, requestId: 'r' }).body.conferenceData,
    ).toBeUndefined();
    const off = draftToWrite({ meet: false }, { existing, requestId: 'r' });
    expect(off.body).toEqual({});
    expect(off.conferenceDataVersion).toBe(0);
  });

  it('keeps kept guests’ answers, this account and rooms when guests change', () => {
    const merged = mergeGuests(
      [
        { email: 'nick@acme.example', self: true, responseStatus: 'accepted' },
        { email: 'pat@example.org', responseStatus: 'accepted' },
        { email: 'gone@example.org', responseStatus: 'declined' },
        { email: 'room@resource.calendar.google.com', resource: true },
      ],
      ['pat@example.org', 'lee@example.org'],
      OWN,
    );
    expect(merged).toEqual([
      { email: 'nick@acme.example', self: true, responseStatus: 'accepted' },
      { email: 'pat@example.org', responseStatus: 'accepted' },
      { email: 'room@resource.calendar.google.com', resource: true },
      { email: 'lee@example.org' },
    ]);
  });

  it('checks the times', () => {
    expect(timesProblem({ allDay: false, start: draft.end, end: draft.start })).toMatch(
      /end after/,
    );
    expect(timesProblem({ allDay: true, start: '2026-10-21', end: '2026-10-21' })).toMatch(
      /end after/,
    );
    expect(timesProblem({ allDay: true, start: '2026-10-21', end: '2026-10-22' })).toBeNull();
  });
});

describe('the editor’s draft', () => {
  const event: RangeEvent = {
    key: 'cal␟e1',
    id: 'e1',
    calendarId: 'cal',
    recurringEventId: null,
    title: 'Partner sync',
    allDay: false,
    startsAt: '2026-10-21T15:00:00Z',
    endsAt: '2026-10-21T16:00:00Z',
    startDate: null,
    endDate: null,
    timeZone: 'America/Chicago',
    location: null,
    place: null,
    description: null,
    joinUrl: null,
    meetUrl: null,
    meetPending: false,
    colorId: null,
    color: { background: '#16a765', foreground: '#1d1d1d' },
    organizer: { email: 'cal', name: null, self: true },
    attendees: [
      {
        email: 'nick@acme.example',
        name: null,
        response: 'accepted',
        self: true,
        resource: false,
        organizer: true,
        optional: false,
      },
      {
        email: 'pat@example.org',
        name: 'Pat',
        response: 'accepted',
        self: false,
        resource: false,
        organizer: false,
        optional: false,
      },
    ],
    guestsCanModify: false,
    canModify: true,
    readOnlyReason: null,
    canRespond: false,
    myResponse: 'accepted',
    attachments: [],
    verdict: { meeting: true, reason: 'With Pat', with: ['Pat'] },
    hold: false,
    inPerson: false,
    transparent: false,
    eventType: 'default',
    htmlLink: null,
  };

  it('sends only what changed, with the times together', () => {
    const before = draftFromEvent(event, 'America/Chicago', OWN);
    expect(before.guests).toEqual(['pat@example.org']);
    expect(changedFields(before, { ...before })).toEqual({});
    expect(changedFields(before, { ...before, title: 'Partner sync (moved)' })).toEqual({
      title: 'Partner sync (moved)',
    });
    expect(
      changedFields(before, {
        ...before,
        start: '2026-10-21T16:00:00Z',
        end: '2026-10-21T17:00:00Z',
      }),
    ).toEqual({
      allDay: false,
      start: '2026-10-21T16:00:00Z',
      end: '2026-10-21T17:00:00Z',
      timeZone: 'America/Chicago',
    });
    // The same instant written another way is not a change.
    expect(changedFields(before, { ...before, start: '2026-10-21T10:00:00-05:00' })).toEqual({});
    expect(
      changedFields(before, { ...before, guests: ['pat@example.org', 'lee@example.org'] }),
    ).toEqual({
      guests: ['pat@example.org', 'lee@example.org'],
    });
  });

  it('reads and writes the date and time fields in the profile’s zone', () => {
    expect(wallFields('2026-10-21T15:00:00Z', 'America/Chicago')).toEqual({
      date: '2026-10-21',
      time: '10:00',
    });
    expect(instantFromFields('2026-10-21', '10:00', 'America/Chicago')).toBe(
      '2026-10-21T15:00:00.000Z',
    );
    expect(instantFromFields('2026-10-21', '25:00', 'America/Chicago')).toBeNull();
  });

  it('shows the change at once, in Google’s colour for the new colorId', () => {
    const calendar = { id: 'cal', color: event.color } as CalendarInfo;
    const palette = [{ id: '11', name: 'Tomato', background: '#dc2127', foreground: '#ffffff' }];
    const next = optimisticEvent(event, { colorId: '11', title: '' }, calendar, palette, event.key);
    expect(next.color.background).toBe('#dc2127');
    expect(next.title).toBe('(no title)');
    expect(event.title).toBe('Partner sync');
  });
});
