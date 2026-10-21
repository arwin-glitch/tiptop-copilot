import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * "Arwin replied": the pop-up above the Ask Arwin launcher for an answer that
 * lands out of sight, and the full Ask page under its new name.
 *
 * The demo answers within the request, so each test holds the question's
 * request back (Playwright's routing, nothing in the app) until the panel is
 * confirmed closed: the answer then lands with the panel closed, as a
 * production answer does a minute or two after it was asked. An answer asked
 * on the full Ask page is handed to the widget with the page's own watch
 * event, which the widget then checks like any answer on its way.
 */

// One demo sign-in for the file: demo entry is rate-limited across the suite.
const SIGNED_IN = resolve('test-results', 'ask-reply-state.json');

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

const launcher = (page: Page) =>
  page.getByRole('button', { name: /^Ask Arwin \(AI\)(, new answer)?$/ });
const marked = (page: Page) => page.getByRole('button', { name: 'Ask Arwin (AI), new answer' });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Ask Arwin' });
const notice = (page: Page) => page.locator('[data-ask-reply]');

/**
 * Holds the questions asked on `path` (Server Actions, posted to the page
 * itself) until the returned release is called: no race with the clock.
 */
async function holdQuestions(page: Page, path: string): Promise<() => void> {
  let release = () => {};
  const gate = new Promise<void>((done) => {
    release = () => done();
  });
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      const request = route.request();
      if (request.method() === 'POST' && request.headers()['next-action']) {
        // Released by the test; the fallback only keeps a failed test from hanging.
        await Promise.race([gate, new Promise((done) => setTimeout(done, 60_000))]);
      }
      await route.continue();
    },
  );
  return release;
}

/** Asks in a new conversation, closes the panel, then lets the answer come back. */
async function askThenClose(page: Page, question: string, release: () => void) {
  await launcher(page).click();
  const dialog = panel(page);
  await dialog.getByRole('button', { name: 'New conversation' }).click();
  const field = dialog.getByLabel('Your question');
  await field.fill(question);
  await field.press('Enter');
  await expect(dialog.getByText(question)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // Out of the pop-up's way: a pointer resting on it would hold it open.
  await page.mouse.move(8, 8);
  release();
}

/** Asks on the full Ask page (a conversation of its own); returns its id. */
async function askOnFullPage(page: Page, question: string): Promise<string> {
  await page.goto('/ask');
  await page.getByLabel('Your question').fill(question);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.waitForURL(/\/ask\?thread=/);
  await expect(page.getByText('AI-generated').first()).toBeVisible({ timeout: 30_000 });
  const threadId = new URL(page.url()).searchParams.get('thread');
  expect(threadId).toBeTruthy();
  return threadId ?? '';
}

/** Hands a conversation to the widget to check, as the full Ask page does for one it waits on. */
async function watchThread(page: Page, threadId: string) {
  await page.evaluate(
    (id) =>
      window.dispatchEvent(
        new CustomEvent('tiptop:ask-watch', { detail: { threadId: id, watching: true } }),
      ),
    threadId,
  );
}

test('an answer that lands with the panel closed pops up, then goes by itself', async ({
  page,
}) => {
  await page.goto('/today');
  const release = await holdQuestions(page, '/today');
  await askThenClose(page, 'What follow-ups are overdue?', release);

  const card = notice(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  const shownAt = Date.now();
  await expect(card.getByRole('button', { name: /^Arwin replied: / })).toBeVisible();
  await expect(card).toContainText('You asked: What follow-ups are overdue?');
  // A preview of the answer: plain text, one line of it, clipped.
  const preview = (await card.locator('[data-ask-reply-preview]').textContent())?.trim() ?? '';
  expect(preview.length).toBeGreaterThan(0);
  expect(preview.length).toBeLessThanOrEqual(70);
  expect(preview).not.toContain('What follow-ups are overdue?');
  // Told to a screen reader, without taking focus from where Esc left it.
  await expect(page.locator('[data-ask-reply-announcer]')).toContainText(
    `Arwin replied: ${preview}`,
  );
  await expect(marked(page)).toBeFocused();

  // It goes by itself after about three and a half seconds…
  await expect(card).toBeHidden({ timeout: 8_000 });
  expect(Date.now() - shownAt).toBeGreaterThan(2_500);
  // …and the gold dot stays until the conversation is opened.
  await expect(marked(page)).toBeVisible();
  await page.waitForTimeout(500);
  await expect(card).toHaveCount(0);
  await launcher(page).click();
  await expect(panel(page).getByText('What follow-ups are overdue?')).toBeVisible();
  await expect(panel(page).getByText('AI-generated').first()).toBeVisible();
});

test('clicking the pop-up opens the panel on that conversation', async ({ page }) => {
  await page.goto('/deals');
  const release = await holdQuestions(page, '/deals');
  await askThenClose(page, 'Who is waiting on me?', release);

  const card = notice(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: /^Arwin replied/ }).click();

  const dialog = panel(page);
  await expect(dialog).toBeVisible();
  await expect(card).toHaveCount(0);
  await expect(dialog.getByText('Who is waiting on me?')).toBeVisible();
  await expect(dialog.getByText('AI-generated').first()).toBeVisible();
  await expect(dialog.getByLabel('Your question')).toBeFocused();
  await expect(page).toHaveURL(/\/deals$/);

  // Opened, the dot is gone.
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Ask Arwin (AI)', exact: true })).toBeVisible();
});

test('a hover holds it; the X dismisses it and leaves the dot', async ({ page }) => {
  await page.goto('/today');
  const release = await holdQuestions(page, '/today');
  await askThenClose(page, 'Which deals are in diligence?', release);

  const card = notice(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.hover();
  await page.waitForTimeout(4_500);
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(card).toHaveCount(0);
  await expect(marked(page)).toBeVisible();
});

test('it waits for a guided tour to end', async ({ page }) => {
  await page.goto('/today?tour=today');
  const tourCard = page.locator('[data-tour-card]');
  await expect(tourCard).toBeVisible();
  const release = await holdQuestions(page, '/today');

  // Asked through the widget's open event, as an "Ask about this" button does.
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('tiptop:ask-open', { detail: { question: 'Anything urgent today?' } }),
    ),
  );
  const dialog = panel(page);
  await expect(dialog.getByText('Anything urgent today?')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.mouse.move(8, 8);
  release();

  // The answer lands (the launcher is marked) while the tour still runs: no pop-up.
  await expect(marked(page)).toBeVisible({ timeout: 30_000 });
  await expect(tourCard).toBeVisible();
  await expect(notice(page)).toHaveCount(0);

  // The tour ends; the pop-up has its turn.
  await tourCard.getByRole('button', { name: 'End tour' }).click();
  await expect(tourCard).toHaveCount(0);
  await expect(notice(page)).toBeVisible();
});

test('while another dialog has its corner, the pop-up waits to be seen', async ({ page }) => {
  const threadId = await askOnFullPage(page, 'Which companies raised this quarter?');
  await page.goto('/today');
  // Search is a dialog: the launcher's corner steps aside while it is open.
  await page
    .getByRole('button', { name: /^Search/ })
    .first()
    .click();
  const search = page.getByRole('dialog', { name: 'Search' });
  await expect(search).toBeVisible();
  await watchThread(page, threadId);

  const card = notice(page);
  await expect(card).toBeAttached({ timeout: 30_000 });
  await expect(card).toBeHidden();
  // Longer than the pop-up's time: out of sight, its clock does not run.
  await page.waitForTimeout(4_500);
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
  await page.mouse.move(8, 8);
  await expect(card).toBeVisible();
  await expect(card).toContainText('You asked: Which companies raised this quarter?');
  await expect(card).toBeHidden({ timeout: 8_000 });
  await expect(marked(page)).toBeVisible();
});

test('in the open panel it floats over the conversation; Esc dismisses only it, and a draft survives', async ({
  page,
}) => {
  const first = await askOnFullPage(page, 'What did the last board meeting decide?');
  const second = await askOnFullPage(page, 'Which intros are still open?');

  await page.goto('/today');
  await launcher(page).click();
  const dialog = panel(page);
  await dialog.getByRole('button', { name: 'New conversation' }).click();
  const field = dialog.getByLabel('Your question');
  await field.fill('Which founders emailed me today?');
  await field.press('Enter');
  await expect(dialog.getByText('AI-generated').first()).toBeVisible({ timeout: 30_000 });
  // A follow-up, half typed.
  await field.fill('And tomorrow');
  const before = await field.boundingBox();

  // An answer to another conversation lands: the card is in the panel, over
  // the conversation, and nothing under it moves.
  await watchThread(page, first);
  const card = dialog.locator('[data-ask-reply]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('You asked: What did the last board meeting decide?');
  expect(await field.boundingBox()).toEqual(before);

  // Esc on the card closes the card, not the panel.
  await card.getByRole('button', { name: /^Arwin replied/ }).focus();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(field).toHaveValue('And tomorrow');

  // Opening the next one switches conversations; the draft waits to be returned to.
  await watchThread(page, second);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: /^Arwin replied/ }).click();
  await expect(dialog.getByText('Which intros are still open?').first()).toBeVisible();
  await expect(field).toHaveValue('');
  await dialog.getByRole('button', { name: 'All conversations' }).click();
  await dialog
    .getByRole('button', { name: /Which founders emailed me today\?/ })
    .first()
    .click();
  await expect(field).toHaveValue('And tomorrow');
});

test('on the full Ask page, a conversation opened there clears the dot', async ({ page }) => {
  const first = await askOnFullPage(page, 'Who are our newest founders?');
  const second = await askOnFullPage(page, 'Which deals need a decision?');
  const todayLink = () =>
    page
      .getByRole('navigation', { name: 'Main' })
      .first()
      .getByRole('link', { name: 'Today', exact: true });

  // The page has no launcher: the pop-up sits under its header.
  await page.goto('/ask');
  await watchThread(page, first);
  const card = notice(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: /^Arwin replied/ }).click();
  await page.waitForURL((url) => url.searchParams.get('thread') === first);
  await expect(card).toHaveCount(0);
  // Read there, so the launcher elsewhere has nothing new to point at.
  await todayLink().click();
  await page.waitForURL(/\/today/);
  await expect(page.getByRole('button', { name: 'Ask Arwin (AI)', exact: true })).toBeVisible();

  // Back to the page; this time the pop-up is dismissed and the conversation
  // opened from the page's Recent list instead.
  await launcher(page).click();
  await panel(page).getByRole('link', { name: 'Open full page' }).click();
  await page.waitForURL(/\/ask$/);
  await watchThread(page, second);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(card).toHaveCount(0);
  await page
    .getByRole('link', { name: /Which deals need a decision\?/ })
    .first()
    .click();
  await page.waitForURL((url) => url.searchParams.get('thread') === second);
  await todayLink().click();
  await page.waitForURL(/\/today/);
  await expect(page.getByRole('button', { name: 'Ask Arwin (AI)', exact: true })).toBeVisible();
});

test('with reduced motion it appears and goes without animating', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/today');
  const release = await holdQuestions(page, '/today');
  await askThenClose(page, 'What is on my calendar this week?', release);

  const card = notice(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  expect(await card.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await expect(card).toBeHidden({ timeout: 8_000 });
});

test('the full page is Ask Arwin', async ({ page }) => {
  await page.goto('/ask');
  await expect(page.getByRole('heading', { level: 1, name: 'Ask Arwin' })).toBeVisible();
  await expect(page).toHaveTitle(/^Ask Arwin/);
  await expect(page.getByLabel('Your question')).toHaveAttribute(
    'placeholder',
    'Ask Arwin anything…',
  );
  await expect(page.getByText('Ask TipTop')).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test('the pop-up fits the screen, above the launcher and the tab bar', async ({ page }) => {
    await page.goto('/today');
    const release = await holdQuestions(page, '/today');
    await askThenClose(page, 'Who should I follow up with?', release);

    const card = notice(page);
    await expect(card).toBeVisible({ timeout: 30_000 });
    const [box, button, close, bar] = await Promise.all([
      card.boundingBox(),
      marked(page).boundingBox(),
      card.getByRole('button', { name: 'Dismiss' }).boundingBox(),
      page.getByRole('navigation', { name: 'Main' }).last().boundingBox(),
    ]);
    const viewport = page.viewportSize();
    expect(box && button && close && bar && viewport).toBeTruthy();
    if (!box || !button || !close || !bar || !viewport) return;
    // Inside the screen, never over the launcher, both above the tab bar.
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(button.y);
    expect(button.y + button.height).toBeLessThanOrEqual(bar.y);
    // A thumb-sized X.
    expect(close.width).toBeGreaterThanOrEqual(44);
    expect(close.height).toBeGreaterThanOrEqual(44);
    // Nothing scrolls sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);
  });
});
