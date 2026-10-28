import { describe, expect, it } from 'vitest';
import {
  boardHosts,
  isBoardPath,
  isCopilotBoardPath,
  requestHosts,
  routeBoardHost,
} from '@/lib/jobs-board/host';
import {
  BOARD_IMAGE_LIMIT,
  BOARD_PAGE_LIMIT,
  boardClientKey,
  boardRequestAllowed,
  resetBoardRateLimit,
} from '@/lib/jobs-board/rate-limit';
import {
  boardHostOrigin,
  boardPublicUrl,
  canonicalBoardUrl,
  configuredBoardUrl,
} from '@/lib/jobs-board/config';
import { robotsAllows, robotsCrawlDelaySeconds, robotsRuleMatches } from '@/lib/jobs-board/robots';
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
    expect(routeBoardHost('/', ['jobs.tiptop.vc'], HOSTS)).toEqual({
      kind: 'rewrite',
      pathname: '/jobs-host',
    });
    expect(routeBoardHost('/acme/backend-1a2b3c', ['jobs.tiptop.vc'], HOSTS)).toEqual({
      kind: 'rewrite',
      pathname: '/jobs-host/acme/backend-1a2b3c',
    });
    expect(routeBoardHost('/sitemap.xml', ['jobs.tiptop.vc'], HOSTS)).toEqual({
      kind: 'rewrite',
      pathname: '/jobs-host/sitemap.xml',
    });
  });

  it('never exposes Kraken on the board host: its pages become board addresses or a 404', () => {
    expect(routeBoardHost('/today', ['jobs.tiptop.vc'], HOSTS)).toEqual({
      kind: 'rewrite',
      pathname: '/jobs-host/today',
    });
    expect(routeBoardHost('/jobs-preview', ['jobs.tiptop.vc'], HOSTS)).toEqual({
      kind: 'rewrite',
      pathname: '/jobs-host/jobs-preview',
    });
    // Three levels deep is no board address: a 404 before any page renders.
    expect(routeBoardHost('/api/cron/daily', ['jobs.tiptop.vc'], HOSTS)).toEqual({
      kind: 'not_found',
    });
  });

  it('answers 404 to scanner paths and odd shapes, so they never render a page', () => {
    for (const path of [
      '/.env',
      '/wp-login.php',
      '/admin/config.php',
      '/a/b/c',
      '/Acme',
      '/acme/opengraph-image',
      '/acme/role/other',
      `/${'a'.repeat(102)}`,
    ]) {
      expect(routeBoardHost(path, ['jobs.tiptop.vc'], HOSTS)).toEqual({ kind: 'not_found' });
    }
    expect(routeBoardHost('/jobs/.env', ['jobs.tiptop.vc'], HOSTS)).toEqual({
      kind: 'not_found',
    });
  });

  it("serves the pages' link-preview images at their internal addresses, and nothing else internal", () => {
    expect(routeBoardHost('/jobs-host/opengraph-image', ['jobs.tiptop.vc'], HOSTS)).toEqual({
      kind: 'serve',
    });
    expect(
      routeBoardHost('/jobs-host/acme/vp-sales-1a2b3c/opengraph-image', ['jobs.tiptop.vc'], HOSTS),
    ).toEqual({ kind: 'serve' });
    expect(routeBoardHost('/jobs-host/acme', ['jobs.tiptop.vc'], HOSTS)).toEqual({
      kind: 'not_found',
    });
    expect(
      routeBoardHost(
        '/jobs-host/acme/vp-sales-1a2b3c/opengraph-image',
        ['copilot.tiptop.vc'],
        HOSTS,
      ),
    ).toEqual({ kind: 'not_found' });
  });

  it('redirects old /jobs links to the short form, and passes Next assets through', () => {
    expect(routeBoardHost('/jobs', ['jobs.tiptop.vc'], HOSTS)).toEqual({
      kind: 'redirect',
      pathname: '/',
    });
    expect(routeBoardHost('/jobs/acme', ['jobs.tiptop.vc'], HOSTS)).toEqual({
      kind: 'redirect',
      pathname: '/acme',
    });
    expect(routeBoardHost('/_next/static/chunk.js', ['jobs.tiptop.vc'], HOSTS)).toEqual({
      kind: 'serve',
    });
    expect(routeBoardHost('/icon.svg', ['jobs.tiptop.vc'], HOSTS)).toEqual({ kind: 'serve' });
  });

  it('keeps /jobs-host internal everywhere, and leaves other hosts alone', () => {
    expect(routeBoardHost('/jobs-host', ['jobs.tiptop.vc'], HOSTS)).toEqual({ kind: 'not_found' });
    expect(routeBoardHost('/jobs-host/acme', ['copilot.tiptop.vc'], HOSTS)).toEqual({
      kind: 'not_found',
    });
    expect(routeBoardHost('/jobs', ['copilot.tiptop.vc'], HOSTS)).toEqual({ kind: 'pass' });
    expect(routeBoardHost('/', ['copilot.tiptop.vc'], HOSTS)).toEqual({ kind: 'pass' });
    expect(routeBoardHost('/', [], HOSTS)).toEqual({ kind: 'pass' });
  });

  it('reads the Host header without its port or trailing dot', () => {
    const headers = (values: Record<string, string>) => ({ get: (n: string) => values[n] ?? null });
    expect(requestHosts(headers({ host: 'JOBS.tiptop.vc:443' }), {})).toEqual(['jobs.tiptop.vc']);
    expect(requestHosts(headers({ host: 'jobs.tiptop.vc.' }), {})).toEqual(['jobs.tiptop.vc']);
    expect(requestHosts(headers({ host: 'bad host!' }), {})).toEqual([]);
  });

  it('ignores X-Forwarded-Host unless the deployment says to trust it', () => {
    const headers = (values: Record<string, string>) => ({ get: (n: string) => values[n] ?? null });
    const spoofed = headers({ host: 'copilot.tiptop.vc', 'x-forwarded-host': 'jobs.tiptop.vc' });
    // Any client can write the header: by default it changes nothing.
    expect(requestHosts(spoofed, {})).toEqual(['copilot.tiptop.vc']);
    expect(routeBoardHost('/today', requestHosts(spoofed, {}), HOSTS)).toEqual({ kind: 'pass' });
    // The e2e server, which has no DNS for the board host, trusts it.
    expect(requestHosts(spoofed, { JOBS_BOARD_TRUST_FORWARDED_HOST: 'true' })).toEqual([
      'copilot.tiptop.vc',
      'jobs.tiptop.vc',
    ]);
  });

  it('cannot be talked out of the board on its own host by a forwarded header', () => {
    const headers = { get: (n: string) => (n === 'host' ? 'jobs.tiptop.vc' : 'copilot.tiptop.vc') };
    const trusted = { JOBS_BOARD_TRUST_FORWARDED_HOST: 'true' };
    expect(routeBoardHost('/today', requestHosts(headers, trusted), HOSTS)).toEqual({
      kind: 'rewrite',
      pathname: '/jobs-host/today',
    });
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

describe('board paths', () => {
  it('knows the shapes the board serves', () => {
    for (const ok of [
      '/',
      '',
      '/companies',
      '/acme',
      '/acme/',
      '/acme/vp-sales-1a2b3c',
      '/acme/vp-sales-1a2b3c/opengraph-image',
      '/opengraph-image',
      '/sitemap.xml',
      '/robots.txt',
    ]) {
      expect(isBoardPath(ok)).toBe(true);
    }
    for (const bad of ['/.env', '/a/b/c', '/a b', '/acme/opengraph-image', '/-acme', 'acme']) {
      expect(isBoardPath(bad)).toBe(false);
    }
  });

  it("judges Kraken's own /jobs addresses, and leaves the rest alone", () => {
    expect(isCopilotBoardPath('/jobs')).toBe(true);
    expect(isCopilotBoardPath('/jobs/acme/vp-sales-1a2b3c')).toBe(true);
    expect(isCopilotBoardPath('/jobs/sitemap.xml')).toBe(true);
    expect(isCopilotBoardPath('/jobs/a/b/c')).toBe(false);
    expect(isCopilotBoardPath('/jobs/wp-login.php')).toBe(false);
    expect(isCopilotBoardPath('/jobs-preview')).toBeNull();
    expect(isCopilotBoardPath('/today')).toBeNull();
  });
});

describe('the board brake', () => {
  const from = (ip: string) => ({ get: (n: string) => (n === 'cf-connecting-ip' ? ip : null) });

  it('allows a page allowance per address per minute, and a smaller one for images', () => {
    resetBoardRateLimit();
    const now = 1_000_000;
    for (let i = 0; i < BOARD_PAGE_LIMIT; i++) {
      expect(boardRequestAllowed(from('203.0.113.7'), '/jobs', now)).toBe(true);
    }
    expect(boardRequestAllowed(from('203.0.113.7'), '/jobs/acme', now)).toBe(false);
    // Another address is untouched; the next minute starts afresh.
    expect(boardRequestAllowed(from('203.0.113.8'), '/jobs', now)).toBe(true);
    expect(boardRequestAllowed(from('203.0.113.7'), '/jobs', now + 60_000)).toBe(true);

    for (let i = 0; i < BOARD_IMAGE_LIMIT; i++) {
      expect(boardRequestAllowed(from('203.0.113.9'), '/a/b/opengraph-image', now)).toBe(true);
    }
    expect(boardRequestAllowed(from('203.0.113.9'), '/a/b/opengraph-image', now)).toBe(false);
    // Pages have their own allowance.
    expect(boardRequestAllowed(from('203.0.113.9'), '/a/b', now)).toBe(true);
    resetBoardRateLimit();
  });

  it('keys on the edge address, else the last forwarded hop, and an IPv6 /64', () => {
    const headers = (values: Record<string, string>) => ({ get: (n: string) => values[n] ?? null });
    expect(boardClientKey(headers({ 'x-forwarded-for': '1.1.1.1, 198.51.100.4' }))).toBe(
      '198.51.100.4',
    );
    expect(
      boardClientKey(headers({ 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '1.1.1.1' })),
    ).toBe('203.0.113.5');
    expect(boardClientKey(headers({ 'cf-connecting-ip': '2001:db8:aa:bb:1:2:3:4' }))).toBe(
      '2001:db8:aa:bb::/64',
    );
    expect(boardClientKey(headers({}))).toBe('unknown');
  });
});

describe('board addresses', () => {
  it('uses JOBS_BOARD_URL when set, else Kraken /jobs', () => {
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

  it('matches wildcards in linear time, so a hostile rule cannot freeze the app', () => {
    expect(robotsRuleMatches('/a*b*c$', '/axxbyyc')).toBe(true);
    expect(robotsRuleMatches('/a*b*c$', '/axxbyycz')).toBe(false);
    expect(robotsRuleMatches('/*.json$', '/x/y.json')).toBe(true);
    expect(robotsRuleMatches('/fish*', '/fishheads')).toBe(true);
    expect(robotsRuleMatches('/fish$', '/fishheads')).toBe(false);
    expect(robotsRuleMatches('/*', '/')).toBe(true);
    const hostile = `User-agent: *\nDisallow: /${'*'.repeat(30)}Z\n`;
    const path = `/v1/boards/${'a'.repeat(60)}/jobs?content=true`;
    const started = performance.now();
    expect(robotsAllows(hostile, path)).toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
    // A rule past the size cap is ignored rather than matched.
    expect(
      robotsAllows(`User-agent: *\nDisallow: /${'x'.repeat(600)}*\n`, `/${'x'.repeat(700)}`),
    ).toBe(true);
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
      '::ffff:7f00:1',
      '::127.0.0.1',
      '64:ff9b::a00:1',
      '2002:a00:1::1',
      '2001:0:4136:e378::1',
      'fec0::1',
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
