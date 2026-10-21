import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Server-rendered text must not depend on the clock zone of the machine that
 * rendered it. Render runs in UTC and a reader's browser in their own zone, so
 * a time printed in "the local zone" reads differently on each side: React
 * then throws the server's page away with a text mismatch (minified error
 * #418) and draws it again in the browser. Times belong in the profile's
 * timezone on both sides.
 *
 * The web server runs with this runner's environment, so its zone is the
 * runner's own. The browser goes to two zones far from it, UTC+14 and UTC-11:
 * at any hour one of them is on a different calendar day from the server, so
 * a "today" or a date read from either machine's own clock cannot slip past.
 */

const SERVER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const BROWSER_ZONES = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'].filter((z) => z !== SERVER_ZONE);

// Each page and a marker inside its streamed content, so the check waits for
// the part of the page that the server rendered late and React hydrated last.
const PAGES = [
  { path: '/today', marker: '[data-tour="today-sections"]' },
  { path: '/tasks', marker: '[data-tour="tasks-list"]' },
  { path: '/follow-ups', marker: '[data-tour="followups-session"]' },
  { path: '/calendar', marker: '[data-tour="calendar-days"]' },
  // The new views, by address (the switch is not touched, so nothing is remembered).
  { path: '/calendar?view=week', marker: '[data-calendar-view="week"]' },
  { path: '/calendar?view=month', marker: '[data-calendar-view="month"]' },
  { path: '/inbox', marker: '[data-tour="inbox-list"]' },
  // A sent campaign's report and receipt, and a draft in the composer.
  {
    path: '/fund-ii/campaigns/00000000-0000-4000-8000-0000000007d0',
    marker: 'section[aria-labelledby="report-people"]',
  },
  {
    path: '/fund-ii/campaigns/00000000-0000-4000-8000-0000000007d1',
    marker: 'nav[aria-label="Campaign steps"]',
  },
  // Pages added or reworked since, that print times or dates as well.
  { path: '/follow-ups/session', marker: '[aria-label="Time you have"]' },
  { path: '/fund-ii', marker: '[data-tour="fund-readers"]' },
  { path: '/portfolio?tab=numbers', marker: '[data-numbers-updated]' },
  { path: '/deals', marker: '[data-tour="deals-pipeline"]' },
  { path: '/updates', marker: '[data-tour="reports-latest"]' },
];

const HYDRATION = /#418|#423|#425|hydrat|didn't match/i;

// One demo sign-in for the whole file: demo entry is capped at 60 a minute
// across the suite.
const SIGNED_IN = path.resolve('test-results', 'hydration-timezone-state.json');

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

for (const timezoneId of BROWSER_ZONES) {
  test.describe(`browser in ${timezoneId}, server in ${SERVER_ZONE}`, () => {
    test.use({ timezoneId });

    test('the main pages hydrate without a text mismatch', async ({ page }) => {
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(
        timezoneId,
      );
      const errors: string[] = [];
      page.on('pageerror', (e) => {
        if (HYDRATION.test(e.message)) errors.push(`${page.url()}: ${e.message}`);
      });
      page.on('console', (m) => {
        if (m.type() === 'error' && HYDRATION.test(m.text())) {
          errors.push(`${page.url()}: ${m.text()}`);
        }
      });

      for (const { path: route, marker } of PAGES) {
        await page.goto(route);
        // Hydrated means React has attached to the marker; a mismatch is
        // reported before that, while React is still reconciling the HTML.
        await expect
          .poll(() =>
            page
              .locator(marker)
              .first()
              .evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactFiber$')))
              .catch(() => false),
          )
          .toBe(true);
      }

      expect(errors).toEqual([]);
    });
  });
}
