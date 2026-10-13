import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataStore } from '@/lib/db/store';
import type { ThreadParticipants } from '@/lib/google/gmail-participants';
import { findWarmPaths, resetWarmPathsCache } from '@/lib/services/warm-paths';
import type { Integration } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * findWarmPaths against a mocked, read-only Gmail: failures must never turn
 * into a cached "nobody", and an LP thread that does not show the firm must
 * never label someone else as the firm. All names and addresses are fictional.
 */

const gmail = vi.hoisted(() => ({
  /** Gmail search -> thread ids. */
  search: (_q: string): string[] => [],
  /** Thread id -> headers, or an error. */
  threads: new Map<string, () => Result<ThreadParticipants>>(),
}));

vi.mock('@/lib/config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config/env')>()),
  isDemoMode: () => false,
}));

vi.mock('@/lib/google/gmail-inbox', async (importOriginal) => {
  const result = await import('@/lib/util/result');
  return {
    ...(await importOriginal<typeof import('@/lib/google/gmail-inbox')>()),
    listThreadPage: vi.fn(async (_store: unknown, _integration: unknown, opts: { q?: string }) =>
      result.ok({
        threads: gmail.search(opts.q ?? '').map((id) => ({ id, snippet: '', historyId: '1' })),
        nextPageToken: null,
      }),
    ),
  };
});

vi.mock('@/lib/google/gmail-participants', async () => {
  const result = await import('@/lib/util/result');
  return {
    // Anything not set up below is a thread that is gone.
    readThreadParticipants: vi.fn(async (_store: unknown, _integration: unknown, id: string) => {
      const read = gmail.threads.get(id);
      return read ? read() : result.err('not_found', 'That conversation is not in the mailbox.');
    }),
  };
});

const NOW = new Date('2026-10-13T16:00:00Z');
const STORE = {} as DataStore;
const INTEGRATION = {
  status: 'connected',
  account_email: 'nick@tiptop.vc',
  scopes: [],
} as unknown as Integration;

const raw = (id: string, messages: [from: string, to: string, cc?: string][]) => () =>
  ok({
    id,
    subject: `Subject ${id}`,
    messages: messages.map(([from, to, cc = '']) => ({
      from,
      to,
      cc,
      at: '2026-09-01T00:00:00.000Z',
    })),
  });

const rateLimited = () => err('provider_unavailable', 'Gmail returned 429.', { retryable: true });

beforeEach(() => {
  resetWarmPathsCache();
  gmail.threads.clear();
  gmail.search = () => [];
});

describe('Gmail failures', () => {
  it('a failed thread read is an error, not an empty answer, and is not cached', async () => {
    gmail.search = (q) => (q.includes('harbor.example') ? ['0a0000000001', '0a0000000002'] : []);
    gmail.threads.set('0a0000000001', rateLimited);
    gmail.threads.set('0a0000000002', rateLimited);
    const query = { kind: 'email', email: 'jane@harbor.example' } as const;

    const first = await findWarmPaths(STORE, 'org-1', INTEGRATION, query, { now: NOW });
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.code).toBe('provider_unavailable');
      expect(first.error.retryable).toBe(true);
    }

    // Gmail recovers: the next ask reads the mail instead of a remembered "nobody".
    gmail.threads.set(
      '0a0000000001',
      raw('0a0000000001', [['Jane Doe <jane@harbor.example>', 'nick@tiptop.vc']]),
    );
    gmail.threads.set(
      '0a0000000002',
      raw('0a0000000002', [['nick@tiptop.vc', 'jane@harbor.example, Ann Lee <ann@birch.example>']]),
    );
    const later = new Date(NOW.getTime() + 60_000);
    const second = await findWarmPaths(STORE, 'org-1', INTEGRATION, query, { now: later });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.checkedAt).toBe(later.toISOString());
    expect(second.value.known.map((p) => [p.email, p.threads])).toEqual([
      ['jane@harbor.example', 2],
    ]);
    expect(second.value.introducers.map((p) => p.email)).toEqual(['ann@birch.example']);
  });

  it('one failed read out of several still fails the whole answer', async () => {
    gmail.search = () => ['0b0000000001', '0b0000000002'];
    gmail.threads.set(
      '0b0000000001',
      raw('0b0000000001', [['jane@harbor.example', 'nick@tiptop.vc']]),
    );
    gmail.threads.set('0b0000000002', rateLimited);
    const res = await findWarmPaths(
      STORE,
      'org-1',
      INTEGRATION,
      { kind: 'email', email: 'jane@harbor.example' },
      { now: NOW },
    );
    expect(res.ok).toBe(false);
  });

  it('a firm lookup with failed reads is an error, not "no domain found"', async () => {
    gmail.search = () => ['0c0000000001'];
    gmail.threads.set('0c0000000001', rateLimited);
    const res = await findWarmPaths(
      STORE,
      'org-1',
      INTEGRATION,
      { kind: 'firm', firm: 'Harbor Family Office' },
      { now: NOW },
    );
    expect(res.ok).toBe(false);
  });

  it('a thread that is gone (or only a draft) is skipped, not a failure', async () => {
    gmail.search = () => ['0d0000000001', '0d00000000ff'];
    gmail.threads.set(
      '0d0000000001',
      raw('0d0000000001', [['jane@harbor.example', 'nick@tiptop.vc']]),
    );
    const res = await findWarmPaths(
      STORE,
      'org-1',
      INTEGRATION,
      { kind: 'email', email: 'jane@harbor.example' },
      { now: NOW },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.known.map((p) => p.email)).toEqual(['jane@harbor.example']);
  });

  it('an LP thread that is gone says so', async () => {
    const res = await findWarmPaths(
      STORE,
      'org-1',
      INTEGRATION,
      { kind: 'thread', thread: '0e00000000ff', firm: null },
      { now: NOW },
    );
    expect(res.ok && res.value).toMatchObject({
      state: 'no_target',
      message: "That thread isn't in your mail anymore.",
    });
  });
});

describe('LP thread with a firm hint', () => {
  // Bob introduces Nick to Jane, who uses Gmail. Carla is Bob's colleague.
  const INTRO = '0f0000000001';
  const introThread = raw(INTRO, [
    ['Bob Reyes <bob@introfirm.example>', 'nick@tiptop.vc, Jane <jane.harbor@gmail.com>'],
  ]);

  it('falls back to the firm name when the thread does not show it', async () => {
    gmail.threads.set(INTRO, introThread);
    gmail.threads.set(
      '0f0000000002',
      raw('0f0000000002', [['Carl Ito <carl@harborfo.example>', 'nick@tiptop.vc']]),
    );
    gmail.threads.set(
      '0f0000000003',
      raw('0f0000000003', [['nick@tiptop.vc', 'carl@harborfo.example, mia@harborfo.example']]),
    );
    gmail.search = (q) => {
      if (q.startsWith('"Harbor Family Office"')) return ['0f0000000002', '0f0000000003'];
      if (q.includes('harborfo.example')) return ['0f0000000002', '0f0000000003'];
      return [];
    };
    const res = await findWarmPaths(
      STORE,
      'org-1',
      INTEGRATION,
      { kind: 'thread', thread: INTRO, firm: 'Harbor Family Office' },
      { now: NOW },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.target).toEqual({
      kind: 'domain',
      label: 'Harbor Family Office',
      domains: ['harborfo.example'],
      addresses: [],
    });
    const known = res.value.known.map((p) => p.email);
    expect(known).toEqual(['carl@harborfo.example', 'mia@harborfo.example']);
    expect(known).not.toContain('bob@introfirm.example');
  });

  it('is unsure, with the people on the thread to pick from, when the firm cannot be found', async () => {
    gmail.threads.set(INTRO, introThread);
    gmail.search = () => [];
    const res = await findWarmPaths(
      STORE,
      'org-1',
      INTEGRATION,
      { kind: 'thread', thread: INTRO, firm: 'Harbor Family Office' },
      { now: NOW },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({
      state: 'unsure',
      target: null,
      known: [],
      message:
        "Couldn't tell which email domain is Harbor Family Office's, so nothing was guessed.",
      candidates: ['introfirm.example', 'jane.harbor@gmail.com'],
      choices: [
        { email: 'bob@introfirm.example', name: 'Bob Reyes' },
        { email: 'jane.harbor@gmail.com', name: 'Jane' },
      ],
    });
  });

  it('without a firm hint, an intro thread is unsure rather than merged', async () => {
    gmail.threads.set(INTRO, introThread);
    const res = await findWarmPaths(
      STORE,
      'org-1',
      INTEGRATION,
      { kind: 'thread', thread: INTRO, firm: null },
      { now: NOW },
    );
    expect(res.ok && res.value.state).toBe('unsure');
    expect(res.ok && res.value.choices.map((c) => c.email)).toEqual([
      'bob@introfirm.example',
      'jane.harbor@gmail.com',
    ]);
  });
});
