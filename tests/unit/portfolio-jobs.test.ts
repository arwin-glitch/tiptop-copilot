import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  applyJobLiveness,
  dedupeJobRoles,
  filterJobRoles,
  jobBlurb,
  jobFilterParams,
  jobKey,
  jobPlace,
  jobsFreshness,
  normalizeJobFunction,
  normalizeJobRemote,
  normalizeJobTitle,
  parseJobFilters,
  roleIsAtCompany,
  sortJobRoles,
  type JobRole,
} from '@/lib/portfolio/jobs';
import { jobId } from '@/lib/portfolio/job-id';
import { collectJobs, parseJobsMessage } from '@/lib/services/portfolio-jobs';
import { demoJobs } from '@/lib/demo/jobs-fixtures';

/** Every company, person, address and id below is fictional. */
const post = (value: unknown) => `JOBS_V1\n\`${JSON.stringify(value)}\``;
const msg = (text: string, ts: string, extra: Record<string, unknown> = {}) => ({
  text,
  ts,
  ...extra,
});

const ROLE = {
  company: 'Example Robotics',
  company_domain: 'examplerobotics.example',
  is_portfolio: true,
  title: 'Senior Backend Engineer',
  function: 'engineering',
  seniority: 'Senior',
  location: 'Austin, TX',
  remote: 'hybrid',
  comp: '$150K-$180K',
  link: 'https://jobs.examplerobotics.example/backend',
  contact_name: 'Ada Example',
  contact_email: 'ada@examplerobotics.example',
  status: 'active',
  status_note: 'late-stage interviews',
  first_seen: '2026-07-02',
  last_seen: '2026-10-01',
  times_mentioned: 4,
  sources: [
    { message_id: '1a0000000000aaaa', date: '2026-10-01', subject: 'Example Robotics - September' },
    { message_id: '1a0000000000bbbb', date: '2026-09-02', subject: 'Example Robotics - August' },
  ],
};

const RUN = '2026-10-19T13:00:00.000Z';

function role(overrides: Partial<JobRole> = {}): JobRole {
  const parsed = parseJobsMessage(post({ run_at: RUN, roles: [ROLE] }))!.roles[0]!;
  const merged = { ...parsed, ...overrides };
  return { ...merged, id: jobId(merged.company, merged.title) };
}

describe('the dedupe key', () => {
  it('reads one role through abbreviations, parentheticals and punctuation', () => {
    expect(normalizeJobTitle('Sr. Backend Eng (Remote)')).toBe('senior backend engineer');
    expect(jobKey('Example Robotics, Inc.', 'Sr. Backend Eng (Remote)')).toBe(
      jobKey('Example Robotics', 'Senior Backend Engineer'),
    );
    expect(jobId('Example Robotics', 'Senior Backend Engineer')).toBe(
      jobId('example robotics inc', 'senior backend engineer'),
    );
  });

  it('keeps different roles and companies apart', () => {
    expect(jobId('Example Robotics', 'Backend Engineer')).not.toBe(
      jobId('Example Robotics', 'Frontend Engineer'),
    );
    expect(jobId('Example Robotics', 'Backend Engineer')).not.toBe(
      jobId('Sample Freight', 'Backend Engineer'),
    );
  });
});

describe('normalizing what the routine writes', () => {
  it('maps functions, their aliases and anything else', () => {
    expect(normalizeJobFunction('Engineering')).toBe('engineering');
    expect(normalizeJobFunction('Customer Success')).toBe('customer_success');
    expect(normalizeJobFunction('GTM')).toBe('sales');
    expect(normalizeJobFunction('Machine Learning')).toBe('data');
    expect(normalizeJobFunction('astrology')).toBe('other');
    expect(normalizeJobFunction(null)).toBe('other');
  });

  it('maps remote wording and booleans, and leaves the unsaid unsaid', () => {
    expect(normalizeJobRemote('Remote (US)')).toBe('remote');
    expect(normalizeJobRemote('On-site')).toBe('onsite');
    expect(normalizeJobRemote('in office')).toBe('onsite');
    expect(normalizeJobRemote('Hybrid, 3 days')).toBe('hybrid');
    expect(normalizeJobRemote(true)).toBe('remote');
    expect(normalizeJobRemote(undefined)).toBeNull();
    expect(normalizeJobRemote('flexible')).toBeNull();
  });
});

describe('parseJobsMessage', () => {
  it('reads a post, with the app hashing its own id', () => {
    const parsed = parseJobsMessage(post({ run_at: RUN, roles: [{ ...ROLE, id: 'theirs' }] }));
    expect(parsed?.dropped).toBe(0);
    const r = parsed!.roles[0]!;
    expect(r.id).toBe(jobId('Example Robotics', 'Senior Backend Engineer'));
    expect(r.function).toBe('engineering');
    expect(r.remote).toBe('hybrid');
    // A bare day shows as that day in any US timezone.
    expect(r.first_seen).toBe('2026-07-02T12:00:00.000Z');
    expect(r.sources).toHaveLength(2);
  });

  it("undoes Slack's link markup on a job link and a contact address", () => {
    const raw = post({ run_at: RUN, roles: [ROLE] })
      .replace(
        'https://jobs.examplerobotics.example/backend',
        '<https://jobs.examplerobotics.example/backend>',
      )
      .replace(
        'ada@examplerobotics.example',
        '<mailto:ada@examplerobotics.example|ada@examplerobotics.example>',
      )
      .replace('$150K-$180K', '$150K-$180K &amp; equity');
    const r = parseJobsMessage(raw)!.roles[0]!;
    expect(r.link).toBe('https://jobs.examplerobotics.example/backend');
    expect(r.contact_email).toBe('ada@examplerobotics.example');
    expect(r.comp).toBe('$150K-$180K & equity');
  });

  it('drops a bad row and counts it, keeping the rest', () => {
    const parsed = parseJobsMessage(
      post({
        run_at: RUN,
        roles: [ROLE, { ...ROLE, title: 'Designer', status: 'maybe' }, { company: 'Nope' }],
      }),
    );
    expect(parsed?.roles.map((r) => r.title)).toEqual(['Senior Backend Engineer']);
    expect(parsed?.dropped).toBe(2);
  });

  it('keeps only plain web links, valid addresses and hex message ids', () => {
    const parsed = parseJobsMessage(
      post({
        run_at: RUN,
        roles: [
          {
            ...ROLE,
            link: 'javascript:alert(1)',
            contact_email: 'not an address',
            company_domain: 'not a domain',
          },
          { ...ROLE, title: 'Analyst', sources: [{ message_id: 'zz', date: RUN, subject: 'x' }] },
        ],
      }),
    );
    const [first] = parsed!.roles;
    expect(first?.link).toBeNull();
    expect(first?.contact_email).toBeNull();
    expect(first?.company_domain).toBeNull();
    expect(parsed?.dropped).toBe(1);
  });

  it('cuts an over-long note short and drops an over-long link, keeping the role', () => {
    const parsed = parseJobsMessage(
      post({
        run_at: RUN,
        roles: [
          {
            ...ROLE,
            status_note: `${'late-stage interviews, '.repeat(12)}want someone by January`,
            link: `https://jobs.examplerobotics.example/backend?${'x'.repeat(700)}`,
          },
        ],
      }),
    );
    expect(parsed?.dropped).toBe(0);
    const r = parsed!.roles[0]!;
    // Cut at a word, inside the limit, with no dangling comma before the ellipsis.
    expect(r.status_note!.length).toBeLessThanOrEqual(200);
    expect(r.status_note!.length).toBeGreaterThan(150);
    expect(r.status_note).toMatch(/(interviews|late-stage)…$/);
    expect(r.link).toBeNull();
  });

  it('ignores other markers, bad JSON and a bad envelope', () => {
    expect(parseJobsMessage(`PORTFOLIO_HEALTH_V1\n\`{"run_at":"${RUN}"}\``)).toBeNull();
    expect(parseJobsMessage('JOBS_V1\n`{not json}`')).toBeNull();
    expect(parseJobsMessage(post({ run_at: 'yesterday', roles: [] }))).toBeNull();
    expect(parseJobsMessage(post({ run_at: RUN, part: 99, roles: [] }))).toBeNull();
    expect(parseJobsMessage(42)).toBeNull();
  });
});

describe('collectJobs', () => {
  const second = { ...ROLE, title: 'Account Executive', function: 'sales' };
  const third = { ...ROLE, company: 'Sample Freight', title: 'Head of Ops', function: 'ops' };

  it('joins the parts of the newest run in order, and dedupes across them', () => {
    const repeat = {
      ...ROLE,
      title: 'Sr. Backend Engineer',
      last_seen: '2026-10-10',
      status_note: 'offer out',
      sources: [{ message_id: '1a0000000000cccc', date: '2026-10-10', subject: 'Hiring update' }],
    };
    const snapshot = collectJobs([
      msg(post({ run_at: RUN, part: 2, parts: 2, roles: [third, repeat] }), '1792400100.000200'),
      msg(post({ run_at: RUN, part: 1, parts: 2, roles: [ROLE, second] }), '1792400000.000100'),
    ]);
    expect(snapshot?.partial).toBe(false);
    expect(snapshot?.roles).toHaveLength(3);
    const backend = snapshot!.roles.find((r) => r.title.includes('Backend'))!;
    expect(backend.status_note).toBe('offer out');
    expect(backend.first_seen).toBe('2026-07-02T12:00:00.000Z');
    expect(backend.sources.map((s) => s.message_id)).toEqual([
      '1a0000000000cccc',
      '1a0000000000aaaa',
      '1a0000000000bbbb',
    ]);
    expect(snapshot?.runAt).toBe(RUN);
    expect(snapshot?.postedAt).toBe(new Date(1792400100.0002 * 1000).toISOString());
  });

  it('passes over a run still posting for the last complete one', () => {
    const NEXT = '2026-10-26T13:00:00.000Z';
    const messages = [
      msg(post({ run_at: NEXT, part: 1, parts: 2, roles: [second] }), '1793000000.000100'),
      msg(post({ run_at: RUN, roles: [ROLE] }), '1792400000.000100'),
    ];
    const snapshot = collectJobs(messages);
    expect(snapshot?.runAt).toBe(RUN);
    expect(snapshot?.partial).toBe(false);

    // With nothing complete to fall back on, the newest is shown, marked partial.
    const only = collectJobs([messages[0]!]);
    expect(only?.runAt).toBe(NEXT);
    expect(only?.partial).toBe(true);
  });

  it('reads a run without a parts count as whole when its parts run 1..n', () => {
    const gap = collectJobs([
      msg(post({ run_at: RUN, part: 3, roles: [third] }), '1792400200.000100'),
      msg(post({ run_at: RUN, part: 1, roles: [ROLE] }), '1792400000.000100'),
    ]);
    expect(gap?.partial).toBe(true);
    const whole = collectJobs([
      msg(post({ run_at: RUN, part: 2, roles: [third] }), '1792400200.000100'),
      msg(post({ run_at: RUN, part: 1, roles: [ROLE] }), '1792400000.000100'),
    ]);
    expect(whole?.partial).toBe(false);
  });

  it('joins parts however each spells the run time', () => {
    const snapshot = collectJobs([
      msg(
        post({ run_at: '2026-10-19T13:00:00Z', part: 2, parts: 2, roles: [third] }),
        '1792400100.1',
      ),
      msg(post({ run_at: RUN, part: 1, parts: 2, roles: [ROLE] }), '1792400000.1'),
    ]);
    expect(snapshot?.partial).toBe(false);
    expect(snapshot?.runAt).toBe(RUN);
    expect(snapshot?.roles).toHaveLength(2);
  });

  it('keeps the later post of a part posted twice', () => {
    const snapshot = collectJobs([
      msg(post({ run_at: RUN, roles: [second] }), '1792400300.000100'),
      msg(post({ run_at: RUN, roles: [ROLE] }), '1792400000.000100'),
    ]);
    expect(snapshot?.roles.map((r) => r.title)).toEqual(['Account Executive']);
  });

  it('skips edits, joins and anyone not on the poster list', () => {
    const text = post({ run_at: RUN, roles: [ROLE] });
    expect(collectJobs([msg(text, '1792400000.1', { subtype: 'message_changed' })])).toBeNull();
    expect(collectJobs([msg(text, '1792400000.1', { user: 'U_OTHER' })], ['U_POSTER'])).toBeNull();
    expect(
      collectJobs([msg(text, '1792400000.1', { user: 'U_POSTER' })], ['U_POSTER'])?.roles,
    ).toHaveLength(1);
    expect(collectJobs([])).toBeNull();
  });

  it('carries the scan window and the dropped count', () => {
    const snapshot = collectJobs([
      msg(
        post({
          run_at: RUN,
          scanned_since: '2026-06-21T00:00:00Z',
          emails_scanned: 57,
          roles: [ROLE, { title: 'broken' }],
        }),
        '1792400000.000100',
      ),
    ]);
    expect(snapshot?.scannedSince).toBe('2026-06-21T00:00:00.000Z');
    expect(snapshot?.emailsScanned).toBe(57);
    expect(snapshot?.dropped).toBe(1);
  });
});

describe('filters', () => {
  const roles = sortJobRoles([
    role(),
    role({ title: 'Account Executive', function: 'sales', status: 'probably_filled' }),
    role({
      company: 'Sample Freight',
      company_domain: null,
      title: 'Designer',
      function: 'design',
    }),
    role({ company: 'Sample Freight', title: 'Controller', function: 'finance', status: 'filled' }),
  ]);

  it('open on Active, and read anything unknown as the default', () => {
    const f = parseJobFilters({});
    expect(f).toEqual({ status: 'active', company: null, fn: null, q: '' });
    expect(parseJobFilters({ status: 'zzz', fn: 'astrology' })).toEqual(f);
    expect(jobFilterParams(f)).toEqual({});
    expect(filterJobRoles(roles, f).map((r) => r.title)).toEqual([
      'Senior Backend Engineer',
      'Designer',
    ]);
  });

  it('filter by status, company (by normalized name), team and words', () => {
    const all = parseJobFilters({ status: 'all' });
    expect(filterJobRoles(roles, all)).toHaveLength(4);
    expect(
      filterJobRoles(roles, { ...all, company: 'sample freight inc' }).map((r) => r.title),
    ).toEqual(['Designer', 'Controller']);
    expect(filterJobRoles(roles, { ...all, fn: 'sales' }).map((r) => r.title)).toEqual([
      'Account Executive',
    ]);
    expect(filterJobRoles(roles, { ...all, q: 'austin backend' }).map((r) => r.title)).toEqual([
      'Senior Backend Engineer',
    ]);
    expect(filterJobRoles(roles, { ...all, q: 'late-stage' })).toHaveLength(4);
  });

  it('count a filter with the others applied', () => {
    const f = parseJobFilters({ company: 'Sample Freight' });
    expect(filterJobRoles(roles, f, 'status')).toHaveLength(2);
    expect(filterJobRoles(roles, f, 'company')).toHaveLength(2);
    expect(jobFilterParams({ ...f, q: 'x' })).toEqual({ company: 'Sample Freight', q: 'x' });
  });
});

describe('display', () => {
  it('builds the copy blurb from title, company, place and link', () => {
    expect(jobBlurb(role())).toBe(
      'Senior Backend Engineer at Example Robotics\nAustin, TX · Hybrid\nhttps://jobs.examplerobotics.example/backend',
    );
    expect(jobBlurb(role({ location: null, remote: null, link: null }))).toBe(
      'Senior Backend Engineer at Example Robotics',
    );
    expect(jobPlace({ location: 'Remote', remote: 'remote' })).toBe('Remote');
  });

  it('matches a role to a company by domain or by name', () => {
    const r = role();
    expect(
      roleIsAtCompany(r, { name: 'Renamed Co', website: 'https://www.examplerobotics.example' }),
    ).toBe(true);
    expect(roleIsAtCompany(r, { name: 'Example Robotics Inc', domain: null })).toBe(true);
    expect(roleIsAtCompany(r, { name: 'Sample Freight', domain: 'samplefreight.example' })).toBe(
      false,
    );
  });

  it('calls a scan overdue after ten days', () => {
    const now = new Date('2026-10-21T12:00:00Z');
    expect(jobsFreshness('2026-10-19T13:00:00Z', now)).toEqual({ days: 1, stale: false });
    expect(jobsFreshness('2026-10-08T13:00:00Z', now)).toEqual({ days: 12, stale: true });
  });

  it("closes an open role whose posting is gone, never over the founder's word", () => {
    const open = role();
    const filled = role({ title: 'Controller', status: 'filled' });
    const verdicts = new Map([
      [open.id, { gone: true, board: 'Lever', checkedAt: RUN }],
      [filled.id, { gone: true, board: 'Lever', checkedAt: RUN }],
    ]);
    const [a, b] = applyJobLiveness([open, filled], verdicts);
    expect(a?.status).toBe('closed');
    expect(a?.status_note).toBe('The posting is no longer on Lever');
    expect(b?.status).toBe('filled');
    expect(applyJobLiveness([open], new Map())[0]).toBe(open);
  });

  it('merges a role listed twice into one', () => {
    const a = role();
    const b = role({ last_seen: '2026-10-15T12:00:00.000Z', times_mentioned: 6, link: null });
    const [merged, ...rest] = dedupeJobRoles([a, b]);
    expect(rest).toHaveLength(0);
    expect(merged?.times_mentioned).toBe(6);
    expect(merged?.last_seen).toBe('2026-10-15T12:00:00.000Z');
    expect(merged?.link).toBe('https://jobs.examplerobotics.example/backend');
  });
});

describe('the demo snapshot', () => {
  it('has roles in every status, fictional addresses only, and ids that match the rule', () => {
    const snapshot = demoJobs(new Date('2026-10-21T12:00:00Z'));
    const statuses = new Set(snapshot.roles.map((r) => r.status));
    expect([...statuses].sort()).toEqual(['active', 'closed', 'filled', 'probably_filled']);
    for (const r of snapshot.roles) {
      expect(r.id).toBe(jobId(r.company, r.title));
      if (r.contact_email) expect(r.contact_email).toMatch(/\.demo$/);
      if (r.link) expect(new URL(r.link).hostname).toMatch(/\.demo$/);
      for (const s of r.sources) expect(s.message_id).toMatch(/^[0-9a-f]{10,24}$/);
    }
  });
});
