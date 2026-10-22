import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import type { MeetingEvent } from '@/lib/calendar/meetings';
import { readCalendarDay } from '@/lib/services/calendar-view';
import { resetFollowUpsCache } from '@/lib/services/follow-ups';
import { ok } from '@/lib/util/result';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The other place the Oct 21 week-ahead post failed to reach: the Calendar
 * day list's prep notes (D-073). A fictional post of the same shape (two
 * numbered parts sharing one run_at, prep notes of 250 to 340 characters
 * where 240 fit, one meeting of a kind the app does not know) is read the way
 * the Calendar page reads it: readCalendarDay, which reads the relay itself
 * and gives each meeting the prep note whose start time matches. Every name
 * and word here is invented.
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

const NOW = new Date('2026-10-21T15:00:00Z');
const TZ = 'America/Chicago';
const RUN = '2026-10-21T11:21:01Z';
const TICK = String.fromCharCode(96);
const SAVED = { ...process.env };

const at = (iso: string) => `${Date.parse(iso) / 1000}.000100`;
const relay = (body: unknown, postedAt: string) => ({
  ts: at(postedAt),
  user: 'U0ROUTINE1',
  text: `WEEK_AHEAD_V1\n${TICK}${JSON.stringify(body)}${TICK}`,
});

/** Invented prep prose, exactly `n` characters, with word breaks throughout. */
function prose(n: number): string {
  const words =
    'Ask how the Northwind pilot is converting, whether the second engineer has started, ' +
    'and what the bridge would need to close; bring the September numbers and the open intro. ';
  return words.repeat(6).slice(0, n);
}

const event = (starts: string, kind: string, prep: string | null, title: string) => ({
  title,
  starts_at: starts,
  ends_at: null,
  with_who: ['Avery Example'],
  kind,
  prep,
  thread_id: null,
});

const YESTERDAY = relay(
  {
    run_at: '2026-10-20T11:20:04Z',
    events: [event('2026-10-21T16:00:00Z', 'founder', 'The copy from the day before.', 'Old')],
  },
  '2026-10-20T11:22:00Z',
);
const PART_1 = relay(
  {
    run_at: RUN,
    part: 1,
    events: [
      event('2026-10-21T16:00:00Z', 'founder', prose(252), 'Northwind Robotics check-in'),
      event('2026-10-21T19:30:00Z', 'offsite', 'A kind the app does not know.', 'Team offsite'),
      event('2026-10-22T17:00:00Z', 'portfolio', prose(338), 'Zeta Labs board call'),
    ],
  },
  '2026-10-21T11:24:10Z',
);
const PART_2 = relay(
  {
    // The same run, spelled with milliseconds.
    run_at: '2026-10-21T11:21:01.000Z',
    part: 2,
    events: [
      event('2026-10-21T20:00:00Z', 'investor', prose(301), 'Co-investor sync'),
      event('2026-10-23T15:00:00Z', 'internal', 'Short prep.', 'Weekly team sync'),
    ],
  },
  '2026-10-21T11:24:12Z',
);

function meeting(id: string, title: string, startsAt: string): MeetingEvent {
  return {
    id,
    status: 'confirmed',
    title,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
    allDay: false,
    eventType: 'default',
    transparent: false,
    location: null,
    description: null,
    joinUrl: 'https://meet.google.com/aaa-bbbb-ccc',
    organizer: { email: 'nick@tiptop.demo', self: true, name: null },
    attendees: [
      { email: 'nick@tiptop.demo', name: null, response: 'accepted', self: true, resource: false },
      {
        email: 'avery@example.org',
        name: 'Avery Example',
        response: 'accepted',
        self: false,
        resource: false,
      },
    ],
  };
}

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness({ now: NOW });
  listed.mockReset();
  resetFollowUpsCache();
  process.env.DEMO_MODE = 'false';
  process.env.ASK_RELAY_SLACK_TOKEN = 'xoxb-test';
  process.env.AUTH_ALLOWED_EMAIL_DOMAINS = 'tiptop.example';
  process.env.DEAL_RELAY_CHANNEL_ID = 'C0EXAMPLE01';
  delete process.env.DEAL_RELAY_POSTER_IDS;
  resetEnvCache();
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/conversations.history')) {
      throw new Error(`unexpected request to ${url.pathname}`);
    }
    const messages =
      url.searchParams.get('channel') === 'C0EXAMPLE01' ? [PART_2, PART_1, YESTERDAY] : [];
    return new Response(JSON.stringify({ ok: true, messages }));
  }) as typeof fetch);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await harness.dispose();
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
  resetFollowUpsCache();
});

describe('the Calendar day list, from a two-part week ahead with long preps', () => {
  it("gives each meeting today's prep note by start time: cut to fit, never the day before's", async () => {
    listed.mockResolvedValue(
      ok([
        meeting('evt-northwind', 'Northwind check-in', '2026-10-21T16:00:00Z'),
        // The week-ahead's meeting here was of an unknown kind: left out, so no note.
        meeting('evt-offsite', 'Team offsite planning', '2026-10-21T19:30:00Z'),
        // From the run's second part.
        meeting('evt-coinvest', 'Co-investor sync', '2026-10-21T20:00:00Z'),
      ]),
    );
    const day = await readCalendarDay(harness.store, harness.auth.organizationId, {
      dateKey: '2026-10-21',
      timeZone: TZ,
      ownEmail: harness.auth.profile.email,
      now: NOW,
    });
    expect(day.state).toBe('ok');
    const prep = Object.fromEntries(day.entries.map((e) => [e.event.id, e.prep]));
    expect(Object.keys(prep)).toEqual(['evt-northwind', 'evt-offsite', 'evt-coinvest']);

    for (const id of ['evt-northwind', 'evt-coinvest']) {
      const note = prep[id];
      expect(typeof note, id).toBe('string');
      expect(note!.length, id).toBeLessThanOrEqual(240);
      expect(note!.endsWith('…'), id).toBe(true);
      expect(note, id).toMatch(/^Ask how the Northwind pilot/);
    }
    expect(prep['evt-northwind']).not.toBe('The copy from the day before.');
    expect(prep['evt-offsite']).toBeNull();
  });
});
