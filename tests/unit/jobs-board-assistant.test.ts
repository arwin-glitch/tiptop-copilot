import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  answerFromBoard,
  APPLY_ANSWER,
  ASSISTANT_GREETING,
  editDistance,
  IDENTITY_ANSWER,
  MAX_ROLE_LINKS,
  isGeneralQuestion,
  parseQuestion,
  relatedJobs,
  REQUIREMENTS_NOTE,
  THANKS_ANSWER,
  type AssistantBoard,
} from '@/lib/jobs-board/assistant';
import {
  DEFAULT_JOBS_ASSISTANT,
  DEFAULT_JOBS_FAQ,
  JOBS_ASSISTANT_PATCH,
  readJobsAssistantConfig,
} from '@/lib/jobs-board/assistant-config';
import { buildPublicBoard } from '@/lib/jobs-board/public';
import type { JobCompany, JobPosting, PortfolioCompany } from '@/lib/types/domain';

/**
 * "Ask Arwin" on the public board, first tier: answers from the published
 * roles alone (no AI), and the written answers' settings. Every company,
 * role and place here is fictional.
 */

const ORG = 'org-1';
const NOW = '2026-10-20T12:00:00.000Z';

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterAll(() => {
  vi.useRealTimers();
});

function portfolio(id: string, name: string): PortfolioCompany {
  return {
    id,
    organization_id: ORG,
    name,
    normalized_name: name.toLowerCase(),
    domain: null,
    website: null,
    current_stage: 'Seed',
    description: 'Internal note: runway is short.',
    sector: null,
    latest_round: null,
    ownership: null,
    key_metrics: null,
    current_priorities: null,
    upcoming_fundraise: null,
    hiring_needs: null,
    gtm_needs: null,
    risks: null,
    last_contact_at: null,
    next_follow_up_at: null,
    is_archived: false,
    created_at: NOW,
    updated_at: NOW,
  } as PortfolioCompany;
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
  } as JobCompany;
}

let n = 0;
function posting(pcId: string, title: string, extra: Partial<JobPosting> = {}): JobPosting {
  n++;
  return {
    id: `p-${n}`,
    organization_id: ORG,
    portfolio_company_id: pcId,
    source: 'manual',
    source_key: `k-${n}`,
    slug: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${n}`,
    title,
    team: null,
    job_function: 'engineering',
    locations: ['Austin, TX'],
    remote: null,
    employment_type: 'full_time',
    seniority: null,
    comp: null,
    description: 'A role.',
    apply_url: 'https://apply.example/role',
    posted_at: new Date(Date.parse(NOW) - n * 60_000).toISOString(),
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
  } as JobPosting;
}

const ROWS = {
  settings: null,
  portfolio: [
    portfolio('pc-acme', 'Acme Robotics'),
    portfolio('pc-ledger', 'Ledgerbird'),
    portfolio('pc-data', 'Data Works'),
    portfolio('pc-quiet', 'Quietly Labs'),
  ],
  jobCompanies: [
    company('pc-acme', 'acme-robotics'),
    company('pc-ledger', 'ledgerbird'),
    company('pc-data', 'data-works'),
    company('pc-quiet', 'quietly-labs', { listed: true }),
  ],
  postings: [
    posting('pc-acme', 'Senior Backend Engineer', { seniority: 'senior' }),
    posting('pc-acme', 'Product Designer', { job_function: 'design', remote: 'hybrid' }),
    posting('pc-acme', 'Rust Firmware Engineer', {
      locations: ['Austin, Texas'],
      remote: 'onsite',
    }),
    posting('pc-ledger', 'Account Executive', {
      job_function: 'sales',
      locations: ['New York, NY'],
      remote: 'remote',
      comp: '$90K - $120K',
    }),
    posting('pc-ledger', 'Staff Data Scientist', {
      job_function: 'data',
      locations: ['Remote - US'],
      remote: 'remote',
      seniority: 'staff',
    }),
    posting('pc-ledger', 'Marketing Intern', {
      job_function: 'marketing',
      locations: ['New York, NY'],
      employment_type: 'internship',
      seniority: 'intern',
    }),
    posting('pc-data', 'Frontend Engineer', {
      locations: ['Denver, CO'],
      remote: 'remote',
      seniority: 'mid',
    }),
    // Never public: an emailed role nobody approved, a hidden role, a closed one.
    posting('pc-acme', 'Secret Stealth Engineer', {
      source: 'email',
      approved_at: null,
      approved_by: null,
      published: false,
    }),
    posting('pc-ledger', 'Hidden Remote Engineer', { remote: 'remote', hidden_at: NOW }),
    posting('pc-data', 'Closed Remote Engineer', { remote: 'remote', status: 'closed' }),
  ],
};

const BOARD: AssistantBoard = buildPublicBoard(ROWS);
const BASE = '/jobs';
const ask = (q: string, base = BASE) => answerFromBoard(q, BOARD, base);

describe('reading a question', () => {
  it('measures typos, giving up past the limit', () => {
    expect(editDistance('enginering', 'engineering')).toBe(1);
    expect(editDistance('ledgerbrd', 'ledgerbird')).toBe(1);
    expect(editDistance('austin', 'boston', 1)).toBe(2);
  });

  it('reads a team, a setup, a level and a type of work', () => {
    const p = parseQuestion('Any senior remote full-time engineering jobs?', BOARD);
    expect(p).toMatchObject({
      fn: 'engineering',
      remote: 'remote',
      seniority: 'senior',
      type: 'full_time',
      rolesAsked: true,
    });
  });

  it('reads a product designer as design and an account executive as sales', () => {
    expect(parseQuestion('product designer roles', BOARD).fn).toBe('design');
    expect(parseQuestion('account executive openings', BOARD)).toMatchObject({
      fn: 'sales',
      seniority: null,
    });
  });

  it('never reads an everyday word as a typo of another ("stuff" is not "staff")', () => {
    expect(parseQuestion('what stuff do you have', BOARD).seniority).toBeNull();
  });

  it('reads a company by name, by its first word, by its board address and with a typo', () => {
    for (const q of [
      'Is Acme Robotics hiring?',
      'is acme hiring',
      'acme-robotics jobs',
      'Is Acme Robtics hiring?',
    ]) {
      expect(parseQuestion(q, BOARD).company?.slug, q).toBe('acme-robotics');
    }
    expect(parseQuestion('ledgerbrd jobs', BOARD).company?.slug).toBe('ledgerbird');
  });

  it('never takes an everyday first word for a company ("data" jobs are a team)', () => {
    const p = parseQuestion('data jobs', BOARD);
    expect(p.company).toBeNull();
    expect(p.fn).toBe('data');
    expect(parseQuestion('jobs at Data Works', BOARD).company?.slug).toBe('data-works');
  });

  it('reads a place the board lists, its short form and its city across spellings', () => {
    expect(parseQuestion('roles in NYC', BOARD).place).toMatchObject({
      values: ['New York, NY'],
      label: 'New York, NY',
    });
    const austin = parseQuestion('jobs in austin', BOARD).place;
    expect(austin?.label).toBe('Austin');
    expect(austin?.values.sort()).toEqual(['Austin, TX', 'Austin, Texas']);
  });
});

describe('answers from the board', () => {
  it('answers the suggestion chips', () => {
    const remote = ask('Remote roles');
    expect(remote?.text).toBe('There are 3 open remote roles.');
    expect(remote?.seeAll).toEqual({
      label: 'See all 3',
      detail: null,
      href: '/jobs?remote=remote',
    });

    const eng = ask('Engineering roles');
    expect(eng?.text).toBe('There are 3 open engineering roles.');
    expect(eng?.links.map((l) => l.label).sort()).toEqual([
      'Frontend Engineer',
      'Rust Firmware Engineer',
      'Senior Backend Engineer',
    ]);

    expect(ask('How do I apply?')).toMatchObject({ kind: 'apply', text: APPLY_ANSWER });
  });

  it('links roles as title, company and place, at the board base it was asked on', () => {
    const answer = ask('senior engineering roles')!;
    expect(answer.text).toBe('There is 1 open senior engineering role.');
    expect(answer.links[0]).toMatchObject({
      label: 'Senior Backend Engineer',
      detail: 'Acme Robotics · Austin, TX',
    });
    expect(answer.links[0]!.href).toMatch(/^\/jobs\/acme-robotics\/senior-backend-engineer-\d+$/);
    expect(ask('senior engineering roles', '')!.links[0]!.href).toMatch(/^\/acme-robotics\//);
    expect(ask('senior engineering roles', '')!.seeAll!.href).toBe(
      '/?fn=engineering&seniority=senior',
    );
  });

  it('says whether a company is hiring, many ways', () => {
    for (const q of ['Is Acme hiring?', 'is acme robotics hiring', 'Is Acme Robtics hiring?']) {
      expect(ask(q)?.text, q).toBe('Yes, Acme Robotics has 3 open roles.');
    }
    expect(ask('ledgerbrd jobs')?.text).toBe('There are 3 open roles at Ledgerbird.');
    expect(ask('Is Quietly Labs hiring?')?.text).toBe(
      'Quietly Labs has no open roles on the board right now.',
    );
  });

  it('counts roles and companies', () => {
    expect(ask('How many jobs are there?')).toMatchObject({
      kind: 'count',
      text: 'There are 7 open roles at 3 companies.',
    });
    expect(ask('how many remote roles')?.text).toBe('There are 3 open remote roles.');
    const all = ask('what roles are open')!;
    expect(all.links).toHaveLength(MAX_ROLE_LINKS);
    expect(all.seeAll?.label).toBe('See all 7');
  });

  it('lists the companies hiring, with or without a team', () => {
    const hiring = ask('Which companies are hiring?')!;
    expect(hiring.kind).toBe('companies');
    expect(hiring.text).toBe('3 companies have open roles.');
    expect(hiring.links.map((l) => l.label)).toEqual(['Acme Robotics', 'Ledgerbird', 'Data Works']);
    expect(hiring.links[0]).toMatchObject({ detail: '3 open roles', href: '/jobs/acme-robotics' });
    expect(hiring.seeAll?.href).toBe('/jobs/companies');
    expect(ask("who's hiring engineers?")?.text).toBe('2 companies have open engineering roles.');
  });

  it('finds places, types and words from titles', () => {
    expect(ask('jobs in austin')?.text).toBe('There are 3 open roles in Austin.');
    expect(ask('nyc roles')?.text).toBe('There are 2 open roles in New York, NY.');
    expect(ask('nyc roles')?.seeAll?.href).toBe('/jobs?location=New+York%2C+NY');
    expect(ask('internships')?.text).toBe('There is 1 open internship role.');
    expect(ask('rust jobs')?.text).toBe('There is 1 open role matching “rust”.');
    expect(ask('enginering roles')?.text).toBe('There are 3 open engineering roles.');
    expect(ask('data jobs')?.links.map((l) => l.label)).toEqual(['Staff Data Scientist']);
  });

  it('says plainly when nothing matches', () => {
    expect(ask('remote design jobs')?.text).toBe(
      'There are no open remote design roles right now.',
    );
    expect(ask('jobs in Tokyo')?.text).toBe("I couldn't find open roles that mention “tokyo”.");
    // Words the board does not know are left out once something else was understood.
    expect(ask('engineering jobs in Tokyo')?.text).toBe('There are 3 open engineering roles.');
  });

  it('says who it is, honestly', () => {
    for (const q of [
      'Are you a bot?',
      'are u human',
      'Am I talking to a real person?',
      'Is this an AI?',
      'who are you',
    ]) {
      expect(ask(q), q).toMatchObject({ kind: 'identity', text: IDENTITY_ANSWER });
    }
    expect(ask('hello')).toMatchObject({ kind: 'greeting', text: ASSISTANT_GREETING });
  });

  it('answers "are you hiring" questions with roles, not with who it is', () => {
    const ai = ask('Are you hiring AI engineers?');
    expect(ai?.kind).toBe('roles');
    expect(ai?.text).not.toBe(IDENTITY_ANSWER);
    const austin = ask('Are you hiring people in Austin?');
    expect(austin?.kind).toBe('roles');
    expect(austin?.text).toMatch(/in Austin/);
    const who = ask('Who are you hiring for?');
    expect(who?.kind).not.toBe('identity');
    expect(who?.text).not.toBe(IDENTITY_ANSWER);
  });

  it('says it is an AI when asked about Arwin in the third person', () => {
    for (const q of [
      'Is Arwin a real person?',
      'Is this automated?',
      'Who is Arwin?',
      'hey, are you an AI?',
      'Is it a bot?',
      'automated?',
    ]) {
      expect(ask(q), q).toMatchObject({ kind: 'identity', text: IDENTITY_ANSWER });
    }
  });

  it('says you are welcome to a thank-you, never the greeting again', () => {
    for (const q of ['thanks!', 'Thank you', 'thank you so much', 'cheers', 'ty']) {
      expect(ask(q), q).toMatchObject({ kind: 'thanks', text: THANKS_ANSWER });
    }
    expect(ask('hi there')?.text ?? ASSISTANT_GREETING).not.toBe(THANKS_ANSWER);
  });

  it('lists roles for a level even when the question mentions experience', () => {
    const entry = ask('Entry level roles, no experience needed');
    expect(entry).toMatchObject({
      kind: 'roles',
      text: 'There are no open entry level roles right now.',
    });
    const senior = ask('Senior roles that require a degree?');
    expect(senior?.links.map((l) => l.label)).toEqual(['Senior Backend Engineer']);
    expect(senior?.text).toBe(`There is 1 open senior role. ${REQUIREMENTS_NOTE}`);
    // Pay and visas are still left to the next tier.
    expect(ask('What experience and salary do senior roles need?')).toBeNull();
    // With nothing to pick roles by, it is a question for the written answers.
    expect(ask('What experience do I need?')).toBeNull();
  });

  it('never claims a leftover question word is a place with no roles', () => {
    expect(ask('Where do the roles come from?')).toBeNull();
    expect(ask('jobs in Tokyo')?.text).toBe("I couldn't find open roles that mention “tokyo”.");
    expect(ask('roles at Globex')?.text).toBe("I couldn't find open roles that mention “globex”.");
  });

  it('marks a general board answer so a written answer can win it', () => {
    expect(isGeneralQuestion('What is this job board?', BOARD)).toBe(true);
    expect(isGeneralQuestion('How do I apply?', BOARD)).toBe(true);
    expect(isGeneralQuestion('remote engineering roles', BOARD)).toBe(false);
    expect(isGeneralQuestion('how many roles', BOARD)).toBe(false);
    expect(isGeneralQuestion('Are you a bot?', BOARD)).toBe(false);
  });

  it('leaves questions the roles cannot answer to the next tier', () => {
    for (const q of [
      'Do companies sponsor visas?',
      "What's the salary for the account executive role?",
      'What is the interview process at Acme?',
      'what is the meaning of life',
      'Tell me a joke about penguins and lighthouses',
      '',
    ]) {
      expect(ask(q), q).toBeNull();
    }
  });

  it('never surfaces a draft, hidden or closed role', () => {
    const questions = [
      'Remote roles',
      'Engineering roles',
      'is acme hiring',
      'how many roles',
      'what roles are open',
      'secret stealth engineer',
      'hidden remote engineer',
      'closed engineer jobs',
    ];
    const text = JSON.stringify(questions.map((q) => ask(q)));
    for (const secret of ['Secret Stealth', 'Hidden Remote', 'Closed Remote', 'runway']) {
      expect(text).not.toContain(secret);
    }
    expect(BOARD.jobs).toHaveLength(7);
  });

  it('picks related public roles for the routine', () => {
    expect(
      relatedJobs('Do remote roles sponsor visas?', BOARD)
        .map((j) => j.title)
        .sort(),
    ).toEqual(['Account Executive', 'Frontend Engineer', 'Staff Data Scientist']);
    expect(relatedJobs('what is the meaning of life', BOARD)).toHaveLength(7);
  });
});

describe('the written answers', () => {
  it('starts with defaults that only state what the board itself does', () => {
    const config = readJobsAssistantConfig(undefined);
    expect(config).toEqual(DEFAULT_JOBS_ASSISTANT);
    expect(config.enabled).toBe(true);
    expect(config.aiAnswers).toBe(false);
    expect(config.faqItems.map((f) => f.q)).toEqual(DEFAULT_JOBS_FAQ.map((f) => f.q));
    const text = JSON.stringify(DEFAULT_JOBS_FAQ).toLowerCase();
    for (const invented of ['visa', 'salary', 'introduc', 'review your', 'we will', 'guarantee']) {
      expect(text).not.toContain(invented);
    }
  });

  it('reads stored settings field by field, dropping only what is bad', () => {
    const config = readJobsAssistantConfig({
      enabled: false,
      aiAnswers: 'yes',
      dailyAiCap: 99,
      faqItems: [{ q: 'Remote?', a: 'Some roles are.' }, { q: '', a: 'no question' }, 'junk'],
    });
    expect(config).toEqual({
      enabled: false,
      aiAnswers: false,
      dailyAiCap: DEFAULT_JOBS_ASSISTANT.dailyAiCap,
      faqItems: [{ q: 'Remote?', a: 'Some roles are.' }],
    });
    // A list the team cleared stays cleared.
    expect(readJobsAssistantConfig({ faqItems: [] }).faqItems).toEqual([]);
    expect(readJobsAssistantConfig([1, 2]).faqItems).toHaveLength(DEFAULT_JOBS_FAQ.length);
  });

  it('validates a save strictly and makes the text plain', () => {
    expect(JOBS_ASSISTANT_PATCH.safeParse({ dailyAiCap: 31 }).success).toBe(false);
    expect(JOBS_ASSISTANT_PATCH.safeParse({ other: true }).success).toBe(false);
    const parsed = JOBS_ASSISTANT_PATCH.parse({
      faqItems: [{ q: 'Where <b>are</b> roles?', a: 'On the <script>x</script>board.' }],
    });
    expect(parsed.faqItems?.[0]).toEqual({ q: 'Where are roles?', a: 'On the xboard.' });
  });
});
