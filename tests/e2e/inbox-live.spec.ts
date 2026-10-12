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
  const firstSubject = (await rows.first().locator('p').first().textContent())?.trim() ?? '';

  // j opens the first conversation, like Gmail.
  await page.keyboard.press('j');
  const pane = page.getByRole('region', { name: 'Reading pane' });
  await expect(pane.getByRole('heading', { level: 2 })).toHaveText(firstSubject);
  await expect(pane.getByRole('listitem').first()).toBeVisible();

  await pane.getByRole('button', { name: 'Reply' }).click();
  await expect(pane.getByRole('textbox', { name: 'Reply' })).toBeFocused();
  // Demo has no sending grant, so Send hands off to Gmail instead.
  await expect(pane.getByRole('button', { name: 'Send in Gmail' })).toBeVisible();
  await page.screenshot({ path: 'test-results/inbox-live.png' });

  // Search filters the list.
  await page.getByRole('searchbox', { name: 'Search email' }).fill('zzzz-no-such-mail');
  await page.keyboard.press('Enter');
  await expect(list.getByText('No mail matches that search.')).toBeVisible();
});
