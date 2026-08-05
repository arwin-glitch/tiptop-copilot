import { describe, expect, it } from 'vitest';
import { AUTO_MERGE_CONFIDENCE, describeMatch, findDuplicateCandidates } from '@/lib/deals/dedupe';
import { normalizeCompanyName } from '@/lib/util/text';
import type { Deal } from '@/lib/types/domain';

/**
 * The rule under test: an exact domain match is treated as certain; every
 * softer signal produces a *suggestion* a human confirms. Auto-merging two
 * different companies on a name similarity corrupts the pipeline in a way
 * that is very hard to unpick, so `isCertain` is the load-bearing field.
 */

let counter = 0;

function deal(over: Partial<Deal> & { company_name: string }): Deal {
  const now = new Date().toISOString();
  return {
    id: `deal-${++counter}`,
    organization_id: 'org-1',
    normalized_name: normalizeCompanyName(over.company_name),
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
    ...over,
  } as Deal;
}

describe('certainty', () => {
  it('treats an exact domain match as certain', () => {
    const existing = [deal({ company_name: 'Vetrix', domain: 'vetrix.demo' })];
    const [match] = findDuplicateCandidates(
      { companyName: 'Vetrix Health', domain: 'vetrix.demo' },
      existing,
    );

    expect(match?.isCertain).toBe(true);
    expect(match?.confidence).toBeGreaterThanOrEqual(AUTO_MERGE_CONFIDENCE);
    expect(match?.reasons).toContain('exact_domain');
  });

  it('does NOT treat a similar name as certain, however close', () => {
    const existing = [deal({ company_name: 'Plumbline Technologies' })];
    const matches = findDuplicateCandidates({ companyName: 'Plumbline Labs' }, existing);

    // Same normalised name after suffix stripping — still only a suggestion.
    expect(matches[0]).toBeDefined();
    expect(matches[0]?.isCertain).toBe(false);
    expect(matches[0]?.confidence).toBeLessThan(AUTO_MERGE_CONFIDENCE);
  });

  it('does not merge two genuinely different construction-AI companies', () => {
    // Girder and Plumbline are both construction estimating. Nothing about
    // that should make them the same deal.
    const existing = [deal({ company_name: 'Girder AI', domain: 'girder.demo' })];
    const matches = findDuplicateCandidates(
      { companyName: 'Plumbline', domain: 'plumbline.demo' },
      existing,
    );
    expect(matches).toHaveLength(0);
  });
});

describe('signals', () => {
  it('matches on website when no explicit domain is supplied', () => {
    const existing = [deal({ company_name: 'Vetrix', website: 'https://www.vetrix.demo/pricing' })];
    const [match] = findDuplicateCandidates(
      { companyName: 'Vetrix', website: 'vetrix.demo' },
      existing,
    );
    expect(match?.reasons).toContain('website_domain');
  });

  it('uses a corporate founder email domain but ignores a free-provider one', () => {
    const existing = [deal({ company_name: 'Vetrix', domain: 'vetrix.demo' })];

    const corporate = findDuplicateCandidates(
      { companyName: 'Something Else', founderEmails: ['priya@vetrix.demo'] },
      existing,
    );
    expect(corporate[0]?.reasons).toContain('founder_email_domain');

    const free = findDuplicateCandidates(
      { companyName: 'Something Else', founderEmails: ['priya@gmail.com'] },
      existing,
    );
    // A gmail.com sender must never bind a deal to a company by domain.
    expect(free).toHaveLength(0);
  });

  it('matches on a shared source thread', () => {
    const target = deal({ company_name: 'Vetrix' });
    const matches = findDuplicateCandidates(
      { companyName: 'Unrelated Name Entirely', sourceThreadIds: ['msg-1'] },
      [target],
      new Map([[target.id, ['msg-1', 'msg-2']]]),
    );
    expect(matches[0]?.reasons).toContain('shared_source_thread');
    expect(matches[0]?.isCertain).toBe(false);
  });

  it('compounds independent signals into higher confidence', () => {
    const existing = [deal({ company_name: 'Vetrix', domain: 'vetrix.demo' })];
    const single = findDuplicateCandidates({ companyName: 'Zzz', domain: 'vetrix.demo' }, existing);
    const multiple = findDuplicateCandidates(
      {
        companyName: 'Vetrix',
        domain: 'vetrix.demo',
        founderEmails: ['priya@vetrix.demo'],
      },
      existing,
    );
    expect(multiple[0]!.confidence).toBeGreaterThan(single[0]!.confidence);
    expect(multiple[0]!.confidence).toBeLessThanOrEqual(0.99);
  });

  it('skips archived deals entirely', () => {
    const existing = [deal({ company_name: 'Vetrix', domain: 'vetrix.demo', is_archived: true })];
    expect(
      findDuplicateCandidates({ companyName: 'Vetrix', domain: 'vetrix.demo' }, existing),
    ).toHaveLength(0);
  });

  it('returns nothing when there is no signal at all', () => {
    const existing = [deal({ company_name: 'Vetrix', domain: 'vetrix.demo' })];
    expect(
      findDuplicateCandidates({ companyName: 'Halyard Freight', domain: 'halyard.demo' }, existing),
    ).toHaveLength(0);
  });

  it('sorts the strongest candidate first', () => {
    const existing = [
      // Name match only — a suggestion.
      deal({ company_name: 'Vetrix' }),
      // Domain match — certain.
      deal({ company_name: 'Something Else Entirely', domain: 'vetrix.demo' }),
    ];
    const matches = findDuplicateCandidates(
      { companyName: 'Vetrix', domain: 'vetrix.demo' },
      existing,
    );
    expect(matches).toHaveLength(2);
    expect(matches[0]!.confidence).toBeGreaterThan(matches[1]!.confidence);
    expect(matches[0]!.deal.domain).toBe('vetrix.demo');
    expect(matches[1]!.isCertain).toBe(false);
  });

  it('drops a weak signal below the suggestion threshold instead of surfacing noise', () => {
    // A merely-similar name (0.35) is below the 0.45 floor on its own.
    const existing = [deal({ company_name: 'Vetrix Systems Group' })];
    expect(findDuplicateCandidates({ companyName: 'Vetrix' }, existing)).toHaveLength(0);
  });
});

describe('describeMatch', () => {
  it('says "confirm before merging" for anything short of certain', () => {
    const existing = [deal({ company_name: 'Plumbline Technologies' })];
    const [match] = findDuplicateCandidates({ companyName: 'Plumbline Labs' }, existing);
    expect(describeMatch(match!)).toContain('Confirm before merging');
  });

  it('states certainty plainly for an exact domain match', () => {
    const existing = [deal({ company_name: 'Vetrix', domain: 'vetrix.demo' })];
    const [match] = findDuplicateCandidates({ companyName: 'X', domain: 'vetrix.demo' }, existing);
    expect(describeMatch(match!)).toMatch(/^Certain match/);
  });
});
