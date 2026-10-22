import { describe, expect, it } from 'vitest';
import {
  boardFiltersToSearch,
  buildPublicBoard,
  EMPTY_FILTERS,
  facetCounts,
  filterBoardJobs,
  hasFilters,
  parseBoardFilters,
  postingPublicState,
} from '@/lib/jobs-board/public';
import { descriptionHtml, jobPostingJsonLd, serializeJsonLd } from '@/lib/jobs-board/json-ld';
import type { JobCompany, JobPosting, PortfolioCompany } from '@/lib/types/domain';

/**
 * The one gate for what is public, and the public board built from rows.
 * Every company and role here is fictional.
 */

const ORG = 'org-1';
const NOW = '2026-10-20T12:00:00.000Z';

function portfolio(
  id: string,
  name: string,
  extra: Partial<PortfolioCompany> = {},
): PortfolioCompany {
  return {
    id,
    organization_id: ORG,
    name,
    normalized_name: name.toLowerCase(),
    domain: `${name.toLowerCase().replace(/\s+/g, '')}.example`,
    website: `https://${name.toLowerCase().replace(/\s+/g, '')}.example`,
    current_stage: 'Seed',
    description: `${name} makes things.`,
    sector: 'Robotics',
    latest_round: null,
    ownership: '4%',
    key_metrics: '$2M ARR (internal)',
    current_priorities: null,
    upcoming_fundraise: null,
    hiring_needs: null,
    gtm_needs: null,
    risks: 'Runway is short (internal)',
    last_contact_at: null,
    next_follow_up_at: null,
    is_archived: false,
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  };
}

function company(pcId: string, slug: string, extra: Partial<JobCompany> = {}): JobCompany {
  return {
    id: `jc-${pcId}`,
    organization_id: ORG,
    portfolio_company_id: pcId,
    slug,
    careers_url: null,
    ats: null,
    ats_token: null,
    sync_enabled: false,
    auto_publish: false,
    listed: false,
    logo_url: null,
    about: null,
    last_sync_at: null,
    last_sync_status: null,
    last_sync_message: null,
    last_sync_count: null,
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  };
}

let n = 0;
function posting(pcId: string, extra: Partial<JobPosting> = {}): JobPosting {
  n++;
  return {
    id: `p-${n}`,
    organization_id: ORG,
    portfolio_company_id: pcId,
    source: 'manual',
    source_key: `k-${n}`,
    slug: `role-${n}`,
    title: `Role ${n}`,
    team: null,
    job_function: 'engineering',
    locations: ['Austin, TX'],
    remote: null,
    employment_type: 'full_time',
    seniority: null,
    comp: null,
    description: 'A role.',
    apply_url: 'https://apply.example/role',
    posted_at: NOW,
    source_updated_at: null,
    status: 'active',
    published: true,
    featured: false,
    approved_by: 'user-1',
    approved_at: NOW,
    hidden_by: null,
    hidden_at: null,
    first_seen_at: NOW,
    last_seen_at: NOW,
    closed_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  };
}

const ACME = portfolio('pc-acme', 'Acme Fixture');
const ACME_CO = company('pc-acme', 'acme-fixture');

describe('postingPublicState: the one gate', () => {
  it('lets an approved, active, published role with an apply link through', () => {
    expect(postingPublicState(posting('pc-acme'), ACME_CO, ACME)).toBe('public');
  });

  it('never shows an emailed role a person has not approved, even when marked published', () => {
    const emailed = posting('pc-acme', {
      source: 'email',
      approved_at: null,
      approved_by: null,
      published: true,
    });
    expect(postingPublicState(emailed, ACME_CO, ACME)).toBe('needs_approval');
    const manual = posting('pc-acme', { source: 'manual', approved_at: null, published: true });
    expect(postingPublicState(manual, ACME_CO, ACME)).toBe('needs_approval');
  });

  it('shows a board role a person never approved only while auto-publish is on', () => {
    const synced = posting('pc-acme', { source: 'ats', approved_at: null, approved_by: null });
    expect(postingPublicState(synced, company('pc-acme', 'a', { auto_publish: true }), ACME)).toBe(
      'public',
    );
    expect(postingPublicState(synced, company('pc-acme', 'a', { auto_publish: false }), ACME)).toBe(
      'auto_publish_off',
    );
    // One a person published by hand stays public without auto-publish.
    expect(postingPublicState({ ...synced, approved_at: NOW }, ACME_CO, ACME)).toBe('public');
  });

  it('keeps hidden, closed, unpublished, link-less and archived-company roles off', () => {
    expect(postingPublicState(posting('pc-acme', { hidden_at: NOW }), ACME_CO, ACME)).toBe(
      'hidden',
    );
    expect(postingPublicState(posting('pc-acme', { status: 'closed' }), ACME_CO, ACME)).toBe(
      'closed',
    );
    expect(postingPublicState(posting('pc-acme', { published: false }), ACME_CO, ACME)).toBe(
      'not_published',
    );
    expect(postingPublicState(posting('pc-acme', { apply_url: null }), ACME_CO, ACME)).toBe(
      'no_apply_link',
    );
    expect(
      postingPublicState(
        posting('pc-acme', { apply_url: null }),
        company('pc-acme', 'a', { careers_url: 'https://acme.example/careers' }),
        ACME,
      ),
    ).toBe('public');
    expect(postingPublicState(posting('pc-acme'), ACME_CO, { ...ACME, is_archived: true })).toBe(
      'company_gone',
    );
    expect(postingPublicState(posting('pc-acme'), ACME_CO, null)).toBe('company_gone');
    expect(
      postingPublicState(posting('pc-acme', { apply_url: 'javascript:alert(1)' }), ACME_CO, ACME),
    ).toBe('no_apply_link');
  });
});

describe('buildPublicBoard', () => {
  const beta = portfolio('pc-beta', 'Beta Fixture', {
    description: null,
    website: null,
    domain: null,
  });
  const gamma = portfolio('pc-gamma', 'Gamma Fixture');

  it('carries only public fields, and nothing private about the company', () => {
    const board = buildPublicBoard({
      settings: null,
      portfolio: [ACME],
      jobCompanies: [ACME_CO],
      postings: [posting('pc-acme', { title: 'Platform Engineer', description: 'Secret desc' })],
    });
    expect(board.jobs).toHaveLength(1);
    expect(board.jobs[0]).not.toHaveProperty('approved_by');
    expect(board.jobs[0]).not.toHaveProperty('source');
    expect(board.jobs[0]!.description).toBeNull();
    const text = JSON.stringify(board);
    expect(text).not.toMatch(/internal|4%|Runway/);
    expect(board.companies[0]).toEqual({
      slug: 'acme-fixture',
      name: 'Acme Fixture',
      website: 'https://acmefixture.example',
      domain: 'acmefixture.example',
      logoUrl: null,
      about: 'Acme Fixture makes things.',
      sector: 'Robotics',
      openRoles: 1,
    });
    expect(
      buildPublicBoard(
        {
          settings: null,
          portfolio: [ACME],
          jobCompanies: [ACME_CO],
          postings: [posting('pc-acme')],
        },
        { descriptions: true },
      ).jobs[0]!.description,
    ).toBe('A role.');
  });

  it('shows one role per company and title, preferring the company board copy', () => {
    const board = buildPublicBoard({
      settings: null,
      portfolio: [ACME],
      jobCompanies: [company('pc-acme', 'acme-fixture', { auto_publish: true })],
      postings: [
        posting('pc-acme', { title: 'Sr. Backend Engineer', source: 'email', slug: 'from-email' }),
        posting('pc-acme', {
          title: 'Senior Backend Engineer',
          source: 'ats',
          approved_at: null,
          slug: 'from-board',
        }),
      ],
    });
    expect(board.jobs.map((j) => j.slug)).toEqual(['from-board']);
  });

  it('lists companies with open roles, plus listed ones, and sorts featured then newest', () => {
    const board = buildPublicBoard({
      settings: { title: '  ', intro: null, accent: 'red' },
      portfolio: [ACME, beta, gamma],
      jobCompanies: [
        ACME_CO,
        company('pc-beta', 'beta-fixture', { listed: true }),
        company('pc-gamma', 'gamma-fixture'),
      ],
      postings: [
        posting('pc-acme', { title: 'Old', posted_at: '2026-09-01T00:00:00Z' }),
        posting('pc-acme', { title: 'New', posted_at: '2026-10-19T00:00:00Z' }),
        posting('pc-acme', {
          title: 'Featured',
          posted_at: '2026-08-01T00:00:00Z',
          featured: true,
        }),
        posting('pc-gamma', { title: 'Hidden', hidden_at: NOW, published: false }),
      ],
    });
    expect(board.jobs.map((j) => j.title)).toEqual(['Featured', 'New', 'Old']);
    expect(board.companies.map((c) => [c.slug, c.openRoles])).toEqual([
      ['acme-fixture', 3],
      ['beta-fixture', 0],
    ]);
    expect(board.companies[1]!.about).toBeNull();
    expect(board.title).toBe('Jobs at TipTop portfolio companies');
    expect(board.accent).toBe('#0FC382');
  });
});

describe('board filters', () => {
  const board = buildPublicBoard({
    settings: null,
    portfolio: [ACME, portfolio('pc-beta', 'Beta Fixture')],
    jobCompanies: [ACME_CO, company('pc-beta', 'beta-fixture')],
    postings: [
      posting('pc-acme', {
        title: 'Backend Engineer',
        job_function: 'engineering',
        remote: 'remote',
        seniority: 'senior',
        locations: ['Remote - US'],
      }),
      posting('pc-acme', {
        title: 'Account Executive',
        job_function: 'sales',
        remote: 'onsite',
        locations: ['Austin, TX'],
      }),
      posting('pc-beta', {
        title: 'Designer',
        job_function: 'design',
        remote: 'hybrid',
        employment_type: 'contract',
        locations: ['Denver, CO'],
      }),
    ],
  });

  it('round-trips through the address bar and ignores unknown values', () => {
    const filters = parseBoardFilters(
      '?q=engineer&fn=engineering&remote=remote&seniority=senior&type=bogus',
    );
    expect(filters).toMatchObject({
      q: 'engineer',
      fn: 'engineering',
      remote: 'remote',
      seniority: 'senior',
      type: null,
    });
    expect(boardFiltersToSearch(filters)).toBe(
      '?q=engineer&fn=engineering&remote=remote&seniority=senior',
    );
    expect(boardFiltersToSearch(EMPTY_FILTERS)).toBe('');
    expect(hasFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasFilters({ ...EMPTY_FILTERS, q: '  ' })).toBe(false);
  });

  it('filters by words, company, team, place, setup and type', () => {
    expect(
      filterBoardJobs(board.jobs, { ...EMPTY_FILTERS, q: 'acme engineer' }).map((j) => j.title),
    ).toEqual(['Backend Engineer']);
    expect(filterBoardJobs(board.jobs, { ...EMPTY_FILTERS, company: 'beta-fixture' })).toHaveLength(
      1,
    );
    expect(filterBoardJobs(board.jobs, { ...EMPTY_FILTERS, location: 'austin, tx' })).toHaveLength(
      1,
    );
    expect(filterBoardJobs(board.jobs, { ...EMPTY_FILTERS, type: 'contract' })).toHaveLength(1);
    expect(
      filterBoardJobs(board.jobs, { ...EMPTY_FILTERS, fn: 'sales', remote: 'remote' }),
    ).toHaveLength(0);
  });

  it('counts each value with the other filters applied', () => {
    const filters = { ...EMPTY_FILTERS, company: 'pc-none' };
    expect(filterBoardJobs(board.jobs, filters, 'company')).toHaveLength(3);
    const fns = facetCounts(
      board.jobs,
      (j) => [j.fn],
      (v) => v,
    );
    expect(fns.map((f) => [f.value, f.count])).toEqual([
      ['design', 1],
      ['engineering', 1],
      ['sales', 1],
    ]);
  });
});

describe('JobPosting structured data', () => {
  const board = buildPublicBoard(
    {
      settings: null,
      portfolio: [ACME],
      jobCompanies: [
        company('pc-acme', 'acme-fixture', { logo_url: 'https://cdn.example/acme.png' }),
      ],
      postings: [
        posting('pc-acme', {
          title: 'Engineer </script><script>alert(1)</script>',
          description: '## About\n\n- <b>Bold</b> claim',
          remote: 'remote',
          locations: ['Remote - US', 'Austin, TX'],
        }),
      ],
    },
    { descriptions: true },
  );
  const job = board.jobs[0]!;

  it('describes the role for Google for Jobs from public fields only', () => {
    const data = jobPostingJsonLd(job, board.companies[0]!, 'https://jobs.example/acme-fixture/x');
    expect(data).toMatchObject({
      '@type': 'JobPosting',
      datePosted: '2026-10-20',
      employmentType: 'FULL_TIME',
      jobLocationType: 'TELECOMMUTE',
      hiringOrganization: {
        name: 'Acme Fixture',
        sameAs: 'https://acmefixture.example',
        logo: 'https://cdn.example/acme.png',
      },
    });
    expect((data.jobLocation as unknown[]).length).toBe(1);
  });

  it('escapes everything, so the script tag can never be closed early', () => {
    const json = serializeJsonLd(jobPostingJsonLd(job, null, 'https://jobs.example/x'));
    expect(json).not.toContain('<');
    expect(JSON.parse(json).title).toBe('Engineer </script><script>alert(1)</script>');
    expect(descriptionHtml('- <b>x</b>', 'f')).toBe('<ul><li>&lt;b&gt;x&lt;/b&gt;</li></ul>');
  });
});
