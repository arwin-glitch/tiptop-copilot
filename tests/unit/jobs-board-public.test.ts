import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  boardFiltersToSearch,
  buildPublicBoard,
  EMPTY_FILTERS,
  facetCounts,
  filterBoardJobs,
  hasFilters,
  parseBoardFilters,
  isPortfolioJobCompany,
  placesAndRemote,
  postingPublicState,
  validThroughOf,
} from '@/lib/jobs-board/public';
import {
  descriptionHtml,
  jobPostingJsonLd,
  parsePay,
  parsePlace,
  serializeJsonLd,
} from '@/lib/jobs-board/json-ld';
import type { JobCompany, JobPosting, PortfolioCompany } from '@/lib/types/domain';

/**
 * The one gate for what is public, and the public board built from rows.
 * Every company and role here is fictional.
 */

const ORG = 'org-1';
const NOW = '2026-10-20T12:00:00.000Z';

// The gate ages emailed and hand-added roles against the clock: pin it, so
// these fixed dates never go stale under a later run.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterAll(() => {
  vi.useRealTimers();
});

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
    // Kraken's own portfolio description and sector are internal: never public.
    expect(text).not.toMatch(/makes things|Robotics/);
    expect(board.companies[0]).toEqual({
      slug: 'acme-fixture',
      name: 'Acme Fixture',
      website: 'https://acmefixture.example',
      domain: 'acmefixture.example',
      careersUrl: null,
      logoUrl: null,
      about: null,
      linkedinJobsUrl: null,
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
  const LONG =
    'Build the services that reconcile ledgers for accounting firms. You will own our matching engine end to end, from bank feeds to the review queue accountants use every day.\n\n## What you will do\n\n- Ship <b>Bold</b> features\n- Run the matching engine';
  const board = buildPublicBoard(
    {
      settings: null,
      portfolio: [ACME],
      jobCompanies: [
        company('pc-acme', 'acme-fixture', { logo_url: 'https://cdn.example/acme.png' }),
      ],
      postings: [
        posting('pc-acme', {
          slug: 'remote-role',
          title: 'Engineer </script><script>alert(1)</script>',
          description: LONG,
          remote: 'remote',
          locations: ['Remote - US', 'Austin, TX'],
          comp: '$190K – $220K / year',
        }),
        posting('pc-acme', {
          slug: 'hybrid-role',
          title: 'Hybrid Designer',
          description: LONG,
          remote: null,
          locations: ['Chicago, IL (Hybrid)'],
          source: 'ats',
        }),
        posting('pc-acme', {
          slug: 'thin-role',
          title: 'Thin Role',
          description: 'Too short to be a real description.',
        }),
        posting('pc-acme', {
          slug: 'nowhere-role',
          title: 'Nowhere Role',
          description: LONG,
          locations: ['Somewhere nice'],
          remote: 'onsite',
        }),
        posting('pc-acme', {
          slug: 'remote-canada',
          title: 'Remote Canada Role',
          description: LONG,
          locations: ['Remote (Canada)'],
          remote: 'remote',
        }),
        posting('pc-acme', {
          slug: 'remote-plain',
          title: 'Remote Plain Role',
          description: LONG,
          locations: [],
          remote: 'remote',
        }),
      ],
    },
    { descriptions: true },
  );
  const bySlug = (slug: string) => board.jobs.find((j) => j.slug === slug)!;
  const jsonLd = (slug: string) =>
    jobPostingJsonLd(
      bySlug(slug),
      board.companies[0]!,
      `https://jobs.example/acme-fixture/${slug}`,
    );

  it('describes the role for Google for Jobs from public fields only, with every required field', () => {
    const data = jsonLd('remote-role')!;
    expect(data).toMatchObject({
      '@type': 'JobPosting',
      datePosted: '2026-10-20',
      validThrough: '2026-12-19T12:00:00.000Z',
      employmentType: 'FULL_TIME',
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: [{ '@type': 'Country', name: 'US' }],
      jobLocation: [
        {
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress',
            addressLocality: 'Austin',
            addressRegion: 'TX',
            addressCountry: 'US',
          },
        },
      ],
      baseSalary: {
        '@type': 'MonetaryAmount',
        currency: 'USD',
        value: {
          '@type': 'QuantitativeValue',
          minValue: 190000,
          maxValue: 220000,
          unitText: 'YEAR',
        },
      },
      hiringOrganization: {
        name: 'Acme Fixture',
        sameAs: 'https://acmefixture.example',
        logo: 'https://cdn.example/acme.png',
      },
    });
  });

  it('reads a hybrid place without its "(Hybrid)", and gives board roles no validThrough', () => {
    const data = jsonLd('hybrid-role')!;
    expect(data.jobLocation).toEqual([
      {
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          addressLocality: 'Chicago',
          addressRegion: 'IL',
          addressCountry: 'US',
        },
      },
    ]);
    expect(data).not.toHaveProperty('jobLocationType');
    expect(data).not.toHaveProperty('validThrough');
    expect(bySlug('hybrid-role').remote).toBe('hybrid');
  });

  it('names the country a remote role hires in, defaulting to the US', () => {
    expect(jsonLd('remote-canada')!.applicantLocationRequirements).toEqual([
      { '@type': 'Country', name: 'CA' },
    ]);
    expect(jsonLd('remote-plain')!.applicantLocationRequirements).toEqual([
      { '@type': 'Country', name: 'US' },
    ]);
    expect(jsonLd('remote-plain')).not.toHaveProperty('jobLocation');
  });

  it('gives no structured data rather than invented or incomplete fields', () => {
    // A short description is not padded with made-up words.
    expect(jsonLd('thin-role')).toBeNull();
    // No place Google can read and not remote: nothing.
    expect(jsonLd('nowhere-role')).toBeNull();
    // An emailed role with no description: nothing.
    const emailed = { ...bySlug('remote-role'), description: null };
    expect(jobPostingJsonLd(emailed, null, 'https://jobs.example/x')).toBeNull();
  });

  it('escapes everything, so the script tag can never be closed early', () => {
    const json = serializeJsonLd(jsonLd('remote-role'));
    expect(json).not.toContain('<');
    expect(JSON.parse(json).title).toBe('Engineer </script><script>alert(1)</script>');
    expect(descriptionHtml('- <b>x</b>')).toBe('<ul><li>&lt;b&gt;x&lt;/b&gt;</li></ul>');
    expect(descriptionHtml('')).toBeNull();
  });

  it('parses places and pay only when they read cleanly', () => {
    expect(parsePlace('Austin, TX')).toEqual({ locality: 'Austin', region: 'TX', country: 'US' });
    expect(parsePlace('Denver, CO, USA')).toEqual({
      locality: 'Denver',
      region: 'CO',
      country: 'US',
    });
    expect(parsePlace('Toronto, ON')).toEqual({ locality: 'Toronto', region: 'ON', country: 'CA' });
    expect(parsePlace('Berlin, Germany')).toEqual({
      locality: 'Berlin',
      region: null,
      country: 'DE',
    });
    expect(parsePlace('Canada')).toEqual({ locality: null, region: null, country: 'CA' });
    expect(parsePlace('Remote - US')).toBeNull();
    expect(parsePlace('Bay Area')).toBeNull();
    expect(parsePlace('Austin, ZZ')).toBeNull();

    expect(parsePay('$150,000 - $180,000')).toEqual({
      currency: 'USD',
      min: 150000,
      max: 180000,
      unit: 'YEAR',
    });
    expect(parsePay('USD 60-75/hr')).toEqual({ currency: 'USD', min: 60, max: 75, unit: 'HOUR' });
    expect(parsePay('$150K base + 0.5% equity')).toEqual({
      currency: 'USD',
      min: 150000,
      max: 150000,
      unit: 'YEAR',
    });
    expect(parsePay('0.5% - 1% equity')).toBeNull();
    expect(parsePay('Competitive')).toBeNull();
    expect(parsePay('$5 - $9')).toBeNull();
  });
});

describe('stale emailed and hand-added roles', () => {
  const DAY = 86_400_000;
  const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();

  it('takes a role nobody confirmed for 60 days off the board, until a person re-confirms it', () => {
    const old = posting('pc-acme', { approved_at: ago(61), last_seen_at: ago(61) });
    expect(postingPublicState(old, ACME_CO, ACME)).toBe('stale');
    // Mentioned again by the founder: confirmed.
    expect(postingPublicState({ ...old, last_seen_at: ago(3) }, ACME_CO, ACME)).toBe('public');
    // Re-approved by a person (Publish again): confirmed.
    expect(postingPublicState({ ...old, approved_at: ago(0) }, ACME_CO, ACME)).toBe('public');
    // A role from the company's own board closes itself instead: never stale.
    expect(
      postingPublicState(
        { ...old, source: 'ats' },
        company('pc-acme', 'a', { auto_publish: true }),
        ACME,
      ),
    ).toBe('public');
    expect(validThroughOf({ source: 'ats', approved_at: NOW, last_seen_at: NOW })).toBeNull();
  });

  it("dates an emailed role from its approval, not the founder's first mention", () => {
    const board = buildPublicBoard({
      settings: null,
      portfolio: [ACME],
      jobCompanies: [ACME_CO],
      postings: [
        posting('pc-acme', {
          source: 'email',
          posted_at: ago(90),
          first_seen_at: ago(90),
          approved_at: ago(1),
        }),
      ],
    });
    expect(board.jobs[0]!.postedAt).toBe(ago(1));
  });

  it('folds "(Hybrid)" into the work setup and keeps each place once', () => {
    expect(placesAndRemote(['Chicago, IL (Hybrid)', 'Chicago,  IL', 'chicago, il'], null)).toEqual({
      locations: ['Chicago, IL'],
      remote: 'hybrid',
    });
    // A setup a person chose stands.
    expect(placesAndRemote(['Austin, TX (Remote)'], 'onsite')).toEqual({
      locations: ['Austin, TX'],
      remote: 'onsite',
    });
  });
});

describe('portfolio companies only', () => {
  it('never shows a company or role that is not a live portfolio company of this organization', () => {
    const stranger = company('pc-globex', 'globex', { listed: true });
    const otherOrgPortfolio = portfolio('pc-initech', 'Initech Fixture', {
      organization_id: 'org-2',
    });
    const otherOrgCompany = company('pc-initech', 'initech', { listed: true });
    const board = buildPublicBoard({
      settings: null,
      // Globex has job settings and roles but is not in the portfolio;
      // Initech's portfolio row belongs to another organization.
      portfolio: [ACME, otherOrgPortfolio],
      jobCompanies: [ACME_CO, stranger, otherOrgCompany],
      postings: [
        posting('pc-acme', { title: 'Acme Role' }),
        posting('pc-globex', { title: 'Globex Role' }),
        posting('pc-initech', { title: 'Initech Role' }),
        // A role row from another organization under a portfolio company.
        posting('pc-acme', { title: 'Foreign Row', organization_id: 'org-2' }),
      ],
    });
    expect(board.jobs.map((j) => j.title)).toEqual(['Acme Role']);
    expect(board.companies.map((c) => c.slug)).toEqual(['acme-fixture']);
  });

  it('isPortfolioJobCompany checks the portfolio row, archive and organization', () => {
    expect(isPortfolioJobCompany(ACME_CO, ACME)).toBe(true);
    expect(isPortfolioJobCompany(ACME_CO, undefined)).toBe(false);
    expect(isPortfolioJobCompany(ACME_CO, { ...ACME, is_archived: true })).toBe(false);
    expect(isPortfolioJobCompany(ACME_CO, { ...ACME, organization_id: 'org-2' })).toBe(false);
    expect(isPortfolioJobCompany(ACME_CO, { ...ACME, id: 'pc-other' })).toBe(false);
  });

  it('shows a LinkedIn jobs link only when it is a valid one', () => {
    const withLink = (linkedin_url: string | null) =>
      buildPublicBoard({
        settings: null,
        portfolio: [ACME],
        jobCompanies: [company('pc-acme', 'acme-fixture', { listed: true, linkedin_url })],
        postings: [],
      }).companies[0]!.linkedinJobsUrl;
    expect(withLink('https://www.linkedin.com/company/acme-fixture/jobs/')).toBe(
      'https://www.linkedin.com/company/acme-fixture/jobs/',
    );
    expect(withLink('javascript:alert(1)')).toBeNull();
    expect(withLink('https://www.linkedin.com/company/acme-fixture')).toBeNull();
    expect(withLink(null)).toBeNull();
  });
});
