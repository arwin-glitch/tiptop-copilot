import { describe, expect, it } from 'vitest';
import {
  classifyMeeting,
  dueMeetingAlerts,
  toMeetingEvent,
  type MeetingEvent,
} from '@/lib/calendar/meetings';
import { parseDossier } from '@/lib/services/calendar-view';

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

  it('an invite someone else sent Nick', () => {
    expect(
      verdict({ title: 'Partner sync', organizer: { email: 'jo@fund.com', self: false } }).meeting,
    ).toBe(true);
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
