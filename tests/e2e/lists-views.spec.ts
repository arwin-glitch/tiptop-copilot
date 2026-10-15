import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Saved views on a list, Affinity-style, in demo mode against the invented
 * Deal Pipeline (eleven deals, nine with an amount, $5,900,000 in all).
 *
 * What a unit test cannot see: that a filter built in the popover reaches
 * the server and the totals follow it, that "Save as new view" makes a tab
 * that survives a reload, and that the exports really download — the view's
 * rows in its columns, a company's notes, and the whole CRM as a ZIP.
 *
 * Runs before lists.spec.ts on the shared demo store, so every write here is
 * undone before the file ends: the view it saves, it deletes.
 */

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

async function openDealPipeline(page: Page) {
  await page.goto('/lists');
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Deal Pipeline/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Deal Pipeline' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await enterDemo(page);
});

test('a filter runs on the server, the totals follow, and it saves as a view', async ({ page }) => {
  await openDealPipeline(page);
  const views = page.getByRole('navigation', { name: 'Views' });
  await expect(views.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page');

  const table = page.getByRole('table');
  // Imported from Affinity without Affinity's own timer, Time in Stage would
  // be blank on every row: it is offered in Columns, not shown.
  await expect(table.getByRole('columnheader', { name: 'Time in Stage' })).toHaveCount(0);
  await page.getByRole('button', { name: /^Columns/ }).click();
  await page.getByRole('checkbox', { name: /Time in Stage/ }).check();
  await page.keyboard.press('Escape');
  await expect(table.getByRole('columnheader', { name: 'Time in Stage' })).toBeVisible();
  const footer = table.locator('tfoot');
  await expect(footer.getByLabel('Amount total')).toHaveText('$5,900,000');
  await expect(footer).toContainText('11 entries');
  await expect(footer).toContainText('9 entries');

  // Amount at least $1M, built in the filter popover.
  await page.getByRole('button', { name: /^Filter/ }).click();
  const filters = page.getByRole('dialog', { name: 'Filters' });
  await filters.getByRole('button', { name: 'Add filter' }).click();
  await filters.getByRole('combobox', { name: 'Filter 1 field' }).selectOption('Amount');
  await expect(filters.getByRole('combobox', { name: 'Filter 1 condition' })).toHaveValue('gte');
  await filters.getByRole('textbox', { name: 'Filter 1 value' }).fill('$1M');
  await filters.getByRole('button', { name: 'Apply filters' }).click();
  await page.waitForURL(/f=amount/);

  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table.locator('tbody th button')).toHaveText(['Cobaltline', 'Marrowgate Software']);
  await expect(
    page.getByRole('list', { name: 'Active filters' }).getByText('Amount is at least $1,000,000'),
  ).toBeVisible();
  await expect(footer.getByLabel('Amount total')).toHaveText('$2,250,000');
  await expect(footer).toContainText('2 entries');
  // The status chips count what the filter leaves.
  const chips = page.getByRole('group', { name: 'Filter by Status' });
  await expect(chips.getByRole('button', { name: /^5\. Diligence/ })).toHaveAccessibleName(
    /^5\. Diligence\s*2$/,
  );

  // Saved as a view: a tab of its own, and the URL is just the view.
  await expect(page.getByText('Showing a changed view of All')).toBeVisible();
  await page.getByRole('button', { name: 'Save as new view' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save as new view' });
  await dialog.getByRole('textbox', { name: 'View name' }).fill('Big checks');
  await dialog.getByRole('button', { name: 'Save view' }).click();
  await page.waitForURL(/[?&]v=[a-z0-9]+$/);
  const bigChecks = views.getByRole('link', { name: 'Big checks' });
  await expect(bigChecks).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Showing a changed view of All')).toHaveCount(0);
  await expect(table.locator('tbody tr')).toHaveCount(2);

  await page.reload();
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(2);
  await expect(
    page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Big checks' }),
  ).toHaveAttribute('aria-current', 'page');

  // All is still all of it.
  await page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'All' }).click();
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(11);

  // A change to the saved view is offered for saving; Reset puts it back.
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('link', { name: 'Big checks' })
    .click();
  await page
    .getByRole('table')
    .getByRole('columnheader', { name: 'Name' })
    .getByRole('button')
    .click();
  await page.waitForURL(/mod=1/);
  await expect(page.getByText('Unsaved changes to “Big checks”')).toBeVisible();
  await page.getByRole('link', { name: 'Reset' }).click();
  await expect(page.getByText('Unsaved changes to “Big checks”')).toHaveCount(0);

  // Renamed, then deleted, which leaves the demo store as it was.
  await page.getByRole('button', { name: 'Options for the Big checks view' }).click();
  await page.getByRole('button', { name: 'Rename view' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename view' });
  await rename.getByRole('textbox', { name: 'View name' }).fill('Large rounds');
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(
    page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Large rounds' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Options for the Large rounds view' }).click();
  await page.getByRole('button', { name: 'Delete view' }).click();
  await page
    .getByRole('dialog', { name: /Delete “Large rounds”/ })
    .getByRole('button', { name: 'Delete view' })
    .click();
  await expect(
    page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Large rounds' }),
  ).toHaveCount(0);
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(11);
});

test('the board totals every column', async ({ page }) => {
  await openDealPipeline(page);
  await page.getByRole('tab', { name: 'Board' }).click();
  await page.waitForURL(/view=board/);
  const board = page.getByRole('region', { name: 'Deal Pipeline by status' });
  const diligence = board.getByRole('region', { name: /^5\. Diligence/ });
  await expect(diligence.getByLabel('Column totals')).toContainText('$2,250,000');
  await expect(diligence.getByLabel('Column totals')).toContainText('2 entries');
  const passed = board.getByRole('region', { name: /^Passed/ });
  await expect(passed.getByLabel('Column totals')).toContainText('$900,000');
});

test('"Export CSV" downloads every entry the view matches, in its columns', async ({ page }) => {
  await openDealPipeline(page);
  await page.goto(`${page.url()}?f=${encodeURIComponent('amount:gte:1000000')}`);
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(2);
  // The export follows the columns on screen, Time in Stage included once shown.
  await page.getByRole('button', { name: /^Columns/ }).click();
  await page.getByRole('checkbox', { name: /Time in Stage/ }).check();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('table').getByRole('columnheader', { name: 'Time in Stage' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Export' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: /Export CSV/ }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('Deal-Pipeline.csv');
  const csv = readFileSync(await download.path())
    .toString('utf8')
    .replace(/^﻿/, '');
  const lines = csv.trim().split('\r\n');
  expect(lines[0]).toBe(
    'Name,Status,Time in Stage (days),Amount,Owners,Source Channel,Industry,Date Added,Last Contact',
  );
  expect(lines).toHaveLength(3);
  expect(lines[1]).toMatch(
    /^Cobaltline,5\. Diligence,,1000000,Morgan Ellery; Dana Whitcombe,Inbound,/,
  );
  expect(lines[2]).toMatch(/^Marrowgate Software,5\. Diligence,,1250000,/);
});

test('a company’s notes export from its profile, and the whole CRM as a ZIP', async ({ page }) => {
  await page.goto('/lists');
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Portfolio/ })
    .click();
  await page.getByRole('table').getByRole('button', { name: 'Hearthstone Payroll' }).click();
  await page
    .getByRole('dialog', { name: 'Hearthstone Payroll' })
    .getByRole('link', { name: /Open profile/ })
    .click();
  await page.waitForURL(/\/lists\/records\//);

  const [notes] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Export notes on Hearthstone Payroll as CSV' }).click(),
  ]);
  expect(notes.suggestedFilename()).toBe('Hearthstone-Payroll-notes.csv');
  const csv = readFileSync(await notes.path()).toString('utf8');
  expect(csv.replace(/^﻿/, '').split('\r\n')[0]).toBe(
    'Date,Title,Author,Content,Attached to,Source,Flagged',
  );
  expect(csv).toContain('Board update');

  await openDealPipeline(page);
  await page.getByRole('button', { name: 'Export' }).click();
  const [zip] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: /Export everything/ }).click(),
  ]);
  expect(zip.suggestedFilename()).toMatch(/^copilot-crm-export-\d{4}-\d{2}-\d{2}\.zip$/);
  const bytes = readFileSync(await zip.path());
  // A ZIP starts with the local file header signature.
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  expect(bytes.length).toBeGreaterThan(1000);
});

test('a refused export says so on screen instead of saving the error as a file', async ({
  page,
}) => {
  await openDealPipeline(page);
  await page.route(/\/api\/crm\/lists\/[^/]+\/export/, (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' },
      }),
    }),
  );
  let downloads = 0;
  page.on('download', () => {
    downloads += 1;
  });
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('link', { name: /Export CSV/ }).click();
  await expect(page.getByText('Too many requests. Try again in a minute.')).toBeVisible();
  expect(downloads).toBe(0);
});

test('an LP list shows its commitments but never adds them up', async ({ page }) => {
  await page.goto('/lists');
  await page
    .getByRole('main')
    .getByRole('link', { name: /^LP Pipeline/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'LP Pipeline' })).toBeVisible();
  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader', { name: 'Commitment' })).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(5);
  await expect(table.locator('tfoot')).toHaveCount(0);

  await page.getByRole('tab', { name: 'Board' }).click();
  await page.waitForURL(/view=board/);
  await expect(page.getByRole('region', { name: 'LP Pipeline by status' })).toBeVisible();
  await expect(page.getByLabel('Column totals')).toHaveCount(0);
});
