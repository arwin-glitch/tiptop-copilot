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
 *
 * Time is Playwright's fake clock, and every step waits for the watcher to be
 * done with its last check before the next one (`settled`). Two things go
 * wrong otherwise, both artefacts of the test rather than the watcher: a tick
 * or a visibility change that lands while a check is still being read is
 * skipped, by design; and the fake clock also runs `AbortSignal.timeout`, so
 * jumping 15 seconds while a check is in flight aborts it at its 10-second
 * limit, which the watcher counts as a failed check and backs off for (2, 4,
 * 8… ticks), going quiet for the rest of the test. Real time cannot pass 15
 * seconds during a request that takes milliseconds.
 */

const VERSION_URL = '**/api/briefings/current';
const VERSION_PATH = '/api/briefings/current';

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

/**
 * An init script: counts the page's version checks, started and settled. A
 * check settles when the watcher has read its answer (or got none); the
 * watcher's own handling of it runs in the same microtask checkpoint, so a
 * later `evaluate` that sees it settled sees the watcher idle again. It only
 * watches: every call still goes to the real `fetch`, with its own signal.
 */
function countVersionChecks(versionPath: string) {
  const checks = { started: 0, settled: 0 };
  (window as unknown as { __versionChecks: typeof checks }).__versionChecks = checks;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url, window.location.href).pathname !== versionPath) return realFetch(input, init);
    checks.started++;
    let response: Response;
    try {
      response = await realFetch(input, init);
    } catch (error) {
      checks.settled++;
      throw error;
    }
    if (!response.ok) {
      checks.settled++;
      return response;
    }
    const read = response.json.bind(response);
    response.json = () =>
      read().finally(() => {
        checks.settled++;
      });
    return response;
  };
}

/** Waits until the page has started `count` version checks and the watcher is done with all of them. */
async function settled(page: Page, count: number) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { started, settled } = (
          window as unknown as { __versionChecks: { started: number; settled: number } }
        ).__versionChecks;
        return { started, settled };
      }),
    )
    .toEqual({ started: count, settled: count });
}

/** Open /today and return the version the watcher's first check saw, once it is done with it. */
async function openToday(page: Page): Promise<string> {
  await page.addInitScript(countVersionChecks, VERSION_PATH);
  await page.clock.install();
  const firstCheck = page.waitForResponse(VERSION_URL);
  await page.goto('/today');
  await expect(page.getByRole('heading', { name: /Good day/ })).toBeVisible();
  const body = (await (await firstCheck).json()) as { version: string };
  await settled(page, 1);
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
  await settled(page, 2);
  expect(checks).toBe(1);
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

  // Three ticks, each one check, each seeing the new version.
  for (let tick = 1; tick <= 3; tick++) {
    await page.clock.runFor(15_000);
    await settled(page, 1 + tick);
  }
  expect(checks).toBe(3);
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
  await settled(page, 2);
  expect(checks).toBe(1);
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
