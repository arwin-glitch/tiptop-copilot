import { describe, expect, it } from 'vitest';
import {
  colorRequest,
  colorRule,
  duplicateDraft,
  eventOptions,
  isColorOnly,
  respondRule,
  rsvpRequest,
  withResponse,
} from '@/lib/calendar/event-actions';
import {
  descriptionParts,
  mapsUrl,
  recurrenceSummary,
  responseCounts,
  responseSummary,
  safeHref,
} from '@/lib/calendar/event-text';
import type { GCalEvent } from '@/lib/calendar/google-types';
import type { RangeEvent } from '@/lib/calendar/range-types';

/**
 * The event card's quick actions, as requests: what an answer, a colour and
 * a duplicate send, and which options a card offers. Fictional people only.
 */

const OWN = ['nick@acme.example'];

const invite: Pick<GCalEvent, 'organizer' | 'attendees' | 'eventType' | 'status'> & {
  guestsCanModify?: boolean;
} = {
  status: 'confirmed',
  eventType: 'default',
  organizer: { email: 'maya@ledger.example', displayName: 'Maya Chen', self: false },
  attendees: [
    { email: 'maya@ledger.example', displayName: 'Maya Chen', responseStatus: 'accepted' },
    {
      email: 'nick@acme.example',
      responseStatus: 'needsAction',
      self: true,
      comment: 'maybe late',
    },
    { email: 'sam@ledger.example', responseStatus: 'tentative', optional: true },
  ],
};

function rangeEvent(over: Partial<RangeEvent> = {}): RangeEvent {
  return {
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
    location: 'Room 4',
    place: 'Room 4',
    description: 'Bring the numbers',
    joinUrl: 'https://meet.google.com/abc-defg-hij',
    meetUrl: 'https://meet.google.com/abc-defg-hij',
    meetPending: false,
    colorId: '5',
    color: { background: '#fbd75b', foreground: '#1d1d1d' },
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
      {
        email: 'room-4@resource.calendar.google.com',
        name: 'Room 4',
        response: 'accepted',
        self: false,
        resource: true,
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
    inPerson: true,
    transparent: false,
    eventType: 'default',
    htmlLink: 'https://calendar.google.com/calendar/event?eid=e1',
    ...over,
  };
}

describe('answering an invitation (Going? Yes / No / Maybe)', () => {
  it('sends only Nick’s own entry in Google’s answer-only form, so nobody else’s can change', () => {
    const request = rsvpRequest(invite, 'accepted', 'dont_send', OWN)!;
    expect(Object.keys(request.body).sort()).toEqual(['attendees', 'attendeesOmitted']);
    expect(request.body.attendeesOmitted).toBe(true);
    // His entry as Google has it (his note kept), with only the answer changed.
    expect(request.body.attendees).toEqual([
      { email: 'nick@acme.example', responseStatus: 'accepted', self: true, comment: 'maybe late' },
    ]);
    // Even where the organizer lets guests change the event.
    const guestsCanModify = { ...invite, guestsCanModify: true };
    const editable = rsvpRequest(guestsCanModify, 'declined', 'send', OWN)!;
    expect(editable.body.attendees?.map((a) => a.email)).toEqual(['nick@acme.example']);
    expect(editable.body.attendeesOmitted).toBe(true);
  });

  it('tells the organizer only on Send: Don’t send and no answer are both none', () => {
    expect(rsvpRequest(invite, 'declined', 'send', OWN)!.sendUpdates).toBe('all');
    expect(rsvpRequest(invite, 'declined', 'dont_send', OWN)!.sendUpdates).toBe('none');
    expect(rsvpRequest(invite, 'declined', null, OWN)!.sendUpdates).toBe('none');
    expect(rsvpRequest(invite, 'declined', undefined, OWN)!.sendUpdates).toBe('none');
  });

  it('finds Nick by his address when Google sends no self flag, and refuses when he is not invited', () => {
    const noSelf = {
      attendees: [{ email: 'Nick@Acme.example', responseStatus: 'needsAction' }],
    };
    expect(rsvpRequest(noSelf, 'tentative', 'dont_send', OWN)!.body.attendees).toEqual([
      { email: 'Nick@Acme.example', responseStatus: 'tentative' },
    ]);
    expect(
      rsvpRequest({ attendees: [{ email: 'pat@example.org' }] }, 'accepted', 'send', OWN),
    ).toBe(null);
  });

  it('is offered to a guest on a writable calendar, not to the organizer or on a read-only one', () => {
    expect(respondRule(invite, 'owner', OWN)).toEqual({ canRespond: true, reason: null });
    expect(respondRule(invite, 'reader', OWN).canRespond).toBe(false);
    expect(
      respondRule(
        { ...invite, organizer: { email: 'nick@acme.example', self: true } },
        'owner',
        OWN,
      ),
    ).toEqual({ canRespond: false, reason: 'You organize this event.' });
    expect(respondRule({ ...invite, status: 'cancelled' }, 'owner', OWN).canRespond).toBe(false);
    expect(respondRule({ ...invite, eventType: 'outOfOffice' }, 'owner', OWN).canRespond).toBe(
      false,
    );
    expect(respondRule({ ...invite, attendees: [] }, 'owner', OWN).reason).toBe(
      'You are not on the guest list.',
    );
  });

  it('shows the answer at once on the page', () => {
    const event = rangeEvent({ myResponse: 'needsAction' });
    const answered = withResponse(event, 'tentative', OWN);
    expect(answered.myResponse).toBe('tentative');
    expect(answered.attendees[0]!.response).toBe('tentative');
    expect(answered.attendees[1]!.response).toBe('accepted');
  });
});

describe('a colour from the card', () => {
  it('sends Google’s colorId and nothing else, and never emails anyone', () => {
    expect(colorRequest('11')).toEqual({
      body: { colorId: '11' },
      sendUpdates: 'none',
      conferenceDataVersion: 0,
    });
    // Back to the calendar's own colour.
    expect(colorRequest(null).body).toEqual({ colorId: null });
  });

  it('a change that is only a colour is told apart from any other', () => {
    expect(isColorOnly({ colorId: '3' })).toBe(true);
    expect(isColorOnly({ colorId: null })).toBe(true);
    expect(isColorOnly({ colorId: '3', title: 'x' })).toBe(false);
    expect(isColorOnly({ title: 'x' })).toBe(false);
    expect(isColorOnly({})).toBe(false);
  });

  it('can be picked on an event Nick may change, or on his copy of one he is a guest on', () => {
    expect(colorRule(invite, 'owner', OWN).canColor).toBe(true);
    expect(
      colorRule({ ...invite, organizer: { email: 'cal', self: true } }, 'writer', OWN).canColor,
    ).toBe(true);
    expect(colorRule(invite, 'reader', OWN)).toEqual({
      canColor: false,
      reason: 'This calendar is view-only for this account.',
    });
  });
});

describe('duplicate', () => {
  it('is a new event with the same details, a fresh Meet link, and the guests but not Nick or rooms', () => {
    const draft = duplicateDraft(rangeEvent(), 'America/Chicago', OWN);
    expect(draft).toEqual({
      title: 'Partner sync',
      allDay: false,
      start: '2026-10-21T15:00:00Z',
      end: '2026-10-21T16:00:00Z',
      timeZone: 'America/Chicago',
      description: 'Bring the numbers',
      location: 'Room 4',
      guests: ['pat@example.org'],
      meet: true,
      colorId: '5',
    });
    expect(duplicateDraft(rangeEvent({ meetUrl: null }), 'UTC', OWN).meet).toBe(false);
  });
});

describe('the options a card offers', () => {
  const ctx = { editing: true, calendarWritable: true, ownEmails: OWN };

  it('an event Nick may change: Edit, Delete, Duplicate, colour; no Going?', () => {
    expect(eventOptions(rangeEvent(), ctx)).toEqual({
      edit: true,
      delete: true,
      duplicate: true,
      color: true,
      rsvp: false,
      emailGuests: true,
      join: true,
      copyLink: true,
      openInGoogle: true,
    });
  });

  it('an invitation: Going?, colour and Duplicate, but no Edit or Delete', () => {
    const options = eventOptions(rangeEvent({ canModify: false, canRespond: true }), ctx);
    expect(options).toMatchObject({
      edit: false,
      delete: false,
      duplicate: true,
      color: true,
      rsvp: true,
    });
  });

  it('read-only (a view-only calendar, or editing off): only what writes nothing', () => {
    const writes = ['edit', 'delete', 'duplicate', 'color', 'rsvp'] as const;
    for (const options of [
      eventOptions(rangeEvent({ canRespond: true }), { ...ctx, calendarWritable: false }),
      eventOptions(rangeEvent({ canRespond: true }), { ...ctx, editing: false }),
      eventOptions(rangeEvent({ canModify: false }), ctx),
    ]) {
      for (const w of writes) expect(options[w], w).toBe(false);
      expect(options).toMatchObject({
        emailGuests: true,
        join: true,
        copyLink: true,
        openInGoogle: true,
      });
    }
  });

  it('Email guests only when someone besides Nick (and the rooms) is on it', () => {
    const alone = rangeEvent({ attendees: rangeEvent().attendees.filter((a) => a.self) });
    expect(eventOptions(alone, ctx).emailGuests).toBe(false);
  });
});

describe('the card’s words', () => {
  it('says how a series repeats, as Google does', () => {
    expect(recurrenceSummary(['RRULE:FREQ=WEEKLY;COUNT=12'], '2026-10-26')).toBe(
      'Weekly on Monday, 12 times',
    );
    expect(recurrenceSummary(['RRULE:FREQ=DAILY'], '2026-10-26')).toBe('Daily');
    expect(recurrenceSummary(['RRULE:FREQ=DAILY;INTERVAL=3'], null)).toBe('Every 3 days');
    expect(recurrenceSummary(['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'], '2026-10-26')).toBe(
      'Every weekday (Monday to Friday)',
    );
    expect(recurrenceSummary(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,MO'], '2026-10-26')).toBe(
      'Every 2 weeks on Monday and Wednesday',
    );
    expect(recurrenceSummary(['RRULE:FREQ=MONTHLY;BYDAY=3TH'], '2026-10-15')).toBe(
      'Monthly on the third Thursday',
    );
    expect(recurrenceSummary(['RRULE:FREQ=MONTHLY;BYDAY=-1FR'], '2026-10-30')).toBe(
      'Monthly on the last Friday',
    );
    expect(recurrenceSummary(['RRULE:FREQ=MONTHLY'], '2026-10-21')).toBe('Monthly on day 21');
    expect(
      recurrenceSummary(
        ['EXDATE:20261102T150000Z', 'RRULE:FREQ=YEARLY;UNTIL=20301231'],
        '2026-10-21',
      ),
    ).toBe('Annually on October 21, until Dec 31, 2030');
    expect(recurrenceSummary(['RRULE:FREQ=HOURLY'], '2026-10-21')).toBe('Repeats');
    expect(recurrenceSummary([], '2026-10-21')).toBe(null);
  });

  it('counts the guests’ answers', () => {
    const counts = responseCounts([
      { response: 'accepted' },
      { response: 'accepted' },
      { response: 'declined' },
      { response: 'needsAction' },
      { response: null },
    ]);
    expect(counts).toEqual({ yes: 2, no: 1, maybe: 0, awaiting: 2 });
    expect(responseSummary(counts)).toBe('2 yes, 1 no, 2 awaiting');
  });

  it('links a place to Google Maps', () => {
    expect(mapsUrl(' 500 Example Blvd, Austin ')).toBe(
      'https://www.google.com/maps/search/?api=1&query=500%20Example%20Blvd%2C%20Austin',
    );
  });

  it('shows a description as words and links, never as HTML', () => {
    const parts = descriptionParts(
      'Agenda:<br><b>Q3</b> review <a href="https://docs.google.com/document/d/x">the agenda</a>' +
        ' and <a href="javascript:alert(1)">this</a>, also https://example.org/plan.',
    );
    expect(parts).toEqual([
      { type: 'text', text: 'Agenda:\nQ3 review ' },
      {
        type: 'link',
        href: 'https://docs.google.com/document/d/x',
        label: 'the agenda',
        host: 'docs.google.com',
      },
      { type: 'text', text: ' and this, also ' },
      {
        type: 'link',
        href: 'https://example.org/plan',
        label: 'https://example.org/plan',
        host: null,
      },
      { type: 'text', text: '.' },
    ]);
    // Plain text keeps its line breaks; a mailto link stays clickable.
    expect(descriptionParts('Call me\nmailto:pat@example.org')).toEqual([
      { type: 'text', text: 'Call me\n' },
      { type: 'link', href: 'mailto:pat@example.org', label: 'mailto:pat@example.org', host: null },
    ]);
    expect(descriptionParts('<script>alert(1)</script>Hi')).toEqual([{ type: 'text', text: 'Hi' }]);
    expect(descriptionParts('')).toEqual([]);
  });

  it('opens only http, https and mailto links, with no credentials', () => {
    expect(safeHref('https://example.org/a?b=1&amp;c=2')).toBe('https://example.org/a?b=1&c=2');
    expect(safeHref('javascript:alert(1)')).toBe(null);
    expect(safeHref('data:text/html,hi')).toBe(null);
    expect(safeHref('https://user:pw@example.org')).toBe(null);
    expect(safeHref('not a link')).toBe(null);
  });
});
