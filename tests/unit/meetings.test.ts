import { describe, expect, it } from 'vitest';
import {
  classifyMeeting,
  dueMeetingAlerts,
  isInPerson,
  meetingFromStoredEvent,
  physicalLocation,
  toMeetingEvent,
  type MeetingEvent,
} from '@/lib/calendar/meetings';
import { parseDossier } from '@/lib/services/calendar-view';
import type { CalendarEvent } from '@/lib/types/domain';

const NICK = 'nick@acme.vc';
const NOW = new Date('2026-10-13T15:00:00Z'); // 10:00 Chicago

function event(over: Partial<MeetingEvent> = {}): MeetingEvent {
  return {
    id: 'evt1',
    status: 'confirmed',
    title: 'Something',
    startsAt: '2026-10-13T15:05:00Z',
    endsAt: '2026-10-13T15:35:00Z',
    allDay: false,
    eventType: 'default',
    transparent: false,
    location: null,
    description: null,
    joinUrl: null,
    organizer: { email: NICK, self: true },
    attendees: [],
    ...over,
  };
}

const person = (email: string, response = 'accepted', name: string | null = null) => ({
  email,
  name,
  response,
  self: false,
  resource: false,
});
const me = (response = 'accepted') => ({
  email: NICK,
  name: null,
  response,
  self: true,
  resource: false,
});

const verdict = (over: Partial<MeetingEvent>) => classifyMeeting(event(over), [NICK]);

describe('what counts as a meeting', () => {
  it('a call with someone else invited', () => {
    const v = verdict({
      title: 'Lindel / Nick',
      attendees: [me(), person('lindel@edenroad.com', 'accepted', 'Lindel Eakman')],
    });
    expect(v).toMatchObject({ meeting: true, with: ['Lindel Eakman'] });
  });

  it('an invite someone else sent Nick, once he has accepted it', () => {
    const invite = { title: 'Partner sync', organizer: { email: 'jo@fund.com', self: false } };
    expect(verdict({ ...invite, attendees: [me('accepted')] }).meeting).toBe(true);
  });

  it('not an open group invite he never accepted, like an LP pitch session', () => {
    const pitch = {
      title: 'Caddie <> LP Pitch / Q&A',
      organizer: { email: 'mike@pef.com', self: false },
    };
    expect(verdict({ ...pitch, attendees: [me('needsAction')] }).reason).toBe(
      "Group invite Nick hasn't accepted",
    );
    expect(verdict({ ...pitch, attendees: [] }).meeting).toBe(false);
  });

  it("Nick's own other addresses are not other people", () => {
    const v = verdict({
      title: 'Tiptop <> Nakama',
      attendees: [me(), person('ntippman@gmail.com'), person('jake.lee@nakama.com')],
    });
    expect(v.with).toEqual(['Jake Lee']);
  });

  it('a block with a video link but no title words is still a call', () => {
    expect(verdict({ title: 'Quick one', joinUrl: 'https://zoom.us/j/123' }).meeting).toBe(true);
  });

  it('an in-person meeting typed straight onto the calendar', () => {
    expect(verdict({ title: 'Coffee w/ Esteban' }).meeting).toBe(true);
    expect(verdict({ title: 'Intro: Jane <> Nick' }).meeting).toBe(true);
    expect(verdict({ title: 'Dinner with Esteban and Ryan' }).meeting).toBe(true);
  });
});

describe('what is a block, not a meeting', () => {
  it.each([
    ['Focus', {}],
    ['HOLD for Vertex', {}],
    ['Lunch', {}],
    ['Gym', {}],
    ['Flight to SFO', {}],
    ['Email time', {}],
    ['Busy', {}],
    ['Pick up kids', {}],
    ['Prep for board', {}],
  ])('"%s" with nobody else on it', (title) => {
    expect(verdict({ title }).meeting).toBe(false);
  });

  it('family time, even when it names someone', () => {
    expect(verdict({ title: 'Dinner with Mari' }).reason).toBe('Personal or family time');
    expect(verdict({ title: 'Date night' }).meeting).toBe(false);
  });

  it('Google focus time and out-of-office entries', () => {
    expect(verdict({ title: 'Deep work', eventType: 'focusTime' }).reason).toBe('Focus time');
    expect(verdict({ title: 'Away', eventType: 'outOfOffice' }).meeting).toBe(false);
  });

  it('flight and hotel bookings Gmail put on the calendar', () => {
    const v = verdict({
      title: 'Flight to Austin (UA 123)',
      eventType: 'fromGmail',
      organizer: { email: 'unknownorganizer@calendar.google.com', self: false },
    });
    expect(v.meeting).toBe(false);
  });

  it('a meeting Nick declined, or everyone else declined', () => {
    expect(verdict({ title: 'Sync', attendees: [me('declined'), person('a@x.com')] }).meeting).toBe(
      false,
    );
    expect(
      verdict({ title: 'Sync', attendees: [me(), person('a@x.com', 'declined')] }).reason,
    ).toBe('Everyone else declined');
  });

  it('a hold with people on it that nobody has accepted yet', () => {
    const v = verdict({
      title: 'Hold - call with Jane',
      attendees: [me(), person('jane@co.com', 'needsAction')],
    });
    expect(v.meeting).toBe(false);
  });

  it('a room booking alone does not make it a meeting', () => {
    const room = {
      email: 'room-1@resource.calendar.google.com',
      name: 'Room 1',
      response: 'accepted',
      self: false,
      resource: true,
    };
    expect(verdict({ title: 'Heads down', attendees: [me(), room] }).meeting).toBe(false);
  });

  it('all-day entries and plain untitled blocks', () => {
    expect(verdict({ allDay: true, startsAt: null }).meeting).toBe(false);
    expect(verdict({ title: 'Untitled' }).reason).toBe('No one else is on it');
  });
});

describe('reading Google events', () => {
  it('finds the join link from Meet, conference data or a Zoom link in the location', () => {
    expect(
      toMeetingEvent({ id: 'a', hangoutLink: 'https://meet.google.com/abc-defg-hij' }).joinUrl,
    ).toContain('meet.google.com');
    expect(
      toMeetingEvent({ id: 'b', location: 'Zoom: https://acme.zoom.us/j/99887766?pwd=x' }).joinUrl,
    ).toBe('https://acme.zoom.us/j/99887766?pwd=x');
  });
});

describe('the 5-minute alert', () => {
  const meeting = event({
    title: 'Lindel / Nick',
    attendees: [me(), person('lindel@edenroad.com', 'accepted', 'Lindel')],
    joinUrl: 'https://zoom.us/j/1',
  });

  it('fires about five minutes before a real meeting, once', () => {
    const due = dueMeetingAlerts([meeting], [NICK], new Set(), NOW, 'America/Chicago');
    expect(due).toHaveLength(1);
    expect(due[0]!.title).toBe('Lindel / Nick in 5 min');
    expect(due[0]!.body).toBe('10:05 AM · with Lindel · Tap to join');
    expect(
      dueMeetingAlerts([meeting], [NICK], new Set([due[0]!.key]), NOW, 'America/Chicago'),
    ).toHaveLength(0);
  });

  it('never for a block, too early, or once it has started', () => {
    const block = event({ title: 'Focus' });
    expect(dueMeetingAlerts([block], [NICK], new Set(), NOW, 'America/Chicago')).toHaveLength(0);
    const later = { ...meeting, startsAt: '2026-10-13T15:20:00Z' };
    expect(dueMeetingAlerts([later], [NICK], new Set(), NOW, 'America/Chicago')).toHaveLength(0);
    const started = { ...meeting, startsAt: '2026-10-13T14:59:00Z' };
    expect(dueMeetingAlerts([started], [NICK], new Set(), NOW, 'America/Chicago')).toHaveLength(0);
  });
});

describe('the dossier', () => {
  it('splits into one section per meeting with how-you-got-here and questions', () => {
    const [s] = parseDossier(`11:00 AM · Ledgerly pre-board sync with Maya Chen
The one thing to know: she wants the board on pricing.
How you got here: seed lead in 2025;
last sync two weeks ago.
Worth asking:
1. Which VP Sales finalist?
2. What changes her timing?`);
    expect(s).toEqual({
      time: '11:00 AM',
      title: 'Ledgerly pre-board sync with Maya Chen',
      oneThing: 'she wants the board on pricing.',
      howYouGotHere: 'seed lead in 2025; last sync two weeks ago.',
      worthAsking: ['Which VP Sales finalist?', 'What changes her timing?'],
    });
  });
});

describe('calendar notices are not conversations', () => {
  it('spots invites, updates and RSVPs, but not real emails', async () => {
    const { isCalendarNotice } = await import('@/lib/calendar/meetings');
    expect(
      isCalendarNotice('Invitation: Dawid <> Nick @ Tue Oct 13, 2026 9am (CDT) (nick@acme.vc)'),
    ).toBe(true);
    expect(isCalendarNotice('Accepted: Nick Tippmann <> Jack (Flycore) @ Tue Oct 20, 2026')).toBe(
      true,
    );
    expect(isCalendarNotice('Updated invitation: Daily 1:1 @ Tue Jul 21')).toBe(true);
    expect(isCalendarNotice('Re: fintavo | Pre-Seed Round fully signed')).toBe(false);
    expect(isCalendarNotice('Accepted offer details')).toBe(false);
  });
});

describe('event platforms and no-reply senders are not people', () => {
  // An RSVP an event platform put on the calendar: the host's name rides on
  // the robot address, and Nick is the only guest.
  const registration = {
    title: 'Founder Summit',
    startsAt: '2026-10-13T20:30:00Z',
    endsAt: '2026-10-14T02:30:00Z',
    location: '400 Harbor Way, Lakeside',
    organizer: { email: 'calendar-invite@lu.ma', self: false, name: 'Northwind Ventures' },
  };

  it('a Luma-style invite with only Nick on it is a block', () => {
    const v = verdict({ ...registration, attendees: [me('accepted')] });
    expect(v).toEqual({
      meeting: false,
      reason: 'An event registration, not a meeting',
      with: [],
    });
  });

  it('still a block when the platform address is also listed as a guest', () => {
    const robot = person('calendar-invite@lu.ma', 'accepted', 'Northwind Ventures');
    expect(verdict({ ...registration, attendees: [me(), robot] }).meeting).toBe(false);
  });

  it('a Luma-style invite with a real person on it is still a meeting', () => {
    const v = verdict({
      ...registration,
      attendees: [me(), person('pat.quill@harborfund.example', 'accepted')],
    });
    expect(v).toMatchObject({ meeting: true, with: ['Pat Quill'] });
  });

  it('a no-reply organizer is a block', () => {
    const v = verdict({
      title: 'Demo Day livestream',
      organizer: { email: 'no-reply@ticketing.example', self: false },
      attendees: [me('accepted')],
    });
    expect(v.reason).toBe('An event registration, not a meeting');
  });

  it('never alerts for an event registration', () => {
    const e = event({
      ...registration,
      startsAt: '2026-10-13T15:05:00Z',
      attendees: [me('accepted')],
    });
    expect(dueMeetingAlerts([e], [NICK], new Set(), NOW, 'America/Chicago')).toHaveLength(0);
  });
});

describe('names shown to Nick', () => {
  it("uses a real organizer's display name, not their address", () => {
    const v = verdict({
      title: 'Partner sync',
      organizer: { email: 'jq@harborfund.example', self: false, name: 'Jordan Quill' },
      attendees: [me('accepted')],
    });
    expect(v).toMatchObject({ meeting: true, reason: 'Invited by Jordan Quill' });
    expect(v.with).toEqual(['Jordan Quill']);
  });

  it('capitalises a single-word handle', () => {
    const invited = verdict({
      title: 'Partner sync',
      organizer: { email: 'andrew@x.example', self: false },
      attendees: [me('accepted')],
    });
    expect(invited.reason).toBe('Invited by Andrew');
    expect(verdict({ title: 'Sync', attendees: [me(), person('andrew@x.example')] }).with).toEqual([
      'Andrew',
    ]);
  });

  it('reads the organizer display name from Google, and synced rows still work without one', () => {
    expect(
      toMeetingEvent({ id: 'c', organizer: { email: 'Jo@Fund.example', displayName: 'Jo Park' } })
        .organizer,
    ).toEqual({ email: 'jo@fund.example', self: false, name: 'Jo Park' });

    const row = {
      provider_event_id: 'demo-1',
      title: 'Partner sync',
      description: null,
      location: null,
      starts_at: '2026-10-13T15:05:00Z',
      ends_at: '2026-10-13T15:35:00Z',
      all_day: false,
      attendees: [],
      organizer_email: 'andrew@x.example',
    } as unknown as CalendarEvent;
    const stored = meetingFromStoredEvent(row);
    expect(stored.organizer).toEqual({ email: 'andrew@x.example', self: false, name: null });
    expect(classifyMeeting(stored, [NICK]).reason).toBe("Group invite Nick hasn't accepted");
  });
});

describe('in-person meetings', () => {
  const pat = person('pat@harborfund.example', 'accepted', 'Pat Quill');
  const meet = 'https://meet.google.com/abc-defg-hij';
  const alert = (over: Partial<MeetingEvent>) =>
    dueMeetingAlerts(
      [event({ attendees: [me(), pat], joinUrl: meet, ...over })],
      [NICK],
      new Set(),
      NOW,
      'America/Chicago',
    )[0]!;

  it('IRL in the title, with a Meet link attached: shows where, not "Tap to join"', () => {
    const a = alert({ title: 'Pat & Nick IRL', location: 'Harbor Market Hall' });
    expect(a.body).toBe('10:05 AM · with Pat Quill · Harbor Market Hall');
    expect(a.inPerson).toBe(true);
  });

  it('IRL with no location just drops the join prompt, and stays a meeting', () => {
    const a = alert({ title: 'Pat & Nick IRL' });
    expect(a.body).toBe('10:05 AM · with Pat Quill');
    expect(
      classifyMeeting(event({ title: 'Pat & Nick IRL', attendees: [me(), pat] }), [NICK]),
    ).toMatchObject({ meeting: true });
  });

  it('a physical location without IRL in the title is in person too', () => {
    const a = alert({ title: 'Pat / Nick', location: '12 Pier Road, Lakeside' });
    expect(a.body).toBe('10:05 AM · with Pat Quill · 12 Pier Road, Lakeside');
    expect(a.body).not.toContain('Tap to join');
  });

  it('a video-only meeting still says "Tap to join"', () => {
    expect(alert({ title: 'Pat / Nick' }).body).toBe('10:05 AM · with Pat Quill · Tap to join');
    const zoomed = alert({ title: 'Pat / Nick', location: 'Zoom' });
    expect(zoomed.body).toBe('10:05 AM · with Pat Quill · Tap to join');
    expect(zoomed.inPerson).toBe(false);
    expect(alert({ title: 'Pat / Nick', location: 'Microsoft Teams Meeting' }).inPerson).toBe(
      false,
    );
  });

  it('a link in the location is not a place', () => {
    const location = 'https://harborfund.zoom.us/j/5550100';
    expect(isInPerson({ title: 'Pat / Nick', location })).toBe(false);
    expect(alert({ title: 'Pat / Nick', location }).body).toBe(
      '10:05 AM · with Pat Quill · Tap to join',
    );
    expect(isInPerson({ title: 'Pat / Nick', location: 'meet.google.com/abc-defg-hij' })).toBe(
      false,
    );
  });

  it('coffee at, lunch at, in person in the title', () => {
    expect(isInPerson({ title: 'Coffee at Pier 9 w/ Pat', location: null })).toBe(true);
    expect(isInPerson({ title: 'In-person: Pat / Nick', location: null })).toBe(true);
    expect(isInPerson({ title: 'Pat / Nick', location: null })).toBe(false);
  });
});

describe('shared mailboxes at a firm can still book a real meeting', () => {
  const booker = { email: 'calendar@harborfund.example', self: false };

  it('a 1:1 title with a video link, booked from calendar@, still pings', () => {
    const v = verdict({
      title: 'Intro: Pat Quill <> Nick',
      organizer: booker,
      joinUrl: 'https://harborfund.zoom.us/j/5550100',
      attendees: [me('accepted')],
    });
    expect(v).toEqual({ meeting: true, reason: 'Has a video call link', with: [] });
  });

  it('a 1:1 title alone is enough, and the mailbox is never named as the person', () => {
    const v = verdict({
      title: 'Call w/ Pat Quill',
      organizer: booker,
      attendees: [me('accepted')],
    });
    expect(v).toMatchObject({ meeting: true, with: [] });
    expect(v.reason).not.toContain('Calendar');
  });

  it('the same mailbox sending an event name is still a registration', () => {
    const v = verdict({
      title: 'Harbor Fund Annual Summit',
      organizer: booker,
      joinUrl: 'https://harborfund.zoom.us/j/5550100',
      attendees: [me('accepted')],
    });
    expect(v.reason).toBe('An event registration, not a meeting');
  });

  it('an event platform stays a block whatever the title says', () => {
    const v = verdict({
      title: 'Founder <> Investor Mixer',
      organizer: { email: 'calendar-invite@lu.ma', self: false, name: 'Northwind Ventures' },
      attendees: [me('accepted')],
    });
    expect(v.reason).toBe('An event registration, not a meeting');
  });
});

describe('in person or a call: locations, links and titles', () => {
  const pat = person('pat@harborfund.example', 'accepted', 'Pat Quill');
  const meet = 'https://meet.google.com/abc-defg-hij';
  const zoom = 'https://harborfund.zoom.us/j/5550100';
  const alert = (over: Partial<MeetingEvent>) =>
    dueMeetingAlerts(
      [event({ attendees: [me(), pat], joinUrl: meet, ...over })],
      [NICK],
      new Set(),
      NOW,
      'America/Chicago',
    )[0]!;

  it.each([
    '+1 646-555-0100,,84512345#',
    '512-555-0100 x204',
    'Conference line: 712-555-1500 PIN 4821',
    'Meeting ID 845 1234 5678',
    'MS Teams',
    'Join via Teams',
    'teams.microsoft.com/l/meetup-join/19%3ameeting_demo',
    'Video conference',
    'Video',
    'Webinar',
    'Discord',
    'Slack huddle',
  ])('"%s" is a call, not a place', (location) => {
    expect(physicalLocation({ location })).toBeNull();
    expect(isInPerson({ title: 'Pat / Nick', location, joinUrl: meet })).toBe(false);
    expect(alert({ title: 'Pat / Nick', location }).body).toBe(
      '10:05 AM · with Pat Quill · Tap to join',
    );
  });

  it.each([
    '1200 Lake St, Suite 4, Lakeside',
    'Harbor Market Hall',
    'Pin Oak Cafe, 9 Elm Rd',
    'Conference Room B, 400 Harbor Way',
    '12 Pier Road, Lakeside 75001-1234',
  ])('"%s" is a place', (location) => {
    expect(physicalLocation({ location })).toBe(location);
    expect(isInPerson({ title: 'Pat / Nick', location, joinUrl: meet })).toBe(true);
  });

  it('a place with a Zoom link someone chose is hybrid: the join stays', () => {
    const board = alert({
      title: 'Board meeting',
      location: '1200 Lake St, Suite 4, Lakeside',
      joinUrl: zoom,
      organizer: { email: 'ceo@lakeside.example', self: false, name: 'Robin Vale' },
    });
    expect(board.inPerson).toBe(false);
    expect(board.body).toBe('10:05 AM · with Pat Quill · Tap to join');
  });

  it('a place with no link at all is in person', () => {
    expect(isInPerson({ title: 'Pat / Nick', location: '12 Pier Road', joinUrl: null })).toBe(true);
  });

  it('a booked room is where the organizer is, not proof Nick is there', () => {
    const room = {
      email: 'c_demo123@resource.calendar.google.com',
      name: 'HQ-2-Fishbowl (8)',
      response: 'accepted',
      self: false,
      resource: true,
    };
    const remote = alert({
      title: 'Pat / Nick',
      location: 'HQ-2-Fishbowl (8)',
      attendees: [me(), pat, room],
    });
    expect(remote.inPerson).toBe(false);
    expect(remote.body).toBe('10:05 AM · with Pat Quill · Tap to join');

    const irl = alert({
      title: 'Pat & Nick IRL',
      location: 'HQ-2-Fishbowl (8)',
      attendees: [me(), pat, room],
    });
    expect(irl.inPerson).toBe(true);
    expect(irl.body).toBe('10:05 AM · with Pat Quill · HQ-2-Fishbowl (8)');
  });

  it('a title that names a call, or a clock time after "coffee at", is not in person', () => {
    expect(isInPerson({ title: 'Virtual coffee at 3pm', location: null, joinUrl: zoom })).toBe(
      false,
    );
    expect(isInPerson({ title: 'Coffee at 10 w/ Pat (Zoom)', location: null, joinUrl: zoom })).toBe(
      false,
    );
    expect(isInPerson({ title: 'Coffee at 3pm', location: null, joinUrl: meet })).toBe(false);
    expect(isInPerson({ title: 'Lunch at 12:30 w/ Pat', location: null, joinUrl: meet })).toBe(
      false,
    );
    expect(isInPerson({ title: 'Lunch at noon', location: null, joinUrl: meet })).toBe(false);
    expect(
      isInPerson({ title: 'Lunch at 9th Street Kitchen', location: null, joinUrl: meet }),
    ).toBe(true);
    expect(isInPerson({ title: 'Pat & Nick IRL', location: 'Zoom', joinUrl: zoom })).toBe(false);
  });
});
