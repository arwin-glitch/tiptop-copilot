import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Mobile layout and accessibility.
 *
 * This project runs on a Pixel 7 viewport. The things worth asserting are the
 * ones a desktop-only pass never catches: nothing scrolls sideways, the bottom
 * navigation is reachable by thumb and large enough to hit, and the page is
 * still navigable by keyboard and screen reader.
 */

// One demo sign-in for the whole file: demo entry is capped at 60 a minute
// across the suite, and a sign-in per test here tipped the suite over it.
const SIGNED_IN = resolve('test-results', 'responsive-state.json');

test.beforeAll(async ({ browser }, testInfo) => {
  // An explicit empty state, or this context would inherit the file's
  // `storageState` below and try to read the file it is about to write.
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

const PAGES = [
  '/today',
  '/inbox',
  '/deals',
  '/ask',
  '/updates',
  '/portfolio',
  '/fund-ii',
  '/network',
  '/meetings',
  '/knowledge',
  '/tasks',
  '/settings',
  // The Records pages' other subtabs, which hold the long lists and tables.
  '/updates?tab=fresh',
  '/portfolio?tab=companies',
  '/portfolio?tab=jobs',
  '/network?tab=students',
  '/network?tab=students&status=all',
  // A conversation opened by a link: the reading pane alone on a phone.
  '/inbox?thread=0f00000000005102',
  '/fund-ii?tab=pipeline',
  '/network?tab=people',
  '/meetings?tab=notes',
  '/knowledge?tab=contacts',
  '/knowledge?tab=lists',
  '/knowledge?tab=import',
  '/knowledge?tab=import&view=exit',
  // Affinity's data where it is used: tables and chip rows that must not
  // push the page sideways on a phone.
  '/deals?tab=pipeline',
  '/deals?tab=sourcing',
  '/fund-ii?tab=pipeline&source=affinity',
  '/fund-ii?tab=lists',
  '/portfolio?tab=founders',
  '/portfolio?tab=angel',
  '/network?tab=investors',
  '/network?tab=events',
  '/network?tab=people&source=affinity',
  '/meetings?tab=notes&source=affinity',
  // Campaigns: the list, a report, and the composer of the demo draft.
  '/fund-ii?tab=campaigns',
  '/fund-ii/campaigns/00000000-0000-4000-8000-0000000007d0',
  '/fund-ii/campaigns/00000000-0000-4000-8000-0000000007d1',
  // Follow-ups and the email session, whose full email is checked open below.
  '/follow-ups',
  '/follow-ups/session',
  // Diagnostics, and its feeds with their long schedule lines.
  '/diagnostics',
  '/diagnostics?tab=feeds',
];

/** No sideways scroll beyond a few pixels of rounding. */
async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

test.describe('mobile layout', () => {
  for (const path of PAGES) {
    test(`${path} never scrolls horizontally`, async ({ page }) => {
      await page.goto(path);
      // Wait for rendered content, not `networkidle` — this app streams RSC
      // payloads, so the network is never reliably idle and the wait flakes.
      await expect(page.locator('h1')).toBeVisible();

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      // A few pixels of rounding is fine; a sideways scrollbar is not.
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
    });
  }

  // The full email arrives after the page has drawn, so the check above ran
  // before it was there: open everything in it, then look again.
  test("the session's full email, opened all the way, never scrolls sideways", async ({ page }) => {
    await page.goto('/follow-ups/session');
    const email = page.getByRole('region', { name: /^Email: / });
    await expect(email).toBeVisible();
    await email.getByRole('button', { name: 'Show full email' }).click();
    await email.getByRole('button', { name: /^Show earlier messages/ }).click();
    // Every earlier message open too (each click turns one closed header open).
    const closed = email.locator('ol > li > button[aria-expanded="false"]');
    while ((await closed.count()) > 0) await closed.first().click();
    await email.getByRole('button', { name: 'Show quoted text' }).click();
    await expectNoSidewaysScroll(page);
  });

  test('a Follow-ups row with its email open never scrolls sideways', async ({ page }) => {
    await page.goto('/follow-ups');
    const priya = page
      .getByRole('region', { name: "You're waiting on" })
      .locator(':scope > ul > li')
      .filter({ hasText: 'Priya Natarajan' });
    await priya.getByRole('button', { name: /^Show email/ }).click();
    const email = priya.getByRole('region', { name: /^Email: / });
    await email.getByRole('button', { name: 'Show full email' }).click();
    await email.getByRole('button', { name: /^Show earlier messages/ }).click();
    await email.locator('ol > li > button[aria-expanded="false"]').first().click();
    await expectNoSidewaysScroll(page);
  });

  test('a Jobs role with its source emails open never scrolls sideways', async ({ page }) => {
    await page.goto('/portfolio?tab=jobs&status=all');
    const jobs = page.getByRole('region', { name: 'Open roles at portfolio companies' });
    for (const summary of await jobs.locator('details > summary').all()) await summary.click();
    await expect(jobs.getByRole('list', { name: /^Source emails for VP Sales/ })).toBeVisible();
    await expectNoSidewaysScroll(page);
  });

  test('a Students item with its earlier emails open never scrolls sideways', async ({ page }) => {
    await page.goto('/network?tab=students&status=all');
    const students = page.getByRole('region', { name: 'Students and interns' });
    for (const summary of await students.locator('details > summary').all()) await summary.click();
    await expect(
      students.getByRole('list', { name: 'Earlier emails about Tessa Marlow' }),
    ).toBeVisible();
    // The two links stay thumb-sized beside each subject.
    const copilot = students.getByRole('link', { name: /^Open in Copilot/ }).first();
    expect((await copilot.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(32);
    await expectNoSidewaysScroll(page);
  });

  test('a conversation opened by a link fills the phone, and Back shows the list', async ({
    page,
  }) => {
    await page.goto('/inbox?thread=0f00000000005102');
    const pane = page.getByRole('region', { name: 'Reading pane' });
    const list = page.getByRole('region', { name: 'Conversations' });
    await expect(pane.getByRole('heading', { level: 2 })).toHaveText('Mentoring this fall');
    // One column on a phone: the list waits behind the conversation.
    await expect(list).toBeHidden();
    await expectNoSidewaysScroll(page);
    await pane.getByRole('button', { name: 'Back to the list' }).click();
    await expect(list).toBeVisible();
    await expect.poll(() => new URL(page.url()).search).toBe('');
  });

  test('the bottom navigation is present and thumb-sized', async ({ page }) => {
    await page.goto('/today');
    const nav = page.getByRole('navigation', { name: 'Main' }).last();
    await expect(nav).toBeVisible();

    // Every destination is in the bar; the bar scrolls sideways when they
    // do not all fit, so each is reached by scrolling it into view. Ask is
    // not one: it is the Ask Arwin launcher above the bar (ask-widget.spec).
    for (const label of [
      'Today',
      'Follow-ups',
      'Tasks',
      'Deals',
      'Inbox',
      'Portfolio',
      'Fund II',
      'Meetings',
      'Network',
      'Reports',
      'Knowledge',
      'Settings',
      'Help',
    ]) {
      const link = nav.getByRole('link', { name: label, exact: true });
      await link.scrollIntoViewIfNeeded();
      await expect(link).toBeInViewport({ ratio: 0.9 });
      const box = await link.boundingBox();
      // Comfortably above the 44px minimum touch target.
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test('the bottom navigation opens scrolled to the current page', async ({ page }) => {
    await page.goto('/tasks');
    const nav = page.getByRole('navigation', { name: 'Main' }).last();
    await expect(nav.getByRole('link', { name: 'Tasks' })).toBeInViewport({ ratio: 0.9 });
  });

  test('the bottom navigation stays fixed while the page scrolls', async ({ page }) => {
    await page.goto('/today');
    const nav = page.getByRole('navigation', { name: 'Main' }).last();
    const before = await nav.boundingBox();

    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(300);

    const after = await nav.boundingBox();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(4);
  });

  test('navigation actually navigates on a touch viewport', async ({ page }) => {
    await page.goto('/today');
    const nav = page.getByRole('navigation', { name: 'Main' }).last();
    await nav.getByRole('link', { name: 'Deals' }).click();
    await page.waitForURL(/\/deals/);
    await expect(page.getByRole('heading', { name: 'Deals' })).toBeVisible();
  });

  test("a page's subtabs stay in reach under the header while it scrolls", async ({ page }) => {
    // The reports are the longest tab in the demo workspace.
    await page.goto('/updates');
    const tabs = page.getByRole('navigation', { name: 'Reports sections' });
    await expect(tabs).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Weekly digest ·/ })).toBeVisible();
    // Every tab is a full touch target.
    for (const link of await tabs.getByRole('link').all()) {
      expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);

    // Stuck directly below the mobile header, not behind it.
    const header = await page.locator('header').first().boundingBox();
    const bar = await tabs.boundingBox();
    expect(bar).not.toBeNull();
    expect(Math.abs((bar?.y ?? 0) - ((header?.y ?? 0) + (header?.height ?? 0)))).toBeLessThan(2);
    await expect(tabs.getByRole('link', { name: /^Fresh updates/ })).toBeInViewport();
  });

  test('the deal detail page is readable on a narrow screen', async ({ page }) => {
    await page.goto('/deals/00000000-0000-4000-8000-000000000064');
    await expect(page.getByRole('heading', { name: 'Vetrix' })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);
  });

  test('the ask composer stays reachable above the bottom bar', async ({ page }) => {
    await page.goto('/ask');
    const field = page.getByLabel('Your question');
    await expect(field).toBeVisible();

    // Measured from the top of the page, not the viewport. Once it hydrates the
    // page scrolls smoothly to the end of the conversation, so a viewport
    // reading depends on how far that scroll has got: on CI it had not
    // started, and with fifteen conversations listed above it the field was a
    // screen below the fold, while the same check passed on a faster machine.
    const bottom = await field.evaluate((el) => el.getBoundingClientRect().bottom + window.scrollY);
    const viewport = page.viewportSize();
    // The field must be on the first screen, not underneath the nav bar.
    expect(bottom).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);

    // However many conversations there are, the Recent list is below the
    // composer, so it can never push it off the screen.
    const recentTop = await page
      .getByRole('heading', { name: 'Recent', exact: true })
      .evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    expect(recentTop).toBeGreaterThan(bottom);
  });
});

test.describe('accessibility', () => {
  test('every page has exactly one h1 and a main landmark', async ({ page }) => {
    for (const path of PAGES) {
      await page.goto(path);
      await expect(page.locator('main')).toHaveCount(1);
      await expect(page.locator('h1'), `${path} needs one h1`).toHaveCount(1);
    }
  });

  test('the skip link is the first thing keyboard focus reaches', async ({ page }) => {
    await page.goto('/today');
    await page.keyboard.press('Tab');

    const focused = page.locator(':focus');
    await expect(focused).toHaveText('Skip to content');
    await expect(focused).toHaveAttribute('href', '#main');
  });

  test('the demo banner is announced as a status region', async ({ page }) => {
    await page.goto('/today');
    await expect(page.getByRole('status').first()).toContainText('Demo mode');
  });

  test('navigation marks the current page for assistive technology', async ({ page }) => {
    await page.goto('/inbox');
    // The sidebar also marks it, but is display:none at this width — assert on
    // the bottom bar, which is the navigation actually presented here.
    const current = page
      .getByRole('navigation', { name: 'Main' })
      .last()
      .locator('[aria-current="page"]');
    await expect(current).toBeVisible();
    await expect(current).toContainText('Inbox');
  });

  test('every image and icon-only control carries an accessible name', async ({ page }) => {
    for (const path of ['/today', '/deals', '/settings']) {
      await page.goto(path);

      const unnamedImages = await page.locator('img:not([alt])').count();
      expect(unnamedImages, `${path} has an image with no alt`).toBe(0);

      const unnamed = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, a[href]'))
          .filter((el) => {
            // textContent, not innerText: a control inside a collapsed
            // <details> is still a control, and still needs a name.
            const label =
              el.getAttribute('aria-label') ??
              el.getAttribute('title') ??
              (el.textContent ?? '').trim();
            return !label;
          })
          .map((el) => el.outerHTML.slice(0, 120)),
      );
      expect(unnamed, `${path} has an unlabelled control`).toEqual([]);
    }
  });

  test('form controls are labelled', async ({ page }) => {
    await page.goto('/inbox');
    const unlabelled = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input:not([type=hidden]), select, textarea'))
        .filter((el) => {
          const id = el.getAttribute('id');
          const hasLabelFor = id ? document.querySelector(`label[for="${id}"]`) : null;
          return (
            !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !hasLabelFor
          );
        })
        .map((el) => el.outerHTML.slice(0, 120)),
    );
    expect(unlabelled).toEqual([]);
  });

  test('the theme toggle is an operable radio group', async ({ page }) => {
    await page.goto('/today');
    const group = page.getByRole('radiogroup', { name: 'Colour theme' }).first();
    await expect(group).toBeVisible();

    await group.getByRole('radio', { name: 'Dark' }).click();
    await expect(group.getByRole('radio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('the page is usable with the keyboard alone', async ({ page }) => {
    await page.goto('/deals');
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');

    // Focus is somewhere real, and it is visible.
    const tag = await page.evaluate(() => document.activeElement?.tagName ?? null);
    expect(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']).toContain(tag);
  });
});
