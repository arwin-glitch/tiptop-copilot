import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The Affinity importer (Knowledge → Affinity import), in demo mode, with two
 * invented exports from tests/fixtures: an opportunity list and its notes.
 *
 * What is worth asserting end to end, beyond the unit and route tests: that a
 * dropped file is read and its columns guessed in the browser, that Import
 * sends it and reports what happened, and that importing the same files a
 * second time says nothing changed — the promise the page makes to a person
 * who is not sure whether they already imported a list — and that the file,
 * dropped again later, is offered the list it made.
 *
 * Note for other specs: this adds a "harbor seed pipeline" list, its four
 * deals, three companies and two notes to the shared demo store.
 */

const FIXTURES = path.resolve(process.cwd(), 'tests/fixtures');
const LIST_FILE = path.join(FIXTURES, 'harbor_seed_pipeline.csv');
const NOTES_FILE = path.join(FIXTURES, 'harbor_seed_pipeline_notes.csv');

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

test.beforeEach(async ({ page }) => {
  await enterDemo(page);
});

test('reads Affinity exports, imports them, and a second import changes nothing', async ({
  page,
}) => {
  // The importer moved to Knowledge; the old address lands on its tab.
  await page.goto('/lists/import');
  await page.waitForURL(/\/knowledge\?tab=import$/);
  await expect(
    page
      .getByRole('navigation', { name: 'Knowledge sections' })
      .getByRole('link', { name: /^Affinity import/ }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Import from Affinity', level: 2 })).toBeVisible();

  await page.getByLabel('Choose CSV files').setInputFiles([LIST_FILE, NOTES_FILE]);

  // Read and guessed in the browser, before anything is sent.
  await expect(page.getByRole('heading', { name: 'harbor_seed_pipeline.csv' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'harbor_seed_pipeline_notes.csv' })).toBeVisible();
  await expect(page.getByLabel('List name')).toHaveValue('harbor seed pipeline');
  await expect(page.getByLabel('This list holds')).toHaveValue('deal');
  await expect(page.getByLabel('Status column')).toHaveValue('Status');
  await expect(page.getByLabel('Type of Amount')).toHaveValue('money');
  await expect(page.getByLabel('Note text column')).toHaveValue('Note Content');
  await expect(page.getByRole('cell', { name: 'Saltglass Seed' }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Import 2 files' }).click();

  const summary = page.getByRole('status').filter({ hasText: 'Import finished' });
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('1 list: 4 added');
  await expect(summary).toContainText('Notes: 2 added');
  await expect(page.getByText('List imported')).toBeVisible();
  await expect(
    page.getByText('2 of 2 notes are attached to a company, person or deal'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'harbor seed pipeline' })).toBeVisible();

  // The same files again: matched, not duplicated.
  await page.getByRole('button', { name: 'Import again' }).click();
  await expect(
    page.getByText('Everything in this file was already in Copilot, so nothing changed.'),
  ).toHaveCount(2);
  await expect(summary).toContainText('1 list: 0 added · 4 already up to date');

  // Dropped on the page another day, the list file is offered the list it made.
  await page.reload();
  await page.getByLabel('Choose CSV files').setInputFiles([LIST_FILE]);
  await expect(page.getByLabel('Import into').locator('option:checked')).toHaveText(
    /^harbor seed pipeline/,
  );
  await expect(page.getByLabel('List name')).toHaveCount(0);
  await page.getByRole('button', { name: 'Import 1 file' }).click();
  await expect(summary).toContainText('1 list: 0 added · 4 already up to date');
});
