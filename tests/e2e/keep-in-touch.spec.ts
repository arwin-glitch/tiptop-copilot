import { expect, test, type Page } from '@playwright/test';

/**
 * Keep in touch, in demo mode: set a cadence on a profile, see when the next
 * check-in is due, find the person on Network's "Keep in touch" tab, change
 * the cadence to a custom number of days, and turn it off again.
 *
 * Owen Thistlewood is an invented CRM person with no mail in the demo, so
 * his cadence counts from when it is set and no task is added. (The rules
 * for tasks — when one is added, and that a finished one never returns —
 * are covered by tests/integration/keep-in-touch.test.ts.) The spec leaves
 * him with no cadence, as it found him.
 */

// demoCrmId('record', 23) = 1700 + 23, in hex.
const OWEN = '/lists/records/00000000-0000-4000-8000-0000000006bb';

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

test.beforeEach(async ({ page }) => {
  await enterDemo(page);
});

test('sets a keep-in-touch cadence on a profile and lists it on Network', async ({ page }) => {
  await page.goto(OWEN);
  await expect(page.getByRole('heading', { level: 1, name: 'Owen Thistlewood' })).toBeVisible();

  const section = page.getByRole('region', { name: 'Keep in touch' });
  const picker = section.getByRole('combobox', { name: 'Check in' });
  await expect(picker).toHaveValue('off');
  await expect(section).toContainText('None in synced mail or calendar');

  await picker.selectOption('monthly');
  await expect(page.getByText('Keep in touch with Owen Thistlewood: every month.')).toBeVisible();
  await expect(section.getByText('Due in 30 days')).toBeVisible();
  await expect(section).toContainText('counted from when the cadence was set');
  await expect(picker).toHaveValue('monthly');

  // It stays set after a reload: the cadence is stored, not page state.
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Keep in touch' }).getByRole('combobox', { name: 'Check in' }),
  ).toHaveValue('monthly');

  await page.goto('/network?tab=keep');
  const list = page.getByRole('region', { name: 'Keep in touch' });
  await expect(list.getByRole('link', { name: 'Owen Thistlewood' })).toBeVisible();
  await expect(list).toContainText('Every month');
  await list.getByRole('link', { name: 'Owen Thistlewood' }).click();
  await page.waitForURL(/\/lists\/records\//);

  // A custom cadence saves with its button.
  const again = page.getByRole('region', { name: 'Keep in touch' });
  await again.getByRole('combobox', { name: 'Check in' }).selectOption('custom');
  await again.getByLabel('Every how many days').fill('10');
  await again.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Keep in touch with Owen Thistlewood: every 10 days.')).toBeVisible();
  await expect(again.getByText('Due in 10 days')).toBeVisible();

  // Turned off, the profile and the Network tab both say so.
  await again.getByRole('combobox', { name: 'Check in' }).selectOption('off');
  await expect(
    page.getByText('Stopped keep-in-touch reminders for Owen Thistlewood.'),
  ).toBeVisible();
  await expect(again.getByText('Next check-in')).toHaveCount(0);
  await page.goto('/network?tab=keep');
  await expect(page.getByText('No cadences yet')).toBeVisible();
});
