import { expect, test, type Page } from '@playwright/test';

/**
 * Spaces, in demo mode: the demo's Ledgerly Space (fictional fixtures) on
 * the Spaces tab, each of its subtabs, hiding an email, adding a suggested
 * action item, asking a question, the waiting invite on Members, and making a
 * new Space by hand. Nothing here touches mail: Spaces only read.
 */

// demoSpaceId('space', 0) = 2400, in hex.
const LEDGERLY = '/spaces/00000000-0000-4000-8000-000000000960';

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await enterDemo(page);
});

test('lists Spaces with counts and suggestions, from the nav', async ({ page }) => {
  await page.getByRole('link', { name: 'Spaces', exact: true }).first().click();
  await expect(page).toHaveURL(/\/spaces$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Spaces' })).toBeVisible();
  const card = page.getByRole('link', { name: /Ledgerly/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText(/\d+ emails · \d+ meetings · \d+ open items/);
  await expect(card).toContainText('Only you');
  await expect(page.getByRole('heading', { name: 'Suggested Spaces' })).toBeVisible();
});

test('opens a Space behind subtabs: overview, emails, meetings', async ({ page }) => {
  await page.goto(LEDGERLY);
  await expect(page.getByRole('heading', { level: 1, name: 'Ledgerly' })).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Space sections' });
  await expect(tabs.getByRole('link')).toHaveText([
    'Overview',
    'Emails',
    'Meeting log',
    'Action items',
    'Questions',
    'Members',
  ]);
  await expect(page.getByText('Only you can see what is in this Space for now.')).toBeVisible();
  await page.getByRole('button', { name: 'Summarise this Space' }).click();
  await expect(page.getByText(/\[Demo summary\] Ledgerly at a glance/)).toBeVisible();

  await tabs.getByRole('link', { name: 'Emails' }).click();
  await expect(page).toHaveURL(/tab=emails/);
  const rows = page.locator('[data-tour="space-emails"] li');
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  await expect(rows.first().getByRole('link', { name: /Open in Kraken/ })).toBeVisible();
  await rows
    .first()
    .getByRole('button', { name: /Hide from Space/ })
    .click();
  await expect(rows).toHaveCount(before - 1);

  await tabs.getByRole('link', { name: 'Meeting log' }).click();
  await expect(page.getByText('Ledgerly — pre-board sync with Maya')).toBeVisible();
  await expect(page.getByText('Ledgerly board prep')).toBeVisible();
});

test('adds a suggested action item and answers a question', async ({ page }) => {
  await page.goto(`${LEDGERLY}?tab=items`);
  const suggestions = page.getByRole('region', { name: /Suggested from emails and notes/ });
  const add = suggestions.getByRole('button', { name: /^Add: / }).first();
  await expect(add).toBeVisible();
  const title = ((await add.getAttribute('aria-label')) ?? '').replace(/^Add: /, '');
  await add.click();
  const items = page.getByRole('region', { name: 'Action items' });
  await expect(items.getByText(title, { exact: true })).toBeVisible();
  await expect(suggestions.getByRole('button', { name: `Add: ${title}` })).toHaveCount(0);

  await page.goto(`${LEDGERLY}?tab=ask`);
  await page.getByLabel('Ask about this Space').fill('Where is the VP Sales search?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByText(/\[Demo answer\] From what is in Ledgerly/)).toBeVisible();
});

test('shows the waiting invite on Members', async ({ page }) => {
  await page.goto(`${LEDGERLY}?tab=members`);
  await expect(page.getByText('Riley Moreno')).toBeVisible();
  await expect(page.getByText('Invited, not answered yet')).toBeVisible();
  await expect(page.getByText('Hidden by you')).toBeVisible();
  await expect(page.getByRole('button', { name: /Show again/ })).toHaveCount(1);
});

test('makes a new Space by hand', async ({ page }) => {
  await page.goto('/spaces');
  await page.getByRole('button', { name: 'New Space' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Space' });
  await dialog.getByLabel('Name').fill('Northwind Labs');
  await dialog.getByLabel('Company domains').fill('northwind.demo');
  await dialog.getByRole('button', { name: 'Make Space' }).click();
  await expect(page).toHaveURL(/\/spaces\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Northwind Labs' })).toBeVisible();
  await expect(page.getByText(/Matches northwind\.demo/)).toBeVisible();
  await page.goto('/spaces');
  await expect(page.getByRole('link', { name: /Northwind Labs/ })).toBeVisible();
});
