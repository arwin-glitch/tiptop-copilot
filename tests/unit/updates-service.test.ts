import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDemoSlack, DEMO_UPDATE_SOURCES, type DemoSlack } from '@/lib/demo/updates-fixtures';
import { getUpdatesFeed } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { readUpdates, resetUpdatesCache, type UpdatesFeed } from '@/lib/services/updates';
import type { SlackMessage, UpdateSource } from '@/lib/updates/types';

/**
 * The Slack reader: exact requests, access mapping, pagination, replies,
 * the cache and its throttles. Every Slack answer comes from a recording
 * fake over the invented demo workspace; the global fetch throws.
 */

const T0 = new Date('2026-09-23T15:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const SEC = 1_000;
const MIN = 60_000;
const HOUR = 3_600_000;

const HARBOR = 'CDEMO0000H1';
const PITCHLINE = 'CDEMO0000P1';
const SCOUT = 'CDEMO0000S1';
const SYNDICATE = 'CDEMO0000Y1';
const DIGEST = 'CDEMO0000D1';

function source(key: string): UpdateSource {
  const s = DEMO_UPDATE_SOURCES.find((x) => x.key === key);
  if (!s) throw new Error(key);
  return s;
}
const READABLE = DEMO_UPDATE_SOURCES.filter((s) => s.key !== 'syndicate');

interface Call {
  url: URL;
  init: RequestInit | undefined;
}

type Override = (url: URL, method: string) => Response | Promise<Response> | undefined;

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

/** A recording Slack over a mutable copy of the demo workspace. */
function fakeSlack(opts: { data?: DemoSlack; override?: Override; scopes?: string | null } = {}) {
  const data = opts.data ?? buildDemoSlack(T0);
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const method = url.pathname.replace('/api/', '');
    const overridden = await opts.override?.(url, method);
    if (overridden) return overridden;
    if (method === 'auth.test') {
      const headers: Record<string, string> = {};
      const scopes = opts.scopes === undefined ? 'channels:history,groups:history' : opts.scopes;
      if (scopes !== null) headers['x-oauth-scopes'] = scopes;
      return json(
        { ok: true, url: 'https://demo-workspace.slack.com/', user: 'copilot_demo_bot' },
        { headers },
      );
    }
    const channel = url.searchParams.get('channel') ?? '';
    const error = data.errors[channel];
    if (error) return json({ ok: false, error });
    if (method === 'conversations.history') {
      return json({ ok: true, messages: data.history[channel] ?? [], response_metadata: {} });
    }
    const replies = data.replies[`${channel}:${url.searchParams.get('ts')}`];
    return replies
      ? json({ ok: true, messages: replies, response_metadata: { next_cursor: '' } })
      : json({ ok: false, error: 'thread_not_found' });
  }) as typeof fetch;
  const count = (method: string, channel?: string) =>
    calls.filter(
      (c) =>
        c.url.pathname === `/api/${method}` &&
        (channel === undefined || c.url.searchParams.get('channel') === channel),
    ).length;
  return { data, calls, fetchImpl, count };
}

function feed(
  fetchImpl: typeof fetch,
  sources: readonly UpdateSource[] = DEMO_UPDATE_SOURCES,
): UpdatesFeed {
  return { sources, token: 'xoxb-test', fetchImpl };
}

function demoFeed(): UpdatesFeed {
  const f = getUpdatesFeed(T0);
  if (!f) throw new Error('demo mode always has a feed');
  return f;
}

function view(snapshot: Awaited<ReturnType<typeof readUpdates>>, key: string) {
  const v = snapshot.sources.find((s) => s.source.key === key);
  if (!v) throw new Error(key);
  return v;
}

beforeEach(() => {
  resetUpdatesCache();
  vi.stubGlobal('fetch', () => {
    throw new Error('the global fetch must never be called');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('happy path', () => {
  it('calls auth.test once, then one exact history call per source', async () => {
    const slack = fakeSlack();
    const snapshot = await readUpdates(feed(slack.fetchImpl, READABLE), { now: T0 });

    expect(slack.count('auth.test')).toBe(1);
    const history = slack.calls.filter((c) => c.url.pathname === '/api/conversations.history');
    expect(history.map((c) => c.url.href)).toEqual(
      READABLE.map(
        (s) => `https://slack.com/api/conversations.history?channel=${s.channelId}&limit=100`,
      ),
    );
    for (const call of slack.calls) {
      expect(call.url.href).not.toContain('xoxb-test');
      expect((call.init?.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-test');
      expect(call.init?.cache).toBe('no-store');
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
      expect(call.init?.method ?? 'GET').toBe('GET');
    }

    expect(snapshot.setup).toBeNull();
    expect(snapshot.workspace).toEqual({
      botHandle: 'copilot_demo_bot',
      url: 'https://demo-workspace.slack.com/',
    });
    expect(view(snapshot, 'harbor').posts.map((p) => p.type)).toEqual(['dealflow', 'dealflow']);
    expect(view(snapshot, 'scout').posts.map((p) => p.type)).toEqual(['dealflow', 'dealflow']);
    expect(view(snapshot, 'digest').posts.map((p) => p.type)).toEqual([
      'digest',
      'digest',
      'digest',
      'digest',
      'roster',
    ]);
  });

  it('builds permalinks, channel links and the last-post time', async () => {
    const slack = fakeSlack();
    const snapshot = await readUpdates(feed(slack.fetchImpl, READABLE), { now: T0 });
    const harbor = view(snapshot, 'harbor');
    const latest = harbor.posts[0];
    expect(latest?.permalink).toBe(
      `https://demo-workspace.slack.com/archives/${HARBOR}/p${latest?.ts.replace('.', '')}`,
    );
    expect(harbor.channelUrl).toBe(`https://demo-workspace.slack.com/archives/${HARBOR}`);
    expect(harbor.lastPostAt).toBe(latest?.postedAt);
    expect(harbor.overdue).toBe(false);
    expect(latest?.settling).toBe(false);
  });

  it('marks a source overdue once its last report is older than its threshold', async () => {
    const slack = fakeSlack();
    const snapshot = await readUpdates(feed(slack.fetchImpl, [source('harbor')]), {
      now: at(9 * 24 * HOUR),
    });
    expect(view(snapshot, 'harbor').overdue).toBe(true);
  });
});

describe('replies', () => {
  it('reads threads only for parents with replies, and drops the parent copy', async () => {
    const slack = fakeSlack();
    const snapshot = await readUpdates(feed(slack.fetchImpl, READABLE), { now: T0 });

    const replies = slack.calls.filter((c) => c.url.pathname === '/api/conversations.replies');
    const threaded = [HARBOR, PITCHLINE, SCOUT, DIGEST].flatMap((ch) =>
      (slack.data.history[ch] ?? [])
        .filter((m) => (m.reply_count ?? 0) > 0)
        .map((m) => `${ch}:${m.ts}`),
    );
    expect(
      replies
        .map((c) => `${c.url.searchParams.get('channel')}:${c.url.searchParams.get('ts')}`)
        .sort(),
    ).toEqual(threaded.sort());
    for (const c of replies) expect(c.url.searchParams.get('limit')).toBe('200');

    const harbor = view(snapshot, 'harbor').posts[0];
    expect(harbor?.type === 'dealflow' && harbor.counts.newDeals).toBe(3);
    // The parent's exec paragraph appears once, not twice.
    expect(harbor?.type === 'dealflow' && harbor.sections[0]?.blocks).toHaveLength(1);
    const weekly = view(snapshot, 'digest').posts[0];
    expect(weekly?.type === 'digest' && weekly.items.length).toBe(3);
    expect(weekly?.type === 'digest' && weekly.notes.length).toBe(1);
  });

  it('reuses a thread whose latest reply is unchanged, and re-reads it when it changes', async () => {
    const slack = fakeSlack();
    const f = feed(slack.fetchImpl, [source('harbor')]);
    await readUpdates(f, { now: T0 });
    expect(slack.count('conversations.replies')).toBe(1);

    await readUpdates(f, { now: at(21 * SEC), force: true });
    expect(slack.count('conversations.history')).toBe(2);
    expect(slack.count('conversations.replies')).toBe(1);

    const parent = slack.data.history[HARBOR]?.[0] as SlackMessage;
    parent.latest_reply = '1789733200.000999';
    await readUpdates(f, { now: at(42 * SEC), force: true });
    expect(slack.count('conversations.replies')).toBe(2);
  });

  it('keeps the parent when its thread cannot be read', async () => {
    const slack = fakeSlack({
      override: (_url, method) =>
        method === 'conversations.replies'
          ? json({ ok: false, error: 'thread_not_found' })
          : undefined,
    });
    const snapshot = await readUpdates(feed(slack.fetchImpl, [source('harbor')]), { now: T0 });
    const latest = view(snapshot, 'harbor').posts[0];
    expect(latest?.threadMissing).toBe(true);
    expect(latest?.type === 'dealflow' && latest.sections[0]?.key).toBe('summary');
    expect(view(snapshot, 'harbor').access.state).toBe('ok');
  });

  it('never makes more than 16 replies calls in one read', async () => {
    const data: DemoSlack = { history: {}, replies: {}, errors: {} };
    const sources: UpdateSource[] = [];
    for (let c = 0; c < 5; c++) {
      const channel = `CDEMO0000C${c}`;
      sources.push({ ...source('harbor'), key: `c${c}`, channelId: channel });
      data.history[channel] = [];
      for (let r = 0; r < 4; r++) {
        const ts = `${1789700000 - r * 604800}.00010${c}`;
        const parent: SlackMessage = {
          ts,
          text: `_Juniper Deal Flow — Weekly Update | Week ${r}_\n\nSummary text.`,
          reply_count: 1,
          latest_reply: `${ts}9`,
        };
        data.history[channel]?.push(parent);
        data.replies[`${channel}:${ts}`] = [
          parent,
          { ts: `${ts}9`, text: '*Action Items*\n• follow up', thread_ts: ts },
        ];
      }
    }
    const slack = fakeSlack({ data });
    const snapshot = await readUpdates(feed(slack.fetchImpl, sources), { now: T0 });
    expect(slack.count('conversations.replies')).toBe(16);
    const missing = snapshot.sources.flatMap((v) => v.posts).filter((p) => p.threadMissing);
    expect(missing).toHaveLength(4);
  });
});

describe('pagination', () => {
  it('follows the cursor while too few reports have been seen', async () => {
    const slack = fakeSlack({
      override: (url, method) => {
        if (method !== 'conversations.history') return undefined;
        const [latest, earlier] = slack.data.history[HARBOR] ?? [];
        return url.searchParams.get('cursor') === 'c2'
          ? json({ ok: true, messages: [earlier], response_metadata: { next_cursor: '' } })
          : json({
              ok: true,
              messages: [latest],
              has_more: true,
              response_metadata: { next_cursor: 'c2' },
            });
      },
    });
    const snapshot = await readUpdates(feed(slack.fetchImpl, [source('harbor')]), { now: T0 });
    const history = slack.calls.filter((c) => c.url.pathname === '/api/conversations.history');
    expect(history).toHaveLength(2);
    expect(history[1]?.url.searchParams.get('cursor')).toBe('c2');
    expect(view(snapshot, 'harbor').posts).toHaveLength(2);
  });

  it('never reads more than three pages', async () => {
    const slack = fakeSlack({
      override: (_url, method) =>
        method === 'conversations.history'
          ? json({
              ok: true,
              messages: [{ ts: '1789000000.000100', text: 'chatter' }],
              response_metadata: { next_cursor: 'more' },
            })
          : undefined,
    });
    await readUpdates(feed(slack.fetchImpl, [source('harbor')]), { now: T0 });
    expect(slack.count('conversations.history')).toBe(3);
  });

  it('follows the cursor for a thread too', async () => {
    const slack = fakeSlack({
      override: (url, method) => {
        if (method !== 'conversations.replies') return undefined;
        const all = slack.data.replies[`${HARBOR}:${url.searchParams.get('ts')}`] ?? [];
        return url.searchParams.get('cursor') === 'r2'
          ? json({ ok: true, messages: all.slice(2), response_metadata: { next_cursor: '' } })
          : json({ ok: true, messages: all.slice(0, 2), response_metadata: { next_cursor: 'r2' } });
      },
    });
    const snapshot = await readUpdates(feed(slack.fetchImpl, [source('harbor')]), { now: T0 });
    expect(slack.count('conversations.replies')).toBe(2);
    const latest = view(snapshot, 'harbor').posts[0];
    expect(latest?.type === 'dealflow' && latest.counts.newDeals).toBe(3);
  });
});

describe('access mapping', () => {
  it.each(['not_in_channel', 'channel_not_found'])(
    'maps %s to an invite instruction',
    async (error) => {
      const slack = fakeSlack();
      slack.data.errors[HARBOR] = error;
      const snapshot = await readUpdates(feed(slack.fetchImpl, [source('harbor')]), { now: T0 });
      const harbor = view(snapshot, 'harbor');
      expect(harbor.access).toEqual({ state: 'not_invited', code: error });
      expect(harbor.channelUrl).toBe(`https://demo-workspace.slack.com/archives/${HARBOR}`);
      expect(snapshot.setup).toBeNull();
    },
  );

  it('maps missing_scope to a scope step and an app-wide banner', async () => {
    const slack = fakeSlack({
      override: (_url, method) =>
        method === 'conversations.history'
          ? json({ ok: false, error: 'missing_scope', needed: 'groups:history' })
          : undefined,
    });
    const snapshot = await readUpdates(feed(slack.fetchImpl, [source('harbor')]), { now: T0 });
    expect(view(snapshot, 'harbor').access).toEqual({
      state: 'missing_scope',
      needed: 'groups:history',
    });
    expect(snapshot.setup).toEqual({ kind: 'missing_scope', needed: 'groups:history' });
  });

  it('reads no history when the token visibly lacks groups:history', async () => {
    const slack = fakeSlack({ scopes: 'channels:history,chat:write' });
    const snapshot = await readUpdates(feed(slack.fetchImpl, READABLE), { now: T0 });
    expect(slack.count('conversations.history')).toBe(0);
    expect(snapshot.setup).toEqual({ kind: 'missing_scope', needed: 'groups:history' });
    for (const v of snapshot.sources) expect(v.access.state).toBe('missing_scope');
  });

  it('stops at auth.test when the token is rejected', async () => {
    const slack = fakeSlack({
      override: (_url, method) =>
        method === 'auth.test' ? json({ ok: false, error: 'invalid_auth' }) : undefined,
    });
    const snapshot = await readUpdates(feed(slack.fetchImpl, READABLE), { now: T0 });
    expect(slack.calls).toHaveLength(1);
    expect(snapshot.setup).toEqual({ kind: 'token_rejected', code: 'invalid_auth' });
    for (const v of snapshot.sources) {
      expect(v.access).toEqual({ state: 'token_rejected', code: 'invalid_auth' });
    }
  });

  it('makes no call at all without a token', async () => {
    const slack = fakeSlack();
    const snapshot = await readUpdates(
      { sources: READABLE, token: undefined, fetchImpl: slack.fetchImpl },
      { now: T0 },
    );
    expect(slack.calls).toHaveLength(0);
    expect(snapshot.setup).toEqual({ kind: 'no_token' });
    for (const v of snapshot.sources) expect(v.access.state).toBe('no_token');
  });

  it('passes an unknown refusal through as an error code', async () => {
    const slack = fakeSlack();
    slack.data.errors[HARBOR] = 'is_archived';
    const snapshot = await readUpdates(feed(slack.fetchImpl, [source('harbor')]), { now: T0 });
    expect(view(snapshot, 'harbor').access).toEqual({ state: 'error', code: 'is_archived' });
  });

  it('carries on without a workspace when auth.test fails for another reason', async () => {
    const slack = fakeSlack({
      override: (_url, method) => (method === 'auth.test' ? json({}, { status: 503 }) : undefined),
    });
    const snapshot = await readUpdates(feed(slack.fetchImpl, [source('harbor')]), { now: T0 });
    expect(snapshot.workspace).toEqual({ botHandle: null, url: null });
    const harbor = view(snapshot, 'harbor');
    expect(harbor.access.state).toBe('ok');
    expect(harbor.posts[0]?.permalink).toBeNull();
  });
});

describe('resilience', () => {
  it('honours Retry-After, even against a forced read', async () => {
    let limited = true;
    const slack = fakeSlack({
      override: (url, method) =>
        limited && method === 'conversations.history' && url.searchParams.get('channel') === HARBOR
          ? json(
              { ok: false, error: 'ratelimited' },
              { status: 429, headers: { 'retry-after': '30' } },
            )
          : undefined,
    });
    const f = feed(slack.fetchImpl, [source('harbor'), source('pitchline')]);
    const first = await readUpdates(f, { now: T0 });
    expect(view(first, 'harbor').access).toEqual({ state: 'rate_limited', retryAfterSec: 30 });

    const before = slack.calls.length;
    const forced = await readUpdates(f, { now: at(10 * SEC), force: true });
    expect(slack.calls.length).toBe(before);
    expect(forced.throttled).toBe(true);

    limited = false;
    const recovered = await readUpdates(f, { now: at(31 * SEC) });
    expect(slack.count('conversations.history', HARBOR)).toBe(2);
    expect(slack.count('conversations.history', PITCHLINE)).toBe(1);
    expect(view(recovered, 'harbor').access.state).toBe('ok');
  });

  it('reports a forced read as throttled while every channel waits out Retry-After', async () => {
    const slack = fakeSlack({
      override: (url, method) =>
        method === 'conversations.history'
          ? json(
              { ok: false, error: 'ratelimited' },
              { status: 429, headers: { 'retry-after': '60' } },
            )
          : undefined,
    });
    const f = feed(slack.fetchImpl, [source('harbor')]);
    await readUpdates(f, { now: T0 });
    // Past the 20 s floor auth.test is re-checked, but no channel is re-read.
    const forced = await readUpdates(f, { now: at(25 * SEC), force: true });
    expect(slack.count('auth.test')).toBe(2);
    expect(slack.count('conversations.history')).toBe(1);
    expect(forced.throttled).toBe(true);
  });

  it.each([
    ['a 503', () => json({}, { status: 503 })],
    [
      'an aborted fetch',
      () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
    ],
  ])('reports %s as unreachable', async (_label, fail) => {
    const slack = fakeSlack({
      override: (_url, method) => (method === 'conversations.history' ? fail() : undefined),
    });
    const snapshot = await readUpdates(feed(slack.fetchImpl, [source('harbor')]), { now: T0 });
    expect(view(snapshot, 'harbor').access).toEqual({ state: 'unreachable' });
  });

  it('drops everything it kept from a channel the bot was removed from', async () => {
    let removed = false;
    const slack = fakeSlack({
      override: (_url, method) =>
        removed && method === 'conversations.history'
          ? json({ ok: false, error: 'not_in_channel' })
          : undefined,
    });
    const f = feed(slack.fetchImpl, [source('harbor')]);
    const good = await readUpdates(f, { now: T0 });
    expect(view(good, 'harbor').posts).toHaveLength(2);

    removed = true;
    const after = await readUpdates(f, { now: at(6 * MIN) });
    expect(view(after, 'harbor').access.state).toBe('not_invited');
    expect(view(after, 'harbor').posts).toEqual([]);
    expect(view(after, 'harbor').stale).toBeNull();

    // A later outage has nothing left to fall back on.
    removed = false;
    const outage = fakeSlack({
      override: (_url, method) =>
        method === 'conversations.history' ? json({}, { status: 503 }) : undefined,
    });
    const down = await readUpdates(feed(outage.fetchImpl, [source('harbor')]), {
      now: at(8 * MIN),
    });
    expect(view(down, 'harbor').posts).toEqual([]);
  });

  it('drops every channel the moment the token is revoked', async () => {
    let revoked = false;
    const slack = fakeSlack({
      override: (_url, method) =>
        revoked && method === 'auth.test' ? json({ ok: false, error: 'token_revoked' }) : undefined,
    });
    const f = feed(slack.fetchImpl, READABLE);
    await readUpdates(f, { now: T0 });

    revoked = true;
    const after = await readUpdates(f, { now: at(2 * HOUR) });
    expect(after.setup).toEqual({ kind: 'token_rejected', code: 'token_revoked' });
    for (const v of after.sources) {
      expect(v.posts).toEqual([]);
      expect(v.stale).toBeNull();
    }
  });

  it('keeps honouring Retry-After from a thread read on the next forced read', async () => {
    let limited = true;
    const slack = fakeSlack({
      override: (_url, method) =>
        limited && method === 'conversations.replies'
          ? json(
              { ok: false, error: 'ratelimited' },
              { status: 429, headers: { 'retry-after': '60' } },
            )
          : undefined,
    });
    const f = feed(slack.fetchImpl, [source('harbor')]);
    const first = await readUpdates(f, { now: T0 });
    expect(view(first, 'harbor').posts[0]?.threadMissing).toBe(true);
    expect(slack.count('conversations.replies')).toBe(1);

    await readUpdates(f, { now: at(21 * SEC), force: true });
    expect(slack.count('conversations.replies')).toBe(1);

    limited = false;
    const recovered = await readUpdates(f, { now: at(61 * SEC), force: true });
    expect(slack.count('conversations.replies')).toBe(2);
    expect(view(recovered, 'harbor').posts[0]?.threadMissing).toBe(false);
  });

  it('re-reads a channel after a minute when a thread could not be read', async () => {
    let failing = true;
    const slack = fakeSlack({
      override: (_url, method) =>
        failing && method === 'conversations.replies'
          ? json({ ok: false, error: 'internal_error' })
          : undefined,
    });
    const f = feed(slack.fetchImpl, [source('harbor')]);
    await readUpdates(f, { now: T0 });
    failing = false;
    await readUpdates(f, { now: at(59 * SEC) });
    expect(slack.count('conversations.history')).toBe(1);
    const healed = await readUpdates(f, { now: at(60 * SEC) });
    expect(slack.count('conversations.history')).toBe(2);
    expect(view(healed, 'harbor').posts[0]?.threadMissing).toBe(false);
  });

  it('never replaces a complete last good copy with one whose thread is missing', async () => {
    let mode: 'ok' | 'no-thread' | 'down' = 'ok';
    const slack = fakeSlack({
      override: (_url, method) => {
        if (mode === 'no-thread' && method === 'conversations.replies') {
          return json({ ok: false, error: 'internal_error' });
        }
        if (mode === 'down' && method === 'conversations.history') {
          return json({}, { status: 503 });
        }
        return undefined;
      },
    });
    const f = feed(slack.fetchImpl, [source('harbor')]);
    await readUpdates(f, { now: T0 });

    mode = 'no-thread';
    const parent = slack.data.history[HARBOR]?.[0] as SlackMessage;
    parent.latest_reply = '1789733200.000999';
    const degraded = await readUpdates(f, { now: at(6 * MIN) });
    expect(view(degraded, 'harbor').posts[0]?.threadMissing).toBe(true);

    mode = 'down';
    const outage = await readUpdates(f, { now: at(8 * MIN) });
    const latest = view(outage, 'harbor').posts[0];
    expect(view(outage, 'harbor').stale).toEqual({ since: T0.toISOString() });
    expect(latest?.threadMissing).toBe(false);
    expect(latest?.type === 'dealflow' && latest.counts.newDeals).toBe(3);
  });

  it('serves the last good copy when a later read fails, for up to a day', async () => {
    let down = false;
    const slack = fakeSlack({
      override: (_url, method) =>
        down && method === 'conversations.history' ? json({}, { status: 503 }) : undefined,
    });
    const f = feed(slack.fetchImpl, [source('harbor')]);
    const good = await readUpdates(f, { now: T0 });
    const posts = view(good, 'harbor').posts;
    expect(posts).toHaveLength(2);

    down = true;
    const failing = await readUpdates(f, { now: at(5 * MIN + 1) });
    const harbor = view(failing, 'harbor');
    expect(harbor.access.state).toBe('unreachable');
    expect(harbor.stale).toEqual({ since: T0.toISOString() });
    expect(harbor.posts.map((p) => p.ts)).toEqual(posts.map((p) => p.ts));

    const later = await readUpdates(f, { now: at(24 * HOUR + 1) });
    expect(view(later, 'harbor').stale).toBeNull();
    expect(view(later, 'harbor').posts).toEqual([]);
  });
});

describe('cache', () => {
  it('serves a read from memory for five minutes', async () => {
    const slack = fakeSlack();
    const f = feed(slack.fetchImpl, READABLE);
    await readUpdates(f, { now: T0 });
    const first = slack.calls.length;

    await readUpdates(f, { now: at(5 * MIN - 1) });
    expect(slack.calls.length).toBe(first);

    await readUpdates(f, { now: at(5 * MIN + 1) });
    expect(slack.count('conversations.history')).toBe(2 * READABLE.length);
    // Threads are unchanged, so none is read again.
    expect(slack.count('conversations.replies')).toBe(4);
  });

  it('re-reads an unchanged thread after half an hour, so an edited reply shows', async () => {
    const slack = fakeSlack();
    const f = feed(slack.fetchImpl, [source('harbor')]);
    await readUpdates(f, { now: T0 });
    await readUpdates(f, { now: at(29 * MIN) });
    expect(slack.count('conversations.replies')).toBe(1);
    await readUpdates(f, { now: at(35 * MIN) });
    expect(slack.count('conversations.replies')).toBe(2);
  });

  it('re-checks a refused channel after a minute', async () => {
    const slack = fakeSlack();
    const f = feed(slack.fetchImpl, [source('syndicate')]);
    await readUpdates(f, { now: T0 });
    await readUpdates(f, { now: at(59 * SEC) });
    expect(slack.count('conversations.history', SYNDICATE)).toBe(1);
    await readUpdates(f, { now: at(60 * SEC) });
    expect(slack.count('conversations.history', SYNDICATE)).toBe(2);
  });

  it('re-reads after a minute while a thread may still be posting', async () => {
    const slack = fakeSlack();
    const parent = slack.data.history[HARBOR]?.[0] as SlackMessage;
    // Read three minutes after the report was posted.
    const now = new Date(Number(parent.ts) * 1000 + 3 * MIN);
    const f = feed(slack.fetchImpl, [source('harbor')]);
    const first = await readUpdates(f, { now });
    expect(view(first, 'harbor').posts[0]?.settling).toBe(true);
    await readUpdates(f, { now: new Date(now.getTime() + 59 * SEC) });
    expect(slack.count('conversations.history')).toBe(1);
    await readUpdates(f, { now: new Date(now.getTime() + 60 * SEC) });
    expect(slack.count('conversations.history')).toBe(2);
  });

  it('floors a forced refresh at 20 seconds', async () => {
    const slack = fakeSlack();
    const f = feed(slack.fetchImpl, READABLE);
    await readUpdates(f, { now: T0 });
    const first = slack.calls.length;

    const early = await readUpdates(f, { now: at(19 * SEC), force: true });
    expect(slack.calls.length).toBe(first);
    expect(early.throttled).toBe(true);

    const later = await readUpdates(f, { now: at(20 * SEC), force: true });
    expect(later.throttled).toBe(false);
    expect(slack.count('conversations.history')).toBe(2 * READABLE.length);
    expect(slack.count('auth.test')).toBe(2);
  });

  it('shares one set of calls between concurrent reads', async () => {
    const single = fakeSlack();
    await readUpdates(feed(single.fetchImpl, READABLE), { now: T0 });
    resetUpdatesCache();

    const slack = fakeSlack();
    const f = feed(slack.fetchImpl, READABLE);
    const [a, b] = await Promise.all([readUpdates(f, { now: T0 }), readUpdates(f, { now: T0 })]);
    expect(slack.calls.length).toBe(single.calls.length);
    expect(a.sources.map((v) => v.posts.length)).toEqual(b.sources.map((v) => v.posts.length));
  });

  it('re-runs auth.test after an hour, or after a minute when the scope was missing', async () => {
    const ok = fakeSlack();
    const f = feed(ok.fetchImpl, [source('harbor')]);
    await readUpdates(f, { now: T0 });
    await readUpdates(f, { now: at(HOUR - 1) });
    expect(ok.count('auth.test')).toBe(1);
    await readUpdates(f, { now: at(HOUR) });
    expect(ok.count('auth.test')).toBe(2);

    resetUpdatesCache();
    const missing = fakeSlack({ scopes: 'channels:history' });
    const g = feed(missing.fetchImpl, [source('harbor')]);
    await readUpdates(g, { now: T0 });
    await readUpdates(g, { now: at(59 * SEC) });
    expect(missing.count('auth.test')).toBe(1);
    await readUpdates(g, { now: at(60 * SEC) });
    expect(missing.count('auth.test')).toBe(2);
  });
});

describe('log hygiene', () => {
  it('logs codes and counts, never message text or timestamps', async () => {
    const SENTINEL = 'SENTINEL-7Q-invented';
    const data = buildDemoSlack(T0);
    const parent = data.history[HARBOR]?.[0] as SlackMessage;
    parent.text = `${parent.text}\n${SENTINEL}`;
    let fail = false;
    const slack = fakeSlack({
      data,
      override: (_url, method) =>
        fail && method === 'conversations.history'
          ? json({ ok: false, error: 'not_in_channel' })
          : undefined,
    });
    const logged: unknown[] = [];
    for (const level of ['info', 'warn', 'error'] as const) {
      vi.spyOn(log, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    const f = feed(slack.fetchImpl, READABLE);
    await readUpdates(f, { now: T0 });
    fail = true;
    await readUpdates(f, { now: at(6 * MIN), force: true });

    expect(logged.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(logged);
    expect(serialised).not.toContain(SENTINEL);
    for (const channel of Object.values(data.history)) {
      for (const m of channel) expect(serialised).not.toContain(m.ts);
    }
    expect(serialised).not.toContain('xoxb-test');
  });
});

describe('a post the parsers cannot read', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/updates/dealflow');
    vi.resetModules();
  });

  it('shows as a generic card and leaves the rest of the channel alone', async () => {
    vi.resetModules();
    vi.doMock('@/lib/updates/dealflow', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/updates/dealflow')>();
      return {
        ...actual,
        parseDealflowReport: (...args: Parameters<typeof actual.parseDealflowReport>) => {
          // Only the threaded report fails; the other channel has no threads.
          if (args[2].length > 0) throw new RangeError('invented failure');
          return actual.parseDealflowReport(...args);
        },
      };
    });
    const service = await import('@/lib/services/updates');
    service.resetUpdatesCache();
    const slack = fakeSlack();
    const snapshot = await service.readUpdates(
      feed(slack.fetchImpl, [source('harbor'), source('pitchline')]),
      { now: T0 },
    );
    const harbor = view(snapshot, 'harbor');
    expect(harbor.access.state).toBe('ok');
    expect(harbor.posts.map((p) => p.type).sort()).toEqual(['dealflow', 'other']);
    expect(view(snapshot, 'pitchline').posts.map((p) => p.type)).toEqual(['dealflow', 'dealflow']);
  });
});

describe('demo mode', () => {
  it('reads the invented workspace without touching the network', async () => {
    const snapshot = await readUpdates(demoFeed(), { now: T0 });
    expect(snapshot.sources.map((v) => [v.source.key, v.access.state])).toEqual([
      ['harbor', 'ok'],
      ['pitchline', 'ok'],
      ['scout', 'ok'],
      ['syndicate', 'not_invited'],
      ['digest', 'ok'],
    ]);
    const rosters = view(snapshot, 'digest').posts.filter((p) => p.type === 'roster');
    expect(rosters).toHaveLength(1);
    expect(rosters[0]?.type === 'roster' && rosters[0].version).toBe(2);
    for (const v of snapshot.sources) {
      for (const p of v.posts) expect(p.settling).toBe(false);
    }
  });
});
