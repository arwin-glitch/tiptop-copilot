import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';
import { resetEnvCache } from '@/lib/config/env';
import { POST as webhook } from '@/app/api/integrations/tasks/webhook/route';
import {
  ingestTasksFromSlack,
  parseTaskRelayMessage,
  resetTaskPullThrottle,
} from '@/lib/services/task-ingest';
import type { Task } from '@/lib/types/domain';

/**
 * The properties worth pinning: the same token discipline the other bridges
 * have, that ingest is add-only (a title matching an open/snoozed task is
 * skipped, nothing is ever completed or edited), and that a task is
 * attributed to a real organization member (the table requires it).
 */

const TOKEN = 'task-token-for-tests-0000000000';

let harness: Harness;
const SAVED = { ...process.env };

beforeEach(async () => {
  harness = await createHarness();
  process.env.TASK_BRIDGE_TOKEN = TOKEN;
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

function post(token: string, body?: unknown) {
  return new NextRequest(
    `https://tiptop-copilot.onrender.com/api/integrations/tasks/webhook?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

async function tasks(): Promise<Task[]> {
  return (await harness.store.list('tasks', harness.auth.organizationId, {})) as Task[];
}

const PAYLOAD = {
  source: 'test',
  tasks: [{ title: 'Follow up with Jane about the SAFE', detail: 'From the Sep 21 call notes.' }],
};

describe('authentication', () => {
  it('accepts the configured token', async () => {
    const response = await webhook(post(TOKEN, PAYLOAD));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      created: ['Follow up with Jane about the SAFE'],
    });
  });

  it('refuses a token that does not match, and adds nothing', async () => {
    const before = (await tasks()).length;
    const response = await webhook(post('not-the-token', PAYLOAD));
    expect(response.status).toBe(401);
    expect(await tasks()).toHaveLength(before);
  });

  it('refuses a token that is a prefix of the real one', async () => {
    const response = await webhook(post(TOKEN.slice(0, 8), PAYLOAD));
    expect(response.status).toBe(401);
  });

  it('says so, not "invalid token", when no token is configured', async () => {
    delete process.env.TASK_BRIDGE_TOKEN;
    resetEnvCache();
    const response = await webhook(post('anything', PAYLOAD));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'not_configured' } });
  });
});

describe('validation', () => {
  it('skips a payload with no tasks', async () => {
    const response = await webhook(post(TOKEN, { source: 'test', tasks: [] }));
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      skipped: 'payload failed validation',
    });
  });

  it('rejects a due_at that is not a real timestamp', async () => {
    const response = await webhook(
      post(TOKEN, { source: 'test', tasks: [{ title: 'X', due_at: 'next Tuesday' }] }),
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      skipped: 'payload failed validation',
    });
  });
});

describe('add-only ingest', () => {
  it('creates the task, attributed to the organization owner', async () => {
    await webhook(post(TOKEN, PAYLOAD));
    const row = (await tasks()).find((t) => t.title === PAYLOAD.tasks[0]!.title);
    expect(row).toMatchObject({
      status: 'open',
      source: 'suggested',
      detail: 'From the Sep 21 call notes.',
      created_by: harness.auth.userId,
      assigned_to: harness.auth.userId,
    });
  });

  it('an urgent task with no due_at gets one, so it buckets as due today', async () => {
    await webhook(
      post(TOKEN, { source: 'test', tasks: [{ title: 'Call Sydecar today', urgent: true }] }),
    );
    const row = (await tasks()).find((t) => t.title === 'Call Sydecar today');
    expect(row?.due_at).not.toBeNull();
  });

  it('re-posting the same title (any case/spacing) adds nothing', async () => {
    await webhook(post(TOKEN, PAYLOAD));
    const before = (await tasks()).length;
    const response = await webhook(
      post(TOKEN, {
        source: 'test',
        tasks: [{ title: '  Follow up with jane about the safe  ' }],
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      created: [],
      existing: ['Follow up with jane about the safe'],
    });
    expect(await tasks()).toHaveLength(before);
  });

  it('does not re-add a task the human already completed', async () => {
    await webhook(post(TOKEN, PAYLOAD));
    const row = (await tasks()).find((t) => t.title === PAYLOAD.tasks[0]!.title)!;
    await harness.store.update('tasks', harness.auth.organizationId, row.id, {
      status: 'complete',
      completed_at: new Date().toISOString(),
    });
    await webhook(post(TOKEN, PAYLOAD));
    expect((await tasks()).filter((t) => t.title === PAYLOAD.tasks[0]!.title)).toHaveLength(1);
  });

  it('a duplicate inside one payload is added once', async () => {
    await webhook(
      post(TOKEN, {
        source: 'test',
        tasks: [{ title: 'ZZ Twin task' }, { title: 'zz twin task' }],
      }),
    );
    expect((await tasks()).filter((t) => /zz twin task/i.test(t.title))).toHaveLength(1);
  });
});

describe('ambiguous tenancy', () => {
  it('skips rather than guessing which organization a post belongs to', async () => {
    await addSecondOrganization(harness);
    const response = await webhook(post(TOKEN, PAYLOAD));
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      skipped: 'no unambiguous organization',
    });
  });
});

describe('the Slack relay path (for cloud routines that cannot reach the app)', () => {
  const relay = (text: string) => ({ text });
  const fakeSlack = (messages: Array<{ text: string }>, ok = true) =>
    (async () =>
      new Response(
        JSON.stringify(ok ? { ok: true, messages } : { ok: false, error: 'not_in_channel' }),
      )) as unknown as typeof fetch;

  beforeEach(() => {
    process.env.ASK_RELAY_SLACK_TOKEN = 'xoxb-test';
    resetEnvCache();
    resetTaskPullThrottle();
  });

  it('parses only the exact marker plus backticked JSON', () => {
    const msg = relay(
      'TASK_ADD_V1\n`{"source":"granola","tasks":[{"title":"ZZ Relay task"}]}`',
    ).text;
    expect(parseTaskRelayMessage(msg)?.tasks[0]?.title).toBe('ZZ Relay task');
    expect(parseTaskRelayMessage('ASK_ANSWER_V1\n`{"message_id":"x"}`')).toBeNull();
  });

  it('unwraps a source_url-less Slack link rewrite inside a plain string field too', () => {
    const msg =
      'TASK_ADD_V1\n`{"source":"granola","tasks":[{"title":"ZZ Link","detail":"see <https://x.dev|x.dev>"}]}`';
    expect(parseTaskRelayMessage(msg)?.tasks[0]?.detail).toContain('https://x.dev');
  });

  it('adds a task from a relay message, once, however often the channel is re-read', async () => {
    const msg = relay('TASK_ADD_V1\n`{"source":"granola","tasks":[{"title":"ZZ Relay task"}]}`');
    const slack = fakeSlack([msg, relay('ordinary chatter')]);
    const first = await ingestTasksFromSlack(harness.store, harness.auth.organizationId, slack);
    expect(first?.created).toEqual(['ZZ Relay task']);
    const second = await ingestTasksFromSlack(harness.store, harness.auth.organizationId, slack);
    expect(second?.created).toEqual([]);
    expect((await tasks()).filter((t) => t.title === 'ZZ Relay task')).toHaveLength(1);
  });

  it('does nothing, and does not throw, when Slack refuses the read', async () => {
    const before = (await tasks()).length;
    const result = await ingestTasksFromSlack(
      harness.store,
      harness.auth.organizationId,
      fakeSlack([], false),
    );
    expect(result).toBeNull();
    expect(await tasks()).toHaveLength(before);
  });
});
