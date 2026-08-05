import 'server-only';
import { env } from '@/lib/config/env';
import type { ModelTier } from './provider';

/**
 * Model resolution and cost estimation.
 *
 * Call sites name a *tier*; the concrete model id comes from the environment.
 * That is what makes "swap the deep model" a config change rather than a
 * codebase-wide find-and-replace.
 */

export function modelFor(tier: ModelTier): string {
  return tier === 'fast' ? env().modelFast : env().modelDeep;
}

/**
 * Published per-million-token prices, used only to estimate spend against the
 * configured daily budget. If the provider reports different pricing the
 * budget is conservative, never permissive: unknown models fall back to the
 * most expensive entry.
 */
const PRICE_TABLE: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

const FALLBACK_PRICE = { input: 10, output: 50 };

export function estimateCostUsd(
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
  cacheReadTokens: number | null = null,
): number {
  const price = PRICE_TABLE[model] ?? FALLBACK_PRICE;
  const inTok = inputTokens ?? 0;
  const outTok = outputTokens ?? 0;
  const cached = cacheReadTokens ?? 0;
  // Cache reads bill at roughly a tenth of the input rate.
  const cost =
    (inTok / 1_000_000) * price.input +
    (cached / 1_000_000) * price.input * 0.1 +
    (outTok / 1_000_000) * price.output;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Effort for deep-tier calls. Fast-tier calls run at low effort. */
export function effortFor(tier: ModelTier): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  return tier === 'fast' ? 'low' : env().aiEffortDeep;
}

export function defaultMaxTokens(tier: ModelTier): number {
  return tier === 'fast' ? 4_000 : 16_000;
}
