import { DEMO_IDS } from '@/lib/demo/ids';
import { guessFunction, guessSeniority, remoteFromPlace } from '@/lib/jobs-board/fields';
import { htmlToStructuredText } from '@/lib/jobs-board/sanitize';
import { roleSlug } from '@/lib/jobs-board/slug';
import type { JobBoardSettings, JobCompany, JobPosting } from '@/lib/types/domain';
import { shortHash } from '@/lib/util/hash';

/**
 * Demo mode only: the public job board, switched on, over the demo
 * portfolio's two invented companies. Ledgerly lists its roles on an
 * invented Greenhouse board (`ledgerly-demo`) that demo mode "reads" from
 * `demoAtsFetch` below, never the network; Stonebridge Ops has one role
 * added by hand. Every company, role, address and id is fictional.
 *
 * The emailed roles come from the demo jobs snapshot (jobs-fixtures.ts) the
 * first time the Jobs tab is opened: Stonebridge's "Founding Engineer"
 * waits for approval there.
 */

const NS = '00000000-0000-4000-8000-';
const id = (n: number) => `${NS}${n.toString(16).padStart(12, '0')}`;

export const DEMO_JOBS_IDS = {
  settings: id(0x9a000),
  ledgerly: id(0x9a001),
  stonebridge: id(0x9a002),
  hiddenRole: id(0x9a105),
  manualRole: id(0x9a201),
} as const;

export const DEMO_GREENHOUSE_TOKEN = 'ledgerly-demo';

interface DemoBoardRole {
  id: number;
  title: string;
  department: string;
  location: string;
  html: string;
  /** Days before now it was first published. */
  age: number;
  /** In the demo store already (false: only the board lists it, so "Refresh now" adds it). */
  seeded: boolean;
}

const enc = (html: string) =>
  html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const LEDGERLY_ROLES: DemoBoardRole[] = [
  {
    id: 4100101,
    title: 'VP Sales',
    department: 'Sales',
    location: 'Chicago, IL (Hybrid)',
    age: 21,
    seeded: true,
    html: '<p>Ledgerly builds AI bookkeeping for accounting firms. We are looking for our first VP Sales to build the team that takes us from 94 firms to 500.</p><h3>What you will do</h3><ul><li>Own new revenue and build a team of five account executives</li><li>Turn founder-led sales into a repeatable playbook</li><li>Work with product on pricing and packaging</li></ul><h3>About you</h3><ul><li>Seven or more years selling software to professional services</li><li>You have hired and led a sales team before</li></ul>',
  },
  {
    id: 4100102,
    title: 'Senior Backend Engineer',
    department: 'Engineering',
    location: 'Remote - US',
    age: 12,
    seeded: true,
    html: '<p>Join a small team building the ledger engine that reconciles millions of transactions a month.</p><p><strong>What you will work on</strong></p><ul><li>Our TypeScript and Postgres services</li><li>Bank feed connectors and matching</li></ul><script>alert(1)</script>',
  },
  {
    id: 4100103,
    title: 'Product Designer',
    department: 'Design',
    location: 'Chicago, IL',
    age: 9,
    seeded: true,
    html: '<p>Design the workflows accountants use every day. You will own research, flows and the design system.</p>',
  },
  {
    id: 4100104,
    title: 'Customer Success Manager',
    department: 'Customer Success',
    location: 'Remote - US',
    age: 4,
    seeded: true,
    html: '<p>Help accounting firms get live in their first 30 days, and keep them growing after.</p>',
  },
  {
    id: 4100105,
    title: 'Executive Assistant to the CEO',
    department: 'Operations',
    location: 'Chicago, IL',
    age: 30,
    seeded: true,
    html: '<p>Support our CEO with scheduling, travel and board preparation.</p>',
  },
  {
    id: 4100106,
    title: 'Data Engineer',
    department: 'Engineering',
    location: 'Remote - US',
    age: 1,
    seeded: false,
    html: '<p>Build the pipelines behind our reconciliation models.</p>',
  },
];

function greenhouseJob(role: DemoBoardRole, now: Date) {
  const published = new Date(now.getTime() - role.age * 86_400_000).toISOString();
  return {
    id: role.id,
    internal_job_id: role.id + 1000,
    title: role.title,
    updated_at: published,
    first_published: published,
    requisition_id: null,
    location: { name: role.location },
    absolute_url: `https://job-boards.greenhouse.io/${DEMO_GREENHOUSE_TOKEN}/jobs/${role.id}`,
    metadata: [{ id: 1, name: 'Employment Type', value: 'Full-time', value_type: 'single_select' }],
    // Greenhouse sends the description entity-encoded.
    content: enc(role.html),
    departments: [{ id: 7, name: role.department }],
    offices: [],
  };
}

/** The invented Greenhouse board's API answer. */
export function demoGreenhouseAnswer(now: Date) {
  return {
    jobs: LEDGERLY_ROLES.map((r) => greenhouseJob(r, now)),
    meta: { total: LEDGERLY_ROLES.length },
  };
}

/**
 * Demo mode's stand-in for the network: the invented board and its
 * robots.txt; everything else is "not found".
 */
export const demoAtsFetch: typeof fetch = async (input) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url === 'https://boards-api.greenhouse.io/robots.txt') {
    return new Response('User-agent: *\nDisallow: /embed/\n', { status: 200 });
  }
  if (
    url === `https://boards-api.greenhouse.io/v1/boards/${DEMO_GREENHOUSE_TOKEN}/jobs?content=true`
  ) {
    return new Response(JSON.stringify(demoGreenhouseAnswer(new Date())), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response('Not found', { status: 404 });
};

export function demoJobsBoard(now: Date): {
  job_board_settings: JobBoardSettings[];
  job_companies: JobCompany[];
  job_postings: JobPosting[];
} {
  const iso = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
  const org = DEMO_IDS.org;
  const created = iso(14);

  const settings: JobBoardSettings = {
    id: DEMO_JOBS_IDS.settings,
    organization_id: org,
    enabled: true,
    title: 'Jobs at TipTop portfolio companies',
    intro:
      'Open roles at the companies TipTop backs. Every role links straight to the company to apply.',
    accent: '#0FC382',
    updated_by: DEMO_IDS.user,
    created_at: created,
    updated_at: created,
  };

  const company = (
    fields: Partial<JobCompany> & Pick<JobCompany, 'id' | 'portfolio_company_id' | 'slug'>,
  ): JobCompany => ({
    organization_id: org,
    careers_url: null,
    ats: null,
    ats_token: null,
    sync_enabled: false,
    auto_publish: false,
    listed: true,
    logo_url: null,
    about: null,
    last_sync_at: null,
    last_sync_status: null,
    last_sync_message: null,
    last_sync_count: null,
    created_at: created,
    updated_at: created,
    ...fields,
  });

  const companies: JobCompany[] = [
    company({
      id: DEMO_JOBS_IDS.ledgerly,
      portfolio_company_id: DEMO_IDS.pcLedgerly,
      slug: 'ledgerly',
      careers_url: `https://job-boards.greenhouse.io/${DEMO_GREENHOUSE_TOKEN}`,
      ats: 'greenhouse',
      ats_token: DEMO_GREENHOUSE_TOKEN,
      sync_enabled: true,
      auto_publish: true,
      about:
        'AI bookkeeping for accounting firms: the ledger reconciles itself, and accountants review instead of re-key.',
      last_sync_at: iso(0.2),
      last_sync_status: 'ok',
      last_sync_message: '5 open roles',
      last_sync_count: 5,
    }),
    company({
      id: DEMO_JOBS_IDS.stonebridge,
      portfolio_company_id: DEMO_IDS.pcStonebridge,
      slug: 'stonebridge-ops',
      careers_url: 'https://stonebridgeops.demo/careers',
      about:
        'Operations software for field-service teams: scheduling, dispatch and job costing in one place.',
    }),
  ];

  const postings: JobPosting[] = LEDGERLY_ROLES.filter((r) => r.seeded).map((role) => {
    const key = `greenhouse:${DEMO_GREENHOUSE_TOKEN}:${role.id}`;
    const hidden = role.id === 4100105;
    return {
      id: hidden ? DEMO_JOBS_IDS.hiddenRole : id(0x9a100 + (role.id - 4100100)),
      organization_id: org,
      portfolio_company_id: DEMO_IDS.pcLedgerly,
      source: 'ats',
      source_key: key,
      slug: roleSlug(role.title, shortHash(key, 6)),
      title: role.title,
      team: role.department,
      job_function: guessFunction(role.title, role.department),
      locations: [role.location],
      remote: remoteFromPlace(role.location),
      employment_type: 'full_time',
      seniority: guessSeniority(role.title),
      comp: null,
      description: htmlToStructuredText(enc(role.html)),
      apply_url: `https://job-boards.greenhouse.io/${DEMO_GREENHOUSE_TOKEN}/jobs/${role.id}`,
      posted_at: iso(role.age),
      source_updated_at: iso(role.age),
      status: 'active',
      published: !hidden,
      featured: role.id === 4100101,
      approved_by: null,
      approved_at: null,
      hidden_by: hidden ? DEMO_IDS.user : null,
      hidden_at: hidden ? iso(10) : null,
      first_seen_at: iso(role.age),
      last_seen_at: iso(0.2),
      closed_at: null,
      created_at: iso(role.age),
      updated_at: iso(0.2),
    } satisfies JobPosting;
  });

  const manualKey = 'demo-manual-operations-lead';
  postings.push({
    id: DEMO_JOBS_IDS.manualRole,
    organization_id: org,
    portfolio_company_id: DEMO_IDS.pcStonebridge,
    source: 'manual',
    source_key: manualKey,
    slug: roleSlug('Operations Lead', shortHash(`manual:${manualKey}`, 6)),
    title: 'Operations Lead',
    team: 'Operations',
    job_function: 'operations',
    locations: ['Austin, TX'],
    remote: 'onsite',
    employment_type: 'full_time',
    seniority: 'lead',
    comp: '$95K – $115K / year',
    description:
      'Run day-to-day operations for our first 40 customers and build the playbooks that let us serve 400.\n\n## What you will do\n\n- Own onboarding and scheduling for new customers\n- Work with the founders on pricing and contracts\n- Hire the first two operations specialists',
    apply_url: 'https://stonebridgeops.demo/careers/operations-lead',
    posted_at: iso(6),
    source_updated_at: null,
    status: 'active',
    published: true,
    featured: false,
    approved_by: DEMO_IDS.user,
    approved_at: iso(6),
    hidden_by: null,
    hidden_at: null,
    first_seen_at: iso(6),
    last_seen_at: iso(6),
    closed_at: null,
    created_at: iso(6),
    updated_at: iso(6),
  });

  return { job_board_settings: [settings], job_companies: companies, job_postings: postings };
}
