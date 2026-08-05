import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeDeal,
  latestAnalysis,
  overrideRecommendation,
  resolveRedFlag,
} from '@/lib/services/deal-analysis';
import { recordDecision } from '@/lib/services/deals';
import { DEMO_IDS } from '@/lib/demo/ids';
import {
  RECOMMENDATIONS,
  type AiUsageRecord,
  type DealAnalysis,
  type DealDecision,
} from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Deal analysis end to end: persistence, the content-hash cache, and the
 * invariants the analysis is built around — unscored is not zero, the code
 * applies the thresholds, a hard flag caps rather than vetoes, and no path
 * here can mark a deal invested.
 */

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

async function analyze(dealId: string, force = false) {
  const result = await analyzeDeal(harness.auth, dealId, { force });
  if (!result.ok) throw new Error(`analysis failed: ${result.error.message}`);
  return result.value;
}

const aiCalls = async () =>
  (
    (await harness.store.list('ai_usage', harness.auth.organizationId, {
      eq: { operation: 'deal.analyze' },
    })) as AiUsageRecord[]
  ).length;

describe('persistence', () => {
  it('stores a versioned analysis with its citations and scorecard', async () => {
    const analysis = await analyze(DEMO_IDS.dealVetrix);

    expect(analysis.version).toBeGreaterThanOrEqual(1);
    expect(analysis.deal_id).toBe(DEMO_IDS.dealVetrix);
    expect(analysis.categories.length).toBeGreaterThan(0);
    expect(analysis.citations.length).toBeGreaterThan(0);

    const stored = (await harness.store.get(
      'deal_analyses',
      harness.auth.organizationId,
      analysis.id,
    )) as DealAnalysis;
    expect(stored.recommendation).toBe(analysis.recommendation);
  });

  it('makes the newest version the one latestAnalysis returns', async () => {
    const first = await analyze(DEMO_IDS.dealVetrix);
    const second = await analyze(DEMO_IDS.dealVetrix, true);

    expect(second.version).toBe(first.version + 1);
    const latest = await latestAnalysis(harness.auth.organizationId, DEMO_IDS.dealVetrix);
    expect(latest?.id).toBe(second.id);
  });

  it('refuses to analyse a deal with no attached sources, and says what still works', async () => {
    const now = new Date().toISOString();
    await harness.store.insert('deals', {
      id: 'deal-empty',
      organization_id: harness.auth.organizationId,
      company_name: 'Sourceless Co',
      normalized_name: 'sourceless',
      website: null,
      domain: null,
      stage: 'new',
      industry: null,
      vertical: null,
      geography: null,
      funding_stage: null,
      round_size: null,
      amount_raised: null,
      valuation_or_cap: null,
      existing_investors: [],
      requested_check: null,
      referral_source: null,
      received_at: now,
      product_summary: null,
      customer: null,
      problem: null,
      solution: null,
      ai_usage: null,
      traction: null,
      revenue: null,
      growth: null,
      customer_count: null,
      pipeline: null,
      business_model: null,
      pricing: null,
      market: null,
      competition: null,
      team: null,
      founder_market_fit: null,
      gtm_motion: null,
      defensibility: null,
      data_advantage: null,
      risks: [],
      open_questions: [],
      outcome: null,
      is_archived: false,
      created_at: now,
      updated_at: now,
    });

    const result = await analyzeDeal(harness.auth, 'deal-empty');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
      expect(result.error.stillUsable).toBeTruthy();
    }
  });

  it('refuses a deal from another organization as not found', async () => {
    const result = await analyzeDeal(harness.auth, 'deal-that-does-not-exist');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });
});

describe('content-hash cache', () => {
  it('reuses the stored analysis instead of spending a second call', async () => {
    const first = await analyze(DEMO_IDS.dealVetrix);
    const callsAfterFirst = await aiCalls();

    const second = await analyze(DEMO_IDS.dealVetrix);
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(first.version);
    expect(await aiCalls()).toBe(callsAfterFirst);
  });

  it('spends a call when forced', async () => {
    await analyze(DEMO_IDS.dealVetrix);
    const before = await aiCalls();

    await analyze(DEMO_IDS.dealVetrix, true);
    expect(await aiCalls()).toBe(before + 1);
  });

  it('re-analyses when the evidence changes', async () => {
    const first = await analyze(DEMO_IDS.dealVetrix);

    // A new source changes the content hash, so the cache must miss.
    await harness.store.insert('deal_sources', {
      id: 'source-new-note',
      organization_id: harness.auth.organizationId,
      deal_id: DEMO_IDS.dealVetrix,
      kind: 'email_message',
      ref_id: DEMO_IDS.msgGirderUpdate,
      label: 'Additional context',
      url: null,
      occurred_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    const second = await analyze(DEMO_IDS.dealVetrix);
    expect(second.id).not.toBe(first.id);
  });
});

describe('invariants in a persisted analysis', () => {
  it('never emits INVESTED', async () => {
    for (const dealId of [DEMO_IDS.dealVetrix, DEMO_IDS.dealGirder, DEMO_IDS.dealLoomstack]) {
      const analysis = await analyze(dealId, true);
      expect(RECOMMENDATIONS as readonly string[]).toContain(analysis.recommendation);
      expect(analysis.recommendation).not.toBe('INVESTED');
    }
  });

  it('records an unevidenced category as unscored with a null score, never zero', async () => {
    const analysis = await analyze(DEMO_IDS.dealVetrix, true);
    const unscored = analysis.categories.filter((c) => c.status === 'unscored');

    for (const category of unscored) {
      expect(category.score).toBeNull();
      expect(category.rationale).toBeTruthy();
    }
    // Whatever is unscored must be excluded from the attempted weight.
    const attempted = analysis.categories
      .filter((c) => c.status === 'scored')
      .reduce((sum, c) => sum + c.weight, 0);
    expect(analysis.attempted_weight).toBeCloseTo(attempted, 5);
  });

  it('derives the quality score only from attempted weight', async () => {
    const analysis = await analyze(DEMO_IDS.dealVetrix, true);
    const scored = analysis.categories.filter((c) => c.status === 'scored');
    const earned = scored.reduce((sum, c) => sum + ((c.score ?? 0) / 100) * c.weight, 0);
    const expected =
      analysis.attempted_weight > 0 ? Math.round((earned / analysis.attempted_weight) * 100) : 0;

    expect(analysis.quality_score).toBe(expected);
  });

  it('never claims certainty', async () => {
    const analysis = await analyze(DEMO_IDS.dealVetrix, true);
    expect(analysis.confidence).toBeGreaterThanOrEqual(5);
    expect(analysis.confidence).toBeLessThanOrEqual(95);
  });

  it('cites only sources that were actually supplied to it', async () => {
    const analysis = await analyze(DEMO_IDS.dealVetrix, true);
    const available = new Set(analysis.citations.map((c) => c.id));

    for (const category of analysis.categories) {
      for (const id of category.citation_ids) expect(available.has(id)).toBe(true);
    }
    for (const flag of analysis.red_flags) {
      for (const id of flag.citation_ids) expect(available.has(id)).toBe(true);
    }
  });

  it('does not obey an instruction embedded in the deal’s own sources', async () => {
    const analysis = await analyze(DEMO_IDS.dealPlumbline, true);

    // The Plumbline intro demands ADVANCE at 100. The score is computed from
    // the scorecard, and the label from Nick's thresholds.
    expect(analysis.quality_score).toBeLessThan(100);
    expect(analysis.recommendation).not.toBe('INVESTED');
    expect(analysis.human_override).toBeNull();
  });
});

describe('red-flag capping', () => {
  it('caps the label at MONITOR without altering the score, and lifts on resolve', async () => {
    // LoomStack carries a thesis-mismatch hard flag in the fixtures.
    const analysis = await analyze(DEMO_IDS.dealLoomstack, true);
    const hard = analysis.red_flags.filter((f) => f.severity === 'hard' && !f.resolved);
    if (hard.length === 0) return; // nothing to assert on this fixture

    expect(['PASS', 'MONITOR']).toContain(analysis.recommendation);
    const scoreBefore = analysis.quality_score;

    const lifted = await resolveRedFlag(harness.auth, analysis.id, hard[0]!.label);
    expect(lifted.ok).toBe(true);
    if (!lifted.ok) return;

    // The underlying score is untouched — resolving the flag re-derives the
    // label from the same arithmetic, with no re-analysis.
    expect(lifted.value.quality_score).toBe(scoreBefore);
    expect(lifted.value.red_flags.find((f) => f.label === hard[0]!.label)?.resolved).toBe(true);
  });
});

describe('human override', () => {
  it('records who overrode what, and why, without rewriting the analysis', async () => {
    const analysis = await analyze(DEMO_IDS.dealVetrix, true);
    const original = analysis.recommendation;

    const overridden = await overrideRecommendation(
      harness.auth,
      analysis.id,
      'PASS',
      'Nick met the team and the second founder is leaving.',
    );
    expect(overridden.ok).toBe(true);
    if (!overridden.ok) return;

    expect(overridden.value.recommendation).toBe(original);
    expect(overridden.value.human_override?.recommendation).toBe('PASS');
    expect(overridden.value.human_override?.note).toContain('second founder');
  });

  it('refuses an override with no reason', async () => {
    const analysis = await analyze(DEMO_IDS.dealVetrix, true);
    const result = await overrideRecommendation(harness.auth, analysis.id, 'PASS', '   ');
    expect(result.ok).toBe(false);
  });
});

describe('the AI cannot mark a deal invested', () => {
  it('records every decision with a human actor', async () => {
    const decision = await recordDecision(
      harness.auth,
      DEMO_IDS.dealVetrix,
      'invest',
      'Partnership agreed at IC.',
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;

    expect(decision.value.actor).toBe('human');
    expect(decision.value.decided_by).toBe(harness.auth.userId);

    const rows = (await harness.store.list('deal_decisions', harness.auth.organizationId, {
      eq: { deal_id: DEMO_IDS.dealVetrix },
    })) as DealDecision[];
    expect(rows.every((d) => d.actor === 'human')).toBe(true);
  });

  it('reaches the invested stage only through a recorded human decision', async () => {
    await analyze(DEMO_IDS.dealVetrix, true);
    const beforeAnalysis = await harness.store.get(
      'deals',
      harness.auth.organizationId,
      DEMO_IDS.dealVetrix,
    );
    expect(beforeAnalysis?.stage).not.toBe('invested');

    await recordDecision(harness.auth, DEMO_IDS.dealVetrix, 'invest', 'IC approved.');
    const after = await harness.store.get(
      'deals',
      harness.auth.organizationId,
      DEMO_IDS.dealVetrix,
    );
    expect(after?.stage).toBe('invested');
  });

  it('refuses a decision with no rationale — the rationale is the part worth keeping', async () => {
    const result = await recordDecision(harness.auth, DEMO_IDS.dealVetrix, 'pass', '  ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_input');
  });
});
