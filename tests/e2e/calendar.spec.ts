import { expect, test, type Page } from '@playwright/test';

/**
 * Every event says whether it is a meeting or a block, and why. The day list
 * that used to say it is retired (D-072); the words live on each event's
 * card in Day, Week and Month, with "How you got here" in its context box.
 */

const TZ = 'America/Chicago';

function dayFromToday(n: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const chip = (page: Page, title: string) =>
  page.locator('[data-event-chip]').filter({ hasText: title });

test('the card says meeting or block, and why, with the ping', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);

  // A meeting: it pings, and the card says why it counts as one.
  await page.goto(`/calendar?view=day&date=${dayFromToday(0)}`);
  await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
  await chip(page, 'Founder office hours').click();
  const meeting = page.getByRole('dialog', { name: 'Founder office hours' });
  await expect(meeting.getByText('Meeting', { exact: true })).toBeVisible();
  await expect(meeting.getByText(/\. Pings 5 min before\.$/)).toBeVisible();
  await expect(meeting.locator('[data-context-box]')).toContainText('How you got here');
  await page.keyboard.press('Escape');

  // A block: no ping, and why not; a hold says so.
  await page.goto(`/calendar?view=day&date=${dayFromToday(1)}`);
  await chip(page, 'Hold: dentist').click();
  const block = page.getByRole('dialog', { name: 'Hold: dentist' });
  await expect(block.getByText('Block', { exact: true })).toBeVisible();
  await expect(block.getByText('Hold', { exact: true })).toBeVisible();
  await expect(block.getByText(/\. No ping\.$/)).toBeVisible();
  await page.screenshot({ path: 'test-results/calendar.png' });
});
