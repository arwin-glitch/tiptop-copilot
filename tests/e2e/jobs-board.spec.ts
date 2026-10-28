import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The public job board over the invented demo workspace (D-077): Kraken's
 * Portfolio > Jobs controls (the "View public board" button, approvals,
 * publish / hide / feature, the switch, Refresh now) and the public pages
 * (search, filters, a role, apply out, a company, the board host, a phone).
 * The demo board starts switched on with Ledgerly's roles from its invented
 * Greenhouse board and one Stonebridge role added by hand. Runs in order:
 * later steps see earlier ones' changes.
 */

test.describe.configure({ mode: 'serial' });

const SIGNED_IN = path.resolve('test-results', 'jobs-board-state.json');

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);
  await context.storageState({ path: SIGNED_IN });
  await context.close();
});

test.use({ storageState: SIGNED_IN });

async function openJobsView(page: Page, view?: 'approvals' | 'board' | 'companies') {
  await page.goto(view ? `/portfolio?tab=jobs&view=${view}` : '/portfolio?tab=jobs');
  await expect(page.getByRole('region', { name: 'Public job board' })).toBeVisible();
}

async function publicTitles(page: Page): Promise<string[]> {
  await page.goto('/jobs');
  const list = page.getByRole('list', { name: 'All open roles' });
  await expect(list).toBeVisible();
  return list.locator('.jb-job-title').allInnerTexts();
}

test('the Jobs tab has a "View public board" button that opens the public board in a new tab', async ({
  page,
  context,
}) => {
  await openJobsView(page);
  const bar = page.getByRole('region', { name: 'Public job board' });
  await expect(bar).toContainText('Live');
  const button = bar.getByRole('link', { name: 'View public board' });
  await expect(button).toHaveAttribute('href', '/jobs');
  await expect(button).toHaveAttribute('target', '_blank');
  await expect(bar.getByRole('button', { name: 'Copy link' })).toBeVisible();
  // The original Jobs list still shows under the header.
  await expect(
    page.getByRole('region', { name: 'Open roles at portfolio companies' }),
  ).toBeVisible();

  const [board] = await Promise.all([context.waitForEvent('page'), button.click()]);
  await board.waitForLoadState();
  expect(new URL(board.url()).pathname).toBe('/jobs');
  await expect(
    board.getByRole('heading', { level: 1, name: 'Jobs at TipTop portfolio companies' }),
  ).toBeVisible();
  await board.close();
});

test('an emailed role waits on Approvals, off the board, until a person approves it', async ({
  page,
}) => {
  expect(await publicTitles(page)).not.toContain('Founding Engineer');

  await openJobsView(page, 'approvals');
  const queue = page.getByRole('region', { name: 'Roles waiting for approval' });
  const card = queue.getByRole('listitem').filter({ hasText: 'Founding Engineer' });
  await expect(card).toContainText('Stonebridge Ops');
  await expect(card).toContainText('stonebridgeops.demo/jobs/founding-engineer');
  // Nothing private from the email is on the card: no contact, no founder note.
  await expect(card).not.toContainText('dev@stonebridgeops.demo');
  await expect(card).not.toContainText('offers declined');
  await card.getByRole('button', { name: 'Approve and publish: Founding Engineer' }).click();
  await expect(page.getByText('Founding Engineer is on the public board')).toBeVisible();
  await expect(queue.getByText('Nothing waiting')).toBeVisible();

  expect(await publicTitles(page)).toContain('Founding Engineer');
});

test('Hide takes a role off the board, Publish puts it back, Feature lifts it to the top', async ({
  page,
}) => {
  await openJobsView(page, 'board');
  const roles = page.getByRole('region', { name: 'Roles on the public board' });
  await roles.getByRole('button', { name: 'Hide: Product Designer' }).click();
  await expect(page.getByText('Product Designer is hidden from the board')).toBeVisible();
  expect(await publicTitles(page)).not.toContain('Product Designer');

  await openJobsView(page, 'board');
  await page
    .getByRole('group', { name: 'Filter roles by public state' })
    .getByRole('link', { name: /^Hidden/ })
    .click();
  await page.waitForURL((url) => url.searchParams.get('show') === 'hidden');
  await page
    .getByRole('region', { name: 'Roles on the public board' })
    .getByRole('button', { name: 'Publish: Product Designer' })
    .click();
  await expect(page.getByText('Product Designer is on the public board')).toBeVisible();
  expect(await publicTitles(page)).toContain('Product Designer');

  await openJobsView(page, 'board');
  await page
    .getByRole('region', { name: 'Roles on the public board' })
    .getByRole('button', { name: 'Feature: Customer Success Manager' })
    .click();
  await expect(page.getByText('Customer Success Manager is featured')).toBeVisible();
  await page.goto('/jobs');
  const featured = page.getByRole('region', { name: 'Featured roles' });
  await expect(featured).toContainText('Customer Success Manager');
});

test('Refresh now reads the company job board and adds its new role (auto-publish is on)', async ({
  page,
}) => {
  await openJobsView(page, 'companies');
  const companies = page.getByRole('region', { name: 'Companies on the job board' });
  const ledgerly = companies.getByRole('listitem').filter({ hasText: 'Ledgerly' });
  await expect(ledgerly).toContainText('Greenhouse · ledgerly-demo');
  await companies.getByRole('button', { name: 'Refresh all now' }).click();
  await expect(page.getByText(/Read 1 board: 1 new role/)).toBeVisible();
  expect(await publicTitles(page)).toContain('Data Engineer');
});

test('the board switch: off shows "coming soon" with no roles, on brings them back', async ({
  page,
  browser,
}) => {
  // A role's address, read while the board is on, to try once it is off.
  await page.goto('/jobs/ledgerly');
  const roleHref = await page
    .locator('.jb-job', { hasText: 'VP Sales' })
    .first()
    .getAttribute('href');
  expect(roleHref).toMatch(/^\/jobs\/ledgerly\/vp-sales-[a-z0-9]+$/);
  const roleSlug = roleHref!.split('/').pop()!;

  await openJobsView(page);
  const toggle = page.getByRole('switch', { name: 'Public board on' });
  await toggle.click();
  await expect(page.getByText(/The public board is off/)).toBeVisible();
  const bar = page.getByRole('region', { name: 'Public job board' });
  await expect(bar).toContainText('Off');
  // While off, the first button previews the board; the public page says "coming soon".
  await expect(bar.getByRole('link', { name: 'Preview board' })).toHaveAttribute(
    'href',
    '/jobs-preview',
  );
  await expect(bar.getByRole('link', { name: 'View public board (coming soon)' })).toHaveAttribute(
    'href',
    '/jobs',
  );

  // A visitor with no session.
  const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const pub = await visitor.newPage();
  await pub.goto('/jobs');
  await expect(pub.getByRole('heading', { name: 'Our job board is coming soon.' })).toBeVisible();
  await expect(pub.locator('.jb-job')).toHaveCount(0);
  await expect(pub.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  const role = await pub.goto('/jobs/ledgerly');
  expect(role?.status()).toBe(200);
  await expect(pub.getByText('VP Sales')).toHaveCount(0);

  // Signed in, the preview still shows it.
  await page.goto('/jobs-preview');
  await expect(page.getByRole('status').filter({ hasText: 'Preview' })).toBeVisible();
  await expect(page.locator('.jb-job-title', { hasText: 'VP Sales' })).toBeVisible();
  // A visitor cannot reach the preview.
  await pub.goto('/jobs-preview');
  await expect(pub).toHaveURL(/\/login/);
  // Nor with a made-up session cookie: every preview address sends it to
  // /login, and not even the page title carries a role or a company.
  for (const path of [
    '/jobs-preview',
    '/jobs-preview/companies',
    '/jobs-preview/ledgerly',
    `/jobs-preview/ledgerly/${roleSlug}`,
  ]) {
    const forged = await visitor.request.get(path, {
      headers: { Cookie: 'tiptop_session=forged' },
      maxRedirects: 0,
    });
    expect(forged.status(), path).toBe(307);
    expect(forged.headers()['location'], path).toContain('/login');
    const body = await forged.text();
    expect(body, path).not.toContain('VP Sales');
    expect(body, path).not.toContain('Ledgerly');
    expect(body, path).not.toMatch(/open roles? at/);
  }

  await openJobsView(page);
  await page.getByRole('switch', { name: 'Public board on' }).click();
  await expect(page.getByText(/The public board is on/)).toBeVisible();
  await pub.goto('/jobs');
  await expect(pub.locator('.jb-job-title', { hasText: 'VP Sales' })).toBeVisible();
  await visitor.close();
});

test.describe('the public board, as a visitor', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('search and filters narrow the list and live in the address bar', async ({ page }) => {
    await page.goto('/jobs');
    const list = page.getByRole('list', { name: 'All open roles' });
    await expect(list.locator('.jb-job')).not.toHaveCount(0);
    const total = await list.locator('.jb-job').count();

    await page.getByRole('searchbox', { name: 'Search roles' }).fill('designer');
    await expect(list.locator('.jb-job-title')).toHaveText(['Product Designer']);
    await expect(page).toHaveURL(/\?q=designer$/);
    await page.getByRole('button', { name: 'Clear filters' }).first().click();
    await expect(list.locator('.jb-job')).toHaveCount(total);

    await page.getByLabel('Team').selectOption('engineering');
    await expect(page).toHaveURL(/fn=engineering/);
    const titles = await list.locator('.jb-job-title').allInnerTexts();
    expect(titles).toEqual(
      expect.arrayContaining(['Senior Backend Engineer', 'Founding Engineer']),
    );
    expect(titles).not.toContain('VP Sales');

    // A shared filtered link opens filtered.
    await page.goto('/jobs?company=stonebridge-ops');
    await expect(page.getByLabel('Company')).toHaveValue('stonebridge-ops');
    const stonebridge = await list.locator('.jb-job-title').allInnerTexts();
    expect(stonebridge.sort()).toEqual(['Founding Engineer', 'Operations Lead']);
  });

  test('a role page shows the description as text, structured data, and applies out to the company', async ({
    page,
  }) => {
    await page.goto('/jobs');
    await page
      .getByRole('link', { name: /Senior Backend Engineer/ })
      .first()
      .click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Senior Backend Engineer' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/jobs\/ledgerly\/senior-backend-engineer-[a-z0-9]+$/);
    await expect(page.getByRole('heading', { name: 'What you will work on' })).toBeVisible();
    await expect(page.locator('.jb-desc li')).toHaveText([
      'Our TypeScript and Postgres services',
      'Bank feed connectors and matching',
    ]);
    // The board's own script never made it through.
    await expect(page.locator('.jb-desc')).not.toContainText('alert');

    const apply = page.getByRole('link', { name: 'Apply at Ledgerly' });
    await expect(apply).toHaveAttribute(
      'href',
      'https://job-boards.greenhouse.io/ledgerly-demo/jobs/4100102',
    );
    await expect(apply).toHaveAttribute('target', '_blank');
    await expect(apply).toHaveAttribute('rel', /noopener/);

    const jsonLd = JSON.parse(
      (await page.locator('script[type="application/ld+json"]').textContent()) ?? '{}',
    );
    expect(jsonLd).toMatchObject({
      '@type': 'JobPosting',
      title: 'Senior Backend Engineer',
      hiringOrganization: { name: 'Ledgerly' },
      employmentType: 'FULL_TIME',
    });
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      /\/jobs\/ledgerly\/senior-backend-engineer-/,
    );
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      /opengraph-image/,
    );
    await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();

    // The company page lists its roles; a closed or unknown address is a friendly 404.
    await page.getByRole('link', { name: 'Ledgerly', exact: true }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Ledgerly' })).toBeVisible();
    await expect(page.getByText('AI bookkeeping for accounting firms')).toBeVisible();
    // A closed role at a company still on the board: its own page, kept out
    // of search, listing the company's open roles.
    await page.goto('/jobs/ledgerly/no-such-role-000000');
    await expect(
      page.getByRole('heading', { level: 1, name: 'This role has closed.' }),
    ).toBeVisible();
    await expect(page.getByRole('list', { name: 'Open roles at Ledgerly' })).toContainText(
      'VP Sales',
    );
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    const missing = await page.goto('/jobs/no-such-company');
    expect(missing?.status()).toBe(404);
    await expect(
      page.getByRole('heading', { name: 'This page isn’t on the board.' }),
    ).toBeVisible();
    // The hidden role is not reachable by its address either.
    await page.goto('/jobs/companies');
    await expect(page.getByRole('list', { name: 'Companies' }).getByRole('listitem')).toHaveCount(
      2,
    );
  });

  test('the sitemap and robots.txt list the board, and nothing else of Kraken', async ({
    request,
  }) => {
    const sitemap = await (await request.get('/jobs/sitemap.xml')).text();
    expect(sitemap).toContain('<urlset');
    expect(sitemap).toMatch(/\/jobs\/ledgerly\/vp-sales-/);
    expect(sitemap).not.toContain('executive-assistant');
    const robots = await (await request.get('/robots.txt')).text();
    expect(robots).toContain('Disallow: /');
    expect(robots).toContain('Allow: /jobs/');
  });

  test('the board host serves the board at its root, and never Kraken', async ({ request }) => {
    const headers = { 'x-forwarded-host': 'jobs.tiptop.vc' };
    const home = await request.get('/', { headers });
    expect(home.status()).toBe(200);
    const html = await home.text();
    expect(html).toContain('Jobs at TipTop portfolio companies');
    // Links on the board host are written for its root.
    expect(html).toMatch(/href="\/ledgerly\/vp-sales-[a-z0-9]+"/);
    const app = await request.get('/today', { headers, maxRedirects: 0 });
    expect(app.status()).toBe(404);
    expect(await app.text()).not.toContain('Today');
    const company = await request.get('/ledgerly', { headers });
    expect(await company.text()).toContain('AI bookkeeping for accounting firms');
    const robots = await (await request.get('/robots.txt', { headers })).text();
    expect(robots).toContain('Allow: /');
    expect(robots).toContain('Sitemap: https://jobs.tiptop.vc/sitemap.xml');
  });

  test('works on a 390px phone with no sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/jobs');
    await expect(page.getByRole('searchbox', { name: 'Search roles' })).toBeVisible();
    await expect(page.getByLabel('Team')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page
      .getByRole('link', { name: /Operations Lead/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Operations Lead' })).toBeVisible();
    // The apply button also rides along the bottom of a phone's screen.
    const applyBar = page.getByRole('link', { name: 'Apply now at Stonebridge Ops' });
    await expect(applyBar).toBeInViewport();
    await expect(applyBar).toHaveAttribute('href', /stonebridgeops\.demo/);
    // Filters use 16px text, so iOS never zooms into them.
    await page.goto('/jobs');
    const fontSize = await page.getByLabel('Team').evaluate((el) => getComputedStyle(el).fontSize);
    expect(fontSize).toBe('16px');
    await page.goBack();
    const detailOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(detailOverflow).toBeLessThanOrEqual(0);
  });
});

test.describe('the public board, as a link scraper sees it (no JavaScript)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  const boardHost = { 'x-forwarded-host': 'jobs.tiptop.vc' };

  /** A URL's path and query, to ask the local server for it. */
  const local = (url: string) => {
    const parsed = new URL(url.replace(/&amp;/g, '&'));
    return parsed.pathname + parsed.search;
  };
  const ogImage = (html: string) => /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];

  test('old /jobs links on the board host redirect to the short form', async ({ request }) => {
    for (const [from, to] of [
      ['/jobs/ledgerly', '/ledgerly'],
      ['/jobs', '/'],
      ['/jobs/companies?x=1', '/companies?x=1'],
    ] as const) {
      const res = await request.get(from, { headers: boardHost, maxRedirects: 0 });
      expect(res.status(), from).toBe(308);
      expect(local(res.headers()['location']!), from).toBe(to);
    }
  });

  test("the board host's link-preview images load", async ({ request }) => {
    const homeHtml = await (await request.get('/', { headers: boardHost })).text();
    const homeImage = ogImage(homeHtml);
    expect(homeImage).toBeDefined();
    const home = await request.get(local(homeImage!), { headers: boardHost });
    expect(home.status()).toBe(200);
    expect(home.headers()['content-type']).toContain('image/png');

    const company = await (await request.get('/ledgerly', { headers: boardHost })).text();
    const rolePath = /href="(\/ledgerly\/vp-sales-[a-z0-9]+)"/.exec(company)![1]!;
    const roleImage = ogImage(await (await request.get(rolePath, { headers: boardHost })).text());
    expect(new URL(roleImage!).origin).toBe('https://jobs.tiptop.vc');
    const role = await request.get(local(roleImage!), { headers: boardHost });
    expect(role.status()).toBe(200);
    expect(role.headers()['content-type']).toContain('image/png');

    // A made-up role has no image to draw.
    const none = await request.get('/jobs/ledgerly/no-such-role-000000/opengraph-image');
    expect(none.status()).toBe(404);
  });

  test('closed roles and unknown addresses unfurl as the board, never as Kraken', async ({
    request,
  }) => {
    for (const [path, headers] of [
      ['/jobs/ledgerly/no-such-role-000000', {}],
      ['/jobs/no-such-company', {}],
      ['/some-typo', boardHost],
      ['/ledgerly/no-such-role-000000', boardHost],
    ] as const) {
      const html = await (await request.get(path, { headers })).text();
      const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
      expect(title, path).toContain('TipTop VC Jobs');
      expect(title, path).not.toContain('Kraken');
      expect(html, path).not.toContain('investment cockpit');
      expect(html, path).toMatch(/<meta name="robots" content="noindex/);
    }
  });

  test('a made-up address is rendered fresh, never cached per address', async ({ request }) => {
    const res = await request.get('/jobs/no-such-company-a1/no-such-role-b2c3d4');
    expect(res.headers()['x-nextjs-cache']).toBeUndefined();
    expect(res.headers()['cache-control'] ?? '').not.toContain('s-maxage');
    // A scanner's path on the board host never reaches a page at all.
    const scan = await request.get('/wp-login.php', { headers: boardHost });
    expect(scan.status()).toBe(404);
    expect(await scan.text()).toBe('Not found');
  });

  test('an address that floods the board is braked', async ({ request }) => {
    const flood = { 'cf-connecting-ip': '203.0.113.77' };
    let status = 200;
    for (let i = 0; i < 125 && status !== 429; i++) {
      status = (await request.get('/jobs/sitemap.xml', { headers: flood })).status();
    }
    expect(status).toBe(429);
    // Everyone else is untouched.
    const other = await request.get('/jobs/sitemap.xml', {
      headers: { 'cf-connecting-ip': '203.0.113.78' },
    });
    expect(other.status()).toBe(200);
  });
});
