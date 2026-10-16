import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  askKeywords,
  candidateFromContact,
  categoriesOf,
  mergeCandidates,
  stem,
  suggestHelpers,
  type HelperCandidate,
} from '@/lib/network/helpers';
import { listCrmPeople } from '@/lib/services/crm-pages';
import {
  affinityPeopleAt,
  cachedAffinityPoolSize,
  candidateFromEntry,
  helpersForRequests,
  loadHelperCandidates,
  networkSummary,
  resetHelperCandidates,
} from '@/lib/services/network-helpers';
import { recordAutoAsks, resetPortfolioAsks } from '@/lib/services/portfolio-asks';
import { openRequests, listPortfolio } from '@/lib/services/portfolio';
import { resetRelationshipCache } from '@/lib/services/relationships';
import { DEMO_IDS } from '@/lib/demo/ids';
import type { CrmField, CrmRecord, NetworkContact } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

// Fictional people, firms and lists only: this repository is public.

const NOW = new Date('2026-10-15T15:00:00Z');

function contact(overrides: Partial<NetworkContact>): NetworkContact {
  return {
    id: 'c-0',
    organization_id: 'org',
    full_name: 'Nobody',
    email: null,
    company: null,
    title: null,
    relationship: null,
    expertise: [],
    geography: null,
    notes: null,
    source_document_id: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function affinityPerson(overrides: Partial<HelperCandidate>): HelperCandidate {
  return {
    key: `record:${overrides.name ?? 'x'}`,
    source: 'affinity',
    kind: 'person',
    name: 'Someone',
    email: null,
    title: null,
    company: null,
    recordId: `rec-${overrides.name ?? 'x'}`,
    contactId: null,
    lists: [],
    relationship: null,
    expertise: [],
    details: [],
    ...overrides,
  };
}

const coInvestor = candidateFromContact(
  contact({
    id: 'c-1',
    full_name: 'Dana Example',
    email: 'dana@harbor-capital.example',
    company: 'Harbor Capital',
    title: 'Partner',
    relationship: 'Co-investor',
    expertise: ['seed fintech'],
  }),
);
const recruiter = candidateFromContact(
  contact({
    id: 'c-2',
    full_name: 'Jules Example',
    company: 'Talentworks Example',
    title: 'Head of Talent',
    relationship: 'Advisor',
    expertise: ['technical recruiting', 'seed-stage hiring'],
  }),
);
const warmVc = affinityPerson({
  name: 'Kit Warm',
  title: 'General Partner',
  company: 'Northfield Ventures',
  lists: [{ name: 'Co-investor VCs', destination: 'investors' }],
  relationship: 'Warm',
});
const coldVc = affinityPerson({
  name: 'Lee Cold',
  title: 'Principal',
  company: 'Faraway Capital',
  lists: [{ name: 'Co-investor VCs', destination: 'investors' }],
  relationship: 'New',
});
const mailedVc = affinityPerson({
  name: 'Mo Mailed',
  email: 'mo@quill-ventures.example',
  lists: [{ name: 'Intro Round Investors', destination: 'investors' }],
});
const founderAtAsker = affinityPerson({
  name: 'Ray Founder',
  email: 'ray@brightfield.example',
  lists: [{ name: 'Fund I Founders', destination: 'portfolio_people' }],
  relationship: 'Close',
});
const operator = affinityPerson({
  name: 'Ola Operator',
  title: 'COO',
  company: 'Freightline Example',
  lists: [{ name: 'Operator Circle', destination: 'operators' }],
  details: ['logistics', 'COO'],
});

const ALL = [coInvestor, recruiter, warmVc, coldVc, mailedVc, founderAtAsker, operator];
const BRIGHTFIELD = { name: 'Brightfield', domain: 'brightfield.example' };

describe('who could help', () => {
  it('names people whose kind fits and whom Nick knows, with why', () => {
    const lastContact = (c: HelperCandidate) =>
      c.email === 'mo@quill-ventures.example' ? '2026-09-01T12:00:00.000Z' : null;
    const matches = suggestHelpers(
      {
        requestType: 'investor_introduction',
        text: 'Intros to Series A investors who know payments',
        company: BRIGHTFIELD,
      },
      ALL,
      { now: NOW, lastContact, max: 5 },
    );
    const names = matches.map((m) => m.candidate.name);
    expect(names).toEqual(expect.arrayContaining(['Dana Example', 'Kit Warm', 'Mo Mailed']));
    // On an investor list, but nothing ties them to Nick or to the ask.
    expect(names).not.toContain('Lee Cold');
    // The asking company's own founder is never suggested to it.
    expect(names).not.toContain('Ray Founder');
    // Mail with them most recently first.
    expect(names[0]).toBe('Mo Mailed');

    const kit = matches.find((m) => m.candidate.name === 'Kit Warm');
    expect(kit?.reasons).toEqual([
      'On “Co-investor VCs” (Investors) in Affinity',
      'Relationship: Warm',
    ]);
    const dana = matches.find((m) => m.candidate.name === 'Dana Example');
    expect(dana?.reasons).toContain('In the contacts you imported');
  });

  it('matches recruiting asks to people in recruiting, and the ask words to their data', () => {
    const [first, ...rest] = suggestHelpers(
      {
        requestType: 'candidate_request',
        text: 'Referrals for a founding engineer with seed-stage experience',
        company: BRIGHTFIELD,
      },
      ALL,
      { now: NOW },
    );
    expect(first?.candidate.name).toBe('Jules Example');
    // "seed" is a kind word (it says what help, not what about); "stage" is evidence.
    expect(first?.reasons).toContain('Matches “stage” in their expertise');
    expect(rest.map((m) => m.candidate.name)).not.toContain('Kit Warm');
  });

  it('finds people by the words of a general ask when they say enough', () => {
    const matches = suggestHelpers(
      {
        requestType: 'general_update',
        text: 'Anyone who knows logistics COOs?',
        company: BRIGHTFIELD,
      },
      ALL,
      { now: NOW },
    );
    // Two words of the ask (logistics, COO) in Ola's data, but no tie to Nick: not enough.
    expect(matches).toEqual([]);
  });

  it('names nobody when nothing fits, and never more than three', () => {
    expect(
      suggestHelpers(
        { requestType: 'urgent_problem', text: 'Our office flooded', company: BRIGHTFIELD },
        ALL,
        { now: NOW },
      ),
    ).toEqual([]);
    const many = Array.from({ length: 8 }, (_, i) =>
      affinityPerson({
        name: `Warm ${i}`,
        lists: [{ name: 'Co-investor VCs', destination: 'investors' }],
        relationship: 'Close',
      }),
    );
    expect(
      suggestHelpers(
        { requestType: 'fundraising', text: 'Bridge round', company: BRIGHTFIELD },
        many,
        { now: NOW },
      ),
    ).toHaveLength(3);
  });

  it('never counts the kind of help as evidence twice', () => {
    expect(askKeywords('Intros to Series A investors and recruiters')).toEqual([]);
    expect(stem('recruiters')).toBe(stem('recruiting'));
  });

  it('reads what a candidate is from their lists and their own words', () => {
    expect([...categoriesOf(coInvestor)]).toContain('investors');
    expect([...categoriesOf(recruiter)]).toEqual(expect.arrayContaining(['talent', 'providers']));
    expect([...categoriesOf(operator)]).toContain('operators');
    expect([...categoriesOf(founderAtAsker)]).toEqual(['founders']);
  });
});

describe('who could help: evidence, never a list at random', () => {
  const recently = () => '2026-08-01T12:00:00.000Z';
  const investorMd = affinityPerson({
    name: 'Vera Example',
    email: 'vera@harbor-ventures.example',
    title: 'Managing Director',
    company: 'Harbor Ventures',
    lists: [{ name: 'Investors', destination: 'investors' }],
  });
  const investorVp = affinityPerson({
    name: 'Vic Example',
    email: 'vic@harbor-ventures.example',
    title: 'VP',
    company: 'Harbor Ventures',
    lists: [{ name: 'Co-investor VCs', destination: 'investors' }],
  });
  const otherFounder = affinityPerson({
    name: 'Fen Founder',
    email: 'fen@otherco.example',
    lists: [{ name: 'Fund I Founders', destination: 'portfolio_people' }],
  });

  it('never makes a VC partner an operator because of a seniority word', () => {
    expect([...categoriesOf(investorMd)]).toEqual(['investors']);
    expect([...categoriesOf(investorVp)]).toEqual(['investors']);
    // With no list to say what they are, a VP is someone who runs something.
    const vpSales = candidateFromContact(
      contact({ id: 'c-7', full_name: 'Val Example', title: 'VP Sales', company: 'Acme Example' }),
    );
    expect([...categoriesOf(vpSales)]).toContain('operators');
  });

  it('names nobody for a broad ask on a fitting kind and recent mail alone', () => {
    const pool = [investorMd, investorVp, otherFounder];
    for (const [requestType, text] of [
      ['customer_introduction', 'Intros to CFOs at mid-market SaaS companies'],
      ['advisor_request', 'An advisor who knows SOC 2'],
      ['gtm_strategy', 'Feedback on our pricing page'],
      ['product_feedback', 'Beta testers for the new onboarding flow'],
    ] as const) {
      expect(
        suggestHelpers({ requestType, text, company: BRIGHTFIELD }, pool, {
          now: NOW,
          lastContact: recently,
        }),
      ).toEqual([]);
    }
  });

  it('still names a founder for a broad ask when a word of it is in their data', () => {
    const accountingFounder = affinityPerson({
      name: 'Ada Founder',
      email: 'ada@ledgerwise.example',
      lists: [{ name: 'Fund I Founders', destination: 'portfolio_people' }],
      details: ['Accounting software for mid-market firms'],
    });
    const [match] = suggestHelpers(
      {
        requestType: 'customer_introduction',
        text: 'Intros to controllers at mid-market accounting firms',
        company: BRIGHTFIELD,
      },
      [accountingFounder, otherFounder],
      { now: NOW, lastContact: recently },
    );
    expect(match?.candidate.name).toBe('Ada Founder');
    expect(match?.reasons.join(' ')).toMatch(/Matches “mid”, “market” in their Affinity columns/);
  });

  it('never counts the words of a list name, or a kind word by its stem', () => {
    // "investing" and "invest" stem like "investors": never a word of the ask.
    expect(askKeywords('Intros to seed funds investing in vertical SaaS')).toEqual([
      'vertical',
      'saas',
    ]);
    expect(askKeywords('Angels who invest in fintech')).toEqual(['fintech']);

    const strangers = ['Aaron Abbot', 'Beth Brown', 'Carl Cole', 'Dina Dale', 'Eli Eve'].map(
      (name) =>
        affinityPerson({ name, lists: [{ name: 'Co-investor VCs', destination: 'investors' }] }),
    );
    const angels = ['Gus Gale', 'Hal Hart'].map((name) =>
      affinityPerson({ name, lists: [{ name: 'Angel Investors', destination: 'investors' }] }),
    );
    const providers = ['Ivy Ink', 'Jay Jolt'].map((name) =>
      affinityPerson({
        name,
        kind: 'firm',
        lists: [{ name: 'Professional Service Providers', destination: 'providers' }],
      }),
    );
    for (const [requestType, text] of [
      ['investor_introduction', 'Intros to seed funds investing in vertical SaaS'],
      ['investor_introduction', 'Intros to angels who invest in fintech'],
      ['advisor_request', 'An advisor from a professional services firm'],
      ['general_update', 'Anyone who knows professional services?'],
    ] as const) {
      expect(
        suggestHelpers(
          { requestType, text, company: BRIGHTFIELD },
          [...strangers, ...angels, ...providers],
          { now: NOW },
        ),
      ).toEqual([]);
    }
  });

  it('matches thousands of candidates against many requests quickly', () => {
    const many = Array.from({ length: 4_500 }, (_, i) =>
      affinityPerson({
        key: `record:perf-${i}`,
        name: `Person ${i}`,
        email: `p${i}@firm${i % 300}.example`,
        title: i % 3 ? 'Partner' : 'Head of Operations',
        company: `Firm ${i % 300} Example`,
        lists: [{ name: 'Co-investor VCs', destination: i % 2 ? 'investors' : 'operators' }],
        relationship: i % 50 === 0 ? 'Warm' : null,
        details: Array.from({ length: 14 }, (_, j) => `detail ${j} about fintech payments ${i}`),
      }),
    );
    const asks = Array.from({ length: 40 }, (_, i) => ({
      requestType: (i % 2 ? 'investor_introduction' : 'customer_introduction') as
        'investor_introduction' | 'customer_introduction',
      text: `Intros to leads in payments number ${i} for logistics buyers`,
      company: BRIGHTFIELD,
    }));
    const started = performance.now();
    for (const ask of asks) suggestHelpers(ask, many, { now: NOW });
    // About five seconds before each candidate's words were read once; well
    // under one now. The bound is loose so a slow machine never fails it.
    expect(performance.now() - started).toBeLessThan(2_500);
  });
});

describe('candidates from Affinity', () => {
  const fields: CrmField[] = [
    { key: 'relationship', name: 'Relationship', type: 'status', options: ['Close', 'Warm'] },
    { key: 'firm', name: 'Firm', type: 'company' },
    { key: 'check', name: 'Check Size', type: 'money' },
  ];
  const record: CrmRecord = {
    id: 'rec-1',
    organization_id: 'org',
    kind: 'person',
    source: 'affinity',
    external_id: '1',
    name: 'Kit Warm',
    name_key: 'kit warm',
    domain: null,
    emails: ['kit@northfield.example'],
    primary_email: 'kit@northfield.example',
    fields: { 'Job Title': 'General Partner', Phone: '555-0100' },
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };

  it('takes a person row with its role, firm and relationship, never an amount', () => {
    const c = candidateFromEntry(
      {
        id: 'e1',
        title: 'Kit Warm',
        values: { relationship: 'Warm', firm: ['Northfield Ventures'], check: 250000 },
      },
      { name: 'Co-investor VCs', entity_type: 'person', fields, destination: 'investors' },
      record,
    );
    expect(c).toMatchObject({
      key: 'record:rec-1',
      kind: 'person',
      name: 'Kit Warm',
      email: 'kit@northfield.example',
      title: 'General Partner',
      company: 'Northfield Ventures',
      relationship: 'Warm',
      lists: [{ name: 'Co-investor VCs', destination: 'investors' }],
    });
    expect(c?.details.join(' ')).not.toMatch(/250000|555-0100/);
  });

  it('takes provider firms as firms, and skips company rows elsewhere', () => {
    const firm = candidateFromEntry(
      { id: 'e2', title: 'Ashfield Legal Example', values: {} },
      { name: 'Service Providers', entity_type: 'company', fields: [], destination: 'providers' },
      undefined,
    );
    expect(firm).toMatchObject({ kind: 'firm', key: 'entry:e2', name: 'Ashfield Legal Example' });
    expect(
      candidateFromEntry(
        { id: 'e3', title: 'Gold Sponsor Example', values: {} },
        { name: 'Summit Sponsors', entity_type: 'company', fields: [], destination: 'events' },
        undefined,
      ),
    ).toBeNull();
  });

  it('merges an imported contact and an Affinity person with the same address', () => {
    const imported = candidateFromContact(
      contact({ id: 'c-9', full_name: 'Kit Warm', email: 'kit@northfield.example' }),
    );
    const fromAffinity = affinityPerson({
      key: 'record:rec-1',
      recordId: 'rec-1',
      name: 'Kit Warm',
      email: 'kit@northfield.example',
      lists: [{ name: 'Co-investor VCs', destination: 'investors' }],
    });
    const merged = mergeCandidates([imported], [fromAffinity, { ...fromAffinity }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      source: 'imported',
      contactId: 'c-9',
      recordId: 'rec-1',
      lists: [{ name: 'Co-investor VCs', destination: 'investors' }],
    });
  });
});

describe('helpers for requests (demo workspace)', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness({ now: NOW });
    resetHelperCandidates();
    resetRelationshipCache();
    resetPortfolioAsks();
  });
  afterEach(async () => {
    resetHelperCandidates();
    resetRelationshipCache();
    await harness.dispose();
  });

  it('draws on the people from Affinity as well as the imported contacts', async () => {
    const org = harness.auth.organizationId;
    const candidates = await loadHelperCandidates(harness.store, org, { now: NOW });
    expect(candidates.some((c) => c.source === 'imported')).toBe(true);
    expect(candidates.some((c) => c.name === 'Hana Kuroda' && c.source === 'affinity')).toBe(true);
    // Fund II's LP lists are never a pool of helpers.
    expect(candidates.some((c) => c.lists.some((l) => l.name === 'LP Pipeline'))).toBe(false);

    const [requests, companies] = await Promise.all([openRequests(org), listPortfolio(org)]);
    const helpers = await helpersForRequests(harness.store, org, requests, companies, { now: NOW });
    const ledgerly = helpers[DEMO_IDS.updateLedgerly] ?? [];
    // The contact chosen when it was classified stays first, then the rules add Affinity's.
    expect(ledgerly[0]).toMatchObject({ name: 'Daniel Okafor', stored: true });
    const hana = ledgerly.find((h) => h.name === 'Hana Kuroda');
    expect(hana).toMatchObject({ source: 'affinity', stored: false });
    expect(hana?.reasons[0]).toBe('On “Co-investor VCs” (Investors) in Affinity');
    expect(ledgerly.length).toBeLessThanOrEqual(3);
    // Nobody from Ledgerly itself.
    expect(ledgerly.some((h) => h.name === 'Maya Chen')).toBe(false);
  });

  it('attaches helpers to asks read from updates', async () => {
    const org = harness.auth.organizationId;
    await recordAutoAsks(
      harness.store,
      org,
      [
        {
          messageId: 'b1b2c3d4e5f60001',
          threadId: 'b1b2c3d4e5f60001',
          companyId: DEMO_IDS.pcStonebridge,
          subject: 'Stonebridge Ops update',
          sender: 'Jonas Reyes',
          receivedAt: NOW.toISOString(),
          body: 'How you can help\n- Referrals for a founding engineer',
        },
      ],
      { now: NOW },
    );
    const [requests, companies] = await Promise.all([openRequests(org), listPortfolio(org)]);
    const ask = requests.find((r) => r.summary === 'Referrals for a founding engineer');
    expect(ask).toBeDefined();
    const helpers = await helpersForRequests(harness.store, org, [ask!], companies, { now: NOW });
    expect(helpers[ask!.id]?.[0]?.name).toBe('Jean-Marc Baptiste');
  });

  it('names the people Affinity holds at a firm, with their lists and no amounts', async () => {
    const org = harness.auth.organizationId;
    const atFirm = await affinityPeopleAt(harness.store, org, {
      domains: ['riverlight.example'],
      addresses: [],
    });
    expect(atFirm).toHaveLength(1);
    expect(atFirm[0]).toMatchObject({ name: 'Hana Kuroda', title: 'General Partner' });
    expect(atFirm[0]?.lists).toEqual(expect.arrayContaining(['Co-investor VCs']));
    // Who and which lists, nothing else: never a commitment or any other amount.
    expect(Object.keys(atFirm[0] ?? {}).sort()).toEqual(['lists', 'name', 'recordId', 'title']);

    const byAddress = await affinityPeopleAt(harness.store, org, {
      domains: [],
      addresses: ['msolberg@mail.example'],
    });
    expect(byAddress.map((p) => p.name)).toEqual(['Maren Solberg']);
    expect(
      await affinityPeopleAt(harness.store, org, { domains: ['nobody.example'], addresses: [] }),
    ).toEqual([]);
  });

  it('counts both halves of the network for Knowledge, from the pool who could help reads', async () => {
    const org = harness.auth.organizationId;
    // Nothing in memory yet: a badge is left off rather than read thousands of rows.
    expect(cachedAffinityPoolSize(org, NOW)).toBeNull();
    const summary = await networkSummary(harness.store, org, { now: NOW });
    expect(summary.imported).toBe(4);
    expect(summary.affinityPeople).toBeGreaterThan(0);
    expect(summary.destinations.map((d) => d.destination)).toEqual(
      expect.arrayContaining(['investors', 'operators', 'portfolio_people']),
    );
    // The same number as the people "who could help" can name.
    const candidates = await loadHelperCandidates(harness.store, org, { now: NOW });
    expect(summary.affinityPeople).toBe(
      candidates.filter((c) => c.source === 'affinity' && c.kind === 'person').length,
    );
    expect(cachedAffinityPoolSize(org, NOW)).toBe(summary.affinityPeople);

    const searched = await networkSummary(harness.store, org, { query: 'Kuroda', now: NOW });
    expect(searched.affinityPeople).toBe(1);
    // Someone only on an LP list is in Affinity, but never in the introductions network.
    const lpOnly = await listCrmPeople(harness.store, org, { query: 'Thistlewood' });
    expect(lpOnly.ok && lpOnly.value.total).toBe(1);
    expect(
      (await networkSummary(harness.store, org, { query: 'Thistlewood', now: NOW })).affinityPeople,
    ).toBe(0);
  });
});
