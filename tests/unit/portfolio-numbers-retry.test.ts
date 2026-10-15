import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyLike } from '@/lib/company-updates/classify';
import { setGmailWaitForTests } from '@/lib/google/gmail-get';
import { resetCompanyUpdatesCache } from '@/lib/services/company-updates';
import {
  gmailAskSources,
  refreshPortfolioAsks,
  resetPortfolioAsks,
} from '@/lib/services/portfolio-asks';
import {
  loadPortfolioNumbers,
  readPortfolioNumbers,
  readNumbersSnapshot,
  refreshPortfolioNumbers,
  refreshSettled,
  resetPortfolioNumbersCache,
  resetPortfolioNumbersRefresh,
} from '@/lib/services/portfolio-numbers';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The stored numbers' background refresh shares the update bodies with the
 * asks reader, so it reads them the same way: a rate-limited thread is tried
 * again, paced with the asks read when both run at once. A read a page waits
 * on (the live read, and the first read with nothing stored) still fails
 * fast. Gmail is a mocked fetch over fictional mail.
 */

vi.mock('@/lib/config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config/env')>()),
  isDemoMode: () => false,
}));

vi.mock('@/lib/google/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/oauth')>()),
  getAccessToken: vi.fn(async () => ({ ok: true, value: 'test-access-value' })),
}));

const NOW = new Date('2026-10-15T15:00:00Z');
const PATH = '/gmail/v1/users/me';
const UPDATE = {
  id: 'cd00000000000001',
  from: 'Maya Chen <maya@ledgerly.demo>',
  subject: 'Ledgerly October update',
  at: NOW.getTime() - 3 * 86_400_000,
  body: 'Hi all,\n\nARR reached $910K this month.\n\nThanks,\nMaya',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Gmail with one Ledgerly update whose thread is rate limited on its first `limited` reads. */
function fakeGmail(limited = 1) {
  const threadReads: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const path = url.pathname.slice(PATH.length);
      if (path === '/messages') {
        const q = url.searchParams.get('q') ?? '';
        return json({ messages: q.includes('ledgerly') ? [{ id: UPDATE.id }] : [] });
      }
      if (path === `/messages/${UPDATE.id}`) {
        return json({
          id: UPDATE.id,
          threadId: UPDATE.id,
          labelIds: ['INBOX'],
          snippet: '',
          internalDate: String(UPDATE.at),
          payload: {
            headers: [
              { name: 'From', value: UPDATE.from },
              { name: 'To', value: 'nick@tiptop.demo' },
              { name: 'Subject', value: UPDATE.subject },
            ],
          },
        });
      }
      if (path === `/threads/${UPDATE.id}`) {
        threadReads.push(UPDATE.id);
        if (threadReads.length <= limited) return json({ error: { code: 429 } }, 429);
        return json({
          id: UPDATE.id,
          messages: [
            {
              id: UPDATE.id,
              labelIds: ['INBOX'],
              internalDate: String(UPDATE.at),
              payload: {
                mimeType: 'text/plain',
                headers: [
                  { name: 'From', value: UPDATE.from },
                  { name: 'Subject', value: UPDATE.subject },
                ],
                body: { data: Buffer.from(UPDATE.body).toString('base64url') },
              },
            },
          ],
        });
      }
      return json({ error: { code: 404 } }, 404);
    }),
  );
  return { threadReads };
}

describe('portfolio numbers and a rate-limited Gmail', () => {
  let harness: Harness;
  let companies: CompanyLike[];

  beforeEach(async () => {
    harness = await createHarness({ now: NOW });
    resetCompanyUpdatesCache();
    resetPortfolioNumbersCache();
    resetPortfolioNumbersRefresh();
    resetPortfolioAsks();
    setGmailWaitForTests(async () => {});
    companies = (await harness.store.list('portfolio_companies', harness.auth.organizationId, {
      eq: { is_archived: false },
    })) as CompanyLike[];
  });

  afterEach(async () => {
    setGmailWaitForTests(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetCompanyUpdatesCache();
    resetPortfolioNumbersCache();
    resetPortfolioNumbersRefresh();
    resetPortfolioAsks();
    await harness.dispose();
  });

  it('the background refresh tries a rate-limited thread again', async () => {
    const gmail = fakeGmail();
    const done = await refreshPortfolioNumbers(
      harness.store,
      harness.auth.organizationId,
      companies,
      {
        now: () => NOW,
      },
    );
    expect(done.state).toBe('ok');
    expect(gmail.threadReads).toHaveLength(2);
    expect(done.snapshot?.partial).toBe(false);
    const ledgerly = done.snapshot?.companies.find((c) => c.name === 'Ledgerly');
    expect(ledgerly?.revenue?.value.display).toBe('$910K');
  });

  it('the live page read fails fast and says it is partial', async () => {
    const gmail = fakeGmail();
    const result = await readPortfolioNumbers(
      harness.store,
      harness.auth.organizationId,
      companies,
      {
        now: NOW,
        force: true,
      },
    );
    expect(gmail.threadReads).toHaveLength(1);
    expect(result.partial).toBe(true);
    expect(result.companies.find((c) => c.name === 'Ledgerly')?.revenue ?? null).toBeNull();
  });

  it('the first read the page waits on, with nothing stored, fails fast too', async () => {
    const gmail = fakeGmail();
    const waited: number[] = [];
    setGmailWaitForTests(async (ms) => {
      waited.push(ms);
    });
    const loaded = await loadPortfolioNumbers(
      harness.store,
      harness.auth.organizationId,
      companies,
      // One pass only here; the pass that follows by itself is the next test.
      { now: NOW, maxPasses: 1 },
    );
    // One try, no backoff: the page shows what it could read.
    expect(gmail.threadReads).toHaveLength(1);
    expect(waited).toEqual([]);
    expect(loaded.result).toMatchObject({ state: 'ok', partial: true });

    // The next refresh, in the background, reads what the first one missed.
    const done = await refreshPortfolioNumbers(
      harness.store,
      harness.auth.organizationId,
      companies,
      { now: () => NOW },
    );
    expect(gmail.threadReads).toHaveLength(2);
    expect(
      done.snapshot?.companies.find((c) => c.name === 'Ledgerly')?.revenue?.value.display,
    ).toBe('$910K');
  });

  it('a first read that comes back partial carries on by itself, and that pass tries again', async () => {
    // Limited twice: a second pass that failed fast as well would read nothing new.
    const gmail = fakeGmail(2);
    const org = harness.auth.organizationId;
    const loaded = await loadPortfolioNumbers(harness.store, org, companies, {
      now: NOW,
      pauseMs: 0,
    });
    expect(loaded.result).toMatchObject({ state: 'ok', partial: true });
    expect(loaded.refreshing).toBe(true);
    expect(loaded.pending).not.toBeNull();

    const last = await refreshSettled(loaded.pending!);
    expect(last.next).toBeNull();
    // The first pass's one try, then the background pass's 429 and its retry.
    expect(gmail.threadReads).toHaveLength(3);
    const stored = await readNumbersSnapshot(harness.store, org);
    expect(stored?.partial).toBe(false);
    expect(stored?.companies.find((c) => c.name === 'Ledgerly')?.revenue?.value.display).toBe(
      '$910K',
    );
  });

  it('beside the asks read, never more than four Gmail reads at once, and every body read', async () => {
    const updates = Array.from({ length: 20 }, (_, n) => {
      const ledgerly = n % 2 === 0;
      return {
        id: `ce00000000000${String(n).padStart(3, '0')}`,
        from: ledgerly ? UPDATE.from : 'Jonas Reyes <jonas@stonebridgeops.demo>',
        subject: `${ledgerly ? 'Ledgerly' : 'Stonebridge Ops'} weekly update, week ${n}`,
        at: NOW.getTime() - (n + 1) * 86_400_000,
        body: `Hi all,\n\nARR reached $${700 + n}K.\n\nAsks\n- Intros to buyers in region ${n}\n\nThanks!`,
      };
    });
    const byId = new Map(updates.map((u) => [u.id, u]));
    const tried = new Map<string, number>();
    let inFlight = 0;
    let most = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          const url = new URL(String(input));
          const path = url.pathname.slice(PATH.length);
          if (path === '/messages') {
            return json({ messages: updates.map((u) => ({ id: u.id, threadId: u.id })) });
          }
          const id = decodeURIComponent(path.split('/')[2] ?? '');
          const u = byId.get(id);
          if (!u) return json({ error: { code: 404 } }, 404);
          const headers = [
            { name: 'From', value: u.from },
            { name: 'To', value: 'nick@tiptop.demo' },
            { name: 'Subject', value: u.subject },
          ];
          if (path.startsWith('/messages/')) {
            return json({
              id: u.id,
              threadId: u.id,
              labelIds: ['INBOX'],
              snippet: '',
              internalDate: String(u.at),
              payload: { headers },
            });
          }
          // Every thread is rate limited on its first read.
          const n = (tried.get(id) ?? 0) + 1;
          tried.set(id, n);
          if (n === 1) return json({ error: { code: 429 } }, 429);
          return json({
            id: u.id,
            messages: [
              {
                id: u.id,
                labelIds: ['INBOX'],
                internalDate: String(u.at),
                payload: {
                  mimeType: 'text/plain',
                  headers,
                  body: { data: Buffer.from(u.body).toString('base64url') },
                },
              },
            ],
          });
        } finally {
          inFlight -= 1;
        }
      }),
    );

    const org = harness.auth.organizationId;
    const [numbers, asks] = await Promise.all([
      refreshPortfolioNumbers(harness.store, org, companies, { now: () => NOW }),
      refreshPortfolioAsks(harness.store, org, {
        now: () => NOW,
        read: gmailAskSources,
        trigger: 'daily',
      }),
    ]);
    expect(most).toBeLessThanOrEqual(4);
    expect(numbers.state).toBe('ok');
    expect(asks).toMatchObject({ state: 'ok', updates: 20, asks: 20 });
    const [row] = (
      await harness.store.list('audit_events', org, { eq: { action: 'portfolio.asks_read' } })
    ).map((e) => (e as { metadata: Record<string, unknown> }).metadata);
    expect(row).toMatchObject({ emails_scanned: 20, bodies_failed: 0 });
  });
});
