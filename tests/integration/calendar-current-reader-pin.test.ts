import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import type { MeetingEvent } from '@/lib/calendar/meetings';
import { readCalendarDay } from '@/lib/services/calendar-view';
import { ok } from '@/lib/util/result';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * A pin on the Calendar page's day list as it reads today. The new views ship
 * beside it, behind a switch, and the parity checker compares the two; that
 * comparison means nothing if the current reader quietly changes on the way.
 * These expectations were taken from the reader before the new views were
 * added, and must not be edited to make a change pass.
 */

const listed = vi.hoisted(() => vi.fn());
vi.mock('@/lib/calendar/meetings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/calendar/meetings')>()),
  listMeetingEvents: listed,
}));
// The "latest emails" lookup: no Gmail in a test.
vi.mock('@/lib/google/gmail-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/gmail-inbox')>()),
  listThreadPage: vi.fn(async () => ({
    ok: false,
    error: { code: 'provider_unavailable', message: 'offline' },
  })),
}));

const NOW = new Date('2026-10-07T15:00:00Z');
const TZ = 'America/Chicago';
const SAVED = { ...process.env };

function live(over: Partial<MeetingEvent>): MeetingEvent {
  return {
    id: 'evt',
    status: 'confirmed',
    title: 'Untitled',
    startsAt: '2026-10-07T15:00:00Z',
    endsAt: '2026-10-07T15:30:00Z',
    allDay: false,
    eventType: 'default',
    transparent: false,
    location: null,
    description: null,
    joinUrl: null,
    organizer: { email: 'nick@tiptop.demo', self: true, name: null },
    attendees: [],
    ...over,
  };
}

const LIVE_DAY: MeetingEvent[] = [
  live({ id: 'allday-1', title: 'Offsite week', startsAt: null, endsAt: null, allDay: true }),
  live({
    id: 'call-1',
    title: 'Intro call',
    startsAt: '2026-10-07T14:00:00Z',
    endsAt: '2026-10-07T14:30:00Z',
    joinUrl: 'https://meet.google.com/aaa-bbbb-ccc',
    attendees: [
      { email: 'nick@tiptop.demo', name: null, response: 'accepted', self: true, resource: false },
      {
        email: 'pat@example.org',
        name: 'Pat Example',
        response: 'accepted',
        self: false,
        resource: false,
      },
    ],
  }),
  live({ id: 'hold-1', title: 'Hold: board prep', startsAt: '2026-10-07T16:00:00Z' }),
  live({ id: 'focus-1', title: 'Focus', startsAt: '2026-10-07T18:00:00Z', eventType: 'focusTime' }),
  live({
    id: 'coffee-1',
    title: 'Coffee at Example Roasters',
    startsAt: '2026-10-07T20:00:00Z',
    location: '100 Example St, Austin',
  }),
];

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness({ now: NOW });
  listed.mockReset();
});

afterEach(async () => {
  Object.assign(process.env, SAVED);
  resetEnvCache();
  await harness.dispose();
});

const shape = (day: Awaited<ReturnType<typeof readCalendarDay>>) =>
  day.entries.map((e) => ({
    id: e.event.id,
    title: e.event.title,
    startsAt: e.event.startsAt,
    allDay: e.event.allDay,
    meeting: e.verdict.meeting,
    reason: e.verdict.reason,
    inPerson: e.inPerson,
  }));

describe('the current day list reads what it read before the new views', () => {
  it('in demo mode: the synced rows of the day, in time order, with the same verdicts', async () => {
    const day = await readCalendarDay(harness.store, harness.auth.organizationId, {
      dateKey: '2026-10-07',
      timeZone: TZ,
      ownEmail: harness.auth.profile.email,
      now: NOW,
    });
    expect(day.state).toBe('ok');
    expect(listed).not.toHaveBeenCalled();
    expect(shape(day)).toEqual(PINNED_DEMO);
  });

  it('live: one primary-calendar read for the day window, every entry classified the same way', async () => {
    process.env.DEMO_MODE = 'false';
    resetEnvCache();
    listed.mockResolvedValue(ok(LIVE_DAY));
    const day = await readCalendarDay(harness.store, harness.auth.organizationId, {
      dateKey: '2026-10-07',
      timeZone: TZ,
      ownEmail: harness.auth.profile.email,
      now: NOW,
    });
    expect(day.state).toBe('ok');
    expect(listed).toHaveBeenCalledTimes(1);
    const [, integration, from, to] = listed.mock.calls[0]!;
    expect((integration as { id: string }).id).toBeTruthy();
    expect((from as Date).toISOString()).toBe('2026-10-07T05:00:00.000Z');
    expect((to as Date).toISOString()).toBe('2026-10-08T05:00:00.000Z');
    expect(shape(day)).toEqual(PINNED_LIVE);
  });

  it('live: a failed read is an error state, not an empty day', async () => {
    process.env.DEMO_MODE = 'false';
    resetEnvCache();
    listed.mockResolvedValue({
      ok: false,
      error: { code: 'provider_unavailable', message: 'Google Calendar returned 503.' },
    });
    const day = await readCalendarDay(harness.store, harness.auth.organizationId, {
      dateKey: '2026-10-07',
      timeZone: TZ,
      ownEmail: harness.auth.profile.email,
      now: NOW,
    });
    expect(day).toEqual({
      state: 'error',
      dateKey: '2026-10-07',
      entries: [],
      message: 'Google Calendar returned 503.',
    });
  });
});

const PINNED_DEMO = [
  {
    id: 'demo-event-0320',
    title: 'TipTop internal — pipeline review',
    startsAt: '2026-10-07T14:00:00.000Z',
    allDay: false,
    meeting: false,
    reason: 'No one else is on it',
    inPerson: false,
  },
  {
    id: 'demo-event-0321',
    title: 'Girder AI — reference call debrief',
    startsAt: '2026-10-07T16:00:00.000Z',
    allDay: false,
    meeting: true,
    reason: 'With Tom Whitfield',
    inPerson: false,
  },
  {
    id: 'demo-event-0322',
    title: 'Ledgerly board prep',
    startsAt: '2026-10-07T18:30:00.000Z',
    allDay: false,
    meeting: true,
    reason: 'With Maya Chen',
    inPerson: false,
  },
  {
    id: 'demo-event-0323',
    title: 'Coffee — Elena Ward (Marchmont)',
    startsAt: '2026-10-07T21:00:00.000Z',
    allDay: false,
    meeting: true,
    reason: 'With Elena Ward',
    inPerson: false,
  },
];
const PINNED_LIVE = [
  {
    id: 'allday-1',
    title: 'Offsite week',
    startsAt: null,
    allDay: true,
    meeting: false,
    reason: 'All-day entry',
    inPerson: false,
  },
  {
    id: 'call-1',
    title: 'Intro call',
    startsAt: '2026-10-07T14:00:00Z',
    allDay: false,
    meeting: true,
    reason: 'With Pat Example',
    inPerson: false,
  },
  {
    id: 'hold-1',
    title: 'Hold: board prep',
    startsAt: '2026-10-07T16:00:00Z',
    allDay: false,
    meeting: false,
    reason: 'A hold, not confirmed',
    inPerson: false,
  },
  {
    id: 'focus-1',
    title: 'Focus',
    startsAt: '2026-10-07T18:00:00Z',
    allDay: false,
    meeting: false,
    reason: 'Focus time',
    inPerson: false,
  },
  {
    id: 'coffee-1',
    title: 'Coffee at Example Roasters',
    startsAt: '2026-10-07T20:00:00Z',
    allDay: false,
    meeting: true,
    reason: 'The title says it is with someone',
    inPerson: true,
  },
];
