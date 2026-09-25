import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHarness, type Harness } from '../helpers/harness';
import { POST as cron } from '@/app/api/cron/daily/route';
import { DEFAULT_TASK_RELAY_POSTER_IDS, resetEnvCache } from '@/lib/config/env';
import { resetDealPullState } from '@/lib/services/deal-relay';
import { resetReplyCheckState } from '@/lib/services/task-reply-check';
import {
  formatTaskCronStatus,
  getTaskRelayStatus,
  pullTaskRelays,
  readTasksVersion,
  resetTaskRelayState,
  taskCloserRuntime,
} from '@/lib/services/task-relay';
import { resetSnapshotState } from '@/lib/services/task-snapshot';
import type { AuditEvent, Task } from '@/lib/types/domain';

/**
 * The task relays end to end, on the demo store: a suggested task posted to
 * the public relay channel and its close posted to #deal-relay arrive in one
 * pull, the task is added and closed in order, and the daily job reports
 * counts only. Every title and id is invented.
 */

const TICK = String.fromCharCode(96);
const POSTER = DEFAULT_TASK_RELAY_POSTER_IDS[0]!;
const SECRET = 'cron-secret-for-tests-000000000000';
const TITLE = 'ZZ Send Kit the shortlist';
const SAVED = { ...process.env };
let harness: Harness;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 15:00 in Chicago: the reply check waits for 4pm, so it stays out of the way.
  vi.setSystemTime(new Date('2026-09-25T20:00:00.000Z'));
  harness = await createHarness();
  process.env.ASK_RELAY_SLACK_TOKEN = 'xoxb-test';
  process.env.CRON_SECRET = SECRET;
  resetEnvCache();
  resetTaskRelayState();
  resetDealPullState();
  resetReplyCheckState();
  resetSnapshotState();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await harness.dispose();
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
  resetTaskRelayState();
  resetDealPullState();
  resetReplyCheckState();
  resetSnapshotState();
});

const ts = (iso: string) => `${Math.floor(Date.parse(iso) / 1000)}.000100`;

function addPost() {
  const body = { source: 'task-auto-suggest', tasks: [{ title: TITLE, detail: 'From a call.' }] };
  return {
    ts: ts('2026-09-25T19:30:00Z'),
    user: POSTER,
    text: `TASK_ADD_V1\n${TICK}${JSON.stringify(body)}${TICK}`,
  };
}

function closePost() {
  const body = {
    v: 1,
    source: 'task-closer',
    batch: '2026-09-25T19:50:00Z',
    part: 1,
    parts: 1,
    closes: [
      {
        title: TITLE,
        kind: 'send_doc',
        evidence_at: '2026-09-25T19:40:00Z',
        evidence: { type: 'gmail_sent', id: 'abc0000000000071', thread_id: 'abc0000000000070' },
        reason: 'Sent Kit the list of eight firms.',
      },
    ],
  };
  return {
    ts: ts('2026-09-25T19:50:00Z'),
    user: POSTER,
    text: `TASK_CLOSE_V1\n${TICK}${JSON.stringify(body)}${TICK}`,
  };
}

function runPost() {
  const body = {
    v: 1,
    source: 'task-closer',
    run_at: '2026-09-25T19:51:00Z',
    local_date: '2026-09-25',
    list: 'suggested',
    snapshot_batch: null,
    checked: 1,
    closed: 1,
    near_misses: 0,
    excluded: 0,
    unchecked: 0,
  };
  return {
    ts: ts('2026-09-25T19:51:00Z'),
    user: POSTER,
    text: `TASK_CLOSER_RUN_V1\n${TICK}${JSON.stringify(body)}${TICK}`,
  };
}

/** Both channels, each one page newest first; chat.postMessage refused for want of chat:write. */
function fakeSlack() {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('chat.postMessage')) {
      return new Response(
        JSON.stringify({ ok: false, error: 'missing_scope', needed: 'chat:write' }),
      );
    }
    const channel = new URL(url).searchParams.get('channel');
    const messages =
      channel === 'C0C3JPW6PTJ'
        ? [addPost()]
        : channel === 'C0C40TVD4DP'
          ? [runPost(), closePost()]
          : [];
    return new Response(JSON.stringify({ ok: true, messages, has_more: false }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function tasksTitled(title: string): Promise<Task[]> {
  return (await harness.store.list('tasks', harness.auth.organizationId, {
    eq: { title },
  })) as Task[];
}

describe('pullTaskRelays', () => {
  it('adds a suggested task and closes it in the same pull, then changes nothing', async () => {
    const { impl, calls } = fakeSlack();
    const org = harness.auth.organizationId;
    const before = await readTasksVersion(harness.store, org);

    const status = await pullTaskRelays(harness.store, org, { fetchImpl: impl });
    expect(status).toMatchObject({ relay: 'ok', added: 1, closes: { closed: 1, rejected: 0 } });
    expect(status.lastRun?.run).toMatchObject({ local_date: '2026-09-25', closed: 1 });
    expect(status.snapshot.state).toBe('needs_chat_write');
    expect(formatTaskCronStatus(status)).toBe('ok: 1 added, 1 closed, 0 rejected');

    const [task] = await tasksTitled(TITLE);
    expect(task).toMatchObject({ status: 'complete', source: 'suggested' });
    const autos = (await harness.store.list('audit_events', org, {
      eq: { action: 'task.auto_completed', entity_id: task!.id },
    })) as AuditEvent[];
    expect(autos).toHaveLength(1);
    expect(autos[0]).toMatchObject({ user_id: null });
    expect(await readTasksVersion(harness.store, org)).not.toBe(before);

    // The next pull re-reads the same window: nothing new, and no second snapshot attempt.
    const posted = calls.filter((c) => c.includes('chat.postMessage')).length;
    const again = await pullTaskRelays(harness.store, org, { fetchImpl: impl, force: true });
    expect(again).toMatchObject({ added: 0, closes: { closed: 0 } });
    expect(await tasksTitled(TITLE)).toHaveLength(1);
    expect(calls.filter((c) => c.includes('chat.postMessage'))).toHaveLength(posted);

    expect(taskCloserRuntime(org, 'America/Chicago')).toMatchObject({
      relay: 'readable',
      snapshot: 'needs chat:write (tried again every 6 hours)',
    });
  });

  it('throttles each step to once a minute, and shares a run between callers', async () => {
    const { impl, calls } = fakeSlack();
    const org = harness.auth.organizationId;
    const [a, b] = await Promise.all([
      pullTaskRelays(harness.store, org, { fetchImpl: impl }),
      pullTaskRelays(harness.store, org, { fetchImpl: impl }),
    ]);
    expect(a).toBe(b);
    const count = calls.length;
    await pullTaskRelays(harness.store, org, { fetchImpl: impl });
    expect(calls).toHaveLength(count);
    vi.setSystemTime(new Date('2026-09-25T20:01:01.000Z'));
    await pullTaskRelays(harness.store, org, { fetchImpl: impl });
    expect(calls.length).toBeGreaterThan(count);
    expect(getTaskRelayStatus(org).relay).toBe('ok');
  });

  it('says it cannot read #deal-relay, and still adds what the relay channel holds', async () => {
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('C0C40TVD4DP')) {
        return new Response(JSON.stringify({ ok: false, error: 'not_in_channel' }));
      }
      if (url.includes('chat.postMessage')) {
        return new Response(JSON.stringify({ ok: false, error: 'not_in_channel' }));
      }
      return new Response(JSON.stringify({ ok: true, messages: [addPost()] }));
    }) as unknown as typeof fetch;
    const status = await pullTaskRelays(harness.store, harness.auth.organizationId, {
      fetchImpl: impl,
    });
    expect(status).toMatchObject({ relay: 'bot_not_in_channel', added: 1, closes: null });
    expect(status.snapshot.state).toBe('bot_not_in_channel');
    expect((await tasksTitled(TITLE))[0]?.status).toBe('open');
  });
});

describe('the daily job', () => {
  it('reports the task pull as counts only, never a title', async () => {
    vi.stubGlobal('fetch', fakeSlack().impl);
    const response = await cron(
      new NextRequest('https://tiptop-copilot.onrender.com/api/cron/daily?tasks=sync', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: { tasks: string }[] };
    expect(body.results[0]?.tasks).toBe('ok: 1 added, 1 closed, 0 rejected');
    expect(JSON.stringify(body)).not.toContain('Kit');
  });
});
