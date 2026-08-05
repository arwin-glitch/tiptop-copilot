import { describe, expect, it } from 'vitest';
import { deriveRecommendation, computeScorecard } from '@/lib/deals/scoring';
import {
  DEFAULT_SCORING_WEIGHTS,
  DEFAULT_THRESHOLDS,
  RECOMMENDATIONS,
  type RecommendationThresholds,
  type RedFlag,
} from '@/lib/types/domain';

/**
 * Invariants 3, 4 and 5 of the product spine:
 *   the code applies the thresholds, not the model;
 *   a hard red flag caps without rewriting the score;
 *   INVESTED is not a label the system can produce.
 *
 * `scoring.test.ts` covers the arithmetic. This file covers the decision rule
 * end to end, including the paths that would silently regress if someone
 * "simplified" the capping logic.
 */

const flag = (over: Partial<RedFlag> = {}): RedFlag => ({
  label: 'Unclear data rights',
  severity: 'hard',
  detail: 'The training data provenance is not documented.',
  resolved: false,
  citation_ids: [],
  ...over,
});

const base = {
  qualityScore: 88,
  dataCompleteness: 85,
  redFlags: [] as RedFlag[],
  thresholds: DEFAULT_THRESHOLDS,
};

describe('the code applies the thresholds, not the model', () => {
  it('moves the label when only the thresholds change', () => {
    // Same evidence, same score. Nick tightens his bar; the label must follow.
    const lenient: RecommendationThresholds = {
      ...DEFAULT_THRESHOLDS,
      advance_at: 80,
      dig_deeper_below: 80,
      monitor_below: 60,
      pass_below: 40,
    };
    const strict: RecommendationThresholds = {
      ...DEFAULT_THRESHOLDS,
      advance_at: 95,
      dig_deeper_below: 95,
      monitor_below: 85,
      pass_below: 70,
    };

    expect(deriveRecommendation({ ...base, thresholds: lenient }).recommendation).toBe('ADVANCE');
    expect(deriveRecommendation({ ...base, thresholds: strict }).recommendation).toBe('DIG_DEEPER');
  });

  it('ignores a model suggestion that is more optimistic than the arithmetic', () => {
    for (const suggestion of ['ADVANCE', 'DIG_DEEPER', 'MONITOR'] as const) {
      const result = deriveRecommendation({
        ...base,
        qualityScore: 20,
        modelSuggestion: suggestion,
      });
      expect(result.recommendation).toBe('PASS');
      expect(result.cappedBy).toBeNull();
    }
  });

  it('accepts a model suggestion that is more conservative, and says so', () => {
    const result = deriveRecommendation({ ...base, modelSuggestion: 'PASS' });
    expect(result.recommendation).toBe('PASS');
    expect(result.cappedBy).toBe('model_downgrade');
    expect(result.explanation).toContain('88');
  });

  it('does not let a model suggestion override the completeness floor', () => {
    const result = deriveRecommendation({
      ...base,
      dataCompleteness: DEFAULT_THRESHOLDS.minimum_completeness - 1,
      modelSuggestion: 'ADVANCE',
    });
    expect(result.recommendation).toBe('INSUFFICIENT_DATA');
    expect(result.cappedBy).toBe('data_completeness');
  });
});

describe('a hard red flag caps rather than vetoes', () => {
  it('leaves the underlying score intact so resolving the flag restores the label', () => {
    const unresolved = deriveRecommendation({ ...base, redFlags: [flag()] });
    const resolved = deriveRecommendation({ ...base, redFlags: [flag({ resolved: true })] });

    expect(unresolved.recommendation).toBe('MONITOR');
    expect(unresolved.cappedBy).toBe('hard_red_flag');
    // The score is quoted verbatim in the explanation — the cap did not rewrite it.
    expect(unresolved.explanation).toContain('88');

    // Resolving the flag alone, with no other input change, restores ADVANCE.
    expect(resolved.recommendation).toBe('ADVANCE');
    expect(resolved.cappedBy).toBeNull();
  });

  it('never *raises* a label that was already below the cap', () => {
    const result = deriveRecommendation({ ...base, qualityScore: 10, redFlags: [flag()] });
    expect(result.recommendation).toBe('PASS');
  });

  it('caps on any unresolved hard flag, not just the first in the list', () => {
    const result = deriveRecommendation({
      ...base,
      redFlags: [
        flag({ label: 'Fixed', resolved: true }),
        flag({ label: 'Churn', severity: 'soft' }),
        flag({ label: 'Thesis mismatch' }),
      ],
    });
    expect(result.recommendation).toBe('MONITOR');
    expect(result.explanation).toContain('Thesis mismatch');
  });

  it('treats soft flags as commentary, never as a cap', () => {
    const result = deriveRecommendation({
      ...base,
      redFlags: [flag({ severity: 'soft' }), flag({ severity: 'soft', label: 'Crowded market' })],
    });
    expect(result.recommendation).toBe('ADVANCE');
    expect(result.cappedBy).toBeNull();
  });
});

describe('the AI cannot mark a deal invested', () => {
  it('does not include INVESTED among the emittable recommendations', () => {
    expect(RECOMMENDATIONS as readonly string[]).not.toContain('INVESTED');
    expect(RECOMMENDATIONS as readonly string[]).not.toContain('INVEST');
  });

  it('never emits INVESTED for any combination of inputs', () => {
    const permitted = new Set<string>(RECOMMENDATIONS);
    for (let score = 0; score <= 100; score += 4) {
      for (const completeness of [0, 25, 50, 75, 100]) {
        for (const flags of [[], [flag()], [flag({ severity: 'soft' })]]) {
          for (const suggestion of [undefined, 'ADVANCE', 'PASS'] as const) {
            const result = deriveRecommendation({
              qualityScore: score,
              dataCompleteness: completeness,
              redFlags: flags,
              thresholds: DEFAULT_THRESHOLDS,
              ...(suggestion ? { modelSuggestion: suggestion } : {}),
            });
            expect(permitted.has(result.recommendation)).toBe(true);
          }
        }
      }
    }
  });
});

describe('end-to-end: scorecard feeding the recommendation', () => {
  it('a thin but excellent scorecard is INSUFFICIENT_DATA, not ADVANCE', () => {
    // One perfect category out of ten. The arithmetic says 100; coverage says
    // we know almost nothing. Coverage wins.
    const scorecard = computeScorecard(
      DEFAULT_SCORING_WEIGHTS,
      DEFAULT_SCORING_WEIGHTS.map((w) => ({
        key: w.key,
        score: w.key === 'thesis_fit' ? 100 : null,
        rationale: 'test',
        citationIds: w.key === 'thesis_fit' ? ['c1'] : [],
      })),
    );

    expect(scorecard.qualityScore).toBe(100);
    expect(scorecard.dataCompleteness).toBeLessThan(DEFAULT_THRESHOLDS.minimum_completeness);

    const result = deriveRecommendation({
      qualityScore: scorecard.qualityScore,
      dataCompleteness: scorecard.dataCompleteness,
      redFlags: [],
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(result.recommendation).toBe('INSUFFICIENT_DATA');
  });

  it('unscored categories do not drag a good deal into PASS', () => {
    const inputs = DEFAULT_SCORING_WEIGHTS.map((w, i) => ({
      key: w.key,
      // Score two-thirds of the categories well; leave the rest unscored.
      score: i % 3 === 2 ? null : 85,
      rationale: 'test',
      citationIds: i % 3 === 2 ? [] : ['c1'],
    }));
    const scorecard = computeScorecard(DEFAULT_SCORING_WEIGHTS, inputs);
    const result = deriveRecommendation({
      qualityScore: scorecard.qualityScore,
      dataCompleteness: scorecard.dataCompleteness,
      redFlags: [],
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(scorecard.qualityScore).toBe(85);
    expect(result.recommendation).not.toBe('PASS');
    expect(result.recommendation).not.toBe('INSUFFICIENT_DATA');
  });
});
