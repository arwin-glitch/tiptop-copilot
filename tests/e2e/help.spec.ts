import { resolve } from 'node:path';
import { devices, expect, test, type Page } from '@playwright/test';

/**
 * Help and the guided tours.
 *
 * /help shows a card per page (a sketch, numbered pins, its tabs, "Show me"
 * and "Open"); "Show me", a page's "?" or `?tour=<page>` starts a tour that
 * spotlights real elements one at a time. What is asserted is what a unit
 * test cannot see: the tour finds the elements on the real pages, moves
 * between pages, takes the keyboard, skips what is not on screen, ends on
 * Esc, and never stops the page from working.
 */

// One demo sign-in for the file: demo entry is rate-limited across the suite.
const SIGNED_IN = resolve('test-results', 'help-state.json');

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

const card = (page: Page) => page.locator('[data-tour-card]');
const next = (page: Page) => card(page).getByRole('button', { name: /^(Next|Done)$/ });

/** The card's "Today · 2 of 5" line, read as text. */
async function expectStep(page: Page, label: RegExp, title: string) {
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText(label);
  await expect(card(page).getByRole('heading', { name: title })).toBeVisible();
}

const PAGES = [
  'Today',
  'Follow-ups',
  'Tasks',
  'Deals',
  'Inbox',
  'Calendar',
  'Events',
  'Portfolio',
  'Fund II',
  'Meetings',
  'Network',
  'Reports',
  'Knowledge',
  'Settings',
  'Download',
  'Ask Arwin',
];

test.describe('help page', () => {
  test('Help sits in the System group and shows a card for every page', async ({ page }) => {
    await page.goto('/today');
    const nav = page.getByRole('navigation', { name: 'Main' }).first();
    const system = nav.getByRole('list', { name: 'System' });
    await system.getByRole('link', { name: 'Help', exact: true }).click();
    await page.waitForURL(/\/help$/);
    await expect(page.getByRole('heading', { level: 1, name: 'How Copilot works' })).toBeVisible();
    await expect(system.getByRole('link', { name: 'Help', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );

    const main = page.getByRole('main');
    for (const name of PAGES) {
      const entry = main.getByRole('group', { name, exact: true });
      await expect(entry, name).toBeVisible();
      await expect(entry.getByRole('link', { name: `Show me ${name}` })).toBeVisible();
      await expect(entry.getByRole('link', { name: `Open ${name}` })).toBeVisible();
      // The where-to-click legend matches the numbered pins in the sketch.
      expect(
        await entry.getByRole('list', { name: 'Where to click' }).locator('li').count(),
      ).toBeGreaterThanOrEqual(3);
    }
    await expect(main.getByRole('group')).toHaveCount(PAGES.length);

    // Records pages carry their subtab bar's own labels, linked to the tab.
    const portfolio = main.getByRole('group', { name: 'Portfolio', exact: true });
    await expect(portfolio.getByRole('link', { name: 'Numbers', exact: true })).toHaveAttribute(
      'href',
      '/portfolio?tab=numbers',
    );
    await expect(main.getByRole('link', { name: 'Take the 2-minute tour' })).toHaveAttribute(
      'href',
      '/today?tour=all',
    );
  });

  test('Settings links to Help', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Help & tours' })).toBeVisible();
    await page.getByRole('link', { name: 'Open Help' }).click();
    await page.waitForURL(/\/help$/);
  });
});

test.describe('guided tours', () => {
  test('Show me opens Today and steps through its tour', async ({ page }) => {
    await page.goto('/help');
    await page.getByRole('link', { name: 'Show me Today' }).click();
    await page.waitForURL(/\/today$/);

    await expectStep(page, /Today · 1 of 6/i, 'Start here each day');
    // The cut-out sits on the sidebar entry, and focus is in the card.
    await expect(page.locator('[data-tour-spotlight]')).toBeVisible();
    await expect(next(page)).toBeFocused();
    await expect(card(page)).toHaveAttribute('role', 'dialog');

    // Top priorities first, then the glance cards under it, as on the page.
    await next(page).click();
    await expectStep(page, /2 of 6/, 'Your top priorities');
    await expect(next(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expectStep(page, /3 of 6/, 'Your day at a glance');
    await next(page).click();
    await expectStep(page, /4 of 6/, 'Tick it off');
    await card(page).getByRole('button', { name: 'Back' }).click();
    await expectStep(page, /3 of 6/, 'Your day at a glance');
    await next(page).click();
    await next(page).click();
    await expectStep(page, /5 of 6/, 'Quick actions');
    await next(page).click();
    await expectStep(page, /6 of 6/, 'Everything else, folded');
    await expect(next(page)).toHaveText('Done');
    await next(page).click();

    await expect(card(page)).toHaveCount(0);
    await expect(page.locator('[data-tour-spotlight]')).toHaveCount(0);
    // Finished means finished: a reload does not bring it back.
    await page.reload();
    await expect(page.locator('h1')).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });

  test('Esc ends a tour at any step', async ({ page }) => {
    await page.goto('/tasks?tour=tasks');
    await expectStep(page, /Tasks · 1 of 6/i, 'Your to-do list');
    // The parameter is dropped, so a reload does not restart the tour.
    await expect(page).toHaveURL(/\/tasks$/);
    await next(page).click();
    await expectStep(page, /2 of 6/, 'Open, snoozed, done');
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
    await page.reload();
    await expect(page.locator('h1')).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });

  test('a tour survives a reload in the middle', async ({ page }) => {
    await page.goto('/calendar?tour=calendar');
    await expectStep(page, /Calendar · 1 of 5/i, 'Your calendar, live');
    await next(page).click();
    await expectStep(page, /2 of 5/, 'Day, week or month');
    await page.reload();
    await expectStep(page, /2 of 5/, 'Day, week or month');
    await card(page).getByRole('button', { name: 'End tour' }).click();
    await expect(card(page)).toHaveCount(0);
  });

  test("the page's ? button starts that page's tour", async ({ page }) => {
    await page.goto('/deals');
    await page.getByRole('button', { name: 'Tour this page' }).click();
    await expectStep(page, /Deals · 1 of 6/i, 'Every pitch, one place');
    await page.keyboard.press('Escape');
    // Pages without a tour (a deal, a list) have no button.
    await page.goto('/help');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tour this page' })).toHaveCount(0);
  });

  test('the 2-minute tour moves from page to page', async ({ page }) => {
    await page.goto('/help');
    await page.getByRole('link', { name: 'Take the 2-minute tour' }).click();
    await page.waitForURL(/\/today$/);
    await expectStep(page, /1 of 18/, 'Every page, one menu');
    await next(page).click();
    await expectStep(page, /Today · 2 of 18/i, 'Your top priorities');
    await next(page).click();
    await page.waitForURL(/\/follow-ups$/);
    await expectStep(page, /Follow-ups · 3 of 18/i, 'Clear email, one by one');
    await card(page).getByRole('button', { name: 'Back' }).click();
    await page.waitForURL(/\/today$/);
    await expectStep(page, /Today · 2 of 18/i, 'Your top priorities');
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
  });

  test('the page keeps working under a tour, and leaving ends it', async ({ page }) => {
    await page.goto('/today?tour=today');
    await expectStep(page, /1 of 6/, 'Start here each day');
    // The dimming lets the click through to the real navigation.
    await page
      .getByRole('navigation', { name: 'Main' })
      .first()
      .getByRole('link', { name: 'Deals', exact: true })
      .click();
    await page.waitForURL(/\/deals$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Deals' })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });

  test('the Ask Arwin tour runs on the page that is open', async ({ page }) => {
    await page.goto('/help');
    await page.getByRole('link', { name: 'Show me Ask Arwin' }).click();
    await expectStep(page, /Ask Arwin · 1 of 5/i, 'Ask Arwin anything');
    await expect(page).toHaveURL(/\/help$/);
    // The launcher stays on screen for its own tour.
    await expect(page.getByRole('button', { name: 'Ask Arwin (AI)', exact: true })).toBeVisible();
    await next(page).click();
    await expectStep(page, /2 of 5/, 'A quick hello');
    // "Ask about today" is only on Today: skipped here.
    await next(page).click();
    await expectStep(page, /4 of 5/, 'Gold dot means news');
    await next(page).click();
    await expectStep(page, /5 of 5/, 'Feedback on the app');
    await next(page).click();
    await expect(card(page)).toHaveCount(0);
  });
});

test.describe('tours and the other overlays', () => {
  test('the tour waits while the Ask Arwin panel is open, and comes back after', async ({
    page,
  }) => {
    await page.goto('/help');
    await page.getByRole('link', { name: 'Show me Ask Arwin' }).click();
    await expectStep(page, /Ask Arwin · 1 of 5/i, 'Ask Arwin anything');

    // Doing what the step says: tap the green button.
    await page.getByRole('button', { name: 'Ask Arwin (AI)', exact: true }).click();
    // Exact: the tour card's own name, "Ask Arwin anything", starts the same.
    const chat = page.getByRole('dialog', { name: 'Ask Arwin (AI)', exact: true });
    await expect(chat).toBeVisible();
    // No card or scrim over the chat, which is usable as it is.
    await expect(card(page)).toHaveCount(0);
    await expect(page.locator('[data-tour-spotlight]')).toHaveCount(0);
    await expect(chat.getByRole('button', { name: 'New conversation' })).toBeFocused();

    // Esc is the chat's: it closes the chat, and the tour is back at its step.
    await page.keyboard.press('Escape');
    await expect(chat).toBeHidden();
    await expectStep(page, /Ask Arwin · 1 of 5/i, 'Ask Arwin anything');
    // Opening the chat dismissed the greeting, and "Ask about today" is only
    // on Today: both skipped.
    await next(page).click();
    await expectStep(page, /4 of 5/, 'Gold dot means news');
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
  });

  test("Enter on the tour card moves the tour, never the Inbox's own keys", async ({ page }) => {
    await page.goto('/inbox?tour=inbox');
    await expect(card(page)).toBeVisible();
    await expect(next(page)).toBeFocused();
    const step = (await card(page).getByRole('heading').textContent())?.trim() ?? '';

    // Enter (or o) on the Inbox opens the first conversation and marks it read.
    await page.keyboard.press('Enter');
    await expect(card(page).getByRole('heading')).not.toHaveText(step);
    await page.keyboard.press('j');
    await expect(
      page
        .getByRole('region', { name: 'Reading pane' })
        .getByText('Pick a conversation to read it here.'),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
  });
});

// The Pixel 7 profile without its browser choice, which a describe cannot set.
const { defaultBrowserType: _browser, ...pixel7 } = devices['Pixel 7'];

test.describe('on a phone', () => {
  test.use(pixel7);

  test('the card docks full width and the tour skips what a phone hides', async ({ page }) => {
    await page.goto('/inbox?tour=inbox');
    await expectStep(page, /Inbox · 1 of 6/i, 'Your Gmail, live');

    // Spotlit: the bottom bar's Inbox entry, the one on screen at this width.
    const spot = await page.locator('[data-tour-spotlight]').boundingBox();
    const bar = await page.getByRole('navigation', { name: 'Main' }).last().boundingBox();
    expect(spot && bar && spot.y + spot.height > bar.y).toBe(true);

    // Docked inside the screen, edge to edge less the gutter.
    const box = await card(page).boundingBox();
    const width = page.viewportSize()?.width ?? 0;
    expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true);
    expect((box?.width ?? 0) / width).toBeGreaterThan(0.85);

    await next(page).click();
    await expectStep(page, /2 of 6/, 'Mail folders');
    await next(page).click();
    await expectStep(page, /3 of 6/, 'Search all mail');
    await next(page).click();
    await expectStep(page, /4 of 6/, 'Conversations');
    // The reading pane is hidden until a thread is open on a phone.
    await next(page).click();
    await expectStep(page, /6 of 6/, 'Write a new email');
    await next(page).click();
    await expect(card(page)).toHaveCount(0);
  });

  test('Help fits a phone without scrolling sideways', async ({ page }) => {
    await page.goto('/help');
    await expect(page.getByRole('heading', { level: 1, name: 'How Copilot works' })).toBeVisible();
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
    // Help is in the bottom bar too.
    const nav = page.getByRole('navigation', { name: 'Main' }).last();
    await expect(nav.getByRole('link', { name: 'Help', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

test.describe('with reduced motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('the tour still runs, without animation', async ({ page }) => {
    await page.goto('/network?tour=network');
    await expectStep(page, /Network · 1 of 3/i, 'Your network');
    const transition = await page
      .locator('[data-tour-spotlight]')
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    // Computed in seconds; the app's reduced-motion rule collapses every
    // transition to a hundredth of a millisecond.
    expect(transition.split(',').every((d) => parseFloat(d) < 0.002)).toBe(true);
    await next(page).click();
    await expectStep(page, /2 of 3/, 'Switch sections');
    await expect(card(page)).toContainText(
      'Intros, Going cold, Keep in touch, Students & interns, People, Investors, Service providers, Operators, Event lists',
    );
  });
});
