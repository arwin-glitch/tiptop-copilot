import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Pick times on the Calendar tab (Vimcal-style), over the demo's in-memory
 * store and mock calendar: pick a few times on the grid, copy them with the
 * booking link, see them held on the grid, then cancel the pick. Nothing here
 * can reach Google.
 */

const SIGNED_IN = path.resolve('test-results', 'calendar-pick-times-state.json');
const TZ = 'America/Chicago';

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

function dayFromToday(n: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const column = (page: Page, date: string) =>
  page.locator(`[data-calendar-view="day"] [data-date="${date}"]`);

async function dragOnColumn(page: Page, date: string, fromHour: number, toHour: number) {
  const col = column(page, date);
  await col.scrollIntoViewIfNeeded();
  const box = (await col.boundingBox())!;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + fromHour * 48 + 2);
  await page.mouse.down();
  await page.mouse.move(x, box.y + (fromHour + 0.5) * 48, { steps: 4 });
  await page.mouse.move(x, box.y + toHour * 48 - 2, { steps: 4 });
  await page.mouse.up();
}

async function clickOnColumn(page: Page, date: string, hour: number) {
  const col = column(page, date);
  const box = (await col.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + hour * 48 + 5);
}

test('pick times, copy them with the link, see them held, then cancel', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const day = dayFromToday(3);
  await page.goto(`/calendar?view=day&date=${day}`);
  const toggle = page.getByRole('button', { name: 'Pick times' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const panel = page.locator('[data-pick-panel]');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: '30 min' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // A drag picks the hour dragged over; a click picks 30 minutes from the mark.
  await dragOnColumn(page, day, 10, 11);
  await expect(
    page.getByRole('button', { name: /Remove picked time .*, 10am – 11am/ }),
  ).toBeVisible();
  await clickOnColumn(page, day, 14);
  await expect(
    page.getByRole('button', { name: /Remove picked time .*, 2pm – 2:30pm/ }),
  ).toBeVisible();
  // No new event was started meanwhile.
  await expect(page.getByRole('dialog', { name: 'New event' })).toHaveCount(0);

  await expect(panel.locator('pre')).toContainText('10:00 – 11:00 AM, 2:00 – 2:30 PM');
  await expect(panel.locator('pre')).toContainText('(Central Time)');

  await page.screenshot({ path: 'test-results/calendar-pick-times.png' });
  await panel.getByRole('button', { name: 'Copy times and link' }).click();
  await expect(page.getByText('Copied. Paste it into your email.')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(panel).toHaveCount(0);
  // Focus comes back to the toggle, not the top of the page.
  await expect(toggle).toBeFocused();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('10:00 – 11:00 AM, 2:00 – 2:30 PM');
  expect(copied).toMatch(/Book one here: https?:\/\/\S+\/meet\/nick\/p\/[\w-]+/);

  // Held on the grid, picking or not.
  const held = column(page, day).locator('[data-held-pick]');
  await expect(held).toHaveCount(2);
  await expect(held.first()).toContainText('Held: picked times');

  // "s" opens it again; Open picks lists the pick, and Cancel releases it.
  await page.keyboard.press('s');
  await expect(panel).toBeVisible();
  const open = panel.locator('[data-open-pick]');
  await expect(open).toHaveCount(1);
  await open.getByRole('button', { name: 'Cancel' }).click();
  await page
    .getByRole('alertdialog')
    .or(page.getByRole('dialog'))
    .getByRole('button', { name: 'Cancel times' })
    .click();
  await expect(page.getByText('Cancelled. The link no longer works.')).toBeVisible();
  await expect(held).toHaveCount(0);

  // Esc leaves Pick times; a click on the grid then starts an event again.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

test('on a phone the panel is a sheet along the bottom, and the grid stays usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const day = dayFromToday(4);
  await page.goto(`/calendar?view=day&date=${day}`);
  await page.getByRole('button', { name: 'Pick times' }).click();
  const sheet = page.getByRole('region', { name: 'Pick times' });
  await expect(sheet).toBeVisible();
  await column(page, day).scrollIntoViewIfNeeded();
  await clickOnColumn(page, day, 9);
  await expect(sheet).toContainText('1 picked');
  await sheet.getByRole('button', { name: 'Show more' }).click();
  await expect(sheet.getByRole('button', { name: 'Copy times and link' })).toBeEnabled();
  await page.screenshot({ path: 'test-results/calendar-pick-times-phone.png' });
  await sheet.getByRole('button', { name: 'Stop picking times' }).click();
  await expect(sheet).toHaveCount(0);
});
