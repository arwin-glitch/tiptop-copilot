import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Affinity's data where Nick uses it, over the invented demo workspace: the
 * merged pipeline and sourcing lists on Deals, the LP pipelines and LP lists
 * on Fund II (stages only, never an amount), angel investments and founders
 * on Portfolio, investors, providers, operators, events and people on
 * Network, and the notes on Meetings and on the profiles.
 *
 * Each is a subtab or a one-click switch, so the assertions check that the
 * view opens where it should, holds the demo rows it should, and keeps its
 * search and filters on its own tab.
 */

const SIGNED_IN = path.resolve('test-results', 'affinity-pages-state.json');

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

function tab(page: Page, nav: string, name: RegExp) {
  return page.getByRole('navigation', { name: nav }).getByRole('link', { name });
}

test('Deals keeps its screening list first and adds the pipeline and sourcing', async ({
  page,
}) => {
  await page.goto('/deals');
  await expect(tab(page, 'Deals sections', /^Screening/)).toHaveAttribute('aria-current', 'page');

  await tab(page, 'Deals sections', /^Pipeline/).click();
  await page.waitForURL((url) => url.searchParams.get('tab') === 'pipeline');
  const pipeline = page.getByRole('table', { name: 'Pipeline' });
  await expect(pipeline).toBeVisible();
  // Vetrix is a Kraken deal and on an Affinity deal list: one row, both badges.
  const vetrix = pipeline.getByRole('row').filter({ hasText: 'Vetrix' });
  await expect(vetrix).toHaveCount(1);
  await expect(vetrix).toContainText('Kraken');
  await expect(vetrix).toContainText('Affinity');
  await expect(vetrix).toContainText('1. New Lead');
  // A company only Affinity has sits at the stage its label reads as.
  const thornbury = pipeline.getByRole('row').filter({ hasText: 'Thornbury Systems' });
  await expect(thornbury).toContainText('Founder meeting');
  await expect(thornbury).toContainText('read from Affinity');
  // Passed deals are off the open view; every stage shows the disagreement.
  await expect(pipeline.getByRole('row').filter({ hasText: 'Loomstack' })).toHaveCount(0);
  await page
    .getByRole('group', { name: 'Pipeline stage' })
    .getByRole('link', { name: /^Every stage/ })
    .click();
  await page.waitForURL((url) => url.searchParams.get('stage') === 'any');
  const loomstack = pipeline.getByRole('row').filter({ hasText: 'Loomstack' });
  await expect(loomstack).toContainText('5. Due Diligence');
  await expect(loomstack).toContainText('Differs from Kraken');

  // The search stays on the tab and the stage.
  await page.getByRole('searchbox', { name: 'Search the pipeline' }).fill('thornbury');
  await page.waitForURL((url) => url.searchParams.get('q') === 'thornbury');
  await expect(pipeline.locator('tbody tr')).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get('tab')).toBe('pipeline');

  // A Kraken deal's profile shows Affinity's side under its notes.
  await page.goto('/deals?tab=pipeline');
  await pipeline.getByRole('link', { name: 'Vetrix' }).click();
  await page.waitForURL(/\/deals\/[0-9a-f-]+$/);
  await page.getByRole('tab', { name: /Notes/ }).click();
  const fromAffinity = page.getByRole('region', { name: 'From Affinity' });
  await expect(fromAffinity).toContainText('Seed Opportunities');
  await expect(fromAffinity.getByRole('list', { name: 'Affinity notes' })).toContainText(
    'Intro call',
  );

  await page.goto('/deals?tab=sourcing');
  const sourcing = page.getByRole('table', { name: 'Sourcing' });
  await expect(sourcing).toContainText('Ferrowind Energy');
  await expect(sourcing).toContainText('Saltmarsh Labs');
  await page.getByRole('searchbox', { name: 'Search sourcing lists' }).fill('salt');
  await page.waitForURL((url) => url.searchParams.get('q') === 'salt');
  await expect(sourcing.locator('tbody tr')).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get('tab')).toBe('sourcing');
});

test('Fund II shows Affinity LPs by stage, never an amount, and the LP lists', async ({ page }) => {
  await page.goto('/fund-ii?tab=pipeline');
  const source = page.getByRole('group', { name: 'LP pipeline source' });
  await expect(source.getByRole('link', { name: /^From mail/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // The mail view is as it was.
  await expect(page.getByRole('region', { name: 'Soft commit' })).toBeVisible();

  await source.getByRole('link', { name: /^From Affinity/ }).click();
  await page.waitForURL((url) => url.searchParams.get('source') === 'affinity');
  const lps = page.getByRole('table', { name: 'LPs in Affinity' });
  await expect(lps).toBeVisible();
  const celeste = lps.getByRole('row').filter({ hasText: 'Celeste Varga' });
  await expect(celeste).toContainText('4. Soft Commit');
  await expect(celeste).toContainText('Likelihood: High');
  // Stages only: no amount column and no amount, whether typed as money or
  // a plain number named like one.
  await expect(page.getByRole('main')).not.toContainText('Expected Amount');
  await expect(page.getByRole('main')).not.toContainText('500,000');
  await expect(page.getByRole('main')).not.toContainText('Commitment');
  await expect(page.getByRole('main')).not.toContainText('Commit Size');
  await expect(page.getByRole('main')).not.toContainText('300,000');
  await expect(page.getByRole('main')).not.toContainText('300000');

  await page
    .getByRole('group', { name: 'LP stage' })
    .getByRole('link', { name: /^Soft commit/ })
    .click();
  await page.waitForURL((url) => url.searchParams.get('stage') === 'soft_commit');
  await expect(lps.locator('tbody tr')).toHaveCount(2);
  await expect(lps).toContainText('Maren Solberg');
  expect(new URL(page.url()).searchParams.get('tab')).toBe('pipeline');

  // An LP's profile, one click from the row, keeps to the same rule.
  await lps.getByRole('link', { name: 'Celeste Varga' }).click();
  await page.waitForURL(/\/lists\/records\//);
  const onLists = page.getByRole('region', { name: /^Lists/ });
  await expect(onLists).toContainText('Family Office LP Pipeline');
  await expect(onLists).toContainText('Likelihood: High');
  await expect(onLists).not.toContainText('Expected Amount');
  await expect(onLists).not.toContainText('Commit Size');
  await expect(page.getByRole('main')).not.toContainText('500,000');
  await expect(page.getByRole('main')).not.toContainText('300,000');

  await page.goto('/fund-ii?tab=pipeline&source=affinity');
  await tab(page, 'Fund II sections', /^LP lists/).click();
  await page.waitForURL((url) => url.searchParams.get('tab') === 'lists');
  const lists = page.getByRole('table', { name: 'LP lists' });
  await expect(lists).toContainText('Desmond Achterberg');
  await expect(page.getByRole('main')).toContainText('people in all');
});

test("Portfolio keeps Nick's angel investments apart and shows founders", async ({ page }) => {
  await page.goto('/portfolio?tab=angel');
  await expect(tab(page, 'Portfolio sections', /^Angel/)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('main')).toContainText('Not Fund I');
  const angel = page.getByRole('table', { name: 'Angel investments' });
  await expect(angel).toContainText('Tallowpine Coffee');
  await expect(angel).toContainText('Wrenfield Audio');

  // Every founder and portfolio row, matched to a company here or not.
  await page.goto('/portfolio?tab=founders');
  await expect(tab(page, 'Portfolio sections', /^Founders/)).toHaveAttribute(
    'aria-current',
    'page',
  );
  const founders = page.getByRole('table', { name: 'Founders from Affinity' });
  await expect(founders).toContainText('Maya Chen');
  // Neither is a Kraken portfolio company, so no company card shows them.
  await expect(founders).toContainText('Sven Malmberg');
  await expect(founders).toContainText('Lanternfish Bio');
  await page
    .getByRole('group', { name: 'Founders from Affinity: filter by list' })
    .getByRole('link', { name: /^Fund I Founders/ })
    .click();
  await page.waitForURL((url) => url.searchParams.has('list'));
  await expect(founders.locator('tbody tr')).toHaveCount(4);

  await page.goto('/portfolio?tab=companies');
  const ledgerly = page.getByRole('link', { name: /^Ledgerly/ });
  await expect(ledgerly).toContainText('Contacts: Maya Chen, CEO (from Affinity and your mail)');
  await expect(page.getByRole('link', { name: /^Stonebridge Ops/ })).toContainText('Dev Sharma');

  await ledgerly.click();
  await page.waitForURL(/\/portfolio\/[0-9a-f-]+$/);
  const fromAffinity = page.getByRole('region', { name: 'From Affinity' });
  await expect(fromAffinity).toContainText('Maya Chen');
  await expect(fromAffinity).toContainText('Founder check-in');
});

test('Network gains investors, providers, operators, events and Affinity people', async ({
  page,
}) => {
  const cases: [string, RegExp, string, string][] = [
    ['investors', /^Investors/, 'Investors', 'Hana Kuroda'],
    ['providers', /^Service providers/, 'Service providers', 'Ashgrove Legal LLP'],
    ['operators', /^Operators/, 'Operators', 'Rafael Quintero'],
    ['events', /^Event lists/, 'Events', 'Brightwater Bank'],
  ];
  for (const [key, label, table, row] of cases) {
    await page.goto(`/network?tab=${key}`);
    await expect(tab(page, 'Network sections', label)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('table', { name: table })).toContainText(row);
  }
  // A page past the end of a short list shows its last page, not nothing.
  await page.goto('/network?tab=investors&page=9');
  const investors = page.getByRole('table', { name: 'Investors' });
  await expect(investors).toContainText('Hana Kuroda');
  await expect(page.getByRole('navigation', { name: 'Investors: pages' })).toContainText('of');

  await page.goto('/network?tab=events');
  // Events: invite lists and sponsors, sponsorship amounts left out.
  const events = page.getByRole('table', { name: 'Events' });
  await expect(events).toContainText('Ada Brennan');
  await expect(events).not.toContainText('5,000');
  await page
    .getByRole('group', { name: 'Events: filter by list' })
    .getByRole('link', { name: /^Founder Lunch Invites/ })
    .click();
  await page.waitForURL((url) => url.searchParams.has('list'));
  await expect(events.locator('tbody tr')).toHaveCount(3);

  // People: the mail list stays the default; Affinity's people one click away.
  await page.goto('/network?tab=people');
  const source = page.getByRole('group', { name: 'People source' });
  await expect(source.getByRole('link', { name: /^From mail and calendar/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('searchbox', { name: 'Search network' }).fill('Celeste');
  await expect(page.getByText(/Affinity also has 1 person matching/)).toBeVisible();
  await page.getByRole('link', { name: 'Show them' }).click();
  await page.waitForURL((url) => url.searchParams.get('source') === 'affinity');
  const people = page.getByRole('table', { name: 'People from Affinity' });
  await expect(people.locator('tbody tr')).toHaveCount(1);
  await expect(people).toContainText('Celeste Varga');
  await people.getByRole('link', { name: 'Celeste Varga' }).click();
  await page.waitForURL(/\/lists\/records\//);
  await expect(page.getByRole('region', { name: 'Notes' })).toContainText('LP call');
});

test('Meetings lists Affinity notes beside Granola, newest first', async ({ page }) => {
  await page.goto('/meetings?tab=notes');
  const source = page.getByRole('group', { name: 'Notes source' });
  await expect(source.getByRole('link', { name: /^Granola/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await source.getByRole('link', { name: /^Affinity/ }).click();
  await page.waitForURL((url) => url.searchParams.get('source') === 'affinity');
  const notes = page.getByRole('list', { name: 'Affinity notes' });
  await expect(notes.locator(':scope > li').nth(0)).toContainText('Diligence call');
  await expect(notes.locator(':scope > li').nth(1)).toContainText('Founder check-in');
  await expect(notes.getByRole('link', { name: 'Maya Chen' })).toBeVisible();
  // Only Affinity's notes: the one added in Kraken is not in this stream.
  await expect(notes).not.toContainText('Warm intro from a portfolio founder');

  await page.getByRole('searchbox', { name: 'Search Affinity notes' }).fill('retention');
  await page.waitForURL((url) => url.searchParams.get('q') === 'retention');
  await expect(notes.locator(':scope > li')).toHaveCount(2);
  expect(new URL(page.url()).searchParams.get('tab')).toBe('notes');
  expect(new URL(page.url()).searchParams.get('source')).toBe('affinity');
});
