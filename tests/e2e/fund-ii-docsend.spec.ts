import { expect, test } from '@playwright/test';

/** Fund II shows who is reading the DocSend links, hot readers first. */
test('Fund II lists DocSend readers with the hot prospect on top', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);
  await page.goto('/fund-ii');

  const section = page.getByRole('region', { name: 'Reading your DocSend' });
  await expect(section).toBeVisible();
  const first = section.getByRole('listitem').first();
  await expect(first).toContainText('priya@harborlp.demo');
  await expect(first).toContainText('Downloaded');
  await expect(first).toContainText('2 views');
  await expect(section.getByText('1 person read the LP update')).toBeVisible();
  await section.screenshot({ path: 'test-results/fund-ii-docsend.png' });
});
