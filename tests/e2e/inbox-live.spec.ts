import { expect, test } from '@playwright/test';

/** The Inbox tab reads like Gmail: a list, a reading pane, keys, and a reply box. */
test('Inbox opens a conversation in the reading pane and offers a reply', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);
  await page.goto('/inbox');

  const list = page.getByRole('region', { name: 'Conversations' });
  const rows = list.getByRole('listitem');
  await expect(rows.first()).toBeVisible();
  const firstSubject =
    (await rows.first().locator('[data-row-subject]').textContent())?.trim() ?? '';

  // j opens the first conversation, like Gmail. The keys listen once the page has
  // hydrated; a warm server paints the rows before that, so wait for it.
  await page.waitForLoadState('networkidle');
  await page.keyboard.press('j');
  const pane = page.getByRole('region', { name: 'Reading pane' });
  await expect(pane.getByRole('heading', { level: 2 })).toHaveText(firstSubject);
  await expect(pane.getByRole('listitem').first()).toBeVisible();

  await pane.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(pane.getByRole('textbox', { name: 'Reply' })).toBeFocused();
  // Demo has no sending grant, so Send hands off to Gmail instead.
  await expect(pane.getByRole('button', { name: 'Send in Gmail' })).toBeVisible();
  await page.screenshot({ path: 'test-results/inbox-live.png' });

  // Back to the list (u), then the Gmail folders and the ? overlay.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('u');
  await expect(list).toBeVisible();
  await page.keyboard.press('Shift+?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  const nav = page.getByRole('navigation', { name: 'Mail folders' });
  await nav.getByRole('button', { name: /^Drafts/ }).click();
  await expect(list.getByText('Intro to the Ledgerly team')).toBeVisible();
  await nav.getByRole('button', { name: /^Scheduled/ }).click();
  await expect(list.getByText(/within about 3 minutes/)).toBeVisible();
  await nav.getByRole('button', { name: /^Inbox/ }).click();

  // Search filters the list.
  await page.getByRole('searchbox', { name: 'Search email' }).fill('zzzz-no-such-mail');
  await page.keyboard.press('Enter');
  await expect(list.getByText('No mail matches that search.')).toBeVisible();
});
