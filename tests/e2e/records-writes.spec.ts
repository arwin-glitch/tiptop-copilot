import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * CRM write parity: the CRM keeps growing in Kraken once Affinity is gone.
 *
 * Demo mode, against the invented CRM in lib/demo/fixtures.ts (people 37–39
 * carry a place and an Affinity last contact for Find & save). What is
 * asserted is what a unit test cannot see: a new list made and filled from a
 * search, a column of the team's own edited in the side panel, notes edited
 * and deleted, a row taken off with Undo, a duplicate person opened instead
 * of made, and a saved list offered to a campaign.
 *
 * Named to run after the Lists specs: the lists made here are new, so they
 * would change the groups those specs count on Knowledge → Affinity lists.
 * Only lists, people and notes made here are changed.
 */

const SIGNED_IN = path.resolve('test-results', 'records-writes-state.json');

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

async function newList(page: Page, name: string, holds: 'People' | 'Companies' | 'Deals') {
  await page.goto('/knowledge?tab=lists');
  await page.getByRole('button', { name: 'New list' }).click();
  const dialog = page.getByRole('dialog', { name: 'New list' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('It holds').selectOption({ label: holds });
  await dialog.getByRole('button', { name: 'Make the list' }).click();
  await page.waitForURL(/\/lists\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

async function findAustin(page: Page) {
  await page.goto('/knowledge?tab=find');
  const form = page.getByRole('search', { name: 'Find people and companies' });
  await form.getByLabel('Where').fill('Austin');
  await form.getByLabel('In touch within').selectOption({ label: 'The last 3 years' });
  await form.getByRole('button', { name: 'Search' }).click();
  await page.waitForURL(/place=Austin/);
  return page.getByRole('region', { name: 'Search results' });
}

test('a list is made, filled from Find & save, and given a column of its own', async ({ page }) => {
  await newList(page, 'Demo Picnic Guests', 'People');
  await expect(page.getByText('This list is empty')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Find people and companies' })).toBeVisible();

  // People in Austin, in touch within three years: one of the two in Austin.
  const results = await findAustin(page);
  await expect(
    page.getByRole('heading', { name: /People in Austin, in touch within 3 years/ }),
  ).toBeVisible();
  await expect(results.getByRole('link', { name: 'Wren Calloway' })).toBeVisible();
  await expect(results.getByRole('link', { name: 'Jonah Pelletier' })).toHaveCount(0);
  await expect(results.getByText('Austin, Texas, United States')).toBeVisible();

  // Every match onto the list made a moment ago.
  await page.getByRole('button', { name: 'Add to list' }).click();
  const pick = page.getByRole('dialog', { name: 'Add these people to a list' });
  await pick.getByLabel('List').selectOption({ label: 'Demo Picnic Guests (0) · made in Kraken' });
  await pick.getByRole('button', { name: 'Add them' }).click();
  await expect(page.getByText('Added 1 to Demo Picnic Guests')).toBeVisible();

  // And the same matches as a new list of their own.
  await page.getByRole('button', { name: 'Save as list' }).click();
  const save = page.getByRole('dialog', { name: 'Save these as a new list' });
  await expect(save.getByLabel('Name of the new list')).toHaveValue(
    'People in Austin, in touch within 3 years',
  );
  await save.getByLabel('Name of the new list').fill('Demo Austin Circle');
  await save.getByRole('button', { name: 'Save list' }).click();
  await page.waitForURL(/\/lists\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { level: 1, name: 'Demo Austin Circle' })).toBeVisible();
  const table = page.getByRole('table');
  await expect(table.getByRole('button', { name: 'Wren Calloway' })).toBeVisible();

  // A column of the team's own, filled in from the side panel.
  await page.getByRole('button', { name: 'Add column' }).click();
  const column = page.getByRole('dialog', { name: 'Add a column to Demo Austin Circle' });
  await column.getByLabel('Column name').fill('Table');
  await column.getByRole('button', { name: 'Add column' }).click();
  await expect(page.getByText('Added the column Table')).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Table' })).toBeVisible();

  await table.getByRole('button', { name: 'Wren Calloway' }).click();
  const panel = page.getByRole('dialog', { name: 'Wren Calloway' });
  await panel.getByRole('button', { name: 'Edit Table for Wren Calloway' }).click();
  await panel.getByRole('textbox', { name: 'Table for Wren Calloway' }).fill('7');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Edit Table for Wren Calloway' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByRole('table').locator('tbody tr').first()).toContainText('7');
});

test('notes written in Kraken are edited and deleted; Affinity’s say why they cannot be', async ({
  page,
}) => {
  await page.goto('/knowledge?tab=lists');
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Demo Austin Circle/ })
    .click();
  await page.getByRole('table').getByRole('button', { name: 'Wren Calloway' }).click();
  const panel = page.getByRole('dialog', { name: 'Wren Calloway' });

  await panel.getByRole('textbox', { name: 'New note' }).fill('Bring the seating chart.');
  await panel.getByRole('button', { name: 'Add note' }).click();
  await expect(panel.getByText('Bring the seating chart.')).toBeVisible();

  await panel.getByRole('button', { name: 'Edit note: Bring the seating chart.' }).click();
  await panel
    .getByRole('textbox', { name: 'Edit note' })
    .fill('Bring the seating chart and the badges.');
  await panel.getByRole('button', { name: 'Save note' }).click();
  await expect(panel.getByText('Bring the seating chart and the badges.')).toBeVisible();

  await panel.getByRole('button', { name: /^Delete note: Bring the seating chart/ }).click();
  await page
    .getByRole('dialog', { name: 'Delete this note?' })
    .getByRole('button', { name: 'Delete note' })
    .click();
  await expect(panel.getByText('Bring the seating chart and the badges.')).toHaveCount(0);
  await expect(panel.getByText('No notes on this entry yet.')).toBeVisible();

  // An imported note on an Affinity list is read-only while the sync runs.
  await page.goto('/knowledge?tab=lists');
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Deal Pipeline/ })
    .click();
  await page.getByRole('table').getByRole('button', { name: 'Marrowgate Software' }).click();
  const deal = page.getByRole('dialog', { name: 'Marrowgate Software' });
  await expect(deal.getByText('Read-only while the Affinity sync runs').first()).toBeVisible();
});

test('a row comes off a list with Undo, and stays off', async ({ page }) => {
  await page.goto('/knowledge?tab=lists');
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Demo Austin Circle/ })
    .click();
  const table = page.getByRole('table');
  await table.getByRole('button', { name: 'Wren Calloway' }).click();
  await page
    .getByRole('dialog', { name: 'Wren Calloway' })
    .getByRole('button', { name: 'Remove from Demo Austin Circle' })
    .click();
  const toast = page.getByText('Removed Wren Calloway from Demo Austin Circle');
  await expect(toast).toBeVisible();
  await expect(page.getByText('This list is empty')).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  // The message, not the screen-reader announcement that says the same with a full stop.
  await expect(
    page.getByText('Wren Calloway is back on Demo Austin Circle', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('table').getByRole('button', { name: 'Wren Calloway' }),
  ).toBeVisible();

  // Removed for good this time: gone after a reload too.
  await page.getByRole('table').getByRole('button', { name: 'Wren Calloway' }).click();
  await page
    .getByRole('dialog', { name: 'Wren Calloway' })
    .getByRole('button', { name: 'Remove from Demo Austin Circle' })
    .click();
  await expect(page.getByText('This list is empty')).toBeVisible();
  await page.reload();
  await expect(page.getByText('This list is empty')).toBeVisible();
});

test('a new person is opened, not copied, when the CRM already has them', async ({ page }) => {
  await page.goto('/knowledge?tab=find');
  await page.getByRole('button', { name: 'New person' }).click();
  let dialog = page.getByRole('dialog', { name: 'New person' });
  await dialog.getByLabel('Name').fill('W. Calloway');
  await dialog.getByLabel('Email').fill('WREN@tallgrass-robotics.example');
  await dialog.getByRole('button', { name: 'Add person' }).click();
  await page.waitForURL(/\/lists\/records\//);
  await expect(page.getByRole('heading', { level: 1, name: 'Wren Calloway' })).toBeVisible();
  await expect(page.getByText('Wren Calloway is already in the CRM. Opening it.')).toBeVisible();

  await page.goto('/knowledge?tab=find');
  await page.getByRole('button', { name: 'New person' }).click();
  dialog = page.getByRole('dialog', { name: 'New person' });
  await dialog.getByLabel('Name').fill('Pat Rivers');
  await dialog.getByLabel('Email').fill('pat.rivers@quietfield.example');
  await dialog.getByLabel('Location').fill('Austin, TX');
  await dialog.getByRole('button', { name: 'Add person' }).click();
  await page.waitForURL(/\/lists\/records\//);
  await expect(page.getByRole('heading', { level: 1, name: 'Pat Rivers' })).toBeVisible();
  await expect(page.getByText('Person · added in Kraken')).toBeVisible();

  // Onto a list from the profile, and a note of their own.
  await page.getByRole('button', { name: 'Add to list' }).click();
  const pick = page.getByRole('dialog', { name: 'Add Pat Rivers to a list' });
  await pick.getByLabel('List').selectOption({ label: 'Demo Picnic Guests (1) · made in Kraken' });
  await pick.getByRole('button', { name: 'Add to list' }).click();
  await expect(page.getByText('Added Pat Rivers to Demo Picnic Guests')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Lists' }).getByRole('link', { name: 'Demo Picnic Guests' }),
  ).toBeVisible();

  const notes = page.getByRole('region', { name: 'Notes' });
  await notes.getByRole('textbox', { name: 'New note' }).fill('Met at the community meetup.');
  await notes.getByRole('button', { name: 'Add note' }).click();
  await expect(notes.getByText('Met at the community meetup.')).toBeVisible();
  await expect(
    notes.getByRole('button', { name: /^Edit note: Met at the community/ }),
  ).toBeVisible();
});

test('a filtered view saves as a list, and a saved list is offered to a campaign', async ({
  page,
}) => {
  await page.goto('/knowledge?tab=lists');
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Deal Pipeline/ })
    .click();
  await page
    .getByRole('group', { name: 'Filter by Status' })
    .getByRole('button', { name: /^5\. Diligence/ })
    .click();
  await page.waitForURL(/status=/);
  const titles = (await page.getByRole('table').locator('tbody th button').allInnerTexts()).sort();
  expect(titles.length).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Save as list' }).click();
  const save = page.getByRole('dialog', { name: 'Save as a new list' });
  await expect(save.getByLabel('Name of the new list')).toHaveValue('Deal Pipeline (filtered)');
  await save.getByLabel('Name of the new list').fill('Demo Diligence Snapshot');
  await save.getByRole('button', { name: 'Save list' }).click();
  await page.waitForURL(/\/lists\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Demo Diligence Snapshot' }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      (await page.getByRole('table').locator('tbody th button').allInnerTexts()).sort(),
    )
    .toEqual(titles);

  // A campaign can take its recipients from a list made in Kraken.
  await page.goto('/fund-ii?tab=campaigns');
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  await page.waitForURL(/\/fund-ii\/campaigns\/[0-9a-f-]{36}$/);
  await expect(
    page.getByLabel('List', { exact: true }).locator('option', { hasText: 'Demo Picnic Guests' }),
  ).toHaveCount(1);
});
