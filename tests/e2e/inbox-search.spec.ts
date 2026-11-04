import { expect, test } from '@playwright/test';

/**
 * The Inbox search box, like Gmail's: chips and recent searches on focus,
 * people and conversations while typing, and Create filter from the search
 * options, with the Filters list in the ⋮ menu. Demo mailbox only: the
 * filter stays on the server's demo state.
 */
test('search dropdown, type-ahead and Create filter', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);
  await page.goto('/inbox');

  const list = page.getByRole('region', { name: 'Conversations' });
  const rows = list.getByRole('listitem');
  await expect(rows.first()).toBeVisible();
  const subject = (await rows.first().locator('[data-row-subject]').textContent())?.trim() ?? '';
  const word = subject.split(/\s+/).find((w) => /^[A-Za-z]{4,}$/.test(w)) ?? subject;

  // Focus: the quick chips. One adds its operator and runs the search.
  const box = page.getByRole('searchbox', { name: 'Search email' });
  await box.click();
  const chips = page.getByRole('group', { name: 'Quick filters' });
  await expect(chips.getByRole('button', { name: 'Has attachment' })).toBeVisible();
  await expect(chips.getByRole('button', { name: 'From me' })).toBeVisible();
  await chips.getByRole('button', { name: 'Last 7 days' }).click();
  await expect(box).toHaveValue('newer_than:7d');
  await expect(list.getByText(/Search results in all mail for/)).toBeVisible();

  // The search is remembered: it shows under the box next time, newest first.
  await box.fill('');
  await box.click();
  const recent = page.getByRole('listbox', { name: 'Recent searches' });
  await expect(recent.getByRole('option', { name: /newer_than:7d/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(recent).toBeHidden();

  // Typing: matching conversations, picked with the arrow keys and Enter.
  await box.fill(word.slice(0, Math.max(3, word.length - 1)));
  const suggestions = page.getByRole('listbox', { name: 'Search suggestions' });
  const convo = suggestions.getByRole('option').filter({ hasText: subject });
  await expect(convo.first()).toBeVisible();
  await convo.first().click();
  const pane = page.getByRole('region', { name: 'Reading pane' });
  await expect(pane.getByRole('heading', { level: 2 })).toHaveText(subject);

  // Create filter from the search options (demo: kept here, never Gmail).
  await page.getByRole('button', { name: 'Show search options' }).click();
  const options = page.getByRole('dialog', { name: 'Search options' });
  await options.getByLabel('Subject').fill(subject);
  await options.getByRole('button', { name: 'Create filter' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create filter' });
  await expect(dialog.getByText(/Demo mailbox: the filter stays here/)).toBeVisible();
  await expect(dialog.getByLabel('Subject')).toHaveValue(subject);
  await expect(dialog.getByText(/forward/i).first()).toBeVisible();
  await dialog.getByLabel('Star it').check();
  await dialog.getByRole('button', { name: 'Create filter' }).click();
  await expect(page.getByText('Filter created')).toBeVisible();

  // The Filters list shows it, and Delete (asked once more) removes it.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('u');
  await page
    .getByRole('toolbar', { name: 'List actions' })
    .getByRole('button', { name: 'More' })
    .click();
  await page.getByRole('menuitem', { name: 'Filters' }).click();
  const filters = page.getByRole('dialog', { name: 'Filters' });
  await expect(filters.getByText('Star it')).toBeVisible();
  await filters.getByRole('button', { name: /^Delete filter / }).click();
  await filters.getByRole('button', { name: 'Delete filter', exact: true }).click();
  await expect(filters.getByText(/No filters yet/)).toBeVisible();
});
