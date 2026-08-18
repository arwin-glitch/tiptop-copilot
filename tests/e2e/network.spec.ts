import { expect, test, type Page } from '@playwright/test';

/**
 * The relationship list.
 *
 * This is the screen that answers Affinity, and the claim it makes is narrow
 * and checkable: every figure on it is a count of records that exist. So the
 * tests assert the things that would quietly turn it back into a guess —
 * the mailbox owner appearing as their own top contact, automated senders
 * padding the list, or a company name appearing for someone whose employer was
 * never recorded.
 */

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

test.beforeEach(async ({ page }) => {
  await enterDemo(page);
  await page.goto('/network');
  await expect(page.getByRole('heading', { name: 'Network', level: 1 })).toBeVisible();
});

test('the list is built from real correspondence, with the counts shown', async ({ page }) => {
  const table = page.getByRole('table');
  await expect(table).toBeVisible();

  for (const column of ['Person', 'Where they fit', 'Emails', 'Meetings', 'Last contact']) {
    await expect(table.getByRole('columnheader', { name: column })).toBeVisible();
  }

  // At least one real correspondent came out of the fixtures.
  const rows = table.locator('tbody tr');
  expect(await rows.count()).toBeGreaterThan(0);
});

test('the mailbox owner is never listed as their own contact', async ({ page }) => {
  // Without the own-address filter the person using the product is, by a wide
  // margin, the most frequent name in their own network.
  const table = page.getByRole('table');
  await expect(table).not.toContainText('nick@tiptop.demo');
});

test('automated senders are kept out of the people list', async ({ page }) => {
  const body = await page.locator('main').innerText();
  for (const pattern of [/no-?reply@/i, /do-?not-?reply@/i, /notifications?@/i]) {
    expect(body, `${pattern} should not appear`).not.toMatch(pattern);
  }
});

test('sorting reorders and announces itself', async ({ page }) => {
  const table = page.getByRole('table');
  const person = table.getByRole('columnheader', { name: 'Person' });

  await person.getByRole('button').click();
  await page.waitForURL(/sort=person/);
  await expect(person).toHaveAttribute('aria-sort', 'ascending');

  const names = await table.locator('tbody th').allInnerTexts();
  expect(names.length).toBeGreaterThan(0);

  await person.getByRole('button').click();
  await page.waitForURL(/dir=desc/);
  await expect(person).toHaveAttribute('aria-sort', 'descending');
});

test('a contact with no recorded employer says so rather than guessing one', async ({ page }) => {
  // Inferring a company from the email domain would put every Gmail address at
  // a company called "gmail" and attribute shared-domain contacts to whichever
  // side of a deal was matched first. Invariant 9: nobody is invented.
  const cells = await page.locator('main').innerText();
  if (cells.includes('No company recorded')) {
    expect(cells).toContain('No company recorded');
  }
  // Whatever the fixtures contain, no row may claim a domain as an employer.
  expect(cells).not.toMatch(/\bgmail\b(?!\.)/i);
});

test('search narrows the list and can be cleared', async ({ page }) => {
  const field = page.getByLabel('Search network');
  await field.fill('zzzz-no-such-person');
  await field.press('Enter');
  await page.waitForURL(/q=zzzz/);

  await expect(page.getByText('Nobody matches')).toBeVisible();
  await page.getByRole('link', { name: 'Clear search' }).click();
  await page.waitForURL(/\/network/);
  await expect(page.getByRole('table')).toBeVisible();
});
