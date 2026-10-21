import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyMeeting,
  dueMeetingAlerts,
  listMeetingEvents,
  type MeetingEvent,
} from '@/lib/calendar/meetings';
import { storeTokens } from '@/lib/google/oauth';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import type { Integration } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * A pin on what the meeting pings read. The phone and desktop "meeting in 5
 * minutes" alerts come from listMeetingEvents and classifyMeeting; the new
 * calendar views reuse classifyMeeting but read through their own range
 * reader, so nothing about the pings' request or verdicts may move. These
 * expectations were taken before the new views were added.
 */

const NOW = new Date('2026-10-07T14:55:00Z'); // 9:55 Chicago
const TZ = 'America/Chicago';

const GOOGLE_ITEMS = [
  {
    id: 'g-call',
    status: 'confirmed',
    summary: 'Partner sync',
    start: { dateTime: '2026-10-07T15:00:00Z' },
    end: { dateTime: '2026-10-07T15:30:00Z' },
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    organizer: { email: 'nick@tiptop.demo', self: true },
    attendees: [
      { email: 'nick@tiptop.demo', responseStatus: 'accepted', self: true },
      { email: 'sam@fund.example', displayName: 'Sam Rivera', responseStatus: 'accepted' },
    ],
  },
  {
    id: 'g-hold',
    status: 'confirmed',
    summary: 'Hold for a founder call',
    start: { dateTime: '2026-10-07T15:00:00Z' },
    end: { dateTime: '2026-10-07T15:30:00Z' },
    organizer: { email: 'nick@tiptop.demo', self: true },
    attendees: [{ email: 'jo@startup.example', responseStatus: 'needsAction' }],
  },
  {
    id: 'g-allday',
    status: 'confirmed',
    summary: 'Conference',
    start: { date: '2026-10-07' },
    end: { date: '2026-10-08' },
  },
  {
    id: 'g-irl',
    status: 'confirmed',
    summary: 'Coffee w/ Lee IRL',
    location: '200 Example Ave, Austin',
    start: { dateTime: '2026-10-07T15:01:00Z' },
    end: { dateTime: '2026-10-07T15:45:00Z' },
    hangoutLink: 'https://meet.google.com/xyz-abcd-efg',
    organizer: { email: 'nick@tiptop.demo', self: true },
  },
];

let harness: Harness;
let integration: Integration;
const fetchMock = vi.fn();

beforeEach(async () => {
  harness = await createHarness({ now: NOW });
  integration = (await getPrimaryIntegration(harness.store, harness.auth.organizationId))!;
  await storeTokens(harness.store, integration, {
    accessToken: 'test-access-token',
    expiresInSeconds: 3600,
  });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ items: GOOGLE_ITEMS }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await harness.dispose();
});

describe('the meeting pings read exactly what they read before', () => {
  it('asks Google for the primary calendar only, single events in time order, 50 at most', async () => {
    const from = new Date('2026-10-07T14:50:00Z');
    const to = new Date('2026-10-07T15:10:00Z');
    const listed = await listMeetingEvents(harness.store, integration, from, to);
    expect(listed.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=50&timeMin=2026-10-07T14%3A50%3A00.000Z&timeMax=2026-10-07T15%3A10%3A00.000Z',
    );
    expect((init as RequestInit).method ?? 'GET').toBe('GET');
    expect((init as RequestInit).headers).toEqual({ Authorization: 'Bearer test-access-token' });
  });

  it('maps and classifies every entry the same way', async () => {
    const listed = await listMeetingEvents(
      harness.store,
      integration,
      new Date('2026-10-07T14:50:00Z'),
      new Date('2026-10-07T15:10:00Z'),
    );
    if (!listed.ok) throw new Error('read failed');
    const own = [integration.account_email!];
    const verdicts = listed.value.map((e: MeetingEvent) => ({
      id: e.id,
      startsAt: e.startsAt,
      allDay: e.allDay,
      joinUrl: e.joinUrl,
      ...classifyMeeting(e, own),
    }));
    expect(verdicts).toEqual([
      {
        id: 'g-call',
        startsAt: '2026-10-07T15:00:00Z',
        allDay: false,
        joinUrl: 'https://meet.google.com/abc-defg-hij',
        meeting: true,
        reason: 'With Sam Rivera',
        with: ['Sam Rivera'],
      },
      {
        id: 'g-hold',
        startsAt: '2026-10-07T15:00:00Z',
        allDay: false,
        joinUrl: null,
        meeting: false,
        reason: 'A hold, not confirmed',
        with: [],
      },
      {
        id: 'g-allday',
        startsAt: null,
        allDay: true,
        joinUrl: null,
        meeting: false,
        reason: 'All-day entry',
        with: [],
      },
      {
        id: 'g-irl',
        startsAt: '2026-10-07T15:01:00Z',
        allDay: false,
        joinUrl: 'https://meet.google.com/xyz-abcd-efg',
        meeting: true,
        reason: 'Has a video call link',
        with: [],
      },
    ]);

    // The alerts the phone and desktop get from that read.
    const due = dueMeetingAlerts(listed.value, own, new Set(), NOW, TZ);
    expect(due).toEqual([
      {
        key: 'meeting:g-call:2026-10-07T15:00:00Z',
        eventId: 'g-call',
        title: 'Partner sync in 5 min',
        inPerson: false,
        body: '10:00 AM · with Sam Rivera · Tap to join',
      },
      {
        key: 'meeting:g-irl:2026-10-07T15:01:00Z',
        eventId: 'g-irl',
        title: 'Coffee w/ Lee IRL in 6 min',
        inPerson: true,
        body: '10:01 AM · 200 Example Ave, Austin',
      },
    ]);
  });
});
