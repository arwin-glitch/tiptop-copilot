import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import type { DataStore } from '@/lib/db/store';
import {
  escapeForSlack,
  maybePostSnapshot,
  resetSnapshotState,
  snapshotParts,
  TASK_OPEN_MARKER,
  type SnapshotTask,
} from '@/lib/services/task-snapshot';
import { createTask } from '@/lib/services/tasks';
import type { AuditEvent } from '@/lib/types/domain';

// A made-up counterparty stands in for the real Nick-only ones.
vi.mock('@/lib/tasks/nick-only', async () => {
  const { wordMatcher } =
    await vi.importActual<typeof import('@/lib/tasks/nick-only')>('@/lib/tasks/nick-only');
  const { sha256 } = await vi.importActual<typeof import('@/lib/util/hash')>('@/lib/util/hash');
  return { wordMatcher, mentionsNickOnly: wordMatcher(new Set([sha256('zzfund')])) };
});

/**
 * The open-task snapshot the app posts for the task-closer. Until the Slack
 * app has chat:write every post is refused; that must stay quiet, wait six
 * hours, and never loop. Every title here is invented.
 */

let harness: Harness;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-25T15:00:00.000Z'));
  harness = await createHarness();
  resetSnapshotState();
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.dispose();
  resetSnapshotState();
});

function task(i: number, title = `ZZ Task number ${i}`): SnapshotTask {
  return {
    id: `99999999-0000-4000-8000-${String(i).padStart(12, '0')}`,
    title,
    status: 'open',
    src: 'human',
    created_at: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
  };
}

function bodyOf(text: string): Record<string, unknown> {
  const [marker, json] = text.split('\n');
  expect(marker).toBe(TASK_OPEN_MARKER);
  const raw = json!
    .slice(1, -1)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('snapshotParts', () => {
  it('fits every part in 3,500 characters, newest created first, numbered 1..N', () => {
    const tasks = Array.from({ length: 60 }, (_, i) =>
      task(i, `ZZ ${'long title '.repeat(15)}${i}`),
    );
    const { texts, truncated } = snapshotParts(tasks, { batch: 'b', asOf: 'b' });
    expect(truncated).toBe(false);
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(3_500);
    const bodies = texts.map(bodyOf);
    expect(bodies.map((b) => b.part)).toEqual(texts.map((_, i) => i + 1));
    expect(bodies.every((b) => b.parts === texts.length && b.source === 'tiptop-copilot')).toBe(
      true,
    );
    const ids = bodies.flatMap((b) => (b.tasks as SnapshotTask[]).map((t) => t.id));
    expect(ids).toHaveLength(60);
    expect(ids[0]).toBe(task(59).id);
  });

  it('stops at ten parts and says it was cut', () => {
    const tasks = Array.from({ length: 400 }, (_, i) => task(i, `ZZ ${'x'.repeat(190)} ${i}`));
    const { texts, truncated } = snapshotParts(tasks, { batch: 'b', asOf: 'b' });
    expect(texts).toHaveLength(10);
    expect(truncated).toBe(true);
    expect(texts.map(bodyOf).every((b) => b.truncated === true)).toBe(true);
  });

  it('escapes what Slack would read as markup, and never leaves a backtick in the body', () => {
    expect(escapeForSlack('A & B <c> `d`')).toBe("A &amp; B &lt;c&gt; 'd'");
    const [text] = snapshotParts([task(1, 'ZZ Intro A <> B & `C`')], {
      batch: 'b',
      asOf: 'b',
    }).texts;
    expect(text!.split('`')).toHaveLength(3);
    expect(text).toContain("ZZ Intro A &lt;&gt; B &amp; 'C'");
  });
});

describe('maybePostSnapshot', () => {
  const org = () => harness.auth.organizationId;

  function slack(answer: () => Record<string, unknown>) {
    const calls: { url: string; body: { channel: string; text: string } }[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(answer()));
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  const post = (impl: typeof fetch, store: DataStore = harness.store) =>
    maybePostSnapshot(store, org(), {
      token: 'xoxb-test',
      channelId: 'C0TEST0001',
      fetchImpl: impl,
    });
  const clock = (iso: string) => vi.setSystemTime(new Date(iso));

  async function posts(): Promise<AuditEvent[]> {
    return (await harness.store.list('audit_events', org(), {
      eq: { action: 'task.snapshot_posted' },
    })) as AuditEvent[];
  }

  it('without chat:write, fails quietly and waits six hours before trying again', async () => {
    const { impl, calls } = slack(() => ({
      ok: false,
      error: 'missing_scope',
      needed: 'chat:write',
    }));
    const first = await post(impl);
    expect(first.state).toBe('needs_chat_write');
    expect(first.retryAt).toBe('2026-09-25T21:00:00.000Z');
    expect(calls).toHaveLength(1);

    vi.setSystemTime(new Date('2026-09-25T20:59:00.000Z'));
    expect((await post(impl)).state).toBe('needs_chat_write');
    expect(calls).toHaveLength(1);
    vi.setSystemTime(new Date('2026-09-25T21:00:00.000Z'));
    await post(impl);
    expect(calls).toHaveLength(2);
    expect(await posts()).toEqual([]);
  });

  it('posts the list, a changed one only from 2 to 4 PM Central every 30 minutes, any after 20 hours', async () => {
    const { impl, calls } = slack(() => ({ ok: true }));
    const first = await post(impl);
    expect(first.state).toBe('posted');
    expect(calls[0]?.url).toBe('https://slack.com/api/chat.postMessage');
    expect(calls[0]?.body.channel).toBe('C0TEST0001');
    const body = bodyOf(calls[0]!.body.text);
    const titles = (body.tasks as SnapshotTask[]).map((t) => t.title);
    expect(titles).toContain('Send LoomStack pass note');
    expect(titles).toContain('Ask Tom for the Girder AI onboarding numbers');
    expect(titles).not.toContain('Answer the LP question on the Q3 reporting timeline');
    const snoozed = (body.tasks as SnapshotTask[]).find((t) => t.title.startsWith('Ask Tom'));
    expect(snoozed?.status).toBe('snoozed');
    expect(await posts()).toHaveLength(1);

    let count = calls.length;
    clock('2026-09-25T15:10:00.000Z');
    await createTask(harness.auth, { title: 'ZZ A new follow-up' });
    clock('2026-09-25T17:00:00.000Z'); // noon in Chicago: changed, but not yet the window
    expect((await post(impl)).state).toBe('posted');
    expect(calls).toHaveLength(count);
    clock('2026-09-25T19:05:00.000Z'); // 2:05 PM
    await post(impl);
    expect(calls.length).toBeGreaterThan(count);

    count = calls.length;
    clock('2026-09-25T19:10:00.000Z');
    await createTask(harness.auth, { title: 'ZZ Another follow-up' });
    clock('2026-09-25T19:34:00.000Z');
    await post(impl);
    expect(calls).toHaveLength(count);
    clock('2026-09-25T19:35:00.000Z');
    await post(impl);
    expect(calls.length).toBeGreaterThan(count);

    count = calls.length;
    clock('2026-09-25T21:05:00.000Z'); // 4:05 PM: the check has read it
    await createTask(harness.auth, { title: 'ZZ A late follow-up' });
    clock('2026-09-25T22:00:00.000Z');
    await post(impl);
    clock('2026-09-26T15:34:00.000Z');
    await post(impl);
    expect(calls).toHaveLength(count);
    clock('2026-09-26T15:35:00.000Z');
    await post(impl);
    expect(calls.length).toBeGreaterThan(count);
    expect(await posts()).toHaveLength(4);
  });

  it('does not post again when the record of a post could not be saved', async () => {
    const lossy = new Proxy(harness.store, {
      get(target, prop, receiver) {
        if (prop !== 'insert') return Reflect.get(target, prop, receiver);
        return async (table: string, row: unknown) => {
          if (table === 'audit_events') throw new Error('audit unavailable');
          return (target.insert as (t: string, r: unknown) => Promise<unknown>)(table, row);
        };
      },
    }) as DataStore;
    const { impl, calls } = slack(() => ({ ok: true }));
    expect((await post(impl, lossy)).state).toBe('posted');
    const count = calls.length;
    for (const iso of ['2026-09-25T15:01:00.000Z', '2026-09-25T19:05:00.000Z']) {
      clock(iso);
      await post(impl, lossy);
    }
    expect(calls).toHaveLength(count);
    expect(await posts()).toEqual([]);
  });

  it('leaves out every task that involves a Nick-only counterparty', async () => {
    await createTask(harness.auth, { title: 'ZZ Reply to the Zzfund partners' });
    await createTask(harness.auth, { title: 'ZZ Send the memo', detail: 'For bo@zzfund.example' });
    const { impl, calls } = slack(() => ({ ok: true }));
    await post(impl);
    const listed = calls.flatMap((c) => bodyOf(c.body.text).tasks as SnapshotTask[]);
    expect(listed.map((t) => t.title)).toContain('Send LoomStack pass note');
    expect(JSON.stringify(listed).toLowerCase()).not.toContain('zzfund');
    expect(listed.map((t) => t.title)).not.toContain('ZZ Send the memo');
  });
});
