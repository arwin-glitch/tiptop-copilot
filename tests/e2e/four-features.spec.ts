import { expect, test } from '@playwright/test';

/**
 * Oct 13 features, in demo mode: fresh company updates on Reports, numbers on
 * Portfolio, and the DocSend follow-up plus warm intro paths on Fund II.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);
});

test('Reports shows fresh company updates from Gmail', async ({ page }) => {
  await page.goto('/updates');
  await expect(page.getByText('Fresh company updates').first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: 'test-results/reports-fresh.png', fullPage: true });
});

test('Portfolio shows company-reported numbers', async ({ page }) => {
  await page.goto('/portfolio');
  await expect(page.getByText('Numbers from their updates').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/company-reported/i).first()).toBeVisible();
  // Stored after the first read: a reload shows the same numbers, with when they were read.
  const updated = page.locator('[data-numbers-updated]');
  await expect(updated).toContainText(/Updated .+ · Checked \d+ compan/);
  const stamp = await updated.locator('time').getAttribute('datetime');
  expect(stamp).toBeTruthy();
  await page.reload();
  await expect(page.locator('[data-numbers-updated] time')).toHaveAttribute('datetime', stamp!);
  await expect(page.getByText('$780K').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/portfolio-numbers.png', fullPage: true });
});

test('Fund II offers a follow-up and who can intro', async ({ page }) => {
  await page.goto('/fund-ii');
  const section = page.getByRole('region', { name: 'Reading your DocSend' });
  await expect(section).toBeVisible({ timeout: 30_000 });
  const follow = section.getByRole('button', { name: /follow up/i }).first();
  await expect(follow).toBeVisible();
  await follow.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /copy for gmail/i })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();

  const intro = page.getByRole('button', { name: /who can intro/i }).first();
  await expect(intro).toBeVisible();
  await intro.click();
  await expect(page.getByText(/could introduce|already know/i).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.screenshot({ path: 'test-results/fund-ii-features.png', fullPage: true });
});
