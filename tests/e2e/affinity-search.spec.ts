import { expect, test, type Page } from '@playwright/test';

/**
 * Affinity-style people and companies, in demo mode (every name fictional):
 * Ctrl+K's recent searches and preview panel, the status tag and last-contact
 * filters on Network → People, and the profile's subtabs.
 */

const BRINDLE = '/lists/records/00000000-0000-4000-8000-0000000006a4';

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

test.beforeEach(async ({ page }) => {
  await enterDemo(page);
});

test('Ctrl+K previews a company and remembers it as a recent search', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const search = page.getByRole('searchbox', { name: 'Search everything' });
  await search.fill('Brindle');
  const option = page
    .getByRole('group', { name: 'Lists' })
    .getByRole('option', { name: /^Brindle Health/ });
  await expect(option).toBeVisible();
  await option.hover();

  const preview = page.getByTestId('search-preview');
  await expect(preview).toContainText('Brindle Health');
  await expect(preview.locator('[data-contact-status]')).toBeVisible();
  await expect(preview).toContainText('Last contact');
  await expect(preview.getByRole('list', { name: 'Counts' })).toContainText('Notes');

  await option.getByRole('button').first().click();
  await page.waitForURL(/\/lists\/records\//);
  await expect(page.locator('[data-profile-contact] [data-contact-status]')).toBeVisible();

  await page.keyboard.press('Control+k');
  await expect(page.getByText('Recent searches')).toBeVisible();
  await expect(page.getByRole('option', { name: /^Brindle Health/ })).toBeVisible();
});

test('All companies: status tags, never-contacted filter and last-contact sort', async ({
  page,
}) => {
  await page.goto('/network?tab=people&source=companies');
  const table = page.getByRole('table', { name: 'Companies from Affinity' });
  await expect(table).toBeVisible();
  await expect(table.locator('[data-contact-status]').first()).toBeVisible();

  await page
    .getByRole('group', { name: 'Relationship status' })
    .getByRole('link', { name: 'Never contacted' })
    .click();
  await page.waitForURL((url) => url.searchParams.get('status') === 'never');
  const statuses = await table
    .locator('[data-contact-status]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-contact-status')));
  expect(statuses.length).toBeGreaterThan(0);
  expect(new Set(statuses)).toEqual(new Set(['never']));

  await page.goto('/network?tab=people&source=companies&sort=last_contact');
  const first = table.locator('tbody tr').first();
  await expect(first.locator('[data-contact-status="recent"]')).toBeVisible();
});

test('a profile opens on Overview and has Connections and Activity tabs', async ({ page }) => {
  await page.goto(BRINDLE);
  const tabs = page.getByRole('navigation', { name: 'Profile sections' });
  await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('region', { name: 'Lists' })).toBeVisible();

  await tabs.getByRole('link', { name: 'Connections' }).click();
  await page.waitForURL(/tab=connections/);
  const team = page.getByRole('region', { name: /Who on the team knows them/ });
  await expect(team.locator('[data-signal-bars]').first()).toBeVisible();
  await expect(page.getByRole('region', { name: /People there we know/ })).toContainText(
    'Ada Brennan',
  );

  await tabs.getByRole('link', { name: 'Activity' }).click();
  await page.waitForURL(/tab=activity/);
  const activity = page.locator('[data-profile-activity]');
  await expect(activity.locator('[data-activity-kind="email"]').first()).toBeVisible();
  await expect(activity.getByRole('img', { name: /in the last 12 weeks, by week/ })).toBeVisible();
});
