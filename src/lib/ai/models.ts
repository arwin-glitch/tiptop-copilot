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
export const PRICE_TABLE: Readonly<Record<string, { input: number; output: number }>> = {
  // Anthropic list prices per million tokens, October 2026 (D-076). A model
  // missing here falls back to the most expensive rate, which overstates
  // spend and trips the daily budget early: add new models when they ship.
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  // Haiku 5.5's rate for prompts up to 100K tokens; longer ones bill at
  // $0.50/$2.50, which no fast-tier call here comes near.
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
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
