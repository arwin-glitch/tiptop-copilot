import type { Deal } from '@/lib/types/domain';
import {
  corporateEmailDomain,
  normalizeCompanyName,
  normalizeDomain,
  tokenOverlap,
} from '@/lib/util/text';

/**
 * Duplicate-deal detection.
 *
 * The rule that matters: we never auto-merge on a soft signal. An exact domain
 * match is treated as certain; everything else produces a *suggestion* that a
 * human confirms. Silently merging two different companies with similar names
 * would corrupt the pipeline in a way that is very hard to unpick later.
 */

export interface DuplicateCandidateInput {
  companyName: string;
  domain?: string | null;
  website?: string | null;
  founderEmails?: string[];
  sourceThreadIds?: string[];
}

export type MatchReason =
  | 'exact_domain'
  | 'website_domain'
  | 'founder_email_domain'
  | 'exact_normalized_name'
  | 'similar_name'
  | 'shared_source_thread';

export interface DuplicateMatch {
  deal: Deal;
  /** 0–1. At or above `AUTO_MERGE_CONFIDENCE` the match is treated as certain. */
  confidence: number;
  reasons: MatchReason[];
  /** False means: show a merge suggestion, do not act. */
  isCertain: boolean;
}

export const AUTO_MERGE_CONFIDENCE = 0.95;
const SUGGEST_THRESHOLD = 0.45;

const REASON_WEIGHTS: Record<MatchReason, number> = {
  exact_domain: 0.95,
  website_domain: 0.9,
  founder_email_domain: 0.8,
  exact_normalized_name: 0.6,
  shared_source_thread: 0.7,
  similar_name: 0.35,
};

export function findDuplicateCandidates(
  input: DuplicateCandidateInput,
  existing: readonly Deal[],
  existingSourceThreads: ReadonlyMap<string, string[]> = new Map(),
): DuplicateMatch[] {
  const inputDomain =
    normalizeDomain(input.domain ?? null) ?? normalizeDomain(input.website ?? null);
  const inputName = normalizeCompanyName(input.companyName);
  const founderDomains = new Set(
    (input.founderEmails ?? [])
      .map((e) => corporateEmailDomain(e))
      .filter((d): d is string => Boolean(d)),
  );
  const inputThreads = new Set(input.sourceThreadIds ?? []);

  const matches: DuplicateMatch[] = [];

  for (const deal of existing) {
    if (deal.is_archived) continue;
    const reasons: MatchReason[] = [];

    const dealDomain = normalizeDomain(deal.domain) ?? normalizeDomain(deal.website);

    if (inputDomain && dealDomain && inputDomain === dealDomain) {
      reasons.push(input.domain ? 'exact_domain' : 'website_domain');
    }
    if (dealDomain && founderDomains.has(dealDomain)) {
      reasons.push('founder_email_domain');
    }
    if (inputName && deal.normalized_name && inputName === deal.normalized_name) {
      reasons.push('exact_normalized_name');
    }
    if (inputThreads.size > 0) {
      const dealThreads = existingSourceThreads.get(deal.id) ?? [];
      if (dealThreads.some((t) => inputThreads.has(t))) reasons.push('shared_source_thread');
    }
    if (
      reasons.length === 0 &&
      inputName &&
      deal.normalized_name &&
      tokenOverlap(inputName, deal.normalized_name) >= 0.8
    ) {
      reasons.push('similar_name');
    }

    if (reasons.length === 0) continue;

    // Combine independently: each additional signal reduces the chance that
    // all of them are coincidental.
    const confidence = Math.min(
      0.99,
      1 - reasons.reduce((acc, r) => acc * (1 - REASON_WEIGHTS[r]), 1),
    );

    if (confidence < SUGGEST_THRESHOLD) continue;

    matches.push({
      deal,
      confidence: Math.round(confidence * 100) / 100,
      reasons,
      isCertain: confidence >= AUTO_MERGE_CONFIDENCE,
    });
  }

  return matches.sort((a, b) => b.confidence - a.confidence);
}

export function describeMatch(match: DuplicateMatch): string {
  const parts = match.reasons.map((r) => {
    switch (r) {
      case 'exact_domain':
        return 'the same company domain';
      case 'website_domain':
        return 'the same website domain';
      case 'founder_email_domain':
        return 'a founder email on the same domain';
      case 'exact_normalized_name':
        return 'the same normalised company name';
      case 'shared_source_thread':
        return 'a shared source email thread';
      case 'similar_name':
        return 'a closely similar company name';
    }
  });
  const confidence = `${Math.round(match.confidence * 100)}% confidence`;
  return match.isCertain
    ? `Certain match on ${parts.join(' and ')} (${confidence}).`
    : `Possible duplicate: ${parts.join(' and ')} (${confidence}). Confirm before merging.`;
}
