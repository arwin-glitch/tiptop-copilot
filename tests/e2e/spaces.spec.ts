import { expect, test, type Page } from '@playwright/test';

/**
 * Spaces, in demo mode: the demo's Ledgerly Space (fictional fixtures) on
 * the Spaces tab, each of its subtabs, hiding an email, adding a suggested
 * action item, asking a question, the waiting invite on Members, and making a
 * new Space by hand. Nothing here touches mail: Spaces only read.
 */

// demoSpaceId('space', 0) = 2400, in hex.
const LEDGERLY = '/spaces/00000000-0000-4000-8000-000000000960';
// demoSpaceId('space', 1): Stonebridge Ops, which the demo teammate accepted
// with their own (fictional) Google connected read-only.
const STONEBRIDGE = '/spaces/00000000-0000-4000-8000-000000000961';

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

test("merges a contributor's own mail and meetings, labelled theirs", async ({ page }) => {
  await page.goto(`${STONEBRIDGE}?tab=emails`);
  await expect(page.getByRole('heading', { level: 1, name: 'Stonebridge Ops' })).toBeVisible();
  const chips = page.getByRole('navigation', { name: 'Mailboxes' });
  await expect(chips.getByRole('link', { name: 'All mailboxes' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(chips.getByRole('link', { name: "Riley's mail" })).toBeVisible();
  const rows = page.locator('[data-tour="space-emails"] li');
  const theirs = rows.filter({ hasText: "from Riley's mail" });
  await expect(theirs).toHaveCount(2);
  await expect(rows.filter({ hasText: 'main mailbox' }).first()).toBeVisible();
  // Nothing outside the rules from their mailbox.
  await expect(page.getByText('Dentist appointment reminder')).toHaveCount(0);
  const shortlist = theirs.filter({ hasText: 'engineer shortlist' });
  // Their Gmail, in their own account; never the Inbox.
  await expect(shortlist.getByRole('link', { name: /Open in Gmail/ })).toHaveAttribute(
    'href',
    /authuser=riley%40fund\.demo#all\/a1b2c3d4e5f60001/,
  );
  await expect(shortlist.locator('a[href*="/inbox"]')).toHaveCount(0);
  await shortlist.getByRole('link', { name: /Open in Kraken/ }).click();
  await expect(page).toHaveURL(/\/spaces\/[0-9a-f-]{36}\/email\?item=m\./);
  await expect(page.getByText(/From Riley's mail · read-only/)).toBeVisible();
  await expect(page.getByTestId('space-email-messages').locator('li')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /reply|archive|send/i })).toHaveCount(0);

  await page.goto(`${STONEBRIDGE}?tab=meetings`);
  const sync = page.locator('[data-tour="space-meetings"] li', {
    hasText: 'Stonebridge hiring sync',
  });
  await expect(sync).toContainText("from Riley's calendar");
  await expect(page.getByText('Gym', { exact: true })).toHaveCount(0);
});

test('shows who contributes on Members, and Ledgerly keeps an invitee out', async ({ page }) => {
  await page.goto(`${STONEBRIDGE}?tab=members`);
  const riley = page.locator('[data-tour="space-members"] li', { hasText: 'Riley Moreno' });
  await expect(riley.getByTestId('contribution')).toHaveText('Connected');
  const nick = page.locator('[data-tour="space-members"] li', { hasText: '(you)' });
  await expect(nick.getByTestId('contribution')).toHaveText('Main mailbox');
  // Only your own connection has a Disconnect, and the main mailbox has none.
  await expect(page.getByRole('button', { name: /Disconnect/ })).toHaveCount(0);

  // Riley is only invited to Ledgerly: none of their mail or meetings there.
  await page.goto(`${LEDGERLY}?tab=emails`);
  // (Its one demo email was hidden by an earlier test: the tab itself is enough.)
  await expect(page.locator('[data-tour="space-emails"]')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Mailboxes' })).toHaveCount(0);
  await expect(page.getByText("from Riley's mail")).toHaveCount(0);
  await expect(page.getByText('Ledgerly hiring panel availability')).toHaveCount(0);
  await page.goto(`${LEDGERLY}?tab=meetings`);
  await expect(page.getByText('Ledgerly VP Sales panel')).toHaveCount(0);
});

test('Settings shows your own Google for Spaces', async ({ page }) => {
  await page.goto('/settings?tab=integrations');
  const card = page.locator('[data-tour="settings-spaces-google"]');
  await expect(card.getByRole('heading', { name: 'Your Google (for Spaces)' })).toBeVisible();
  await expect(card).toContainText('Main mailbox');
  await expect(card).toContainText('read-only');
});
