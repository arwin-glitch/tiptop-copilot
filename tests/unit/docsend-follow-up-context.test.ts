import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataStore } from '@/lib/db/store';
import {
  MAX_LOOKUPS,
  readFollowUpContext,
  resetFollowUpCache,
} from '@/lib/services/docsend-follow-up';

/**
 * The "You emailed them" check outside demo mode, against a mocked read-only
 * Gmail. A reader whose sent mail was not checked must be reported as not
 * checked, never as "not emailed". All addresses are fictional.
 */

const gmail = vi.hoisted(() => ({
  /** Address -> newest sent message id, `null` for none, `'fail'` for a Gmail error. */
  sent: new Map<string, string | null | 'fail'>(),
  lookups: 0,
}));

vi.mock('@/lib/config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config/env')>()),
  isDemoMode: () => false,
}));

vi.mock('@/lib/services/inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/inbox')>()),
  getPrimaryIntegration: vi.fn(async () => ({
    status: 'connected',
    account_email: 'nick@tiptop.vc',
    scopes: [],
  })),
}));

vi.mock('@/lib/google/gmail-inbox', async (importOriginal) => {
  const result = await import('@/lib/util/result');
  return {
    ...(await importOriginal<typeof import('@/lib/google/gmail-inbox')>()),
    listMessageIds: vi.fn(async (_store: unknown, _integration: unknown, q: string) => {
      gmail.lookups += 1;
      const address = /\{to:(\S+) /.exec(q)?.[1] ?? '';
      const hit = gmail.sent.get(address) ?? null;
      if (hit === 'fail') return result.err('provider_unavailable', 'Gmail returned 429.');
      return result.ok(hit ? [hit] : []);
    }),
    readMessageHeadline: vi.fn(async (_store: unknown, _integration: unknown, id: string) => ({
      id,
      threadId: id,
      subject: 'Following up - TipTop Ventures',
      at: '2026-10-01T15:00:00.000Z',
    })),
  };
});

const NOW = new Date('2026-10-13T16:00:00Z');
const STORE = {} as DataStore;

beforeEach(() => {
  resetFollowUpCache();
  gmail.sent.clear();
  gmail.lookups = 0;
});

describe('sent-mail check for every Follow up button', () => {
  it('checks well past the old cap of 20, including earlier readers', async () => {
    const emails = Array.from({ length: 25 }, (_, i) => `reader${i}@lp${i}.example`);
    gmail.sent.set('reader14@lp14.example', 'sent0014');
    const ctx = await readFollowUpContext(STORE, 'org-1', emails, { now: NOW });
    expect(ctx.checked.size).toBe(25);
    expect(ctx.lastSent).toEqual({ 'reader14@lp14.example': '2026-10-01T15:00:00.000Z' });
  });

  it('reports failed and over-the-cap lookups as not checked, never as "not emailed"', async () => {
    const emails = Array.from({ length: MAX_LOOKUPS + 3 }, (_, i) => `r${i}@lp.example`);
    gmail.sent.set('r2@lp.example', 'fail');
    const ctx = await readFollowUpContext(STORE, 'org-1', emails, { now: NOW });
    expect(ctx.checked.has('r0@lp.example')).toBe(true);
    expect(ctx.checked.has('r2@lp.example')).toBe(false);
    expect(ctx.checked.has(`r${MAX_LOOKUPS}@lp.example`)).toBe(false);
    expect(ctx.checked.size).toBe(MAX_LOOKUPS - 1);
    expect(ctx.lastSent).toEqual({});
  });

  it('remembers a finished check for 10 minutes, but retries a failed one', async () => {
    gmail.sent.set('a@lp.example', 'fail');
    gmail.sent.set('b@lp.example', 'sent00b');
    await readFollowUpContext(STORE, 'org-1', ['a@lp.example', 'b@lp.example'], { now: NOW });
    expect(gmail.lookups).toBe(2);

    gmail.sent.set('a@lp.example', null);
    const later = new Date(NOW.getTime() + 60_000);
    const ctx = await readFollowUpContext(STORE, 'org-1', ['a@lp.example', 'b@lp.example'], {
      now: later,
    });
    expect(gmail.lookups).toBe(3);
    expect([...ctx.checked].sort()).toEqual(['a@lp.example', 'b@lp.example']);
    expect(ctx.lastSent).toEqual({ 'b@lp.example': '2026-10-01T15:00:00.000Z' });
  });

  it('an address that cannot be searched safely is not checked', async () => {
    const ctx = await readFollowUpContext(STORE, 'org-1', ['x}@lp.example'], { now: NOW });
    expect(ctx.checked.size).toBe(0);
    expect(gmail.lookups).toBe(0);
  });
});
