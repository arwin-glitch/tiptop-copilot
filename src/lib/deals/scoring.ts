import type {
  Recommendation,
  RecommendationThresholds,
  RedFlag,
  ScorecardCategoryResult,
  ScoringWeight,
} from '@/lib/types/domain';

/**
 * Deterministic scorecard arithmetic and recommendation derivation.
 *
 * The model proposes; this module decides. Keeping the arithmetic here rather
 * than trusting the model's own score means the thresholds Nick configures are
 * actually what drive the label, and it makes the behaviour testable without a
 * model in the loop.
 *
 * The central rule: a category with no evidence is *unscored*, not zero. It
 * reduces completeness and confidence; it does not drag the quality score down.
 */

export interface ScoreInput {
  key: string;
  /** 0–100, or null when there was not enough evidence. */
  score: number | null;
  rationale: string;
  citationIds: string[];
}

export interface ScorecardResult {
  categories: ScorecardCategoryResult[];
  /** 0–100, normalised over attempted weight only. */
  qualityScore: number;
  attemptedWeight: number;
  earnedWeight: number;
  totalWeight: number;
  /** Share of enabled weight that had enough evidence to score, 0–100. */
  dataCompleteness: number;
}

export function computeScorecard(
  weights: readonly ScoringWeight[],
  inputs: readonly ScoreInput[],
): ScorecardResult {
  const enabled = weights.filter((w) => w.enabled);
  const totalWeight = enabled.reduce((sum, w) => sum + w.weight, 0);

  const categories: ScorecardCategoryResult[] = enabled.map((w) => {
    const input = inputs.find((i) => i.key === w.key);
    const rawScore = input?.score ?? null;
    const score = rawScore === null ? null : Math.max(0, Math.min(100, Math.round(rawScore)));
    return {
      key: w.key,
      label: w.label,
      weight: w.weight,
      score,
      status: score === null ? 'unscored' : 'scored',
      rationale:
        input?.rationale ??
        'No evidence in the current sources addresses this category. Recorded as unscored, not zero.',
      citation_ids: input?.citationIds ?? [],
    };
  });

  const scored = categories.filter((c) => c.status === 'scored');
  const attemptedWeight = scored.reduce((sum, c) => sum + c.weight, 0);
  const earnedWeight = scored.reduce((sum, c) => sum + ((c.score ?? 0) / 100) * c.weight, 0);

  const qualityScore = attemptedWeight > 0 ? Math.round((earnedWeight / attemptedWeight) * 100) : 0;
  const dataCompleteness = totalWeight > 0 ? Math.round((attemptedWeight / totalWeight) * 100) : 0;

  return {
    categories,
    qualityScore,
    attemptedWeight: Math.round(attemptedWeight * 100) / 100,
    earnedWeight: Math.round(earnedWeight * 100) / 100,
    totalWeight,
    dataCompleteness,
  };
}

export interface RecommendationInput {
  qualityScore: number;
  dataCompleteness: number;
  redFlags: readonly RedFlag[];
  thresholds: RecommendationThresholds;
  /** The model's own suggestion, used only to break ties downward. */
  modelSuggestion?: Recommendation;
}

export interface RecommendationResult {
  recommendation: Recommendation;
  /** Set when a rule overrode the score-derived label. */
  cappedBy: string | null;
  explanation: string;
}

const RANK: Record<Recommendation, number> = {
  INSUFFICIENT_DATA: 0,
  PASS: 1,
  MONITOR: 2,
  DIG_DEEPER: 3,
  ADVANCE: 4,
};

export function deriveRecommendation(input: RecommendationInput): RecommendationResult {
  const { qualityScore, dataCompleteness, redFlags, thresholds } = input;

  const unresolvedHard = redFlags.filter((f) => f.severity === 'hard' && !f.resolved);

  // Not enough evidence to say anything useful, regardless of the score.
  if (dataCompleteness < thresholds.minimum_completeness) {
    return {
      recommendation: 'INSUFFICIENT_DATA',
      cappedBy: 'data_completeness',
      explanation: `Only ${dataCompleteness}% of the scorecard could be evidenced, below the ${thresholds.minimum_completeness}% minimum. Any recommendation would be a guess.`,
    };
  }

  let base: Recommendation;
  if (qualityScore >= thresholds.advance_at) base = 'ADVANCE';
  else if (qualityScore >= thresholds.monitor_below) base = 'DIG_DEEPER';
  else if (qualityScore >= thresholds.pass_below) base = 'MONITOR';
  else base = 'PASS';

  // A hard red flag caps the label rather than rewriting the score, so
  // resolving the flag restores the original recommendation with no re-analysis.
  if (unresolvedHard.length > 0) {
    const capped: Recommendation = base === 'PASS' ? 'PASS' : 'MONITOR';
    if (RANK[capped] < RANK[base]) {
      return {
        recommendation: capped,
        cappedBy: 'hard_red_flag',
        explanation: `Capped at ${capped} by an unresolved hard red flag: ${unresolvedHard[0]?.label}. The underlying score of ${qualityScore} is unchanged and the recommendation lifts if the flag is resolved.`,
      };
    }
    return {
      recommendation: capped,
      cappedBy: 'hard_red_flag',
      explanation: `An unresolved hard red flag is present: ${unresolvedHard[0]?.label}.`,
    };
  }

  // The model may argue *down* from the arithmetic (it saw something the
  // score cannot express) but never up. Enthusiasm does not raise a label.
  if (input.modelSuggestion && RANK[input.modelSuggestion] < RANK[base]) {
    return {
      recommendation: input.modelSuggestion,
      cappedBy: 'model_downgrade',
      explanation: `Score of ${qualityScore} maps to ${base}, but the analysis argued for the more conservative ${input.modelSuggestion}.`,
    };
  }

  return {
    recommendation: base,
    cappedBy: null,
    explanation: `Normalised score of ${qualityScore} on ${dataCompleteness}% coverage maps to ${base}.`,
  };
}

/**
 * Confidence is a function of coverage, evidence quality and score decisiveness
 * — not of how strong the recommendation sounds. A borderline score near a
 * threshold lowers confidence even when coverage is complete.
 */
export function computeConfidence(args: {
  dataCompleteness: number;
  evidenceQuality: number;
  qualityScore: number;
  thresholds: RecommendationThresholds;
  sourceCount: number;
}): number {
  const { dataCompleteness, evidenceQuality, qualityScore, thresholds, sourceCount } = args;

  const boundaries = [
    thresholds.pass_below,
    thresholds.monitor_below,
    thresholds.dig_deeper_below,
    thresholds.advance_at,
  ];
  const distance = Math.min(...boundaries.map((b) => Math.abs(qualityScore - b)));
  // Within 5 points of a boundary the label could flip on one new fact.
  const decisiveness = Math.min(1, distance / 12);

  const breadth = Math.min(1, sourceCount / 4);

  const raw =
    0.4 * (dataCompleteness / 100) +
    0.25 * (evidenceQuality / 100) +
    0.2 * decisiveness +
    0.15 * breadth;

  return Math.max(5, Math.min(95, Math.round(raw * 100)));
}

/** Evidence quality from what the citations actually are, not how many. */
export function computeEvidenceQuality(args: {
  documentCitations: number;
  founderClaimCitations: number;
  thirdPartyCitations: number;
  inferenceCount: number;
}): number {
  const { documentCitations, founderClaimCitations, thirdPartyCitations, inferenceCount } = args;
  const total = documentCitations + founderClaimCitations + thirdPartyCitations + inferenceCount;
  if (total === 0) return 0;
  // A third-party corroboration is worth more than a founder assertion; an
  // uncited inference is worth nothing.
  const weighted =
    documentCitations * 0.85 + thirdPartyCitations * 1.0 + founderClaimCitations * 0.55;
  return Math.max(0, Math.min(100, Math.round((weighted / total) * 100)));
}
