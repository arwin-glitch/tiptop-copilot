import { describe, expect, it } from 'vitest';
import { boardHosts, requestHost, routeBoardHost } from '@/lib/jobs-board/host';
import {
  boardHostOrigin,
  boardPublicUrl,
  canonicalBoardUrl,
  configuredBoardUrl,
} from '@/lib/jobs-board/config';
import { robotsAllows, robotsCrawlDelaySeconds } from '@/lib/jobs-board/robots';
import { companySlug, roleSlug, slugify } from '@/lib/jobs-board/slug';
import {
  formatPayRange,
  guessFunction,
  guessSeniority,
  normalizeEmploymentType,
  placeLine,
} from '@/lib/jobs-board/fields';

/** The board's own host, its addresses, robots.txt, and the small field rules. */

const HOSTS = boardHosts({});

describe('routeBoardHost', () => {
  it('serves the board at the root of jobs.tiptop.vc', () => {
    expect(routeBoardHost('/', 'jobs.tiptop.vc', HOSTS)).toEqual({
      kind: 'rewrite',
      pathname: '/jobs-host',
    });
    expect(routeBoardHost('/acme/backend-1a2b3c', 'jobs.tiptop.vc', HOSTS)).toEqual({
      kind: 'rewrite',
      pathname: '/jobs-host/acme/backend-1a2b3c',
    });
    expect(routeBoardHost('/sitemap.xml', 'jobs.tiptop.vc', HOSTS)).toEqual({
      kind: 'rewrite',
      pathname: '/jobs-host/sitemap.xml',
    });
  });

  it('never exposes Copilot on the board host: its pages become board addresses', () => {
    expect(routeBoardHost('/today', 'jobs.tiptop.vc', HOSTS)).toEqual({
      kind: 'rewrite',
      pathname: '/jobs-host/today',
    });
    expect(routeBoardHost('/api/inbox', 'jobs.tiptop.vc', HOSTS)).toEqual({
      kind: 'rewrite',
      pathname: '/jobs-host/api/inbox',
    });
    expect(routeBoardHost('/jobs-preview', 'jobs.tiptop.vc', HOSTS)).toEqual({
      kind: 'rewrite',
      pathname: '/jobs-host/jobs-preview',
    });
  });

  it('redirects old /jobs links to the short form, and passes Next assets through', () => {
    expect(routeBoardHost('/jobs', 'jobs.tiptop.vc', HOSTS)).toEqual({
      kind: 'redirect',
      pathname: '/',
    });
    expect(routeBoardHost('/jobs/acme', 'jobs.tiptop.vc', HOSTS)).toEqual({
      kind: 'redirect',
      pathname: '/acme',
    });
    expect(routeBoardHost('/_next/static/chunk.js', 'jobs.tiptop.vc', HOSTS)).toEqual({
      kind: 'pass',
    });
    expect(routeBoardHost('/icon.svg', 'jobs.tiptop.vc', HOSTS)).toEqual({ kind: 'pass' });
  });

  it('keeps /jobs-host internal everywhere, and leaves other hosts alone', () => {
    expect(routeBoardHost('/jobs-host', 'jobs.tiptop.vc', HOSTS)).toEqual({ kind: 'not_found' });
    expect(routeBoardHost('/jobs-host/acme', 'copilot.tiptop.vc', HOSTS)).toEqual({
      kind: 'not_found',
    });
    expect(routeBoardHost('/jobs', 'copilot.tiptop.vc', HOSTS)).toEqual({ kind: 'pass' });
    expect(routeBoardHost('/', 'copilot.tiptop.vc', HOSTS)).toEqual({ kind: 'pass' });
    expect(routeBoardHost('/', null, HOSTS)).toEqual({ kind: 'pass' });
  });

  it('reads the host from the forwarded header or the Host header, without its port', () => {
    const headers = (values: Record<string, string>) => ({ get: (n: string) => values[n] ?? null });
    expect(requestHost(headers({ host: 'JOBS.tiptop.vc:443' }))).toBe('jobs.tiptop.vc');
    expect(
      requestHost(
        headers({ host: 'copilot.tiptop.vc', 'x-forwarded-host': 'jobs.tiptop.vc, proxy' }),
      ),
    ).toBe('jobs.tiptop.vc');
    expect(requestHost(headers({ host: 'bad host!' }))).toBeNull();
  });

  it('adds the configured board host and extras', () => {
    expect(
      boardHosts({
        JOBS_BOARD_URL: 'https://careers.example.org',
        JOBS_BOARD_HOSTS: 'jobs.localhost, , x.test:3000',
      }),
    ).toEqual(['jobs.tiptop.vc', 'careers.example.org', 'jobs.localhost', 'x.test']);
    expect(boardHosts({ JOBS_BOARD_URL: 'not a url' })).toEqual(['jobs.tiptop.vc']);
  });
});

describe('board addresses', () => {
  it('uses JOBS_BOARD_URL when set, else Copilot /jobs', () => {
    expect(boardPublicUrl({ APP_URL: 'https://copilot.example' })).toBe(
      'https://copilot.example/jobs',
    );
    expect(
      boardPublicUrl({
        APP_URL: 'https://copilot.example',
        JOBS_BOARD_URL: 'https://jobs.example/',
      }),
    ).toBe('https://jobs.example');
    expect(configuredBoardUrl({ JOBS_BOARD_URL: 'javascript:alert(1)' })).toBeNull();
    expect(canonicalBoardUrl('/acme/role-1', { APP_URL: 'https://c.example' })).toBe(
      'https://c.example/jobs/acme/role-1',
    );
    expect(canonicalBoardUrl('', { JOBS_BOARD_URL: 'https://jobs.example' })).toBe(
      'https://jobs.example',
    );
    expect(boardHostOrigin({})).toBe('https://jobs.tiptop.vc');
  });
});

describe('robots.txt', () => {
  const greenhouseLike = 'User-agent: *\nDisallow: /embed/\n';
  it('obeys the * group, longest match wins, Allow on a tie', () => {
    expect(robotsAllows(greenhouseLike, '/v1/boards/acme/jobs?content=true')).toBe(true);
    expect(robotsAllows(greenhouseLike, '/embed/job_board')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /\nAllow: /v0/', '/v0/postings/acme')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /*.json$', '/a.json')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow:', '/anything')).toBe(true);
    expect(robotsAllows(null, '/x')).toBe(true);
  });

  it('prefers a group naming this bot', () => {
    const txt = 'User-agent: TipTopJobsBot\nDisallow: /\n\nUser-agent: *\nAllow: /';
    expect(robotsAllows(txt, '/v1/boards')).toBe(false);
  });

  it('reads the crawl delay, capped', () => {
    expect(robotsCrawlDelaySeconds('User-agent: *\nAllow: /\nCrawl-delay: 1')).toBe(1);
    expect(robotsCrawlDelaySeconds('User-agent: *\nCrawl-delay: 60')).toBe(10);
    expect(robotsCrawlDelaySeconds('User-agent: otherbot\nCrawl-delay: 5')).toBe(0);
  });
});

describe('slugs', () => {
  it('makes clean, unique, unreserved company addresses', () => {
    expect(slugify('Café Robotics, Inc.')).toBe('cafe-robotics-inc');
    expect(companySlug('Acme', new Set(['acme']))).toBe('acme-2');
    expect(companySlug('Companies', new Set())).toBe('companies-co');
    expect(companySlug('!!!', new Set())).toBe('company-co');
  });

  it('makes role addresses from the title and a stable suffix', () => {
    expect(roleSlug('Sr. Backend Engineer (Remote)', 'A1B2C3')).toBe(
      'sr-backend-engineer-remote-a1b2c3',
    );
    expect(roleSlug('', '')).toBe('role-0');
  });
});

describe('field guesses', () => {
  it('reads level, team and type from the words boards use', () => {
    expect(guessSeniority('Senior Backend Engineer')).toBe('senior');
    expect(guessSeniority('VP Sales')).toBe('vp');
    expect(guessSeniority('Head of Growth')).toBe('director');
    expect(guessSeniority('Software Engineer')).toBeNull();
    expect(guessSeniority('Summer Intern, Design')).toBe('intern');
    expect(guessFunction('Account Executive')).toBe('sales');
    expect(guessFunction('Chief Technology Officer')).toBe('leadership');
    expect(guessFunction('Anything', 'Engineering')).toBe('engineering');
    expect(normalizeEmploymentType('FullTime')).toBe('full_time');
    expect(normalizeEmploymentType('fulltime_permanent')).toBe('full_time');
    expect(normalizeEmploymentType('Contractor')).toBe('contract');
    expect(normalizeEmploymentType('Whatever')).toBeNull();
  });

  it('formats pay and places', () => {
    expect(
      formatPayRange({ min: 90000, max: 120000, currency: 'USD', interval: 'per-year-salary' }),
    ).toBe('$90K – $120K / year');
    expect(formatPayRange({ min: 45, currency: 'usd', interval: 'hourly' })).toBe('$45 / hour');
    expect(formatPayRange({})).toBeNull();
    expect(placeLine(['Austin, TX', 'Denver, CO', 'Boston, MA'], 'hybrid')).toBe(
      'Austin, TX · Denver, CO · +1 more · Hybrid',
    );
    expect(placeLine(['Remote - US'], 'remote')).toBe('Remote - US');
  });
});

describe('private addresses', () => {
  it('knows which addresses are not on the public internet', async () => {
    const { isPrivateAddress, isPublicHostname } = await import('@/lib/services/jobs-board-sync');
    for (const ip of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.20.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['93.184.215.14', '8.8.8.8', '2606:4700::1111'])
      expect(isPrivateAddress(ip)).toBe(false);
    expect(isPublicHostname('careers.fixture-co.example.com')).toBe(true);
    expect(isPublicHostname('localhost')).toBe(false);
    expect(isPublicHostname('10.0.0.1')).toBe(false);
    expect(isPublicHostname('wiki.corp')).toBe(false);
  });
});
