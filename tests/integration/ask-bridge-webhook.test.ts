import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { createHarness, type Harness } from '../helpers/harness';
import { resetEnvCache } from '@/lib/config/env';
import { GET, POST } from '@/app/api/integrations/ask-bridge/webhook/route';
import { ask } from '@/lib/services/chat';

/**
 * The Ask bridge: `ask()` routes a question to a pending `chat_messages` row
 * whenever ASK_BRIDGE_TOKEN is set, instead of calling the in-app Anthropic
 * provider. This webhook is the other half — an external Claude session
 * lists pending questions, then delivers an answer for one.
 *
 * The properties worth pinning: a pending question's text is the prior user
 * message, not something denormalized separately; answering flips status and
 * fills content without touching anything else; a bad token or a message
 * that is already answered are both refused/skipped rather than silently
 * accepted; and a normal (non-bridge) `ask()` call is unaffected when the
 * token is unset.
 */

const TOKEN = 'ask-bridge-token-for-tests-0000000000';

let harness: Harness;
const SAVED = { ...process.env };

beforeEach(async () => {
  harness = await createHarness();
  process.env.ASK_BRIDGE_TOKEN = TOKEN;
  resetEnvCache();
});

afterEach(async () => {
  await harness.dispose();
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

function get(token: string) {
  return new NextRequest(
    `https://tiptop-copilot.onrender.com/api/integrations/ask-bridge/webhook?token=${encodeURIComponent(token)}`,
  );
}

function post(token: string, body?: unknown) {
  return new NextRequest(
    `https://tiptop-copilot.onrender.com/api/integrations/ask-bridge/webhook?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

describe('authentication', () => {
  it('refuses a token that does not match, on both GET and POST', async () => {
    const getResponse = await GET(get('wrong-token'));
    expect(getResponse.status).toBe(401);

    const postResponse = await POST(post('wrong-token', { message_id: 'x', answer: 'y' }));
    expect(postResponse.status).toBe(401);
  });

  it('says so, not "invalid token", when no token is configured', async () => {
    delete process.env.ASK_BRIDGE_TOKEN;
    resetEnvCache();
    const response = await GET(get('anything'));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'not_configured' } });
  });
});

describe('asking a question with the bridge configured', () => {
  it('creates a pending assistant row instead of calling the AI provider', async () => {
    const result = await ask(harness.auth, 'What needs my attention today?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.assistantMessage.status).toBe('pending');
    expect(result.value.assistantMessage.content).toBe('');
    expect(result.value.userMessage.status).toBe('answered');
  });

  it('lists the pending question with its real text via the webhook', async () => {
    const asked = await ask(harness.auth, 'Did anything urgent come in overnight?');
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;

    const response = await GET(get(TOKEN));
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]).toMatchObject({
      message_id: asked.value.assistantMessage.id,
      thread_id: asked.value.thread.id,
      question: 'Did anything urgent come in overnight?',
    });
  });
});

describe('answering a question', () => {
  it('fills in the content and flips status to answered', async () => {
    const asked = await ask(harness.auth, 'What changed since yesterday?');
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;

    const response = await POST(
      post(TOKEN, {
        message_id: asked.value.assistantMessage.id,
        answer: 'Nothing urgent changed since yesterday.',
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      message_id: asked.value.assistantMessage.id,
    });

    const thread = await harness.store.get(
      'chat_threads',
      harness.auth.organizationId,
      asked.value.thread.id,
    );
    expect(thread).not.toBeNull();

    const messages = await harness.store.list('chat_messages', harness.auth.organizationId, {
      eq: { thread_id: asked.value.thread.id },
    });
    const answered = messages.find(
      (m) => (m as { id: string }).id === asked.value.assistantMessage.id,
    ) as { status: string; content: string } | undefined;
    expect(answered?.status).toBe('answered');
    expect(answered?.content).toBe('Nothing urgent changed since yesterday.');
  });

  it('no longer shows the question as pending once answered', async () => {
    const asked = await ask(harness.auth, 'Any deals worth a look?');
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;

    await POST(post(TOKEN, { message_id: asked.value.assistantMessage.id, answer: 'Not yet.' }));

    const response = await GET(get(TOKEN));
    const body = await response.json();
    expect(body.pending).toHaveLength(0);
  });

  it('skips rather than re-answering a message that is already answered', async () => {
    const asked = await ask(harness.auth, 'Anything from the portfolio?');
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;

    await POST(
      post(TOKEN, { message_id: asked.value.assistantMessage.id, answer: 'First answer.' }),
    );
    const second = await POST(
      post(TOKEN, { message_id: asked.value.assistantMessage.id, answer: 'Second answer.' }),
    );

    await expect(second.json()).resolves.toMatchObject({ ok: true, skipped: 'not_pending' });

    const messages = await harness.store.list('chat_messages', harness.auth.organizationId, {
      eq: { thread_id: asked.value.thread.id },
    });
    const answered = messages.find(
      (m) => (m as { id: string }).id === asked.value.assistantMessage.id,
    ) as { content: string } | undefined;
    expect(answered?.content).toBe('First answer.');
  });

  it('skips a message id that does not exist', async () => {
    const response = await POST(
      post(TOKEN, { message_id: '00000000-0000-4000-8000-000000000000', answer: 'Anything' }),
    );
    await expect(response.json()).resolves.toMatchObject({ ok: true, skipped: 'not_found' });
  });
});

describe('validation', () => {
  it('rejects a message_id that is not a UUID', async () => {
    const response = await POST(post(TOKEN, { message_id: 'not-a-uuid', answer: 'Anything' }));
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      skipped: 'payload failed validation',
    });
  });

  it('rejects an empty answer', async () => {
    const response = await POST(
      post(TOKEN, { message_id: '00000000-0000-4000-8000-000000000000', answer: '' }),
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      skipped: 'payload failed validation',
    });
  });
});
