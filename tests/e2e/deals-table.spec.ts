import { expect, test, type Page } from '@playwright/test';

/**
 * The pipeline table.
 *
 * `/deals` became a table in this pass, and the parts worth asserting are the
 * ones that are easy to get subtly wrong and impossible to see in a
 * screenshot: that sorting actually reorders rows and says so to assistive
 * technology, that the header stays put, and — the one that matters most —
 * that a deal with no analysis is rendered as *absent* rather than as zero.
 *
 * That last one is invariant 1 from the handover. A score column is the single
 * most tempting place in the product to print `0` for "we do not know", and in
 * a sorted column that would read as "scored, and scored badly".
 */

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

async function gotoDeals(page: Page) {
  await page.goto('/deals');
  await expect(page.getByRole('heading', { name: 'Deals' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await enterDemo(page);
});

test('the pipeline renders as a table with a described header row', async ({ page }) => {
  await gotoDeals(page);

  const table = page.getByRole('table');
  await expect(table).toBeVisible();

  for (const column of ['Company', 'Stage', 'Recommendation', 'Score', 'Evidence', 'Confidence']) {
    await expect(table.getByRole('columnheader', { name: column })).toBeVisible();
  }

  // Newest first is the default, and it is announced rather than merely drawn.
  await expect(table.getByRole('columnheader', { name: 'Received' })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
});

test('sorting reorders the rows and announces the direction', async ({ page }) => {
  await gotoDeals(page);
  const table = page.getByRole('table');

  const companyHeader = table.getByRole('columnheader', { name: 'Company' });
  await companyHeader.getByRole('button').click();
  await page.waitForURL(/sort=company/);

  await expect(companyHeader).toHaveAttribute('aria-sort', 'ascending');

  const names = await table.locator('tbody th a').allInnerTexts();
  expect(names.length).toBeGreaterThan(1);
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

  // Clicking the same column again reverses it rather than re-sorting the same way.
  await companyHeader.getByRole('button').click();
  await page.waitForURL(/dir=desc/);
  await expect(companyHeader).toHaveAttribute('aria-sort', 'descending');

  const reversed = await table.locator('tbody th a').allInnerTexts();
  expect(reversed).toEqual([...names].reverse());
});

test('an unanalysed deal shows no score rather than a zero', async ({ page }) => {
  await gotoDeals(page);
  const table = page.getByRole('table');

  const unanalysed = table.locator('tbody tr', { hasText: 'Not analysed' }).first();
  await expect(unanalysed).toBeVisible();

  // The three numeric columns for that row are em dashes, not digits.
  const cells = await unanalysed.locator('td').allInnerTexts();
  const numericCells = cells.slice(2, 5);
  expect(numericCells).toEqual(['—', '—', '—']);
  for (const cell of numericCells) expect(cell).not.toMatch(/\d/);
});

test('sorting by score never ranks an unscored deal above a scored one', async ({ page }) => {
  // Ascending by score is the case that would otherwise float every unanalysed
  // deal to the top, as though it had scored zero. Stated as an ordering
  // property rather than "the first row is scored", because a pipeline where
  // nothing has been analysed yet is a legitimate state — and the demo store
  // starts in exactly that state, since analysis is an explicit act.
  await page.goto('/deals?sort=score&dir=asc');
  const table = page.getByRole('table');
  await expect(table).toBeVisible();

  const rows = await table.locator('tbody tr').allInnerTexts();
  expect(rows.length).toBeGreaterThan(0);

  const firstUnscored = rows.findIndex((row) => row.includes('Not analysed'));
  if (firstUnscored !== -1) {
    const after = rows.slice(firstUnscored);
    expect(after.every((row) => row.includes('Not analysed'))).toBe(true);
  }
});

test('the table is replaced by a card list on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await gotoDeals(page);

  // Not a squeezed table: below the breakpoint the table is not rendered at all.
  await expect(page.getByRole('table')).toBeHidden();
  await expect(page.getByRole('link', { name: /Vetrix/ }).first()).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(2);
});
