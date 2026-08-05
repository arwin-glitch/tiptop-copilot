import 'server-only';
import { getAI, getStore } from '@/lib/runtime';
import { PROMPTS } from '@/lib/ai/prompts';
import { dealAnalysisSchema, type CitationRef } from '@/lib/ai/schemas';
import type { AuthContext } from '@/lib/auth/session';
import { recordAudit } from '@/lib/security/audit';
import { checkAiBudget, recordAiUsage } from '@/lib/security/limits';
import { UNTRUSTED_CONTENT_RULE } from '@/lib/security/injection';
import { log } from '@/lib/security/redact';
import {
  computeConfidence,
  computeEvidenceQuality,
  computeScorecard,
  deriveRecommendation,
  type ScoreInput,
} from '@/lib/deals/scoring';
import type { Citation, Deal, DealAnalysis, Recommendation, RedFlag } from '@/lib/types/domain';
import { contentSetHash, newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { buildDealEvidence, loadPriorDecisions } from './evidence';
import { getActiveThesis, thesisKeywords } from './thesis';

/**
 * Deal analysis.
 *
 * Division of labour: the model reads evidence and judges each category; this
 * module does the arithmetic and applies the thresholds. That split is what
 * makes the recommendation reproducible, auditable, and responsive to Nick's
 * configured thresholds rather than to the model's mood.
 *
 * Results are content-addressed. Re-analysing an unchanged deal returns the
 * stored analysis instead of spending a token, unless `force` is set.
 */

export interface AnalyzeOptions {
  force?: boolean;
}

export async function analyzeDeal(
  auth: AuthContext,
  dealId: string,
  options: AnalyzeOptions = {},
): Promise<Result<DealAnalysis>> {
  const store = getStore();
  const deal = (await store.get('deals', auth.organizationId, dealId)) as Deal | null;
  if (!deal) return err('not_found', 'That deal does not exist in this organization.');

  const thesis = await getActiveThesis(store, auth.organizationId, auth.userId);
  const evidence = await buildDealEvidence(store, auth.organizationId, deal);
  const prior = await loadPriorDecisions(store, auth.organizationId, deal.id);

  const sourceHash = contentSetHash([
    ...evidence.sourceHashes,
    `thesis:${thesis.id}`,
    `prompt:${PROMPTS.dealAnalysis.version}`,
  ]);

  if (!options.force) {
    const cached = (await store.list(
      'deal_analyses',
      auth.organizationId,
      { eq: { deal_id: deal.id, source_hash: sourceHash } },
      { orderBy: [{ field: 'version', direction: 'desc' }], limit: 1 },
    )) as DealAnalysis[];
    if (cached[0]) return ok(cached[0]);
  }

  if (evidence.sourceCount === 0) {
    return err(
      'invalid_input',
      'This deal has no attached sources yet. Attach an email or a document before analysing it.',
      { stillUsable: 'You can still edit the deal fields and record a decision manually.' },
    );
  }

  const budget = await checkAiBudget(store, auth.organizationId, auth.userId);
  if (!budget.ok) return budget;

  // Register prior-decision citations so the model can point at precedent.
  for (const citation of prior.citations) evidence.registry.add(citation);

  const context = {
    deal: {
      id: deal.id,
      company_name: deal.company_name,
      stage: deal.stage,
      industry: deal.industry,
      vertical: deal.vertical,
      product_summary: deal.product_summary,
      funding_stage: deal.funding_stage,
      round_size: deal.round_size,
      revenue: deal.revenue,
      traction: deal.traction,
      team: deal.team,
      founder_market_fit: deal.founder_market_fit,
      competition: deal.competition,
    },
    thesis: {
      notes: thesis.thesis_notes,
      preferred_stages: thesis.preferred_stages,
      preferred_industries: thesis.preferred_industries,
      excluded_industries: thesis.excluded_industries,
      hard_disqualifiers: thesis.hard_disqualifiers,
      configured_check_range: thesis.typical_check_range,
      configured_required_traction: thesis.required_traction,
    },
    thesis_keywords: thesisKeywords(thesis).slice(0, 40),
    scoring_weights: thesis.scoring_weights
      .filter((w) => w.enabled)
      .map((w) => ({ key: w.key, label: w.label, weight: w.weight, description: w.description })),
    prior_decisions: prior.decisions,
    available_source_ids: evidence.registry.ids(),
  };

  const userContent = `<context>${JSON.stringify(context)}</context>

${UNTRUSTED_CONTENT_RULE}

<sources>
${evidence.fenced}
</sources>

Analyse this deal. Score only the categories listed in scoring_weights, using their exact keys. Cite only source ids that appear in available_source_ids.`;

  const started = Date.now();
  const ai = getAI();
  const response = await ai.generateStructured({
    tier: 'deep',
    operation: 'deal.analyze',
    promptVersion: PROMPTS.dealAnalysis.version,
    system: PROMPTS.dealAnalysis.system,
    messages: [{ role: 'user', content: userContent }],
    schema: dealAnalysisSchema,
    maxTokens: 16_000,
  });

  await recordAiUsage(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    operation: 'deal.analyze',
    promptVersion: PROMPTS.dealAnalysis.version,
    usage: response.ok ? response.value.usage : null,
    ok: response.ok,
    errorCode: response.ok ? null : response.error.code,
  });

  if (!response.ok) return response;
  const output = response.value.value;

  // ---- Validate citations before trusting anything that rests on them. ----
  const rejected: string[] = [];
  const collect = (refs: readonly (CitationRef | null | undefined)[]): string[] => {
    const { citations, invalid } = evidence.registry.resolve(refs);
    rejected.push(...invalid);
    return citations.map((c) => c.id);
  };

  const scoreInputs: ScoreInput[] = output.categories.map((c) => ({
    key: c.key,
    score: c.score,
    rationale: c.rationale,
    citationIds: collect(c.citations),
  }));

  const redFlags: RedFlag[] = output.red_flags.map((f) => ({
    label: f.label,
    severity: f.severity,
    detail: f.detail,
    resolved: false,
    citation_ids: collect(f.citations),
  }));

  if (rejected.length > 0) {
    log.warn('Rejected fabricated citations from deal analysis', {
      dealId: deal.id,
      rejectedCount: rejected.length,
    });
    await recordAudit(store, {
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'security.citation_rejected',
      entityType: 'deal',
      entityId: deal.id,
      metadata: { rejected_count: rejected.length, operation: 'deal.analyze' },
    });
  }

  // ---- Arithmetic and thresholds are ours, not the model's. ----
  const scorecard = computeScorecard(thesis.scoring_weights, scoreInputs);

  const evidenceQuality = computeEvidenceQuality({
    documentCitations: evidence.counts.documents,
    founderClaimCitations: evidence.counts.founderClaims,
    thirdPartyCitations: evidence.counts.thirdParty,
    inferenceCount: scoreInputs.filter((s) => s.citationIds.length === 0).length,
  });

  const decision = deriveRecommendation({
    qualityScore: scorecard.qualityScore,
    dataCompleteness: scorecard.dataCompleteness,
    redFlags,
    thresholds: thesis.thresholds,
    modelSuggestion: output.recommendation as Recommendation,
  });

  const confidence = computeConfidence({
    dataCompleteness: scorecard.dataCompleteness,
    evidenceQuality,
    qualityScore: scorecard.qualityScore,
    thresholds: thesis.thresholds,
    sourceCount: evidence.sourceCount,
  });

  const citationsUsed: Citation[] = evidence.registry
    .all()
    .filter(
      (c) =>
        scorecard.categories.some((cat) => cat.citation_ids.includes(c.id)) ||
        redFlags.some((f) => f.citation_ids.includes(c.id)),
    );

  const existing = (await store.list(
    'deal_analyses',
    auth.organizationId,
    { eq: { deal_id: deal.id } },
    { orderBy: [{ field: 'version', direction: 'desc' }], limit: 1 },
  )) as DealAnalysis[];
  const version = (existing[0]?.version ?? 0) + 1;

  const analysis: DealAnalysis = {
    id: newId(),
    organization_id: auth.organizationId,
    deal_id: deal.id,
    version,
    recommendation: decision.recommendation,
    headline: output.headline,
    rationale: `${output.rationale} ${decision.explanation}`.trim(),
    quality_score: scorecard.qualityScore,
    attempted_weight: scorecard.attemptedWeight,
    earned_weight: scorecard.earnedWeight,
    data_completeness: scorecard.dataCompleteness,
    evidence_quality: evidenceQuality,
    confidence,
    categories: scorecard.categories,
    strongest_evidence: output.strongest_evidence,
    biggest_concern: output.biggest_concern,
    missing_information: output.missing_information,
    recommended_next_step: output.recommended_next_step,
    diligence_questions: output.diligence_questions,
    upside_case: output.upside_case,
    downside_case: output.downside_case,
    red_flags: redFlags,
    competitive_context: output.competitive_context,
    comparable_deal_ids: output.comparable_prior_deals
      .map((c) => c.deal_id)
      .filter((id) => prior.decisions.some((d) => d.deal_id === id)),
    citations: citationsUsed,
    thirty_second_overview: output.thirty_second_overview,
    model: response.value.usage.model,
    prompt_version: PROMPTS.dealAnalysis.version,
    source_hash: sourceHash,
    generated_at: new Date().toISOString(),
    generated_by: auth.userId,
    human_override: null,
    created_at: new Date().toISOString(),
  };

  await store.insert('deal_analyses', analysis);

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'deal.analysis_generated',
    entityType: 'deal',
    entityId: deal.id,
    metadata: {
      version,
      recommendation: analysis.recommendation,
      quality_score: analysis.quality_score,
      data_completeness: analysis.data_completeness,
      capped_by: decision.cappedBy,
      duration_ms: Date.now() - started,
      model: analysis.model,
    },
  });

  return ok(analysis);
}

export async function latestAnalysis(
  organizationId: string,
  dealId: string,
): Promise<DealAnalysis | null> {
  const store = getStore();
  const rows = (await store.list(
    'deal_analyses',
    organizationId,
    { eq: { deal_id: dealId } },
    { orderBy: [{ field: 'version', direction: 'desc' }], limit: 1 },
  )) as DealAnalysis[];
  return rows[0] ?? null;
}

export async function analysisHistory(
  organizationId: string,
  dealId: string,
): Promise<DealAnalysis[]> {
  const store = getStore();
  return (await store.list(
    'deal_analyses',
    organizationId,
    { eq: { deal_id: dealId } },
    { orderBy: [{ field: 'version', direction: 'desc' }] },
  )) as DealAnalysis[];
}

/**
 * Human override of a recommendation. The original stays intact — this records
 * that Nick disagreed and why, which is exactly the signal worth keeping.
 */
export async function overrideRecommendation(
  auth: AuthContext,
  analysisId: string,
  recommendation: Recommendation,
  note: string,
): Promise<Result<DealAnalysis>> {
  const store = getStore();
  const analysis = (await store.get(
    'deal_analyses',
    auth.organizationId,
    analysisId,
  )) as DealAnalysis | null;
  if (!analysis) return err('not_found', 'That analysis does not exist.');
  if (!note.trim()) {
    // The override is what the whole app and the exported memo will show. The
    // reason for it is the part worth keeping, exactly as for a decision.
    return err('invalid_input', 'An override needs a reason — that is the part worth keeping.');
  }

  const updated = await store.update('deal_analyses', auth.organizationId, analysisId, {
    human_override: {
      recommendation,
      note: note.trim(),
      by: auth.userId,
      at: new Date().toISOString(),
    },
  });

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'deal.analysis_overridden',
    entityType: 'deal_analysis',
    entityId: analysisId,
    metadata: { from: analysis.recommendation, to: recommendation },
  });

  return ok(updated as DealAnalysis);
}

/** The label the UI should show: the human override wins when present. */
export function effectiveRecommendation(analysis: DealAnalysis): Recommendation {
  return analysis.human_override?.recommendation ?? analysis.recommendation;
}

/** Register a red flag as resolved, which lifts any cap it was applying. */
export async function resolveRedFlag(
  auth: AuthContext,
  analysisId: string,
  label: string,
): Promise<Result<DealAnalysis>> {
  const store = getStore();
  const analysis = (await store.get(
    'deal_analyses',
    auth.organizationId,
    analysisId,
  )) as DealAnalysis | null;
  if (!analysis) return err('not_found', 'That analysis does not exist.');

  const redFlags = analysis.red_flags.map((f) =>
    f.label === label ? { ...f, resolved: true } : f,
  );
  const thesis = await getActiveThesis(store, auth.organizationId, auth.userId);
  const decision = deriveRecommendation({
    qualityScore: analysis.quality_score,
    dataCompleteness: analysis.data_completeness,
    redFlags,
    thresholds: thesis.thresholds,
  });

  const updated = await store.update('deal_analyses', auth.organizationId, analysisId, {
    red_flags: redFlags,
    recommendation: decision.recommendation,
    rationale: decision.explanation,
  });

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'deal.analysis_overridden',
    entityType: 'deal_analysis',
    entityId: analysisId,
    metadata: { resolved_flag: label, recommendation: decision.recommendation },
  });

  return ok(updated as DealAnalysis);
}
