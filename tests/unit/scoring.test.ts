import { describe, expect, it } from 'vitest';
import {
  computeConfidence,
  computeEvidenceQuality,
  computeScorecard,
  deriveRecommendation,
} from '@/lib/deals/scoring';
import { DEFAULT_SCORING_WEIGHTS, DEFAULT_THRESHOLDS, type RedFlag } from '@/lib/types/domain';

const weights = DEFAULT_SCORING_WEIGHTS;

function scored(overrides: Record<string, number | null>) {
  return weights.map((w) => ({
    key: w.key,
    score: overrides[w.key] ?? null,
    rationale: 'test',
    citationIds: overrides[w.key] === null || overrides[w.key] === undefined ? [] : ['c1'],
  }));
}

describe('computeScorecard', () => {
  it('normalises over attempted weight, not the full 100 points', () => {
    // Two categories scored perfectly, everything else unknown. The company is
    // not "23/100 bad" — it is 100/100 on what we actually know.
    const result = computeScorecard(weights, scored({ thesis_fit: 100, team: 100 }));

    expect(result.qualityScore).toBe(100);
    expect(result.attemptedWeight).toBe(30);
    expect(result.totalWeight).toBe(100);
    expect(result.dataCompleteness).toBe(30);
  });

  it('records a category with no evidence as unscored, never as zero', () => {
    const result = computeScorecard(weights, scored({ thesis_fit: 80 }));
    const unscored = result.categories.filter((c) => c.status === 'unscored');

    expect(unscored.length).toBe(weights.length - 1);
    expect(unscored.every((c) => c.score === null)).toBe(true);
    // A zero would have dragged the score down; unscored leaves it alone.
    expect(result.qualityScore).toBe(80);
  });

  it('distinguishes a genuine zero from missing data', () => {
    const missing = computeScorecard(weights, scored({ thesis_fit: 90 }));
    const actuallyBad = computeScorecard(weights, scored({ thesis_fit: 90, team: 0 }));

    expect(missing.qualityScore).toBe(90);
    // Scoring team at 0 must move the number; treating it as unknown must not.
    expect(actuallyBad.qualityScore).toBeLessThan(missing.qualityScore);
    expect(actuallyBad.dataCompleteness).toBeGreaterThan(missing.dataCompleteness);
  });

  it('honours disabled categories by excluding them from the total', () => {
    const custom = weights.map((w) => (w.key === 'value_add' ? { ...w, enabled: false } : w));
    const result = computeScorecard(custom, scored({ thesis_fit: 100 }));

    expect(result.totalWeight).toBe(93);
    expect(result.categories.some((c) => c.key === 'value_add')).toBe(false);
  });

  it('clamps out-of-range scores rather than trusting the model', () => {
    const result = computeScorecard(weights, scored({ thesis_fit: 150, team: -20 }));
    const fit = result.categories.find((c) => c.key === 'thesis_fit');
    const team = result.categories.find((c) => c.key === 'team');

    expect(fit?.score).toBe(100);
    expect(team?.score).toBe(0);
  });

  it('returns zero rather than dividing by zero when nothing is scored', () => {
    const result = computeScorecard(weights, scored({}));
    expect(result.qualityScore).toBe(0);
    expect(result.attemptedWeight).toBe(0);
    expect(result.dataCompleteness).toBe(0);
  });
});

describe('deriveRecommendation', () => {
  const noFlags: RedFlag[] = [];

  it('returns INSUFFICIENT_DATA below the completeness floor, whatever the score', () => {
    const result = deriveRecommendation({
      qualityScore: 95,
      dataCompleteness: 20,
      redFlags: noFlags,
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(result.recommendation).toBe('INSUFFICIENT_DATA');
    expect(result.cappedBy).toBe('data_completeness');
  });

  it('maps scores onto the configured thresholds', () => {
    const at = (qualityScore: number) =>
      deriveRecommendation({
        qualityScore,
        dataCompleteness: 80,
        redFlags: noFlags,
        thresholds: DEFAULT_THRESHOLDS,
      }).recommendation;

    expect(at(20)).toBe('PASS');
    expect(at(50)).toBe('MONITOR');
    expect(at(65)).toBe('DIG_DEEPER');
    expect(at(90)).toBe('ADVANCE');
  });

  it('respects custom thresholds rather than hard-coded ones', () => {
    const strict = { ...DEFAULT_THRESHOLDS, advance_at: 95, monitor_below: 80, pass_below: 60 };
    const result = deriveRecommendation({
      qualityScore: 90,
      dataCompleteness: 80,
      redFlags: noFlags,
      thresholds: strict,
    });
    expect(result.recommendation).toBe('DIG_DEEPER');
  });

  it('caps at MONITOR when a hard red flag is unresolved', () => {
    const result = deriveRecommendation({
      qualityScore: 92,
      dataCompleteness: 90,
      redFlags: [
        { label: 'Data rights', severity: 'hard', detail: 'x', resolved: false, citation_ids: [] },
      ],
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(result.recommendation).toBe('MONITOR');
    expect(result.cappedBy).toBe('hard_red_flag');
    // The cap must not rewrite the score, so resolving it restores the label.
    expect(result.explanation).toContain('92');
  });

  it('lifts the cap once the hard flag is resolved', () => {
    const flags: RedFlag[] = [
      { label: 'Data rights', severity: 'hard', detail: 'x', resolved: true, citation_ids: [] },
    ];
    const result = deriveRecommendation({
      qualityScore: 92,
      dataCompleteness: 90,
      redFlags: flags,
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(result.recommendation).toBe('ADVANCE');
    expect(result.cappedBy).toBeNull();
  });

  it('ignores soft flags for the purposes of capping', () => {
    const result = deriveRecommendation({
      qualityScore: 92,
      dataCompleteness: 90,
      redFlags: [
        { label: 'Crowded', severity: 'soft', detail: 'x', resolved: false, citation_ids: [] },
      ],
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(result.recommendation).toBe('ADVANCE');
  });

  it('lets the model argue down but never up', () => {
    const down = deriveRecommendation({
      qualityScore: 90,
      dataCompleteness: 90,
      redFlags: noFlags,
      thresholds: DEFAULT_THRESHOLDS,
      modelSuggestion: 'MONITOR',
    });
    expect(down.recommendation).toBe('MONITOR');
    expect(down.cappedBy).toBe('model_downgrade');

    const up = deriveRecommendation({
      qualityScore: 30,
      dataCompleteness: 90,
      redFlags: noFlags,
      thresholds: DEFAULT_THRESHOLDS,
      modelSuggestion: 'ADVANCE',
    });
    // Enthusiasm does not raise the label.
    expect(up.recommendation).toBe('PASS');
  });

  it('never produces a value outside the five permitted labels', () => {
    const permitted = ['INSUFFICIENT_DATA', 'PASS', 'MONITOR', 'DIG_DEEPER', 'ADVANCE'];
    for (let score = 0; score <= 100; score += 5) {
      for (const completeness of [10, 40, 70, 100]) {
        const result = deriveRecommendation({
          qualityScore: score,
          dataCompleteness: completeness,
          redFlags: noFlags,
          thresholds: DEFAULT_THRESHOLDS,
        });
        expect(permitted).toContain(result.recommendation);
        // "INVESTED" is not a recommendation the system can emit at all.
        expect(result.recommendation).not.toBe('INVESTED');
      }
    }
  });
});

describe('computeConfidence', () => {
  it('is lower near a threshold boundary than well clear of it', () => {
    const base = {
      dataCompleteness: 90,
      evidenceQuality: 80,
      thresholds: DEFAULT_THRESHOLDS,
      sourceCount: 4,
    };
    const borderline = computeConfidence({ ...base, qualityScore: DEFAULT_THRESHOLDS.advance_at });
    const clear = computeConfidence({ ...base, qualityScore: 95 });

    expect(borderline).toBeLessThan(clear);
  });

  it('rises with coverage and falls with thin evidence', () => {
    const thin = computeConfidence({
      dataCompleteness: 30,
      evidenceQuality: 30,
      qualityScore: 60,
      thresholds: DEFAULT_THRESHOLDS,
      sourceCount: 1,
    });
    const rich = computeConfidence({
      dataCompleteness: 95,
      evidenceQuality: 90,
      qualityScore: 60,
      thresholds: DEFAULT_THRESHOLDS,
      sourceCount: 6,
    });

    expect(rich).toBeGreaterThan(thin);
  });

  it('stays inside 5..95 — never claims certainty', () => {
    const max = computeConfidence({
      dataCompleteness: 100,
      evidenceQuality: 100,
      qualityScore: 100,
      thresholds: DEFAULT_THRESHOLDS,
      sourceCount: 50,
    });
    const min = computeConfidence({
      dataCompleteness: 0,
      evidenceQuality: 0,
      qualityScore: DEFAULT_THRESHOLDS.pass_below,
      thresholds: DEFAULT_THRESHOLDS,
      sourceCount: 0,
    });

    expect(max).toBeLessThanOrEqual(95);
    expect(min).toBeGreaterThanOrEqual(5);
  });
});

describe('computeEvidenceQuality', () => {
  it('weights third-party corroboration above a founder assertion', () => {
    const founderOnly = computeEvidenceQuality({
      documentCitations: 0,
      founderClaimCitations: 4,
      thirdPartyCitations: 0,
      inferenceCount: 0,
    });
    const corroborated = computeEvidenceQuality({
      documentCitations: 0,
      founderClaimCitations: 0,
      thirdPartyCitations: 4,
      inferenceCount: 0,
    });

    expect(corroborated).toBeGreaterThan(founderOnly);
  });

  it('scores uncited inference at zero contribution', () => {
    const allInference = computeEvidenceQuality({
      documentCitations: 0,
      founderClaimCitations: 0,
      thirdPartyCitations: 0,
      inferenceCount: 5,
    });
    expect(allInference).toBe(0);
  });

  it('returns 0 when there is no evidence at all', () => {
    expect(
      computeEvidenceQuality({
        documentCitations: 0,
        founderClaimCitations: 0,
        thirdPartyCitations: 0,
        inferenceCount: 0,
      }),
    ).toBe(0);
  });
});
