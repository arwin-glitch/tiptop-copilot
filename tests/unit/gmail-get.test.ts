import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  gmailFailCode,
  gmailGet,
  retryAfterMs,
  setGmailWaitForTests,
} from '@/lib/google/gmail-get';
import { listMessageIds, readThreadFull } from '@/lib/google/gmail-inbox';
import { readMessageMeta } from '@/lib/google/gmail-metadata';
import type { DataStore } from '@/lib/db/store';
import type { Integration } from '@/lib/types/domain';

/**
 * The shared Gmail GET: background reads (`retry`) try Gmail's rate limits
 * and 5xx again with backoff, honouring Retry-After within a deadline;
 * interactive reads still fail on the first non-2xx. Gmail is a mocked fetch
 * and every address is fictional.
 */

vi.mock('@/lib/google/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/oauth')>()),
  getAccessToken: vi.fn(async () => ({ ok: true, value: 'test-access-value' })),
}));

const STORE = {} as DataStore;
const INTEGRATION = {
  status: 'connected',
  account_email: 'nick@tiptop.demo',
  scopes: [],
} as unknown as Integration;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const rateLimit403 = (reason: string) =>
  json(
    {
      error: {
        code: 403,
        message: 'Quota exceeded for quota metric of service gmail.googleapis.com.',
        errors: [{ domain: 'usageLimits', reason }],
      },
    },
    403,
  );

const THREAD = {
  id: '0a00000000000001',
  messages: [
    {
      id: '0a00000000000001',
      labelIds: ['INBOX'],
      internalDate: String(Date.parse('2026-10-01T12:00:00Z')),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'Maya Chen <maya@ledgerly.demo>' },
          { name: 'Subject', value: 'Ledgerly October update' },
        ],
        body: { data: Buffer.from('Asks\n- Intros to Series A leads').toString('base64url') },
      },
    },
  ],
};

/** A fetch that answers with each response in turn, recording the URLs. */
function gmail(...responses: (() => Response | Promise<Response>)[]) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error('no more mocked Gmail responses');
    return next();
  });
  vi.stubGlobal('fetch', fetchMock);
  return { urls, calls: () => fetchMock.mock.calls.length };
}

let waits: number[];

beforeEach(() => {
  waits = [];
  setGmailWaitForTests(async (ms) => {
    waits.push(ms);
  });
});

afterEach(() => {
  setGmailWaitForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const background = { retry: {} };

describe('background reads retry', () => {
  it('tries a 429 again after a backoff near a second', async () => {
    const g = gmail(
      () => json({ error: { code: 429 } }, 429),
      () => json(THREAD),
    );
    const res = await readThreadFull(STORE, INTEGRATION, THREAD.id, background);
    expect(res.ok).toBe(true);
    expect(g.calls()).toBe(2);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(750);
    expect(waits[0]).toBeLessThanOrEqual(1_250);
    if (res.ok) expect(res.value.messages[0]?.text).toContain('Intros to Series A leads');
  });

  it.each(['rateLimitExceeded', 'userRateLimitExceeded'])(
    'tries a 403 %s again',
    async (reason) => {
      const g = gmail(
        () => rateLimit403(reason),
        () => json(THREAD),
      );
      const res = await readThreadFull(STORE, INTEGRATION, THREAD.id, background);
      expect(res.ok).toBe(true);
      expect(g.calls()).toBe(2);
    },
  );

  it("reads the newer error shape's RATE_LIMIT_EXCEEDED as a rate limit too", async () => {
    const g = gmail(
      () =>
        json(
          {
            error: {
              code: 403,
              status: 'PERMISSION_DENIED',
              details: [{ reason: 'RATE_LIMIT_EXCEEDED' }],
            },
          },
          403,
        ),
      () => json({ messages: [{ id: '0a01' }] }),
    );
    const res = await listMessageIds(STORE, INTEGRATION, 'newer_than:45d', 10, background);
    expect(res).toEqual({ ok: true, value: ['0a01'] });
    expect(g.calls()).toBe(2);
  });

  it('never tries a 403 that is not a rate limit again', async () => {
    const g = gmail(() => rateLimit403('insufficientPermissions'));
    const res = await readThreadFull(STORE, INTEGRATION, THREAD.id, background);
    expect(res.ok).toBe(false);
    expect(g.calls()).toBe(1);
    expect(waits).toEqual([]);
    if (!res.ok) expect(gmailFailCode(res.error)).toBe('gmail_4xx');
  });

  it('honours Retry-After, in seconds or as a date, capped at 20 s', async () => {
    gmail(
      () => json({}, 429, { 'retry-after': '3' }),
      () => json({}, 503, { 'retry-after': '120' }),
      () => json(THREAD),
    );
    const res = await readThreadFull(STORE, INTEGRATION, THREAD.id, background);
    expect(res.ok).toBe(true);
    expect(waits).toEqual([3_000, 20_000]);

    const now = Date.parse('2026-10-16T12:00:00Z');
    expect(retryAfterMs('Fri, 16 Oct 2026 12:00:05 GMT', now)).toBe(5_000);
    expect(retryAfterMs('Fri, 16 Oct 2026 11:59:00 GMT', now)).toBe(0);
    expect(retryAfterMs('soon', now)).toBeNull();
    expect(retryAfterMs(null, now)).toBeNull();
  });

  it.each([500, 502, 503, 504])(
    'tries a %i again, four tries in all, backing off',
    async (status) => {
      const g = gmail(
        () => json({}, status),
        () => json({}, status),
        () => json({}, status),
        () => json({}, status),
      );
      const res = await readThreadFull(STORE, INTEGRATION, THREAD.id, background);
      expect(g.calls()).toBe(4);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(gmailFailCode(res.error)).toBe('gmail_5xx');
        // Gmail's status, never its words.
        expect(res.error.message).toBe(`Gmail returned ${status}.`);
      }
      expect(waits).toHaveLength(3);
      const [a = 0, b = 0, c = 0] = waits;
      expect(a).toBeGreaterThanOrEqual(750);
      expect(a).toBeLessThanOrEqual(1_250);
      expect(b).toBeGreaterThanOrEqual(1_500);
      expect(b).toBeLessThanOrEqual(2_500);
      expect(c).toBeGreaterThanOrEqual(3_000);
      expect(c).toBeLessThanOrEqual(5_000);
    },
  );

  it.each([
    [404, 'not_found'],
    [400, 'gmail_4xx'],
    [401, 'gmail_4xx'],
  ] as const)('never tries a %i again', async (status, code) => {
    const g = gmail(() => json({ error: { code: status } }, status));
    const res = await readMessageMeta(STORE, INTEGRATION, '0a00000000000001', background);
    expect(g.calls()).toBe(1);
    expect(waits).toEqual([]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(gmailFailCode(res.error)).toBe(code);
  });

  it('starts no wait that would end after the deadline', async () => {
    const g = gmail(
      () => json({}, 429, { 'retry-after': '10' }),
      () => json(THREAD),
    );
    const res = await readThreadFull(STORE, INTEGRATION, THREAD.id, {
      retry: { deadline: Date.now() + 5_000 },
    });
    expect(g.calls()).toBe(1);
    expect(waits).toEqual([]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(gmailFailCode(res.error)).toBe('rate_limited');
  });

  it('tries an unreachable Gmail again in the background', async () => {
    const g = gmail(
      () => {
        throw new TypeError('fetch failed');
      },
      () => json(THREAD),
    );
    const res = await readThreadFull(STORE, INTEGRATION, THREAD.id, background);
    expect(res.ok).toBe(true);
    expect(g.calls()).toBe(2);
  });
});

/**
 * Request timeouts. AbortSignal.timeout is spied on so a 30 s timeout fires
 * in a few milliseconds, while the time each request asked for is recorded.
 */
describe('background request timeouts', () => {
  let asked: number[];

  beforeEach(() => {
    asked = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      asked.push(ms);
      return real(5);
    });
  });

  /**
   * A Gmail that answers each request in turn, where `'silent'` (and every
   * request past the list) never answers until the request's signal aborts,
   * then fails as `reject` says.
   */
  function silentGmail(
    answers: ('silent' | (() => Response))[] = [],
    reject: (signal: AbortSignal) => unknown = (s) => s.reason,
  ) {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const next = answers.shift() ?? 'silent';
      if (next !== 'silent') return next();
      const signal = init?.signal;
      return new Promise<Response>((_, fail) => {
        if (!signal) return;
        signal.addEventListener('abort', () => fail(reject(signal)));
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { calls: () => fetchMock.mock.calls.length };
  }

  it('gives a silent Gmail 30 s, then tries again', async () => {
    const g = silentGmail(['silent', () => json(THREAD)]);
    const res = await readThreadFull(STORE, INTEGRATION, THREAD.id, background);
    expect(res.ok).toBe(true);
    expect(g.calls()).toBe(2);
    expect(asked).toEqual([30_000, 30_000]);
    expect(waits).toHaveLength(1);
  });

  it('says timeout, however the runtime names the abort, after four tries', async () => {
    // Not a DOMException named TimeoutError: the signal says it timed out.
    const g = silentGmail([], () => new Error('This operation was aborted'));
    const res = await readThreadFull(STORE, INTEGRATION, THREAD.id, background);
    expect(g.calls()).toBe(4);
    expect(asked).toEqual([30_000, 30_000, 30_000, 30_000]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('timeout');
      expect(gmailFailCode(res.error)).toBe('timeout');
    }
  });

  it('never runs a request past the deadline, and says deadline', async () => {
    const g = silentGmail();
    const res = await readThreadFull(STORE, INTEGRATION, THREAD.id, {
      retry: { deadline: Date.now() + 5_000 },
    });
    expect(g.calls()).toBe(1);
    // The request was given the time left, not 30 s, and not tried again.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeGreaterThan(4_000);
    expect(asked[0]).toBeLessThanOrEqual(5_000);
    expect(waits).toEqual([]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(gmailFailCode(res.error)).toBe('deadline');
  });

  it('starts no request once the deadline has passed', async () => {
    const g = silentGmail();
    const res = await readThreadFull(STORE, INTEGRATION, THREAD.id, {
      retry: { deadline: Date.now() - 1 },
    });
    expect(g.calls()).toBe(0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(gmailFailCode(res.error)).toBe('deadline');
  });

  it('an interactive read has no timeout of its own', async () => {
    gmail(() => json(THREAD));
    const res = await readThreadFull(STORE, INTEGRATION, THREAD.id);
    expect(res.ok).toBe(true);
    expect(asked).toEqual([]);
  });
});

/** One mailbox's background reads share one gate, whichever reader asks. */
describe('the mailbox gate', () => {
  /** A Gmail whose requests wait until released, counting how many are in flight. */
  function heldGmail() {
    const held: (() => void)[] = [];
    let inFlight = 0;
    let most = 0;
    const paths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        paths.push(new URL(String(input)).pathname);
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise<void>((resolve) => held.push(resolve));
        inFlight -= 1;
        return json({ labels: [] });
      }),
    );
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    return {
      paths,
      most: () => most,
      inFlight: () => inFlight,
      /** Let every request now waiting answer. */
      releaseAll: async () => {
        while (held.length) {
          for (const r of held.splice(0)) r();
          await tick();
        }
      },
      tick,
    };
  }

  it('lets four background reads of a mailbox run at once, and queues the rest in turn', async () => {
    const g = heldGmail();
    const reads = Array.from({ length: 10 }, () =>
      gmailGet(STORE, INTEGRATION, '/labels', background),
    );
    await g.tick();
    expect(g.inFlight()).toBe(4);
    // A page's read never queues behind them.
    const page = gmailGet(STORE, INTEGRATION, '/labels');
    await g.tick();
    expect(g.inFlight()).toBe(5);
    await g.releaseAll();
    const results = await Promise.all([...reads, page]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(g.paths).toHaveLength(11);
    expect(g.most()).toBe(5);
  });

  it('gives up a queued read when its deadline comes first, without asking Gmail', async () => {
    const g = heldGmail();
    const running = Array.from({ length: 4 }, () =>
      gmailGet(STORE, INTEGRATION, '/labels', background),
    );
    await g.tick();
    const late = await gmailGet(STORE, INTEGRATION, '/labels', {
      retry: { deadline: Date.now() + 20 },
    });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(gmailFailCode(late.error)).toBe('deadline');
    expect(g.paths).toHaveLength(4);
    await g.releaseAll();
    expect((await Promise.all(running)).every((r) => r.ok)).toBe(true);
  });

  it('after a rate limit, the next background read waits it out before asking', async () => {
    const g = gmail(
      () => json({}, 429, { 'retry-after': '3' }),
      () => json(THREAD),
      () => json(THREAD),
    );
    expect((await readThreadFull(STORE, INTEGRATION, THREAD.id, background)).ok).toBe(true);
    expect(waits).toEqual([3_000]);
    // Another reader's read of the same mailbox, started straight after.
    expect((await readThreadFull(STORE, INTEGRATION, THREAD.id, background)).ok).toBe(true);
    expect(waits).toHaveLength(2);
    expect(waits[1]).toBeGreaterThan(2_500);
    expect(waits[1]).toBeLessThanOrEqual(3_000);
    expect(g.calls()).toBe(3);
  });

  it('a read whose deadline comes before the pause ends says rate_limited, without asking', async () => {
    const g = gmail(
      () => json({}, 429, { 'retry-after': '10' }),
      () => json(THREAD),
    );
    expect((await readThreadFull(STORE, INTEGRATION, THREAD.id, background)).ok).toBe(true);
    const res = await readThreadFull(STORE, INTEGRATION, THREAD.id, {
      retry: { deadline: Date.now() + 2_000 },
    });
    expect(g.calls()).toBe(2);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(gmailFailCode(res.error)).toBe('rate_limited');
  });

  it("a page's read is not paused by a background rate limit", async () => {
    const g = gmail(
      () => json({}, 429, { 'retry-after': '10' }),
      () => json(THREAD),
      () => json(THREAD),
    );
    expect((await readThreadFull(STORE, INTEGRATION, THREAD.id, background)).ok).toBe(true);
    expect((await readThreadFull(STORE, INTEGRATION, THREAD.id)).ok).toBe(true);
    expect(waits).toEqual([10_000]);
    expect(g.calls()).toBe(3);
  });
});

describe('interactive reads fail fast', () => {
  it('a 429 is one try and the same error as before', async () => {
    const g = gmail(
      () => json({}, 429, { 'retry-after': '1' }),
      () => json(THREAD),
    );
    const res = await readThreadFull(STORE, INTEGRATION, THREAD.id);
    expect(g.calls()).toBe(1);
    expect(waits).toEqual([]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('provider_unavailable');
      expect(res.error.message).toBe('Gmail returned 429.');
      expect(gmailFailCode(res.error)).toBe('rate_limited');
    }
  });

  it('a 403 rate limit, a 503 or an unreachable Gmail is one try', async () => {
    const g = gmail(
      () => rateLimit403('userRateLimitExceeded'),
      () => json({}, 503),
      () => {
        throw new TypeError('fetch failed');
      },
    );
    const first = await gmailGet(STORE, INTEGRATION, '/labels');
    const second = await gmailGet(STORE, INTEGRATION, '/labels');
    const third = await gmailGet(STORE, INTEGRATION, '/labels');
    expect(g.calls()).toBe(3);
    expect(waits).toEqual([]);
    expect([first, second, third].map((r) => (r.ok ? 'ok' : gmailFailCode(r.error)))).toEqual([
      'rate_limited',
      'gmail_5xx',
      'provider_unavailable',
    ]);
    if (!third.ok) expect(third.error.message).toBe('Could not reach Gmail.');
  });
});
