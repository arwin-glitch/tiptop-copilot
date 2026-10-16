import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshPortfolioAsksOnView, resetPortfolioAsks } from '@/lib/services/portfolio-asks';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Portfolio > Requests outside demo mode, against a mocked read-only Gmail:
 * the view hands the read to `after` and starts nothing itself, and the read
 * leaves an audit row even when Gmail fails. Fictional mailbox only.
 */

const gmail = vi.hoisted(() => ({ lookups: 0 }));

vi.mock('@/lib/config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config/env')>()),
  isDemoMode: () => false,
}));

vi.mock('@/lib/services/inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/inbox')>()),
  getPrimaryIntegration: vi.fn(async () => ({
    status: 'connected',
    account_email: 'partner@fund.example',
    scopes: [],
  })),
}));

vi.mock('@/lib/google/gmail-inbox', async (importOriginal) => {
  const result = await import('@/lib/util/result');
  return {
    ...(await importOriginal<typeof import('@/lib/google/gmail-inbox')>()),
    listMessageIds: vi.fn(async () => {
      gmail.lookups += 1;
      return result.err('provider_unavailable', 'Gmail returned 503.');
    }),
  };
});

const NOW = new Date('2026-10-15T15:00:00Z');

describe('the Requests view outside demo mode', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness({ now: NOW });
    resetPortfolioAsks();
    gmail.lookups = 0;
  });
  afterEach(async () => {
    resetPortfolioAsks();
    await harness.dispose();
  });

  it('schedules the Gmail read with after(), and the read records itself when Gmail fails', async () => {
    const org = harness.auth.organizationId;
    const tasks: (() => Promise<unknown>)[] = [];
    const started = await refreshPortfolioAsksOnView(harness.store, org, {
      schedule: (task) => {
        tasks.push(task);
      },
      now: NOW,
    });
    expect(started).toBe('scheduled');
    expect(tasks).toHaveLength(1);
    // Nothing has touched Gmail while the page renders.
    expect(gmail.lookups).toBe(0);

    await tasks[0]?.();
    expect(gmail.lookups).toBe(1);
    const audits = (await harness.store.list('audit_events', org, {
      eq: { action: 'portfolio.asks_read' },
    })) as { metadata: Record<string, unknown> }[];
    expect(audits.map((a) => a.metadata)).toEqual([
      expect.objectContaining({
        trigger: 'view',
        state: 'error',
        error: 'provider_unavailable',
        emails_scanned: 0,
        asks_found: 0,
        inserted: 0,
      }),
    ]);

    // Failed: the next view inside five minutes does not try again.
    const again: (() => Promise<unknown>)[] = [];
    expect(
      await refreshPortfolioAsksOnView(harness.store, org, {
        schedule: (task) => {
          again.push(task);
        },
        now: new Date(NOW.getTime() + 60_000),
      }),
    ).toBe('throttled');
    expect(again).toHaveLength(0);
  });
});
