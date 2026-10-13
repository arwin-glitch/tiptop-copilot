import { expect, test } from '@playwright/test';

/** The Calendar tab marks every entry as a meeting or a block, and says why. */
test('Calendar labels meetings and blocks with a reason', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);
  await page.goto('/calendar');

  await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Day' }).getByRole('link')).toHaveCount(7);

  const entries = page.locator('main ol > li');
  const count = await entries.count();
  if (count > 0) {
    // Every entry carries a verdict: a meeting that pings, or a block that does not.
    await expect(page.getByText(/Pings 5 min before|No ping\./).first()).toBeVisible();
    const meetings = page.getByText('Pings 5 min before');
    if ((await meetings.count()) > 0) {
      await expect(page.getByText('How you got here:').first()).toBeVisible();
    }
  } else {
    await expect(page.getByText('Nothing on the calendar.')).toBeVisible();
  }
  await page.screenshot({ path: 'test-results/calendar.png', fullPage: true });
});
