import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/lib/auth/session';
import { env, resetEnvCache, type AppEnv } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import {
  authenticateDesktopToken,
  desktopAlertsFor,
  recordDesktopDelivery,
  registerDesktopDevice,
  type DesktopAlert,
  type DesktopCaller,
} from '@/lib/services/desktop-alerts';
import {
  buildFeedReport,
  feedNoticesOn,
  HEARTBEAT_ACTION,
  readAskWaiting,
  readFeedInputs,
  readJobHeartbeats,
  readNotesArrival,
  recordJobHeartbeat,
  recordJobHeartbeatForAll,
  resetFeedHealthState,
  setFeedNotices,
} from '@/lib/services/feed-health';
import type { ChatMessage, ChatThread, MeetingNote, UserProfile } from '@/lib/types/domain';
import { ok } from '@/lib/util/result';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';

/**
 * The feed watchdog on the demo store: feed notices reach only the computers
 * of whoever turned them on, once a day per feed and only 8am to 8pm; the
 * jobs' heartbeat rows; the Ask questions still waiting; the live read of the
 * relay channels through a fake Slack; and the route that turns notices on
 * and off. All data is fictional.
 */

let signedIn: AuthContext | null;
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  authOrError: async () =>
    signedIn
      ? ok(signedIn)
      : { ok: false, error: { code: 'unauthenticated', message: 'Sign in to continue.' } },
}));

const noticesRoute = await import('@/app/api/feeds/notices/route');

// 15:00 UTC = 10:00 on Wednesday Oct 21 in Chicago (daylight time).
const NOON_ISH = new Date('2026-10-21T15:00:00Z');
const MIN = 60_000;
const after = (base: Date, ms: number) => new Date(base.getTime() + ms);

const DEVICE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_DEVICE = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'https://copilot.example';

let harness: Harness;
let store: DataStore;
let auth: AuthContext;

beforeEach(async () => {
  harness = await createHarness({ now: NOON_ISH });
  store = harness.store;
  auth = harness.auth;
  signedIn = auth;
  resetFeedHealthState();
});

afterEach(async () => {
  await harness.dispose();
  resetFeedHealthState();
  resetEnvCache();
});

async function turnOn(who: AuthContext, id: string): Promise<DesktopCaller> {
  const result = await registerDesktopDevice(
    store,
    who,
    { device: id, platform: 'windows', version: '0.4.1' },
    NOON_ISH,
  );
  if (!result.ok) throw new Error(result.error.message);
  const caller = await authenticateDesktopToken(store, result.value.token);
  if (!caller.ok) throw new Error(caller.error.message);
  return caller.value;
}

/** A colleague in the demo organization. */
async function colleague(): Promise<AuthContext> {
  const userId = '00000000-0000-4000-8000-0000000f0e01';
  const at = NOON_ISH.toISOString();
  const profile: UserProfile = {
    id: userId,
    email: 'member2@fund.example',
    full_name: 'Test colleague',
    avatar_url: null,
    timezone: 'America/Chicago',
    theme: 'system',
    created_at: at,
    updated_at: at,
  };
  await store.upsertUserProfile(profile);
  await store.insert('organization_members', {
    id: 'member-feed-1',
    organization_id: auth.organizationId,
    user_id: userId,
    role: 'member',
    created_at: at,
  });
  return { ...auth, userId, role: 'member', profile };
}

const feedAlerts = (due: { alerts: DesktopAlert[] }) =>
  due.alerts.filter((a) => a.keys.some((k) => k.startsWith('feed:')));

describe('feed notices on desktop', () => {
  it('reach only the computers of whoever turned them on, once a day per feed', async () => {
    const mine = await turnOn(auth, DEVICE);
    const theirs = await turnOn(await colleague(), OTHER_DEVICE);

    // Off unless turned on: nobody's computer gets one.
    expect(feedAlerts(await desktopAlertsFor(store, mine, NOON_ISH))).toEqual([]);
    expect(await feedNoticesOn(store, auth.organizationId, auth.userId)).toBe(false);

    await setFeedNotices(store, auth, true, NOON_ISH);
    expect(await feedNoticesOn(store, auth.organizationId, auth.userId)).toBe(true);
    const first = feedAlerts(await desktopAlertsFor(store, mine, NOON_ISH));
    expect(first).toEqual([
      {
        keys: ['feed:task-closer:2026-10-21'],
        title: 'A feed looks stopped',
        body: 'Task closer: last seen 3 days ago',
        url: '/diagnostics?tab=feeds',
        urgent: false,
        quietWhenFocused: false,
      },
    ]);
    // The colleague did not turn them on, so their computer stays quiet.
    expect(feedAlerts(await desktopAlertsFor(store, theirs, NOON_ISH))).toEqual([]);

    // Shown once: the ledger takes the key and it does not come back today.
    expect(
      await recordDesktopDelivery(store, auth.organizationId, DEVICE, first[0]!.keys, NOON_ISH),
    ).toEqual({ recorded: 1 });
    expect(feedAlerts(await desktopAlertsFor(store, mine, after(NOON_ISH, 30 * MIN)))).toEqual([]);

    // The next day, still stopped, it notices once more.
    const tomorrow = new Date('2026-10-22T15:00:00Z');
    expect(feedAlerts(await desktopAlertsFor(store, mine, tomorrow)).map((a) => a.keys)).toEqual([
      ['feed:task-closer:2026-10-22'],
    ]);
  });

  it('stay quiet outside 8am to 8pm, even while the computer still asks', async () => {
    const mine = await turnOn(auth, DEVICE);
    await setFeedNotices(store, auth, true, NOON_ISH);
    const early = new Date('2026-10-21T11:30:00Z'); // 6:30am Chicago
    const evening = new Date('2026-10-22T01:30:00Z'); // 8:30pm Chicago
    expect(feedAlerts(await desktopAlertsFor(store, mine, early))).toEqual([]);
    expect(feedAlerts(await desktopAlertsFor(store, mine, evening))).toEqual([]);
  });

  it('stop the moment they are turned off', async () => {
    const mine = await turnOn(auth, DEVICE);
    await setFeedNotices(store, auth, true, NOON_ISH);
    expect(feedAlerts(await desktopAlertsFor(store, mine, NOON_ISH))).toHaveLength(1);
    await setFeedNotices(store, auth, false, NOON_ISH);
    expect(await feedNoticesOn(store, auth.organizationId, auth.userId)).toBe(false);
    expect(feedAlerts(await desktopAlertsFor(store, mine, after(NOON_ISH, MIN)))).toEqual([]);
  });
});

describe('job heartbeats', () => {
  it('keep one row per job, the sender rewritten at most every ten minutes', async () => {
    const org = auth.organizationId;
    expect(await readJobHeartbeats(store, org)).toEqual({});
    await recordJobHeartbeat(store, org, 'push-sender', NOON_ISH);
    await recordJobHeartbeat(store, org, 'push-sender', after(NOON_ISH, 5 * MIN));
    expect((await readJobHeartbeats(store, org))['push-sender']).toBe(NOON_ISH.toISOString());
    await recordJobHeartbeat(store, org, 'push-sender', after(NOON_ISH, 11 * MIN));
    expect((await readJobHeartbeats(store, org))['push-sender']).toBe(
      after(NOON_ISH, 11 * MIN).toISOString(),
    );

    // The daily job notes every run.
    await recordJobHeartbeat(store, org, 'daily-job', NOON_ISH);
    await recordJobHeartbeat(store, org, 'daily-job', after(NOON_ISH, MIN));
    expect((await readJobHeartbeats(store, org))['daily-job']).toBe(
      after(NOON_ISH, MIN).toISOString(),
    );
    expect(await store.count('audit_events', org, { eq: { action: HEARTBEAT_ACTION } })).toBe(2);
  });

  it('are noted for every organization by a job that serves them all', async () => {
    const other = await addSecondOrganization(harness);
    await recordJobHeartbeatForAll(store, 'push-sender', NOON_ISH);
    expect((await readJobHeartbeats(store, auth.organizationId))['push-sender']).toBeDefined();
    expect((await readJobHeartbeats(store, other.organizationId))['push-sender']).toBeDefined();
  });
});

function message(
  id: string,
  threadId: string,
  role: 'user' | 'assistant',
  createdAt: Date,
  status: 'pending' | 'answered',
  model: string | null = null,
): ChatMessage {
  return {
    id,
    organization_id: auth.organizationId,
    thread_id: threadId,
    role,
    content: status === 'answered' ? 'A fictional answer.' : '',
    citations: [],
    tool_calls: [],
    model,
    prompt_version: null,
    status,
    created_at: createdAt.toISOString(),
  };
}

async function thread(id: string, at: Date): Promise<void> {
  const row: ChatThread = {
    id,
    organization_id: auth.organizationId,
    user_id: auth.userId,
    title: 'Who leads the Example Robotics round?',
    deal_id: null,
    created_at: at.toISOString(),
    updated_at: at.toISOString(),
  };
  await store.insert('chat_threads', row);
}

describe('Ask questions still waiting', () => {
  const T1 = '00000000-0000-4000-8000-00000000f001';
  const T2 = '00000000-0000-4000-8000-00000000f002';

  it('date from the oldest unanswered question after the newest answer', async () => {
    const org = auth.organizationId;
    expect(await readAskWaiting(store, org, NOON_ISH)).toEqual({ waitingSince: null });

    // A question left behind an hour before one that was answered: a one-off.
    await thread(T1, after(NOON_ISH, -90 * MIN));
    await store.insert(
      'chat_messages',
      message(
        '00000000-0000-4000-8000-00000000e001',
        T1,
        'assistant',
        after(NOON_ISH, -90 * MIN),
        'pending',
      ),
    );
    await thread(T2, after(NOON_ISH, -30 * MIN));
    await store.insert(
      'chat_messages',
      message(
        '00000000-0000-4000-8000-00000000e002',
        T2,
        'assistant',
        after(NOON_ISH, -30 * MIN),
        'answered',
        'claude-code-ask-bridge',
      ),
    );
    expect(await readAskWaiting(store, org, NOON_ISH)).toEqual({ waitingSince: null });

    // A question after the last answer is waiting.
    const asked = after(NOON_ISH, -20 * MIN);
    await store.insert(
      'chat_messages',
      message('00000000-0000-4000-8000-00000000e003', T2, 'assistant', asked, 'pending'),
    );
    expect(await readAskWaiting(store, org, NOON_ISH)).toEqual({
      waitingSince: asked.toISOString(),
    });
  });
});

describe('reading a live deployment', () => {
  const ROUTINE = 'U0ROUTINE1';
  const TICK = String.fromCharCode(96);
  const slackTs = (at: Date) => `${(at.getTime() / 1000).toFixed(0)}.000100`;
  const relay = (marker: string, body: unknown, at: Date) => ({
    ts: slackTs(at),
    user: ROUTINE,
    text: `${marker}\n${TICK}${JSON.stringify(body)}${TICK}`,
  });

  function liveEnv(): AppEnv {
    return {
      ...env(),
      demoMode: false,
      askRelaySlackToken: 'xoxb-test',
      dealRelayPosterIds: [],
      taskRelayPosterIds: [ROUTINE],
    };
  }

  /** conversations.history, one page per channel, newest first. */
  function fakeSlack(byChannel: Record<string, unknown>) {
    return (async (input: RequestInfo | URL) => {
      const channel = new URL(String(input)).searchParams.get('channel') ?? '';
      const body = byChannel[channel] ?? { ok: true, messages: [] };
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
  }

  it('reads each relay channel as its cards read it', async () => {
    const e = liveEnv();
    const fetchImpl = fakeSlack({
      [e.dealRelayChannelId]: {
        ok: true,
        messages: [
          relay(
            'PRIORITIES_V1',
            { run_at: after(NOON_ISH, -4 * 60 * MIN).toISOString(), source: 'morning', items: [] },
            after(NOON_ISH, -4 * 60 * MIN),
          ),
          relay(
            'TASK_CLOSER_RUN_V1',
            { source: 'task-closer', checked: 3, closed: 1 },
            after(NOON_ISH, -40 * 60 * MIN),
          ),
        ],
      },
      [e.askRelayChannelId]: {
        ok: true,
        messages: [
          relay(
            'BRIEFING_PAYLOAD_V1',
            {
              kind: 'morning',
              date_key: '2026-10-21',
              title: 'Example brief',
              summary: 'Two fictional items.',
            },
            after(NOON_ISH, -4 * 60 * MIN),
          ),
        ],
      },
    });
    await recordJobHeartbeat(store, auth.organizationId, 'daily-job', after(NOON_ISH, -60 * MIN));

    const inputs = await readFeedInputs(store, auth.organizationId, {
      now: NOON_ISH,
      fetchImpl,
      e,
    });
    const rows = buildFeedReport(inputs, NOON_ISH, 'America/Chicago').rows;
    const status = (id: string) => rows.find((r) => r.id === id)?.status;
    expect(status('priorities')).toBe('ok');
    expect(status('task-closer')).toBe('late');
    expect(status('overview')).toBe('ok');
    expect(status('recap')).toBe('never');
    expect(status('daily-job')).toBe('ok');
    expect(status('push-sender')).toBe('never');
    expect(status('ask-answers')).toBe('never');
  });

  it("says it can't check, never stopped, when Slack refuses", async () => {
    const e = liveEnv();
    const refused = { ok: false, error: 'not_in_channel' };
    const fetchImpl = fakeSlack({
      [e.dealRelayChannelId]: refused,
      [e.askRelayChannelId]: refused,
    });
    const inputs = await readFeedInputs(store, auth.organizationId, {
      now: NOON_ISH,
      fetchImpl,
      e,
    });
    const rows = buildFeedReport(inputs, NOON_ISH, 'America/Chicago').rows;
    const priorities = rows.find((r) => r.id === 'priorities');
    expect(priorities).toMatchObject({
      status: 'unknown',
      reason: 'The Copilot Slack app is not a member of the relay channel.',
    });
    expect(rows.filter((r) => r.def.source !== 'job' && r.status === 'stopped')).toEqual([]);
  });

  it('reads when a meeting note last arrived from the notes themselves', async () => {
    const e = { ...liveEnv(), askRelaySlackToken: undefined };
    const arrived = after(NOON_ISH, -30 * MIN).toISOString();
    const note: MeetingNote = {
      id: '00000000-0000-4000-8000-00000000feed',
      organization_id: auth.organizationId,
      provider: 'granola',
      external_id: 'note-feed-example-1',
      title: 'Example intro call',
      occurred_at: after(NOON_ISH, -90 * MIN).toISOString(),
      attendees: [{ name: 'Avery Example', email: 'avery@northwind.example' }],
      content: 'Fictional notes.',
      source_url: null,
      injection_flagged: false,
      created_at: after(NOON_ISH, -24 * 60 * MIN).toISOString(),
      // Redelivered with newer content since: that is the newest arrival.
      updated_at: arrived,
    };
    await store.insert('meeting_notes', note);
    expect(await readNotesArrival(store, auth.organizationId)).toBe(arrived);

    const inputs = await readFeedInputs(store, auth.organizationId, { now: NOON_ISH, e });
    expect(inputs.notes?.lastAt).toBe(arrived);
    const rows = buildFeedReport(inputs, NOON_ISH, 'America/Chicago').rows;
    expect(rows.find((r) => r.id === 'meeting-notes')).toMatchObject({
      status: 'ok',
      lastSeen: arrived,
    });
  });

  it('is off without a Slack token', async () => {
    const e = { ...liveEnv(), askRelaySlackToken: undefined };
    const inputs = await readFeedInputs(store, auth.organizationId, { now: NOON_ISH, e });
    expect(inputs.dealRelay.state).toBe('off');
    expect(inputs.askRelay.state).toBe('off');
    const rows = buildFeedReport(inputs, NOON_ISH, 'America/Chicago').rows;
    expect(rows.find((r) => r.id === 'ask-answers')?.status).toBe('off');
  });
});

describe('the notices route', () => {
  function post(body: unknown, origin = ORIGIN) {
    return new NextRequest(`${ORIGIN}/api/feeds/notices`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('turns notices on and off for the signed-in person only', async () => {
    const on = await noticesRoute.POST(post({ on: true }));
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ ok: true, on: true });
    expect(await feedNoticesOn(store, auth.organizationId, auth.userId)).toBe(true);
    const member = await colleague();
    expect(await feedNoticesOn(store, auth.organizationId, member.userId)).toBe(false);

    const off = await noticesRoute.POST(post({ on: false }));
    expect(off.status).toBe(200);
    expect(await feedNoticesOn(store, auth.organizationId, auth.userId)).toBe(false);
  });

  it('refuses another site, a bad body and a signed-out caller', async () => {
    expect((await noticesRoute.POST(post({ on: true }, 'https://elsewhere.example'))).status).toBe(
      403,
    );
    expect((await noticesRoute.POST(post({ on: 'yes' }))).status).toBe(400);
    signedIn = null;
    expect((await noticesRoute.POST(post({ on: true }))).status).toBe(401);
    expect(await feedNoticesOn(store, auth.organizationId, auth.userId)).toBe(false);
  });
});
