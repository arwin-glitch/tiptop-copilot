import { expect, test, type Page } from '@playwright/test';

/**
 * Search that filters as you type.
 *
 * Every search box in the app used to require Enter, which reads as broken:
 * you type, the list does not move, and you conclude the search does nothing.
 * These tests assert the two halves of the behaviour that fixes that —
 * narrowing without a submit, and restoring the full list the moment the box
 * is empty — because neither is visible to a unit test and both are the whole
 * point of the control.
 */

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

test.beforeEach(async ({ page }) => {
  await enterDemo(page);
});

test('typing narrows the meeting list without pressing Enter', async ({ page }) => {
  await page.goto('/meetings');

  const cards = page.locator('main li');
  const before = await cards.count();
  expect(before).toBeGreaterThan(1);

  const search = page.getByRole('searchbox', { name: 'Search meetings' });
  // A term from a real fixture note. Typed only — never submitted.
  await search.pressSequentially('Ledgerly', { delay: 30 });

  // The URL is the state, so waiting for it is waiting for the search itself.
  await page.waitForURL(/[?&]q=Ledgerly/);
  await expect.poll(() => cards.count()).toBeLessThan(before);
  await expect(cards.first()).toContainText(/Ledgerly/i);
});

test('clearing the box restores the full list', async ({ page }) => {
  await page.goto('/meetings');
  const cards = page.locator('main li');
  const before = await cards.count();

  const search = page.getByRole('searchbox', { name: 'Search meetings' });
  await search.pressSequentially('Ledgerly', { delay: 30 });
  await page.waitForURL(/[?&]q=Ledgerly/);
  await expect.poll(() => cards.count()).toBeLessThan(before);

  // The dedicated control, not a manual select-all-delete: an empty query has
  // to mean "no filter", not "search for nothing".
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.waitForURL((url) => !url.searchParams.get('q'));
  await expect.poll(() => cards.count()).toBe(before);
});

test('deleting the text by hand also restores the list', async ({ page }) => {
  await page.goto('/meetings');
  const cards = page.locator('main li');
  const before = await cards.count();

  const search = page.getByRole('searchbox', { name: 'Search meetings' });
  await search.pressSequentially('Ledgerly', { delay: 30 });
  await page.waitForURL(/[?&]q=Ledgerly/);

  await search.fill('');
  await page.waitForURL((url) => !url.searchParams.get('q'));
  await expect.poll(() => cards.count()).toBe(before);
});

test('every search box on the app filters as you type', async ({ page }) => {
  // One control, five places. If any page is still on the old submit-only
  // form, its box will not be a searchbox and this fails there.
  for (const [path, label] of [
    ['/meetings', 'Search meetings'],
    ['/deals', 'Search deals'],
    ['/network', 'Search network'],
    ['/inbox', 'Search email'],
    ['/knowledge', 'Search knowledge base'],
  ] as const) {
    await page.goto(path);
    const box = page.getByRole('searchbox', { name: label });
    await expect(box, `${path} should have a live search box`).toBeVisible();

    await box.pressSequentially('zz', { delay: 20 });
    await page.waitForURL(/[?&]q=zz/, { timeout: 5000 });

    await page.getByRole('button', { name: 'Clear search' }).click();
    await page.waitForURL((url) => !url.searchParams.get('q'));
  }
});
