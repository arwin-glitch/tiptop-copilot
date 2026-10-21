import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Feedback in the Ask Arwin panel, and the "AI" tag on its name (D-060).
 *
 * A note typed in the panel's Feedback tab is saved with the page under the
 * panel and lands on the full Ask page's Feedback tab, where it is marked
 * done and opened again. Everywhere the chatbot's name shows, a small "AI"
 * tag says it is the assistant. All notes are invented.
 */

// One demo sign-in for the file: demo entry is rate-limited across the suite.
const SIGNED_IN = resolve('test-results', 'ask-feedback-state.json');

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

const launcher = (page: Page) => page.getByRole('button', { name: 'Ask Arwin (AI)', exact: true });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Ask Arwin (AI)', exact: true });

test('the name carries an "AI" tag on the launcher, the panel and the full page', async ({
  page,
}) => {
  await page.goto('/today');
  await expect(launcher(page)).toBeVisible();
  await expect(launcher(page)).toHaveAttribute('title', 'Ask Arwin (AI)');
  await expect(launcher(page).locator('[data-ai-tag]')).toHaveText('AI');

  await launcher(page).click();
  const dialog = panel(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('header [data-ai-tag]')).toBeVisible();
  // The chat itself is unchanged: it opens on the conversations.
  await expect(dialog.getByRole('tab', { name: 'Conversations' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(dialog.getByRole('button', { name: 'New conversation' })).toBeFocused();

  await page.goto('/ask');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Ask Arwin (AI)', exact: true }),
  ).toBeVisible();
  await expect(page.locator('h1 [data-ai-tag]')).toBeVisible();
});

test('a note sent from the panel lands on the Feedback tab with its page, and closes', async ({
  page,
}) => {
  const words = `Fictional note ${Date.now()}: put the stage first on each card.`;

  await page.goto('/deals');
  await launcher(page).click();
  const dialog = panel(page);
  await dialog.getByRole('tab', { name: 'Feedback' }).click();
  await expect(dialog.getByText('About this page: Deals')).toBeVisible();

  // A half-written note survives closing the panel; it opens where it was left.
  const box = dialog.getByLabel('Your feedback');
  await box.fill(words);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await launcher(page).click();
  await expect(dialog.getByRole('tab', { name: 'Feedback' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(words);

  await dialog.getByRole('button', { name: 'Send feedback' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Thanks.' })).toContainText(
    'Your feedback is saved for the team.',
  );
  await expect(dialog.getByRole('link', { name: 'Open full page' })).toHaveAttribute(
    'href',
    '/ask?tab=feedback',
  );

  // "See all feedback" opens the full page's tab, not the panel again.
  await dialog.getByRole('link', { name: 'See all feedback' }).click();
  await page.waitForURL(/\/ask\?tab=feedback$/);
  const sections = page.getByRole('navigation', { name: 'Ask Arwin sections' });
  await expect(sections.getByRole('link', { name: /^Feedback/ })).toHaveAttribute(
    'aria-current',
    'page',
  );

  const open = page.getByRole('list', { name: 'Open feedback' });
  const mine = open.getByRole('article').filter({ hasText: words });
  await expect(mine).toBeVisible();
  await expect(mine.getByRole('link', { name: 'Deals' })).toHaveAttribute('href', '/deals');

  await mine.getByRole('button', { name: 'Mark done' }).click();
  await expect(page.getByText('Marked done')).toBeVisible();
  await expect(open.getByRole('article').filter({ hasText: words })).toHaveCount(0);

  await page.getByRole('button', { name: /^Done/ }).click();
  const done = page
    .getByRole('list', { name: 'Done feedback' })
    .getByRole('article')
    .filter({ hasText: words });
  await expect(done).toBeVisible();
  await expect(done).toContainText('Done by');

  // Still done after a reload: it was saved, not just hidden.
  await page.reload();
  await page.getByRole('button', { name: /^Done/ }).click();
  const reloaded = page
    .getByRole('list', { name: 'Done feedback' })
    .getByRole('article')
    .filter({ hasText: words });
  await reloaded.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByText('Back on the open list')).toBeVisible();
  await page.getByRole('button', { name: /^Open/ }).click();
  await expect(
    page.getByRole('list', { name: 'Open feedback' }).getByRole('article').filter({
      hasText: words,
    }),
  ).toBeVisible();
});

test('the Feedback tab has its own box and the desktop alerts switch', async ({ page }) => {
  const words = `Fictional page note ${Date.now()}: a darker gold for links.`;
  await page.goto('/ask?tab=feedback');
  // The full page has no panel, so it has a box of its own, with no page attached.
  await page.getByLabel('Your feedback').fill(words);
  await page.getByRole('button', { name: 'Send feedback' }).click();
  await expect(page.getByText('Your feedback is saved for the team.')).toBeVisible();
  const note = page.getByRole('list', { name: 'Open feedback' }).getByRole('article').filter({
    hasText: words,
  });
  await expect(note).toBeVisible();
  await expect(note.getByRole('link')).toHaveCount(0);

  const alerts = page.getByRole('switch', { name: 'Desktop alerts for new feedback' });
  await expect(alerts).toHaveAttribute('aria-checked', 'false');
  await alerts.click();
  await expect(alerts).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await expect(
    page.getByRole('switch', { name: 'Desktop alerts for new feedback' }),
  ).toHaveAttribute('aria-checked', 'true');
});

test("Help's Feedback link opens the page, not the panel", async ({ page }) => {
  await page.goto('/help');
  const ask = page.getByRole('main').getByRole('group', { name: 'Ask Arwin', exact: true });
  await ask.getByRole('link', { name: 'Feedback', exact: true }).click();
  await page.waitForURL(/\/ask\?tab=feedback$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Ask Arwin (AI)' })).toBeVisible();
});
