import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import {
  checkAiBudget,
  getUsageWindow,
  rateLimit,
  recordAiUsage,
  resetLimiters,
} from '@/lib/security/limits';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Rate limits and the daily budget are enforced against persisted `ai_usage`
 * rows, not in-process counters, so the ceiling survives a cold start. The
 * in-process cache may only ever deny faster — it must never grant.
 */

const ORIGINAL = {
  requests: process.env.MAX_AI_REQUESTS_PER_USER_PER_HOUR,
  budget: process.env.DAILY_AI_BUDGET_USD,
};

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
  process.env.MAX_AI_REQUESTS_PER_USER_PER_HOUR = ORIGINAL.requests;
  process.env.DAILY_AI_BUDGET_USD = ORIGINAL.budget;
  resetEnvCache();
  resetLimiters();
});

async function spend(costUsd: number, count = 1, userId = harness.auth.userId) {
  for (let i = 0; i < count; i++) {
    await recordAiUsage(harness.store, {
      organizationId: harness.auth.organizationId,
      userId,
      operation: 'deal.analyze',
      promptVersion: 'v1',
      usage: {
        model: 'test-model',
        inputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 0,
        estimatedCostUsd: costUsd,
        durationMs: 1,
      },
      ok: true,
      errorCode: null,
    });
  }
}

describe('getUsageWindow', () => {
  it('counts this user’s requests in the last hour and the org’s spend today', async () => {
    await spend(0.25, 3);

    const window = await getUsageWindow(
      harness.store,
      harness.auth.organizationId,
      harness.auth.userId,
    );
    expect(window.requestsThisHour).toBe(3);
    expect(window.spendTodayUsd).toBeCloseTo(0.75, 6);
  });

  it('excludes usage older than the window', async () => {
    await harness.store.insert('ai_usage', {
      id: 'old-usage',
      organization_id: harness.auth.organizationId,
      user_id: harness.auth.userId,
      operation: 'deal.analyze',
      model: 'test-model',
      prompt_version: 'v1',
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      estimated_cost_usd: 99,
      ok: true,
      error_code: null,
      duration_ms: 1,
      created_at: new Date(Date.now() - 48 * 3_600_000).toISOString(),
    });

    const window = await getUsageWindow(
      harness.store,
      harness.auth.organizationId,
      harness.auth.userId,
    );
    expect(window.requestsThisHour).toBe(0);
    expect(window.spendTodayUsd).toBe(0);
  });

  it('scopes the hourly count to one user but the budget to the organization', async () => {
    await spend(1, 2, harness.auth.userId);
    await spend(1, 2, 'someone-else');

    const window = await getUsageWindow(
      harness.store,
      harness.auth.organizationId,
      harness.auth.userId,
    );
    expect(window.requestsThisHour).toBe(2);
    expect(window.spendTodayUsd).toBeCloseTo(4, 6);
  });
});

describe('checkAiBudget', () => {
  it('allows a call while under both ceilings', async () => {
    const result = await checkAiBudget(
      harness.store,
      harness.auth.organizationId,
      harness.auth.userId,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses once the hourly request limit is reached, and says what still works', async () => {
    process.env.MAX_AI_REQUESTS_PER_USER_PER_HOUR = '2';
    resetEnvCache();
    await spend(0, 2);

    const result = await checkAiBudget(
      harness.store,
      harness.auth.organizationId,
      harness.auth.userId,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('rate_limited');
      expect(result.error.retryable).toBe(true);
      expect(result.error.stillUsable).toContain('Stored analyses');
    }
  });

  it('refuses once the daily budget is spent, and names the variable to raise', async () => {
    process.env.DAILY_AI_BUDGET_USD = '1';
    resetEnvCache();
    await spend(1.5, 1);

    const result = await checkAiBudget(
      harness.store,
      harness.auth.organizationId,
      harness.auth.userId,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('budget_exceeded');
      expect(result.error.message).toContain('DAILY_AI_BUDGET_USD');
    }
  });

  it('does not let one organization’s spend block another', async () => {
    process.env.DAILY_AI_BUDGET_USD = '1';
    resetEnvCache();
    await spend(5, 1);

    const other = await checkAiBudget(harness.store, 'other-org-id', 'other-user');
    expect(other.ok).toBe(true);
  });

  it('caches only the denial — a cleared limiter re-reads the database', async () => {
    process.env.MAX_AI_REQUESTS_PER_USER_PER_HOUR = '1';
    resetEnvCache();
    await spend(0, 1);

    expect(
      (await checkAiBudget(harness.store, harness.auth.organizationId, harness.auth.userId)).ok,
    ).toBe(false);

    // Raising the ceiling must take effect once the deny cache is cleared;
    // the cache is a fast "no", never a persisted "no".
    process.env.MAX_AI_REQUESTS_PER_USER_PER_HOUR = '500';
    resetEnvCache();
    resetLimiters();
    expect(
      (await checkAiBudget(harness.store, harness.auth.organizationId, harness.auth.userId)).ok,
    ).toBe(true);
  });
});

describe('recordAiUsage', () => {
  it('records a failed call with its error code and zero cost', async () => {
    await recordAiUsage(harness.store, {
      organizationId: harness.auth.organizationId,
      userId: harness.auth.userId,
      operation: 'deal.analyze',
      promptVersion: 'v1',
      usage: null,
      ok: false,
      errorCode: 'provider_unavailable',
    });

    const rows = await harness.store.list('ai_usage', harness.auth.organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(false);
    expect(rows[0]!.error_code).toBe('provider_unavailable');
    expect(rows[0]!.estimated_cost_usd).toBe(0);
    // A failed call still consumes a request slot — that is the point.
    expect(rows[0]!.model).toBe('unknown');
  });
});

describe('rateLimit', () => {
  it('allows up to max within the window then refuses with a retry hint', () => {
    const now = 1_000_000;
    expect(rateLimit('k', 3, 60_000, now).ok).toBe(true);
    expect(rateLimit('k', 3, 60_000, now + 1).ok).toBe(true);
    expect(rateLimit('k', 3, 60_000, now + 2).ok).toBe(true);

    const denied = rateLimit('k', 3, 60_000, now + 3);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe('rate_limited');
      expect(denied.error.details?.retry_after_seconds).toBe(60);
    }
  });

  it('reports the remaining allowance', () => {
    const now = 2_000_000;
    const first = rateLimit('remaining', 3, 60_000, now);
    expect(first.ok && first.value.remaining).toBe(2);
    const second = rateLimit('remaining', 3, 60_000, now + 1);
    expect(second.ok && second.value.remaining).toBe(1);
  });

  it('starts a fresh window once the old one expires', () => {
    const now = 3_000_000;
    rateLimit('window', 1, 1_000, now);
    expect(rateLimit('window', 1, 1_000, now + 500).ok).toBe(false);
    expect(rateLimit('window', 1, 1_000, now + 1_001).ok).toBe(true);
  });

  it('keeps separate buckets per key', () => {
    const now = 4_000_000;
    rateLimit('a', 1, 60_000, now);
    expect(rateLimit('a', 1, 60_000, now).ok).toBe(false);
    expect(rateLimit('b', 1, 60_000, now).ok).toBe(true);
  });
});
