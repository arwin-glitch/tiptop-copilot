import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  atsApiUrl,
  atsBoardUrl,
  detectAtsFromUrl,
  detectAtsInHtml,
  isValidAtsToken,
  parseAtsJobs,
} from '@/lib/jobs-board/ats';

/**
 * Companies' public job boards read into one shape, from recorded answers in
 * each board's documented format. Every company, role and address in the
 * fixtures is fictional.
 */

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join('tests', 'fixtures', 'ats', `${name}.json`), 'utf8'));
}

describe('detectAtsFromUrl', () => {
  it.each([
    ['https://boards.greenhouse.io/examplerobotics', 'greenhouse', 'examplerobotics'],
    [
      'https://job-boards.greenhouse.io/examplerobotics/jobs/7000001',
      'greenhouse',
      'examplerobotics',
    ],
    ['boards.greenhouse.io/embed/job_board?for=examplerobotics', 'greenhouse', 'examplerobotics'],
    [
      'https://boards-api.greenhouse.io/v1/boards/examplerobotics/jobs',
      'greenhouse',
      'examplerobotics',
    ],
    ['https://jobs.lever.co/northwindfixture', 'lever', 'northwindfixture'],
    [
      'jobs.lever.co/northwindfixture/0d6f8a4e-1c2b-4a5d-9e8f-123456789abc',
      'lever',
      'northwindfixture',
    ],
    ['https://api.lever.co/v0/postings/northwindfixture?mode=json', 'lever', 'northwindfixture'],
    ['https://jobs.ashbyhq.com/fixturelabs', 'ashby', 'fixturelabs'],
    ['https://api.ashbyhq.com/posting-api/job-board/fixturelabs', 'ashby', 'fixturelabs'],
    ['https://apply.workable.com/fixture-foods/', 'workable', 'fixture-foods'],
    ['https://fixture-foods.workable.com', 'workable', 'fixture-foods'],
    [
      'https://apply.workable.com/api/v1/widget/accounts/fixture-foods',
      'workable',
      'fixture-foods',
    ],
    ['https://fixturetools.recruitee.com/', 'recruitee', 'fixturetools'],
  ])('%s -> %s %s', (url, ats, token) => {
    expect(detectAtsFromUrl(url)).toEqual({ ats, token });
  });

  it.each([
    'https://examplerobotics.example/careers',
    'https://boards.greenhouse.io/',
    'https://boards.greenhouse.io/embed/job_board',
    'https://apply.workable.com/j/ABC123DEF',
    'https://www.recruitee.com/',
    'https://jobs.lever.co/bad%20name',
    'ftp://jobs.lever.co/northwindfixture',
    'https://user:pass@jobs.lever.co/northwindfixture',
    'not a url',
    '',
    null,
  ])('reads %s as no supported board', (url) => {
    expect(detectAtsFromUrl(url)).toBeNull();
  });

  it('never accepts a token that could change the address', () => {
    expect(isValidAtsToken('greenhouse', '../admin')).toBe(false);
    expect(isValidAtsToken('lever', 'a/b')).toBe(false);
    expect(isValidAtsToken('recruitee', 'has.dot')).toBe(false);
    expect(isValidAtsToken('recruitee', 'fixture-tools')).toBe(true);
  });
});

describe('detectAtsInHtml', () => {
  it('finds an embedded Greenhouse board on a company careers page', () => {
    const html =
      '<html><script src="https://boards.greenhouse.io/embed/job_board/js?for=examplerobotics"></script></html>';
    expect(detectAtsInHtml(html)).toEqual({ ats: 'greenhouse', token: 'examplerobotics' });
  });

  it('finds Lever and Ashby links and widgets, skipping non-board paths', () => {
    expect(
      detectAtsInHtml('<a href="https://jobs.lever.co/northwindfixture/abc">Apply</a>'),
    ).toEqual({
      ats: 'lever',
      token: 'northwindfixture',
    });
    expect(
      detectAtsInHtml('<script src="https://jobs.ashbyhq.com/fixturelabs/embed"></script>'),
    ).toEqual({
      ats: 'ashby',
      token: 'fixturelabs',
    });
    expect(detectAtsInHtml('<a href="https://apply.workable.com/j/XYZ">x</a>')).toBeNull();
    expect(detectAtsInHtml('<a href="https://fixturetools.recruitee.com/o/role">x</a>')).toEqual({
      ats: 'recruitee',
      token: 'fixturetools',
    });
  });

  it('returns null for a page that names no board', () => {
    expect(detectAtsInHtml('<h1>Careers</h1><p>Email jobs@example.test</p>')).toBeNull();
    expect(detectAtsInHtml('')).toBeNull();
  });
});

describe('API addresses', () => {
  it('rebuilds each board API from the checked token', () => {
    expect(atsApiUrl({ ats: 'greenhouse', token: 'examplerobotics' })).toBe(
      'https://boards-api.greenhouse.io/v1/boards/examplerobotics/jobs?content=true',
    );
    expect(atsApiUrl({ ats: 'lever', token: 'northwindfixture' })).toBe(
      'https://api.lever.co/v0/postings/northwindfixture?mode=json',
    );
    expect(atsApiUrl({ ats: 'ashby', token: 'fixturelabs' })).toBe(
      'https://api.ashbyhq.com/posting-api/job-board/fixturelabs?includeCompensation=true',
    );
    expect(atsApiUrl({ ats: 'workable', token: 'fixture-foods' })).toBe(
      'https://apply.workable.com/api/v1/widget/accounts/fixture-foods?details=true',
    );
    expect(atsApiUrl({ ats: 'recruitee', token: 'FixtureTools' })).toBe(
      'https://fixturetools.recruitee.com/api/offers/',
    );
    expect(atsBoardUrl({ ats: 'lever', token: 'northwindfixture' })).toBe(
      'https://jobs.lever.co/northwindfixture',
    );
  });
});

describe('parseAtsJobs', () => {
  it('reads Greenhouse: decodes its double-encoded HTML, drops scripts and images, splits places', () => {
    const parsed = parseAtsJobs('greenhouse', fixture('greenhouse'));
    expect(parsed?.skipped).toBe(2);
    expect(parsed?.postings).toHaveLength(2);
    const [platform, ae] = parsed!.postings;
    expect(platform).toMatchObject({
      externalId: '7000001',
      title: 'Senior Platform Engineer',
      team: 'Engineering',
      locations: ['Remote - US'],
      remote: 'remote',
      employmentType: 'full_time',
      applyUrl: 'https://job-boards.greenhouse.io/examplerobotics/jobs/7000001',
      postedAt: '2026-10-01T13:00:00.000Z',
    });
    expect(platform!.description).toBe(
      'Example Robotics builds warehouse robots.\n\n## What you will do\n\n- Own the fleet API\n- Ship weekly & often',
    );
    expect(platform!.description).not.toMatch(/alert|tracker|<|script/);
    expect(ae!.locations).toEqual(['Austin, TX', 'Denver, CO']);
    expect(ae!.employmentType).toBeNull();
  });

  it('reads Lever: lists become headed bullets, pay range, plain-text fallback, unsafe links dropped', () => {
    const parsed = parseAtsJobs('lever', fixture('lever'));
    expect(parsed?.postings).toHaveLength(2);
    const [designer, intern] = parsed!.postings;
    expect(designer).toMatchObject({
      externalId: '0d6f8a4e-1c2b-4a5d-9e8f-123456789abc',
      title: 'Product Designer',
      team: 'Design',
      locations: ['New York, NY', 'Boston, MA'],
      remote: 'hybrid',
      employmentType: 'full_time',
      comp: '$120K – $150K / year',
      applyUrl: 'https://jobs.lever.co/northwindfixture/0d6f8a4e-1c2b-4a5d-9e8f-123456789abc',
    });
    expect(designer!.description).toContain(
      '## What you bring\n\n- 5 years of product design\n- A portfolio',
    );
    expect(designer!.description).toContain('## <b>Perks</b>');
    expect(intern).toMatchObject({ remote: 'remote', employmentType: 'internship' });
    expect(intern!.description).toBe('- Answer tickets\n- Learn the product');
    // The hosted link is not http(s), so the apply form is used instead.
    expect(intern!.applyUrl).toBe(
      'https://jobs.lever.co/northwindfixture/1a2b3c4d-0000-4000-8000-00000000beef/apply',
    );
  });

  it('reads Ashby: skips unlisted roles, keeps pay summaries, takes the id from the link when missing', () => {
    const parsed = parseAtsJobs('ashby', fixture('ashby'));
    expect(parsed?.postings.map((p) => p.title)).toEqual([
      'Staff Data Scientist',
      'Contract Recruiter',
    ]);
    expect(parsed?.skipped).toBe(0);
    const [scientist, recruiter] = parsed!.postings;
    expect(scientist).toMatchObject({
      team: 'Machine Learning',
      locations: ['San Francisco, CA', 'Seattle, WA'],
      remote: 'onsite',
      employmentType: 'full_time',
      comp: '$180K - $220K',
    });
    expect(scientist!.description).toBe('Build models that matter.\n\n## About you\n\n- Python');
    expect(recruiter).toMatchObject({
      externalId: '7b7b7b7b-cccc-4ddd-8eee-0123456789ab',
      remote: 'remote',
      employmentType: 'contract',
    });
  });

  it('reads Workable and Recruitee', () => {
    const workable = parseAtsJobs('workable', fixture('workable'));
    expect(workable?.postings[0]).toMatchObject({
      externalId: 'ABC123DEF',
      title: 'Operations Manager',
      locations: ['Chicago, Illinois, United States'],
      employmentType: 'full_time',
      applyUrl: 'https://apply.workable.com/j/ABC123DEF',
    });
    const recruitee = parseAtsJobs('recruitee', fixture('recruitee'));
    expect(recruitee?.postings).toHaveLength(1);
    expect(recruitee?.postings[0]).toMatchObject({
      title: 'Growth Marketer',
      remote: 'hybrid',
      employmentType: 'full_time',
      locations: ['Amsterdam, Netherlands'],
      comp: '€60K – €75K / year',
    });
    expect(recruitee?.postings[0]!.description).toContain(
      '## Requirements\n\n- SQL\n- Copywriting',
    );
  });

  it('refuses an answer that is not the documented shape, so a sync never reads it as "no roles"', () => {
    expect(parseAtsJobs('greenhouse', { error: 'nope' })).toBeNull();
    expect(parseAtsJobs('lever', { jobs: [] })).toBeNull();
    expect(parseAtsJobs('ashby', null)).toBeNull();
    expect(parseAtsJobs('greenhouse', { jobs: [] })).toEqual({ postings: [], skipped: 0 });
  });
});
