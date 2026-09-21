import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { resetEnvCache } from '@/lib/config/env';
import { ask } from '@/lib/services/chat';
import {
  fireAskRoutine,
  fireText,
  parseAnswerMessage,
  resetSettleThrottle,
  settleAnswersFromSlack,
} from '@/lib/services/ask-routine';

/**
 * The event-driven half of the Ask bridge. The properties worth pinning: a new
 * question fires the routine with a body the routine can parse; a failing or
 * unconfigured trigger never breaks asking; and an answer the routine posted to
 * the Slack relay channel completes exactly the pending message it names.
 */

const SAVED = { ...process.env };
let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
  process.env.ASK_BRIDGE_TOKEN = 'ask-bridge-token-for-tests-0000000000';
  process.env.ASK_ROUTINE_FIRE_URL =
    'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
  process.env.ASK_ROUTINE_TOKEN = 'routine-token-for-tests';
  process.env.ASK_RELAY_SLACK_TOKEN = 'xoxb-test-read-only';
  resetEnvCache();
  resetSettleThrottle();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await harness.dispose();
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

const QUESTION = {
  message_id: '11111111-1111-4111-8111-111111111111',
  thread_id: '22222222-2222-4222-8222-222222222222',
  deal_id: null,
  question: 'What needs my attention today?',
  created_at: '2026-09-21T15:00:00.000Z',
};

function slackHistory(...texts: string[]) {
  return {
    ok: true,
    json: async () => ({ ok: true, messages: texts.map((text) => ({ text })) }),
  } as unknown as Response;
}

describe('fireAskRoutine', () => {
  it('posts the question in the relay format with bearer auth', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    const fired = await fireAskRoutine(QUESTION, fetchMock as unknown as typeof fetch);

    expect(fired).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(process.env.ASK_ROUTINE_FIRE_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer routine-token-for-tests',
    );
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text.startsWith('ASK_QUESTION_V1\n`')).toBe(true);
    expect(body.text).toContain(QUESTION.message_id);
    expect(body.text).toContain('What needs my attention today?');
  });

  it('reports failure, without throwing, on a refusal or a network error', async () => {
    const refused = vi.fn(async () => ({ ok: false, status: 403 }) as Response);
    await expect(fireAskRoutine(QUESTION, refused as unknown as typeof fetch)).resolves.toBe(false);

    const broken = vi.fn(async () => {
      throw new Error('connection reset');
    });
    await expect(fireAskRoutine(QUESTION, broken as unknown as typeof fetch)).resolves.toBe(false);
  });

  it('does nothing when the trigger is not configured', async () => {
    delete process.env.ASK_ROUTINE_TOKEN;
    resetEnvCache();
    const fetchMock = vi.fn();
    await expect(fireAskRoutine(QUESTION, fetchMock as unknown as typeof fetch)).resolves.toBe(
      false,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('asking a question', () => {
  it('fires the routine once, for the new pending message', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await ask(harness.auth, 'Did anything urgent come in overnight?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const { text } = JSON.parse(init.body as string) as { text: string };
    expect(text).toContain(result.value.assistantMessage.id);
    expect(text).toContain('Did anything urgent come in overnight?');
  });

  it('still saves the question when the trigger fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const result = await ask(harness.auth, 'Anything from the portfolio?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assistantMessage.status).toBe('pending');
  });
});

describe('parseAnswerMessage', () => {
  it('reads the two-line convention, including Slack entity escaping', () => {
    expect(
      parseAnswerMessage(
        'ASK_ANSWER_V1\n`{"message_id":"abc","answer":"Tom &amp; Jerry &gt; all"}`',
      ),
    ).toEqual({ message_id: 'abc', answer: 'Tom & Jerry > all' });
  });

  it('ignores everything that is not a well-formed answer', () => {
    expect(parseAnswerMessage('hello')).toBeNull();
    expect(parseAnswerMessage('ASK_QUESTION_V1\n`{"message_id":"a","answer":"b"}`')).toBeNull();
    expect(parseAnswerMessage('ASK_ANSWER_V1\n`not json`')).toBeNull();
    expect(parseAnswerMessage('ASK_ANSWER_V1\n`{"message_id":"a","answer":"  "}`')).toBeNull();
    expect(parseAnswerMessage('ASK_ANSWER_V1\n`{"answer":"no id"}`')).toBeNull();
    expect(parseAnswerMessage(undefined)).toBeNull();
  });

  it('round-trips the text the routine is told to write', () => {
    expect(fireText(QUESTION)).toContain('"message_id"');
  });
});

describe('settleAnswersFromSlack', () => {
  async function askOne(question: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const asked = await ask(harness.auth, question);
    if (!asked.ok) throw new Error('ask failed');
    vi.unstubAllGlobals();
    return asked.value;
  }

  async function statusOf(threadId: string, messageId: string) {
    const rows = (await harness.store.list('chat_messages', harness.auth.organizationId, {
      eq: { thread_id: threadId },
    })) as Array<{ id: string; status: string; content: string }>;
    return rows.find((r) => r.id === messageId);
  }

  it('completes the pending message a Slack answer names', async () => {
    const asked = await askOne('What changed since yesterday?');
    const id = asked.assistantMessage.id;
    const fetchMock = vi.fn(async () =>
      slackHistory(
        'some human chatter',
        `ASK_ANSWER_V1\n\`${JSON.stringify({ message_id: id, answer: 'Nothing urgent.' })}\``,
      ),
    );

    const settled = await settleAnswersFromSlack(
      harness.store,
      harness.auth.organizationId,
      fetchMock as unknown as typeof fetch,
    );

    expect(settled).toBe(1);
    const row = await statusOf(asked.thread.id, id);
    expect(row?.status).toBe('answered');
    expect(row?.content).toBe('Nothing urgent.');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('conversations.history');
    expect(url).toContain('C0C3JPW6PTJ');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer xoxb-test-read-only',
    );
  });

  it('leaves the message pending when the answer names a different one', async () => {
    const asked = await askOne('Any deals worth a look?');
    const fetchMock = vi.fn(async () =>
      slackHistory(
        `ASK_ANSWER_V1\n\`${JSON.stringify({ message_id: '99999999-9999-4999-8999-999999999999', answer: 'Not this one.' })}\``,
      ),
    );
    const settled = await settleAnswersFromSlack(
      harness.store,
      harness.auth.organizationId,
      fetchMock as unknown as typeof fetch,
    );
    expect(settled).toBe(0);
    expect((await statusOf(asked.thread.id, asked.assistantMessage.id))?.status).toBe('pending');
  });

  it('does not call Slack at all when nothing is waiting', async () => {
    const fetchMock = vi.fn();
    const settled = await settleAnswersFromSlack(
      harness.store,
      harness.auth.organizationId,
      fetchMock as unknown as typeof fetch,
    );
    expect(settled).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('survives Slack refusing the read', async () => {
    await askOne('Anything else?');
    const fetchMock = vi.fn(
      async () =>
        ({ ok: true, json: async () => ({ ok: false, error: 'channel_not_found' }) }) as Response,
    );
    await expect(
      settleAnswersFromSlack(
        harness.store,
        harness.auth.organizationId,
        fetchMock as unknown as typeof fetch,
      ),
    ).resolves.toBe(0);
  });

  it('is throttled, so a fast-polling page does not hammer Slack', async () => {
    await askOne('One more?');
    const fetchMock = vi.fn(async () => slackHistory('nothing here'));
    const run = () =>
      settleAnswersFromSlack(
        harness.store,
        harness.auth.organizationId,
        fetchMock as unknown as typeof fetch,
      );
    await run();
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a Slack token', async () => {
    delete process.env.ASK_RELAY_SLACK_TOKEN;
    resetEnvCache();
    const fetchMock = vi.fn();
    await expect(
      settleAnswersFromSlack(
        harness.store,
        harness.auth.organizationId,
        fetchMock as unknown as typeof fetch,
      ),
    ).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
