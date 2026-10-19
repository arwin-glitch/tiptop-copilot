import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/lib/auth/session';
import { resetEnvCache } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { resetSettleThrottle } from '@/lib/services/ask-routine';
import {
  authenticateDesktopToken,
  desktopAlertsFor,
  recordDesktopDelivery,
  registerDesktopDevice,
  type DesktopAlert,
  type DesktopCaller,
} from '@/lib/services/desktop-alerts';
import type { ChatMessage, ChatThread, UserProfile } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Ask Arwin answers as desktop alerts (desktop 0.4.1, D-058), on the demo
 * store: only the asker's own computers, once per answer, nothing from before
 * a computer was turned on or older than ten minutes, any hour of the day,
 * the 30-second cadence while a question waits (night included), and an
 * answer settled from the Slack relay in the same ask. Chat rows are written
 * directly, with chosen times, since `ask()` runs on the real clock. All data
 * is fictional.
 */

// 15:00 UTC = 10:00 in Chicago (daylight time), the demo owner's timezone.
const NOON_ISH = new Date('2026-10-07T15:00:00Z');
const NIGHT = new Date('2026-10-08T04:00:00Z'); // 23:00 Chicago
const EVENING = new Date('2026-10-08T01:30:00Z'); // 20:30 Chicago
const MIN = 60_000;
const after = (base: Date, ms: number) => new Date(base.getTime() + ms);

const DEVICE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_DEVICE = '0123456789abcdef0123456789abcdef';
const THREAD = '00000000-0000-4000-8000-00000000a001';
const THREAD_2 = '00000000-0000-4000-8000-00000000a002';
const ANSWER_ID = '00000000-0000-4000-8000-00000000b001';
const ANSWER_ID_2 = '00000000-0000-4000-8000-00000000b002';
const ANSWER = '**Yes.** Fictional Capital leads the round [1].\n\nThe rest is support.';
const PREVIEW = 'Yes. Fictional Capital leads the round.';
const ASK = { askReplies: true };

let harness: Harness;
let store: DataStore;
let auth: AuthContext;

beforeEach(async () => {
  harness = await createHarness({ now: NOON_ISH });
  store = harness.store;
  auth = harness.auth;
});

afterEach(async () => {
  await harness.dispose();
});

async function turnOn(
  who: AuthContext = auth,
  id: string = DEVICE,
  now: Date = NOON_ISH,
): Promise<DesktopCaller> {
  const result = await registerDesktopDevice(
    store,
    who,
    { device: id, platform: 'windows', version: '0.4.1' },
    now,
  );
  if (!result.ok) throw new Error(result.error.message);
  const caller = await authenticateDesktopToken(store, result.value.token);
  if (!caller.ok) throw new Error(caller.error.message);
  return caller.value;
}

/** A colleague in the demo organization. */
async function colleague(): Promise<AuthContext> {
  const userId = '00000000-0000-4000-8000-0000000c0b01';
  const at = NOON_ISH.toISOString();
  const profile: UserProfile = {
    id: userId,
    email: 'member1@fund.example',
    full_name: 'Test member',
    avatar_url: null,
    timezone: 'America/Chicago',
    theme: 'system',
    created_at: at,
    updated_at: at,
  };
  await store.upsertUserProfile(profile);
  await store.insert('organization_members', {
    id: 'member-member-1',
    organization_id: auth.organizationId,
    user_id: userId,
    role: 'member',
    created_at: at,
  });
  return { ...auth, userId, role: 'member', profile };
}

function chatMessage(
  threadId: string,
  id: string,
  role: 'user' | 'assistant',
  content: string,
  createdAt: Date,
  status: 'answered' | 'pending' = 'answered',
): ChatMessage {
  return {
    id,
    organization_id: auth.organizationId,
    thread_id: threadId,
    role,
    content,
    citations: [],
    tool_calls: [],
    model: null,
    prompt_version: null,
    status,
    created_at: createdAt.toISOString(),
  };
}

/**
 * A question and its answer as the Ask bridge leaves them: the answer row a
 * millisecond after the question, pending until answered, and the thread
 * touched when it was answered (or asked).
 */
async function asked(
  who: AuthContext,
  options: {
    threadId?: string;
    answerId?: string;
    askedAt: Date;
    answeredAt: Date | null;
    answer?: string;
    question?: string;
  },
): Promise<void> {
  const threadId = options.threadId ?? THREAD;
  const answerId = options.answerId ?? ANSWER_ID;
  const thread: ChatThread = {
    id: threadId,
    organization_id: who.organizationId,
    user_id: who.userId,
    title: 'Who leads the Example Robotics round?',
    deal_id: null,
    created_at: options.askedAt.toISOString(),
    updated_at: (options.answeredAt ?? options.askedAt).toISOString(),
  };
  await store.insert('chat_threads', thread);
  await store.insert(
    'chat_messages',
    chatMessage(
      threadId,
      // The question's id: the answer's, with c for b.
      answerId.replace(/b(\d{3})$/, 'c$1'),
      'user',
      options.question ?? 'Who leads the Example Robotics round?',
      options.askedAt,
    ),
  );
  await store.insert(
    'chat_messages',
    chatMessage(
      threadId,
      answerId,
      'assistant',
      options.answeredAt ? (options.answer ?? ANSWER) : '',
      after(options.askedAt, 1),
      options.answeredAt ? 'answered' : 'pending',
    ),
  );
}

/** The pending answer lands, as answerBridgeQuestion writes it. */
async function answer(at: Date, threadId = THREAD, answerId = ANSWER_ID): Promise<void> {
  await store.update('chat_messages', auth.organizationId, answerId, {
    content: ANSWER,
    status: 'answered',
  });
  await store.update('chat_threads', auth.organizationId, threadId, {
    updated_at: at.toISOString(),
  });
}

function askAlerts(alerts: DesktopAlert[]): DesktopAlert[] {
  return alerts.filter((a) => a.keys.some((k) => k.startsWith('ask:')));
}

describe('an answer to your own question', () => {
  it('pings your computer once, quiet while you look, after meetings and before the rest', async () => {
    const me = await turnOn();
    await asked(auth, { askedAt: after(NOON_ISH, MIN), answeredAt: after(NOON_ISH, 2 * MIN) });
    const due = await desktopAlertsFor(store, me, after(NOON_ISH, 3 * MIN), ASK);
    expect(askAlerts(due.alerts)).toEqual([
      {
        keys: [`ask:${ANSWER_ID}`],
        title: 'Arwin replied',
        body: PREVIEW,
        url: `/ask?thread=${THREAD}`,
        urgent: false,
        quietWhenFocused: true,
      },
    ]);
    const at = due.alerts.findIndex((a) => a.keys[0]?.startsWith('ask:'));
    expect(due.alerts.slice(0, at).every((a) => a.urgent)).toBe(true);
    expect(due.alerts.slice(at + 1).some((a) => a.urgent)).toBe(false);
    expect(due.alerts.filter((a) => a !== due.alerts[at]).every((a) => !a.quietWhenFocused)).toBe(
      true,
    );

    // The 'ask' kind is ledgered like any other, so it never comes back.
    expect(
      await recordDesktopDelivery(
        store,
        auth.organizationId,
        DEVICE,
        [`ask:${ANSWER_ID}`],
        after(NOON_ISH, 3 * MIN),
      ),
    ).toEqual({ recorded: 1 });
    const again = await desktopAlertsFor(store, me, after(NOON_ISH, 3.5 * MIN), ASK);
    expect(askAlerts(again.alerts)).toEqual([]);
  });

  it("goes to the asker's computers only: never a colleague's, never the owner's", async () => {
    const me = await turnOn();
    const member = await colleague();
    const theirs = await turnOn(member, OTHER_DEVICE);
    await asked(member, { askedAt: after(NOON_ISH, MIN), answeredAt: after(NOON_ISH, 2 * MIN) });
    const now = after(NOON_ISH, 3 * MIN);
    expect(askAlerts((await desktopAlertsFor(store, me, now, ASK)).alerts)).toEqual([]);
    expect(askAlerts((await desktopAlertsFor(store, theirs, now, ASK)).alerts)).toMatchObject([
      { keys: [`ask:${ANSWER_ID}`], title: 'Arwin replied' },
    ]);
  });

  it('never replays: nothing from before the computer was turned on, or over ten minutes old', async () => {
    const me = await turnOn();
    await asked(auth, { askedAt: after(NOON_ISH, -3 * MIN), answeredAt: after(NOON_ISH, -MIN) });
    expect(
      askAlerts((await desktopAlertsFor(store, me, after(NOON_ISH, MIN), ASK)).alerts),
    ).toEqual([]);
    await asked(auth, {
      threadId: THREAD_2,
      answerId: ANSWER_ID_2,
      askedAt: after(NOON_ISH, MIN),
      answeredAt: after(NOON_ISH, 2 * MIN),
    });
    expect(
      askAlerts((await desktopAlertsFor(store, me, after(NOON_ISH, 13 * MIN), ASK)).alerts),
    ).toEqual([]);
  });

  it('never an old answer in a thread touched just now', async () => {
    const me = await turnOn(auth, DEVICE, after(NOON_ISH, -4 * 24 * 60 * MIN));
    const threeDaysAgo = after(NOON_ISH, -3 * 24 * 60 * MIN);
    await asked(auth, { askedAt: threeDaysAgo, answeredAt: threeDaysAgo });
    // A deal deleted from under the thread, say, bumps its updated_at.
    await store.update('chat_threads', auth.organizationId, THREAD, {
      updated_at: NOON_ISH.toISOString(),
    });
    expect(askAlerts((await desktopAlertsFor(store, me, NOON_ISH, ASK)).alerts)).toEqual([]);
  });

  it('several answers together are one notification, opening the newest', async () => {
    const me = await turnOn();
    await asked(auth, { askedAt: after(NOON_ISH, MIN), answeredAt: after(NOON_ISH, 2 * MIN) });
    await asked(auth, {
      threadId: THREAD_2,
      answerId: ANSWER_ID_2,
      askedAt: after(NOON_ISH, MIN),
      answeredAt: after(NOON_ISH, 3 * MIN),
      answer: 'No. The round closes next week.',
    });
    const due = await desktopAlertsFor(store, me, after(NOON_ISH, 4 * MIN), ASK);
    expect(askAlerts(due.alerts)).toEqual([
      {
        keys: [`ask:${ANSWER_ID}`, `ask:${ANSWER_ID_2}`],
        title: 'Arwin replied to 2 questions',
        body: 'No. The round closes next week.',
        url: `/ask?thread=${THREAD_2}`,
        urgent: false,
        quietWhenFocused: true,
      },
    ]);
  });

  it('comes in the evening, when otherwise only meetings do', async () => {
    const me = await turnOn();
    await asked(auth, { askedAt: after(EVENING, -2 * MIN), answeredAt: after(EVENING, -MIN) });
    const evening = await desktopAlertsFor(store, me, EVENING, ASK);
    expect(askAlerts(evening.alerts)).toHaveLength(1);
    expect(evening.alerts.filter((a) => !a.quietWhenFocused).every((a) => a.urgent)).toBe(true);
  });
});

describe('while your question waits', () => {
  it('the computer asks again in 30 seconds by day', async () => {
    const me = await turnOn();
    await asked(auth, { askedAt: after(NOON_ISH, MIN), answeredAt: null });
    const due = await desktopAlertsFor(store, me, after(NOON_ISH, 2 * MIN), ASK);
    expect(due.pollAfterSeconds).toBe(30);
    expect(askAlerts(due.alerts)).toEqual([]);
  });

  it('and at night, then pings when the answer lands, and sleeps again', async () => {
    const me = await turnOn();
    await asked(auth, { askedAt: after(NIGHT, -2 * MIN), answeredAt: null });
    expect(await desktopAlertsFor(store, me, NIGHT, ASK)).toEqual({
      alerts: [],
      pollAfterSeconds: 30,
    });
    await answer(after(NIGHT, 20_000));
    const landed = await desktopAlertsFor(store, me, after(NIGHT, 30_000), ASK);
    expect(landed.alerts).toMatchObject([{ keys: [`ask:${ANSWER_ID}`], quietWhenFocused: true }]);
    expect(landed.pollAfterSeconds).toBe(7 * 3600 - 30);

    // Shown and acknowledged: at night the computer's own ledger keeps it
    // from coming again, should the app ask (another question waiting, say).
    expect(
      await recordDesktopDelivery(
        store,
        auth.organizationId,
        DEVICE,
        [`ask:${ANSWER_ID}`],
        after(NIGHT, 30_000),
      ),
    ).toEqual({ recorded: 1 });
    expect(await desktopAlertsFor(store, me, after(NIGHT, 60_000), ASK)).toEqual({
      alerts: [],
      pollAfterSeconds: 7 * 3600 - 60,
    });
  });

  it('not after half an hour: the usual cadence again', async () => {
    const me = await turnOn();
    await asked(auth, { askedAt: after(NOON_ISH, MIN), answeredAt: null });
    expect(
      (await desktopAlertsFor(store, me, after(NOON_ISH, 32 * MIN), ASK)).pollAfterSeconds,
    ).toBe(60);
    await asked(auth, {
      threadId: THREAD_2,
      answerId: ANSWER_ID_2,
      askedAt: after(NIGHT, -31 * MIN),
      answeredAt: null,
    });
    expect(await desktopAlertsFor(store, me, NIGHT, ASK)).toEqual({
      alerts: [],
      pollAfterSeconds: 7 * 3600,
    });
  });

  it('a colleague waiting does not hurry your computer', async () => {
    const me = await turnOn();
    await asked(await colleague(), { askedAt: after(NOON_ISH, MIN), answeredAt: null });
    expect(
      (await desktopAlertsFor(store, me, after(NOON_ISH, 2 * MIN), ASK)).pollAfterSeconds,
    ).toBe(60);
  });
});

describe('a shell before 0.4.1', () => {
  it('gets no Ask Arwin answers and no 30-second cadence, and that is the default', async () => {
    const me = await turnOn();
    await asked(auth, { askedAt: after(NOON_ISH, MIN), answeredAt: after(NOON_ISH, 2 * MIN) });
    await asked(auth, {
      threadId: THREAD_2,
      answerId: ANSWER_ID_2,
      askedAt: after(NOON_ISH, 2 * MIN),
      answeredAt: null,
    });
    const now = after(NOON_ISH, 3 * MIN);
    for (const due of [
      await desktopAlertsFor(store, me, now, { askReplies: false }),
      await desktopAlertsFor(store, me, now),
    ]) {
      expect(askAlerts(due.alerts)).toEqual([]);
      expect(due.alerts.every((a) => !a.quietWhenFocused)).toBe(true);
      expect(due.pollAfterSeconds).toBe(60);
    }
  });
});

describe('an answer waiting in the Slack relay', () => {
  const SAVED = { ...process.env };

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of Object.keys(process.env)) {
      if (!(key in SAVED)) delete process.env[key];
    }
    Object.assign(process.env, SAVED);
    resetEnvCache();
    resetSettleThrottle();
  });

  it('is settled and alerted in the same ask', async () => {
    process.env.ASK_RELAY_SLACK_TOKEN = 'xoxb-fictional-test-token';
    resetEnvCache();
    resetSettleThrottle();
    const relayed = `ASK_ANSWER_V1\n\`${JSON.stringify({ message_id: ANSWER_ID, answer: ANSWER })}\``;
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('conversations.history')
        ? ({
            ok: true,
            json: async () => ({ ok: true, messages: [{ text: relayed }] }),
          } as unknown as Response)
        : ({ ok: false, status: 404, json: async () => ({ ok: false }) } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Answering stamps the thread with the real clock, so this runs on it.
    const now = new Date();
    const me = await turnOn(auth, DEVICE, after(now, -5 * MIN));
    await asked(auth, { askedAt: after(now, -2 * MIN), answeredAt: null });
    const due = await desktopAlertsFor(store, me, now, ASK);
    expect(askAlerts(due.alerts)).toMatchObject([
      { keys: [`ask:${ANSWER_ID}`], title: 'Arwin replied', body: PREVIEW },
    ]);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('conversations.history')),
    ).toBe(true);
    const row = await store.get('chat_messages', auth.organizationId, ANSWER_ID);
    expect(row?.status).toBe('answered');
  });
});
