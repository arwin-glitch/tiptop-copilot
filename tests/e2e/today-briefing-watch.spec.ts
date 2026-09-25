import path from 'node:path';
import { expect, test, type Page, type Request, type Route } from '@playwright/test';

/**
 * An open Today tab keeps its briefing cards current by itself.
 *
 * The watcher polls a fingerprint every 15 seconds while the tab is visible
 * and refreshes the page only when the fingerprint changes. Both halves
 * matter: a tab that never refreshes shows yesterday's recap all afternoon,
 * and one that refreshes on a timer alone re-runs the calendar sync and the
 * outlook generation every 15 seconds for nothing.
 */

const VERSION_URL = '**/api/briefings/current';

// One demo sign-in for the whole file: demo entry is capped at 60 a minute
// across the suite, and the suite already runs close to that.
const SIGNED_IN = path.resolve('test-results', 'today-briefing-watch-state.json');

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

/** A router.refresh() of /today, as opposed to a prefetch or a document load. */
function isTodayRefresh(request: Request): boolean {
  const headers = request.headers();
  return (
    new URL(request.url()).pathname === '/today' &&
    headers['rsc'] === '1' &&
    !headers['next-router-prefetch']
  );
}

/** Open /today and return the version the watcher's first check saw. */
async function openToday(page: Page): Promise<string> {
  await page.clock.install();
  const firstCheck = page.waitForResponse(VERSION_URL);
  await page.goto('/today');
  await expect(page.getByRole('heading', { name: /Good day/ })).toBeVisible();
  const body = (await (await firstCheck).json()) as { version: string };
  return body.version;
}

test('refreshes the page when the briefing version changes', async ({ page }) => {
  await openToday(page);
  await page.route(VERSION_URL, (route) => route.fulfill({ json: { version: 'changed' } }));

  const refresh = page.waitForRequest(isTodayRefresh);
  await page.clock.runFor(16_000);
  await refresh;
});

test('leaves the page alone while the version is unchanged', async ({ page }) => {
  const rendered = await openToday(page);
  let checks = 0;
  await page.route(VERSION_URL, (route) => {
    checks++;
    return route.fulfill({ json: { version: rendered } });
  });
  const refreshes: Request[] = [];
  page.on('request', (request) => {
    if (isTodayRefresh(request)) refreshes.push(request);
  });

  await page.clock.runFor(16_000);
  await expect.poll(() => checks).toBeGreaterThan(0);
  // Give a mistaken refresh time to be issued before asserting there was none.
  await page.waitForTimeout(1_000);
  expect(refreshes).toHaveLength(0);
});

test('asks once per new version while that refresh is still pending', async ({ page }) => {
  await openToday(page);
  let checks = 0;
  await page.route(VERSION_URL, (route) => {
    checks++;
    return route.fulfill({ json: { version: 'changed' } });
  });
  // Hold every refresh, as a slow first render of the day would. The page
  // keeps the old version until one commits, so each tick sees a mismatch.
  const held: Route[] = [];
  await page.route(
    (url) => url.pathname === '/today',
    async (route) => {
      if (isTodayRefresh(route.request())) held.push(route);
      else await route.continue();
    },
  );

  // `checks` counts a request when it reaches the route, but the watcher only
  // clears its in-flight flag once the response is read, so a tick that lands
  // in between is skipped. Keep ticking until three checks have gone out.
  await expect
    .poll(async () => {
      await page.clock.runFor(15_000);
      return checks;
    })
    .toBeGreaterThanOrEqual(3);
  await page.waitForTimeout(1_000);
  expect(held).toHaveLength(1);
});

test('stops checking once the session is gone', async ({ page }) => {
  await openToday(page);
  let checks = 0;
  await page.route(VERSION_URL, (route) => {
    checks++;
    return route.fulfill({ status: 401, json: { ok: false } });
  });

  await page.clock.runFor(16_000);
  await expect.poll(() => checks).toBe(1);
  await page.clock.runFor(45_000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(1_000);
  expect(checks).toBe(1);
});

test('checks at once when the tab becomes visible again', async ({ page }) => {
  await openToday(page);
  await page.route(VERSION_URL, (route) => route.fulfill({ json: { version: 'changed' } }));

  const refresh = page.waitForRequest(isTodayRefresh, { timeout: 5_000 });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await refresh;
});
