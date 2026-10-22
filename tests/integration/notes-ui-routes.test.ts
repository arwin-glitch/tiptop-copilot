import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/lib/auth/session';
import { resetEnvCache } from '@/lib/config/env';
import { resetLimiters } from '@/lib/security/limits';
import type {
  CreateMeetingResponse,
  ListMeetingsResponse,
  ListRecordingRulesResponse,
  RecordingRuleResponse,
} from '@/lib/types/notes';
import { ok, err } from '@/lib/util/result';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * What the Notes screens (D-076, WS2) add to the routes: the never-record
 * rules Settings edits (the team's own, then the read-only defaults; a rule
 * blocks the next meeting at once), and "Notes ready" on a calendar card
 * (the meetings list filtered by the event's id). Demo mode, fictional data.
 */

let harness: Harness;
let caller: AuthContext | null = null;

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  authOrError: async () => (caller ? ok(caller) : err('unauthenticated', 'Sign in.')),
}));

const rulesRoute = await import('@/app/api/notes/recording-rules/route');
const ruleRoute = await import('@/app/api/notes/recording-rules/[id]/route');
const meetingsRoute = await import('@/app/api/notes/meetings/route');
const startRoute = await import('@/app/api/notes/meetings/[id]/start/route');

const ORIGIN = 'http://localhost:3000';
const SAVED_FLAG = process.env.NOTES_ENABLED;

function req(path: string, method = 'GET', body?: unknown, origin = ORIGIN): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers: { origin, host: 'localhost:3000', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
async function json<T>(response: Response): Promise<T & { ok: boolean }> {
  return (await response.json()) as T & { ok: boolean };
}
function setFlag(value: string | undefined) {
  if (value === undefined) delete process.env.NOTES_ENABLED;
  else process.env.NOTES_ENABLED = value;
  resetEnvCache();
}

beforeEach(async () => {
  setFlag('on');
  harness = await createHarness({ now: new Date() });
  caller = harness.auth;
});

afterEach(async () => {
  await harness.dispose();
  resetLimiters();
});

afterAll(() => setFlag(SAVED_FLAG));

describe('never-record rules', () => {
  it('lists the built-in legal and family defaults, read only', async () => {
    const listed = await json<ListRecordingRulesResponse>(
      await rulesRoute.GET(req('/api/notes/recording-rules')),
    );
    expect(listed.ok).toBe(true);
    const defaults = listed.rules.filter((r) => r.isDefault);
    expect(defaults.map((r) => r.label)).toEqual(expect.arrayContaining(['legal', 'family']));
    const first = defaults[0]!;
    const patched = await ruleRoute.PATCH(
      req(`/api/notes/recording-rules/${first.id}`, 'PATCH', { enabled: false }),
      ctx({ id: first.id }),
    );
    expect(patched.status).toBe(403);
  });

  it('a domain rule blocks the next meeting with that guest, and can be turned off and deleted', async () => {
    const made = await json<RecordingRuleResponse>(
      await rulesRoute.POST(
        req('/api/notes/recording-rules', 'POST', {
          kind: 'attendee_domain',
          pattern: '@Sister-Co.example',
          label: 'sister company',
        }),
      ),
    );
    expect(made).toMatchObject({
      ok: true,
      rule: {
        kind: 'attendee_domain',
        pattern: 'sister-co.example',
        enabled: true,
        isDefault: false,
      },
    });

    const meeting = await json<CreateMeetingResponse>(
      await meetingsRoute.POST(
        req('/api/notes/meetings', 'POST', {
          source: 'adhoc',
          title: 'Quarterly catch-up',
          attendees: [{ email: 'casey@sister-co.example', name: 'Casey Lin' }],
        }),
      ),
    );
    expect(meeting.meeting.consent.neverRecord).toMatchObject({ label: 'sister company' });
    const start = await startRoute.POST(
      req(`/api/notes/meetings/${meeting.meeting.id}/start`, 'POST', {
        consent: { confirmed: true, method: 'verbal' },
        captureSource: 'web',
      }),
      ctx({ id: meeting.meeting.id }),
    );
    expect(start.status).toBe(403);

    // A duplicate is refused; switching it off lets the same meeting start.
    const twice = await rulesRoute.POST(
      req('/api/notes/recording-rules', 'POST', {
        kind: 'attendee_domain',
        pattern: 'sister-co.example',
        label: 'again',
      }),
    );
    expect(twice.status).toBe(409);
    const off = await json<RecordingRuleResponse>(
      await ruleRoute.PATCH(
        req(`/api/notes/recording-rules/${made.rule.id}`, 'PATCH', { enabled: false }),
        ctx({ id: made.rule.id }),
      ),
    );
    expect(off.rule.enabled).toBe(false);
    const started = await startRoute.POST(
      req(`/api/notes/meetings/${meeting.meeting.id}/start`, 'POST', {
        consent: { confirmed: true, method: 'verbal' },
        captureSource: 'web',
      }),
      ctx({ id: meeting.meeting.id }),
    );
    expect(started.status).toBe(200);

    const removed = await ruleRoute.DELETE(
      req(`/api/notes/recording-rules/${made.rule.id}`, 'DELETE'),
      ctx({ id: made.rule.id }),
    );
    expect(removed.status).toBe(200);
    const listed = await json<ListRecordingRulesResponse>(
      await rulesRoute.GET(req('/api/notes/recording-rules')),
    );
    expect(listed.rules.some((r) => r.id === made.rule.id)).toBe(false);
  });

  it('refuses a bad domain, a change from another site, and everything while Notes is off', async () => {
    const bad = await rulesRoute.POST(
      req('/api/notes/recording-rules', 'POST', {
        kind: 'attendee_domain',
        pattern: 'not a domain',
        label: 'x',
      }),
    );
    expect(bad.status).toBe(400);
    const foreign = await rulesRoute.POST(
      req(
        '/api/notes/recording-rules',
        'POST',
        { kind: 'title', pattern: 'board', label: 'x' },
        'https://elsewhere.example',
      ),
    );
    expect(foreign.status).toBe(403);
    setFlag(undefined);
    expect((await rulesRoute.GET(req('/api/notes/recording-rules'))).status).toBe(404);
  });
});

describe('Notes ready on a calendar card', () => {
  it('finds the meeting made for an event by its id, and only that one', async () => {
    const made = await json<CreateMeetingResponse>(
      await meetingsRoute.POST(
        req('/api/notes/meetings', 'POST', {
          source: 'calendar',
          providerEventId: 'evt-card-1',
          title: 'Pipeline review',
          attendees: [],
        }),
      ),
    );
    const found = await json<ListMeetingsResponse>(
      await meetingsRoute.GET(req('/api/notes/meetings?source=copilot&eventId=evt-card-1')),
    );
    expect(found.meetings.map((m) => m.meetingId)).toEqual([made.meeting.id]);
    const none = await json<ListMeetingsResponse>(
      await meetingsRoute.GET(req('/api/notes/meetings?source=copilot&eventId=evt-other')),
    );
    expect(none.meetings).toEqual([]);
    const bad = await meetingsRoute.GET(req('/api/notes/meetings?eventId=no%20spaces'));
    expect(bad.status).toBe(400);
  });
});
