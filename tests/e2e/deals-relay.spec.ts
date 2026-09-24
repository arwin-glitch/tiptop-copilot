import path from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';

/**
 * The deal-sorter pipeline in the demo workspace: routine-fed deals with their
 * fit and source, the Deal-sorter card on a deal, Gmail thread links, the
 * human Apply of a suggested stage, the open-tab watcher, and a phone-width
 * layout. The sample deals and thread ids are invented fixtures.
 */

const DEMO = {
  tidewell: '00000000-0000-4000-8000-00000000006a',
  brightkiln: '00000000-0000-4000-8000-00000000006c',
  mossgate: '00000000-0000-4000-8000-00000000006d',
};

const VERSION_URL = '**/api/deals/version';

// One demo sign-in for the whole file: demo entry is capped at 60 a minute
// across the suite.
const SIGNED_IN = path.resolve('test-results', 'deals-relay-state.json');

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

async function gotoDeals(page: Page, url = '/deals') {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Deals', exact: true })).toBeVisible();
}

test('stage chips count the pipeline, and routine deals carry fit, source and suggestions', async ({
  page,
}) => {
  await gotoDeals(page);

  const stages = page.getByRole('group', { name: 'Filter by stage' });
  await expect(stages.getByRole('button', { name: /^Founder meeting\s*1$/ })).toBeVisible();
  // Both demo Portfolio companies are listed under Invested, automatically.
  await expect(stages.getByRole('button', { name: /^Invested\s*2$/ })).toBeVisible();

  const table = page.getByRole('table');
  const tidewell = table.locator('tbody tr', { hasText: 'Tidewell Clinic OS' });
  await expect(tidewell.getByText('Likely fit')).toBeVisible();
  await expect(tidewell.getByText(/Intro: Bramblecrest Ventures/)).toBeVisible();

  const quarrystone = table.locator('tbody tr', { hasText: 'Quarrystone Ledger' });
  await expect(quarrystone.getByText('Possible fit')).toBeVisible();
  await expect(quarrystone.getByText('Angel network feed')).toBeVisible();

  const brightkiln = table.locator('tbody tr', { hasText: 'Brightkiln Freight' });
  await expect(brightkiln.getByText('Suggests: Waiting for information')).toBeVisible();

  await expect(page.getByRole('status', { name: 'Deal-sorter status' })).toContainText(
    'Demo workspace: sample deals.',
  );

  // The fit chips narrow the list.
  await page
    .getByRole('group', { name: 'Filter by fit' })
    .getByRole('button', { name: /^Unlikely fit/ })
    .click();
  await page.waitForURL(/fit=unlikely/);
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table.locator('tbody tr').first()).toContainText('Fernhollow Robotics');
});

/** Any RSC fetch of /deals: a server render, a refresh or a prefetch. */
function isDealsRsc(request: Request): boolean {
  return new URL(request.url()).pathname === '/deals' && request.headers()['rsc'] === '1';
}

test('stage, fit and sort apply in the browser with no server render, and Back undoes them', async ({
  page,
}) => {
  await gotoDeals(page);
  const table = page.getByRole('table');
  const rows = table.locator('tbody tr');
  const names = () => table.locator('tbody th a').allInnerTexts();
  await expect(rows.first()).toBeVisible();
  const newestFirst = await names();
  // Let the load's own link prefetches (the nav's /deals among them) finish.
  await page.waitForLoadState('networkidle');

  const rsc: string[] = [];
  page.on('request', (request) => {
    if (isDealsRsc(request)) rsc.push(request.url());
  });

  const company = table.getByRole('columnheader', { name: 'Company' });
  await company.getByRole('button').click();
  await expect(page).toHaveURL(/\?sort=company&dir=asc$/);
  await expect(company).toHaveAttribute('aria-sort', 'ascending');
  const byName = await names();
  expect(byName).toEqual([...newestFirst].sort((a, b) => a.localeCompare(b)));
  expect(byName).not.toEqual(newestFirst);

  const stages = page.getByRole('group', { name: 'Filter by stage' });
  const diligence = stages.getByRole('button', { name: /^Diligence\s*\d+$/ });
  const diligenceCount = Number(/(\d+)\s*$/.exec(await diligence.innerText())?.[1]);
  expect(diligenceCount).toBeGreaterThan(1);
  await diligence.click();
  await expect(page).toHaveURL(/&stage=diligence$/);
  await expect(diligence).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(diligenceCount);
  for (const text of await rows.allInnerTexts()) expect(text).toContain('Diligence');
  const diligenceNames = await names();
  expect(diligenceNames).toEqual(byName.filter((name) => diligenceNames.includes(name)));

  await page
    .getByRole('group', { name: 'Filter by fit' })
    .getByRole('button', { name: /^Likely fit/ })
    .click();
  await expect(page).toHaveURL(/&stage=diligence&fit=likely$/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Brightkiln Freight');
  // The stage chips now count within the fit filter.
  await expect(stages.getByRole('button', { name: /^Diligence\s*1$/ })).toBeVisible();

  await page.waitForTimeout(500);
  expect(rsc).toEqual([]);

  await page.goBack();
  await expect(page).toHaveURL(/&stage=diligence$/);
  await expect(rows).toHaveCount(diligenceCount);
  await page.goBack();
  await expect(page).toHaveURL(/\?sort=company&dir=asc$/);
  await expect(rows).toHaveCount(newestFirst.length);
  expect(await names()).toEqual(byName);
  await page.goBack();
  await expect(page).toHaveURL(/\/deals$/);
  await expect(company).not.toHaveAttribute('aria-sort', 'ascending');
  expect(await names()).toEqual(newestFirst);
  expect(rsc).toEqual([]);
});

test('a chip click and typing land at once while the open-tab refresh is loading', async ({
  page,
}) => {
  // The watcher's first check sees a new version and refreshes; every /deals
  // server render after the load is held until `release`.
  await page.route(VERSION_URL, (route) => route.fulfill({ json: { version: 'changed' } }));
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname === '/deals',
    async (route) => {
      if (isDealsRefresh(route.request())) await held;
      await route.fallback();
    },
  );
  const refresh = page.waitForRequest(isDealsRefresh);
  await gotoDeals(page);
  const rows = page.getByRole('table').locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  await refresh;

  const diligence = page
    .getByRole('group', { name: 'Filter by stage' })
    .getByRole('button', { name: /^Diligence\s*\d+$/ });
  const diligenceCount = Number(/(\d+)\s*$/.exec(await diligence.innerText())?.[1]);
  await diligence.click();
  // Held, the refresh never lands on its own: these fail if the click waits for it.
  await expect(diligence).toHaveAttribute('aria-pressed', 'true', { timeout: 1_000 });
  await expect(rows).toHaveCount(diligenceCount, { timeout: 1_000 });
  const search = page.getByRole('searchbox', { name: 'Search deals' });
  await search.pressSequentially('Bright');
  await expect(search).toHaveValue('Bright', { timeout: 1_000 });

  release();
  await expect(page).toHaveURL(/stage=diligence/);
  await expect(page).toHaveURL(/q=Bright/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Brightkiln Freight');
  await expect(diligence).toHaveAttribute('aria-pressed', 'true');
});

test('Clear filters brings the list back in place and keeps keyboard focus', async ({ page }) => {
  await gotoDeals(page, '/deals?stage=no-such-stage');
  const clear = page.getByRole('button', { name: 'Clear filters' });
  await clear.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/deals$/);
  await expect(page.getByRole('table').locator('tbody tr').first()).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Filter by stage' }).getByRole('button', { name: /^All/ }),
  ).toBeFocused();
});

test('the deal page shows the Deal-sorter card and links the Gmail thread', async ({ page }) => {
  await page.goto(`/deals/${DEMO.tidewell}`);
  await expect(page.getByRole('heading', { name: 'Deal-sorter' })).toBeVisible();
  await expect(page.getByText('Kept in sync automatically')).toBeVisible();
  await expect(
    page.getByText('Nick accepted a 30-minute intro call with the founders'),
  ).toBeVisible();
  await expect(page.getByText('Ask for the data room after the intro call')).toBeVisible();

  await page.getByRole('tab', { name: 'Sources' }).click();
  const thread = page.getByRole('link', { name: /Intro: Tidewell and TipTop/ });
  await expect(thread).toBeVisible();
  const href = (await thread.getAttribute('href')) ?? '';
  expect(href).toContain('#all/18f3a2b4c5d6e7f1');
  expect(href).toContain('authuser=nick%40tiptop.demo');
});

test('a retraction shows a banner with a human "Not a deal" button', async ({ page }) => {
  await page.goto(`/deals/${DEMO.mossgate}`);
  await expect(page.getByText('The deal-sorter says this is not a deal:')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Not a deal' }).first()).toBeVisible();
});

/** A router.refresh() of /deals, as opposed to a prefetch or a document load. */
function isDealsRefresh(request: Request): boolean {
  const headers = request.headers();
  return (
    new URL(request.url()).pathname === '/deals' &&
    headers['rsc'] === '1' &&
    !headers['next-router-prefetch']
  );
}

async function openDealsWatched(page: Page): Promise<string> {
  await page.clock.install();
  const firstCheck = page.waitForResponse(VERSION_URL);
  await gotoDeals(page);
  const body = (await (await firstCheck).json()) as { version: string };
  return body.version;
}

test('an open Deals tab refreshes when the pipeline version changes', async ({ page }) => {
  await openDealsWatched(page);
  await page.route(VERSION_URL, (route) => route.fulfill({ json: { version: 'changed' } }));
  const refresh = page.waitForRequest(isDealsRefresh);
  await page.clock.runFor(16_000);
  await refresh;
});

test('an open Deals tab is left alone while the version is unchanged', async ({ page }) => {
  const rendered = await openDealsWatched(page);
  let checks = 0;
  await page.route(VERSION_URL, (route) => {
    checks++;
    return route.fulfill({ json: { version: rendered } });
  });
  const refreshes: Request[] = [];
  page.on('request', (request) => {
    if (isDealsRefresh(request)) refreshes.push(request);
  });
  await page.clock.runFor(16_000);
  await expect.poll(() => checks).toBeGreaterThan(0);
  await page.waitForTimeout(1_000);
  expect(refreshes).toHaveLength(0);
});

test('no horizontal scroll at 375px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const url of ['/deals', `/deals/${DEMO.brightkiln}`, `/deals/${DEMO.mossgate}`]) {
    await page.goto(url);
    await expect(page.getByRole('main')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, url).toBeLessThanOrEqual(2);
  }
});

// Last: it changes the fixture's stage.
test('Apply takes the suggested stage, as the person clicking it', async ({ page }) => {
  await page.goto(`/deals/${DEMO.brightkiln}`);
  await expect(page.getByText('Stage set by a person, suggestions only')).toBeVisible();
  const stage = page.getByLabel('Pipeline stage');
  await expect(stage).toHaveValue('diligence');
  await page
    .getByRole('button', { name: 'Apply the suggested stage: Waiting for information' })
    .click();
  await expect(stage).toHaveValue('waiting_for_info');
});
