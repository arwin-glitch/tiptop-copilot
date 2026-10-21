import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Ask Arwin: the floating assistant that replaced the Ask tab.
 *
 * A launcher on every signed-in page opens a panel (a labelled dialog) with
 * the conversation history and a composer; `/ask` links elsewhere open it in
 * place, and `/ask` itself stays as the full-page fallback. The demo answers
 * with the offline model, so an answer lands within the request.
 */

// One demo sign-in for the file: demo entry is rate-limited across the suite.
const SIGNED_IN = resolve('test-results', 'ask-widget-state.json');

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
const panel = (page: Page) => page.getByRole('dialog', { name: 'Ask Arwin' });

test('the launcher is on every page; Ask is no longer a navigation tab', async ({ page }) => {
  await page.goto('/today');
  await expect(launcher(page)).toBeVisible();
  await expect(launcher(page)).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(page.getByRole('button', { name: 'Hi. Need any help?' })).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Main' })
      .first()
      .getByRole('link', { name: 'Ask', exact: true }),
  ).toHaveCount(0);

  await page.goto('/deals');
  await expect(launcher(page)).toBeVisible();

  // The full page still works, and has no launcher over its own composer.
  await page.goto('/ask');
  await expect(page.getByRole('heading', { name: 'Ask Arwin' })).toBeVisible();
  await expect(launcher(page)).toHaveCount(0);
});

test('the greeting can be dismissed, and stays dismissed', async ({ page }) => {
  await page.goto('/today');
  const greeting = page.getByRole('button', { name: 'Hi. Need any help?' });
  await expect(greeting).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss greeting' }).click();
  await expect(greeting).toBeHidden();

  await page.reload();
  await expect(launcher(page)).toBeVisible();
  await expect(greeting).toHaveCount(0);
});

test('opens on history, starts a new conversation and shows the answer', async ({ page }) => {
  await page.goto('/today');
  await launcher(page).click();

  const dialog = panel(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Online')).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Open full page' })).toHaveAttribute(
    'href',
    '/ask',
  );
  const newConversation = dialog.getByRole('button', { name: 'New conversation' });
  await expect(newConversation).toBeFocused();

  await newConversation.click();
  const field = dialog.getByLabel('Your question');
  await expect(field).toBeFocused();
  await field.fill('What follow-ups are overdue?');
  await field.press('Enter');

  await expect(dialog.getByText('What follow-ups are overdue?')).toBeVisible();
  await expect(dialog.getByText('AI-generated').first()).toBeVisible({ timeout: 30_000 });
  // A screen reader is told the answer landed.
  await expect(dialog.locator('[data-ask-announcer]')).toContainText('Arwin answered');
  // Focus never fell out to the page while the question went.
  expect(
    await page.evaluate(() => Boolean(document.activeElement?.closest('[data-ask-panel]'))),
  ).toBe(true);
  // The full-page link now opens this conversation.
  await expect(dialog.getByRole('link', { name: 'Open full page' })).toHaveAttribute(
    'href',
    /^\/ask\?thread=/,
  );

  // Back to the history: the conversation is listed by its question, answered,
  // with the answer's first line and its start time under it.
  await dialog.getByRole('button', { name: 'All conversations' }).click();
  const rows = dialog.getByRole('list', { name: 'Past conversations' }).getByRole('button');
  const newest = rows.first();
  await expect(newest.locator('.font-semibold').first()).toHaveText('What follow-ups are overdue?');
  await expect(newest).toContainText(/Started \w{3} \d{1,2} at \d{1,2}:\d{2} [AP]M/);
  await expect(newest).toContainText('Answered');
  await expect(newest).toContainText('Arwin:');

  // And it opens again from there.
  await newest.click();
  await expect(dialog.getByText('What follow-ups are overdue?')).toBeVisible();

  // The full page takes over from the panel.
  await dialog.getByRole('link', { name: 'Open full page' }).click();
  await page.waitForURL(/\/ask\?thread=/);
  await expect(page.getByRole('heading', { name: 'Ask Arwin' })).toBeVisible();
  await expect(page.getByText('What follow-ups are overdue?').first()).toBeVisible();
});

test('the page is dimmed behind the panel, which is modal at every size', async ({ page }) => {
  await page.goto('/deals');
  await launcher(page).click();
  await expect(panel(page)).toBeVisible();
  const scrim = page.locator('[data-ask-scrim]');
  await expect(scrim).toBeVisible();
  expect(await scrim.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
    'rgba(0, 0, 0, 0)',
  );
  // A click on the dimmed page closes the panel, and does nothing else.
  await page.mouse.click(40, 300);
  await expect(panel(page)).toBeHidden();
  await expect(page).toHaveURL(/\/deals$/);
});

test('keys typed in the panel never reach the Inbox shortcuts underneath', async ({ page }) => {
  await page.goto('/inbox');
  const list = page.getByRole('region', { name: 'Conversations' });
  await expect(list.getByRole('listitem').first()).toBeVisible();
  // j opens the first conversation, like Gmail (once the page has hydrated).
  const pane = page.getByRole('region', { name: 'Reading pane' });
  const subject = pane.getByRole('heading', { level: 2 });
  await expect(async () => {
    await page.keyboard.press('j');
    await expect(subject).toBeVisible({ timeout: 1_000 });
  }).toPass();
  const opened = (await subject.textContent())?.trim() ?? '';

  await launcher(page).click();
  const dialog = panel(page);
  await dialog.getByRole('button', { name: 'New conversation' }).click();
  const field = dialog.getByLabel('Your question');
  await field.fill('Who is waiting on me?');
  // Sent with the button: it is disabled at once, and focus stays in the panel.
  await dialog.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(dialog.getByText('AI-generated').first()).toBeVisible({ timeout: 30_000 });
  expect(
    await page.evaluate(() => Boolean(document.activeElement?.closest('[data-ask-panel]'))),
  ).toBe(true);
  // "u" is back to the list, "j"/"k" move, "x" selects: none of them acts underneath.
  await page.keyboard.type('ujkx');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(subject).toHaveText(opened);
});

test('Ctrl+Enter in the panel asks; it never sends the email session reply', async ({ page }) => {
  let popups = 0;
  page.on('popup', () => popups++);
  await page.goto('/follow-ups/session');
  await expect(page.getByText(/Keys: Ctrl\+Enter send/)).toBeVisible();

  await launcher(page).click();
  const dialog = panel(page);
  await dialog.getByRole('button', { name: 'New conversation' }).click();
  const field = dialog.getByLabel('Your question');
  await field.fill('What did the founders ask last week?');
  await field.press('Control+Enter');
  await expect(dialog.getByText('AI-generated').first()).toBeVisible({ timeout: 30_000 });
  // The session's own Ctrl+Enter would open Gmail (the demo cannot send) or
  // complain that the reply is empty: neither happened.
  await expect(page.getByText('Write a reply first')).toHaveCount(0);
  expect(popups).toBe(0);
});

test('Esc closes it, focus stays inside while open and returns to the launcher', async ({
  page,
}) => {
  await page.goto('/today');
  await launcher(page).click();
  const dialog = panel(page);
  await expect(dialog).toBeVisible();

  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))),
    ).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(launcher(page)).toBeFocused();
});

test('"Ask about today" opens the widget with the question instead of leaving Today', async ({
  page,
}) => {
  await page.goto('/today');
  await page.getByRole('link', { name: 'Ask about today' }).click();

  const dialog = panel(page);
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/today$/);
  await expect(dialog.getByText('What actually needs my attention today?')).toBeVisible();
  await expect(dialog.getByText('AI-generated').first()).toBeVisible({ timeout: 30_000 });
});

test("a deal's Ask link opens a conversation scoped to that deal", async ({ page }) => {
  await page.goto('/deals/00000000-0000-4000-8000-000000000064');
  await expect(page.getByRole('heading', { name: 'Vetrix' })).toBeVisible();
  await page.getByRole('link', { name: 'Ask about this deal' }).click();

  const dialog = panel(page);
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/deals\/00000000-0000-4000-8000-000000000064$/);
  await expect(dialog.getByText('About Vetrix', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Your question')).toHaveAttribute(
    'placeholder',
    'Ask about Vetrix…',
  );
});

test('?ask= opens the widget on any page and leaves a clean URL', async ({ page }) => {
  await page.goto('/portfolio?ask=Which%20portfolio%20companies%20need%20help%3F');
  const dialog = panel(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Which portfolio companies need help?')).toBeVisible();
  await expect(page).toHaveURL(/\/portfolio$/);
});

test('the launcher steps aside for the inbox composer docked in the same corner', async ({
  page,
}) => {
  await page.goto('/inbox');
  await expect(launcher(page)).toBeVisible();
  await page.getByRole('button', { name: 'Compose' }).click();
  const composer = page.getByRole('dialog', { name: 'New email' });
  await expect(composer).toBeVisible();
  await expect(launcher(page)).toBeHidden();

  await composer.getByRole('button', { name: 'Close' }).click();
  await expect(composer).toBeHidden();
  await expect(launcher(page)).toBeVisible();
});

test('the panel respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/today');
  await launcher(page).click();
  const dialog = panel(page);
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});

test.describe('on a phone on its side', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true });

  test('the panel is the full-height sheet, with the composer whole', async ({ page }) => {
    await page.goto('/today');
    await launcher(page).click();
    const dialog = panel(page);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'New conversation' }).click();

    const sheet = await dialog.boundingBox();
    const ask = await dialog.getByRole('button', { name: 'Ask', exact: true }).boundingBox();
    const viewport = page.viewportSize();
    expect(sheet && ask && viewport).toBeTruthy();
    if (!sheet || !ask || !viewport) return;
    // Nearly the whole height, inside the screen.
    expect(sheet.height).toBeGreaterThan(viewport.height - 40);
    expect(sheet.y).toBeGreaterThanOrEqual(0);
    expect(sheet.y + sheet.height).toBeLessThanOrEqual(viewport.height);
    // The Ask button is inside the sheet, not cut off below it.
    expect(ask.y + ask.height).toBeLessThanOrEqual(sheet.y + sheet.height);
    await expect(dialog.getByLabel('Your question')).toBeVisible();
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 412, height: 839 }, hasTouch: true });

  test('the launcher sits above the bottom bar without covering it', async ({ page }) => {
    await page.goto('/today');
    const nav = page.getByRole('navigation', { name: 'Main' }).last();
    await expect(nav).toBeVisible();
    await expect(launcher(page)).toBeVisible();

    const bar = await nav.boundingBox();
    const button = await launcher(page).boundingBox();
    const viewport = page.viewportSize();
    expect(bar).not.toBeNull();
    expect(button).not.toBeNull();
    if (!bar || !button || !viewport) return;
    // Entirely above the bar, inside the screen, at the right edge.
    expect(button.y + button.height).toBeLessThanOrEqual(bar.y);
    expect(button.x + button.width).toBeLessThanOrEqual(viewport.width);
    expect(viewport.width - (button.x + button.width)).toBeLessThan(24);
    // Thumb-sized.
    expect(button.height).toBeGreaterThanOrEqual(44);

    // The bar's own links are still all tappable: none sits under the launcher.
    const greeting = await page.getByRole('button', { name: 'Hi. Need any help?' }).boundingBox();
    if (greeting) expect(greeting.y + greeting.height).toBeLessThanOrEqual(bar.y);

    // Opened, the panel fills the screen inside its edges and closes again.
    await launcher(page).click();
    const dialog = panel(page);
    await expect(dialog).toBeVisible();
    const sheet = await dialog.boundingBox();
    expect(sheet).not.toBeNull();
    if (sheet) {
      expect(sheet.x).toBeGreaterThanOrEqual(0);
      expect(sheet.y).toBeGreaterThanOrEqual(0);
      expect(sheet.x + sheet.width).toBeLessThanOrEqual(viewport.width);
      expect(sheet.y + sheet.height).toBeLessThanOrEqual(viewport.height);
    }
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();

    // Nothing scrolls sideways with the launcher and greeting on screen.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);
  });
});
