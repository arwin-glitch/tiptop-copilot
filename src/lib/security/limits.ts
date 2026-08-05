import 'server-only';
import { envLimits, type CostLimits } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import type { AiUsageRecord } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import type { UsageInfo } from '@/lib/ai/provider';

/**
 * Rate limiting and cost control.
 *
 * Both are enforced against persisted `ai_usage` rows rather than in-process
 * counters, so the limit holds across serverless instances. A small in-process
 * cache short-circuits the obvious rejections without a round trip, but it can
 * only ever *deny* faster — it never grants access the database would refuse.
 */

export interface UsageWindow {
  requestsThisHour: number;
  spendTodayUsd: number;
  limits: CostLimits;
}

const denyCache = new Map<string, number>();

function cacheKey(organizationId: string, userId: string): string {
  return `${organizationId}:${userId}`;
}

export async function getUsageWindow(
  store: DataStore,
  organizationId: string,
  userId: string,
  now: Date = new Date(),
): Promise<UsageWindow> {
  const limits = envLimits();
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const dayStart = new Date(now.getTime() - 86_400_000).toISOString();

  const [hourRows, dayRows] = await Promise.all([
    store.list('ai_usage', organizationId, {
      eq: { user_id: userId },
      gte: { created_at: hourAgo },
    }),
    store.list('ai_usage', organizationId, { gte: { created_at: dayStart } }),
  ]);

  const spendTodayUsd = (dayRows as AiUsageRecord[]).reduce(
    (sum, r) => sum + (r.estimated_cost_usd ?? 0),
    0,
  );

  return {
    requestsThisHour: hourRows.length,
    spendTodayUsd: Math.round(spendTodayUsd * 1_000_000) / 1_000_000,
    limits,
  };
}

/** Check before an AI call. Returns a typed refusal that route handlers surface. */
export async function checkAiBudget(
  store: DataStore,
  organizationId: string,
  userId: string,
  now: Date = new Date(),
): Promise<Result<UsageWindow>> {
  const cached = denyCache.get(cacheKey(organizationId, userId));
  if (cached && cached > now.getTime()) {
    return err('rate_limited', 'Hourly AI request limit reached. Try again shortly.', {
      retryable: true,
      stillUsable: 'Stored analyses, search and every non-AI screen still work.',
    });
  }

  const window = await getUsageWindow(store, organizationId, userId, now);

  if (window.requestsThisHour >= window.limits.maxAiRequestsPerUserPerHour) {
    // Deny until the top of the next hour rather than re-querying every request.
    denyCache.set(cacheKey(organizationId, userId), now.getTime() + 60_000);
    return err(
      'rate_limited',
      `Hourly AI request limit reached (${window.limits.maxAiRequestsPerUserPerHour}/hour). Try again shortly.`,
      {
        retryable: true,
        stillUsable: 'Stored analyses, search and every non-AI screen still work.',
      },
    );
  }

  if (window.spendTodayUsd >= window.limits.dailyAiBudgetUsd) {
    return err(
      'budget_exceeded',
      `Daily AI budget of $${window.limits.dailyAiBudgetUsd.toFixed(2)} has been reached. Raise DAILY_AI_BUDGET_USD or wait for the window to roll.`,
      { stillUsable: 'Stored analyses, search and every non-AI screen still work.' },
    );
  }

  return ok(window);
}

export async function recordAiUsage(
  store: DataStore,
  args: {
    organizationId: string;
    userId: string | null;
    operation: string;
    promptVersion: string;
    usage: UsageInfo | null;
    ok: boolean;
    errorCode: string | null;
  },
): Promise<void> {
  const record: AiUsageRecord = {
    id: newId(),
    organization_id: args.organizationId,
    user_id: args.userId,
    operation: args.operation,
    model: args.usage?.model ?? 'unknown',
    prompt_version: args.promptVersion,
    input_tokens: args.usage?.inputTokens ?? null,
    output_tokens: args.usage?.outputTokens ?? null,
    cache_read_tokens: args.usage?.cacheReadTokens ?? null,
    estimated_cost_usd: args.usage?.estimatedCostUsd ?? 0,
    ok: args.ok,
    error_code: args.errorCode,
    duration_ms: args.usage?.durationMs ?? 0,
    created_at: new Date().toISOString(),
  };
  await store.insert('ai_usage', record);
}

/* --------------------------------------------------- generic rate limiting */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Fixed-window limiter for non-AI endpoints (sync triggers, uploads, auth).
 * In-process is the right scope here: these are abuse brakes on a single-user
 * internal tool, not a billing control.
 */
export function rateLimit(
  key: string,
  max: number,
  windowMs: number,
  now: number = Date.now(),
): Result<{ remaining: number; resetAt: number }> {
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const bucket = { count: 1, resetAt: now + windowMs };
    buckets.set(key, bucket);
    return ok({ remaining: max - 1, resetAt: bucket.resetAt });
  }
  if (existing.count >= max) {
    const seconds = Math.ceil((existing.resetAt - now) / 1000);
    return err('rate_limited', `Too many requests. Try again in ${seconds}s.`, {
      retryable: true,
      details: { retry_after_seconds: seconds },
    });
  }
  existing.count += 1;
  return ok({ remaining: max - existing.count, resetAt: existing.resetAt });
}

/** Test hook. */
export function resetLimiters(): void {
  buckets.clear();
  denyCache.clear();
}
