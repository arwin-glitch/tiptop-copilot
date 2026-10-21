import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The feed watchdog over the invented demo workspace: Diagnostics opens on
 * its setup report as before, Feeds is one click away and lists every feed
 * worst first in plain words (the demo's task closer has missed three days,
 * its deal sorter a run), feed notices are off until the person turns them on
 * for their own computers, and then a computer of theirs gets one notice for
 * the stopped feed (8am to 8pm Central only, the demo owner's timezone).
 */

const SIGNED_IN = path.resolve('test-results', 'feed-watchdog-state.json');
const EMPTY = { cookies: [], origins: [] };
const DEVICE = 'feed0000feed0000feed0000feed0000';

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: EMPTY,
  });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);
  await context.storageState({ path: SIGNED_IN });
  await context.close();
});

test.use({ storageState: SIGNED_IN });

/** The hour in Chicago now, which is when the server decides notices may go out. */
function chicagoHour(): number {
  return (
    Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        hour: 'numeric',
        hourCycle: 'h23',
      }).format(new Date()),
    ) % 24
  );
}

test('Diagnostics keeps its setup report and puts the feeds one click away', async ({ page }) => {
  await page.goto('/diagnostics');
  const bar = page.getByRole('navigation', { name: 'Diagnostics sections' });
  await expect(bar.getByRole('link', { name: 'Setup' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Configuration' })).toBeVisible();

  await bar.getByRole('link', { name: 'Feeds' }).click();
  await page.waitForURL(/\/diagnostics\?tab=feeds$/);
  await expect(bar.getByRole('link', { name: 'Feeds' })).toHaveAttribute('aria-current', 'page');
  // Only the open tab renders.
  await expect(page.getByRole('heading', { name: 'Configuration' })).toHaveCount(0);

  await expect(page.getByText('1 feed looks stopped and 1 is late.')).toBeVisible();
  const feeds = page.getByRole('list', { name: 'Feeds' });
  const rows = feeds.locator('li');
  // Worst first: the stopped feed, then the late one.
  await expect(rows.first()).toHaveAttribute('data-feed', 'task-closer');
  await expect(rows.first()).toContainText('Looks stopped');
  await expect(rows.first()).toContainText('at least two runs look missed');
  await expect(rows.first()).toContainText('Every day at 3pm Central');
  await expect(rows.nth(1)).toHaveAttribute('data-feed', 'deal-sorter');
  await expect(rows.nth(1)).toContainText('Late');
  await expect(feeds.locator('li[data-feed="relationships"]')).toContainText('Running');
  await expect(feeds.locator('li[data-feed="portfolio-adds"]')).toContainText(
    'normal when there was nothing new',
  );

  // Back returns to the setup report.
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Configuration' })).toBeVisible();
});

test('feed notices are off until turned on, then reach this person’s computer only', async ({
  page,
  playwright,
  baseURL,
}) => {
  await page.goto('/diagnostics?tab=feeds');
  await expect(page.getByText('Feed notices are off.')).toBeVisible();
  await page.getByRole('button', { name: 'Turn on feed notices' }).click();
  await expect(page.getByText('Feed notices are on.')).toBeVisible();
  // Saved, not just shown.
  await page.reload();
  await expect(page.getByText('Feed notices are on.')).toBeVisible();

  // A computer of theirs with desktop alerts on, as the desktop app's
  // Settings turns it on (from the page, with its session).
  const turnOn = await page.evaluate(async (device) => {
    const res = await fetch('/api/push/desktop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device, platform: 'windows', version: '0.4.1' }),
    });
    return { status: res.status, body: (await res.json()) as { token?: string } };
  }, DEVICE);
  expect(turnOn.status).toBe(200);
  const token = turnOn.body.token ?? '';

  // The shell's own ask: no session, just the token.
  const shell = await playwright.request.newContext({ baseURL, storageState: EMPTY });
  const asked = await shell.get('/api/desktop/alerts', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(asked.status()).toBe(200);
  const body = (await asked.json()) as {
    alerts: { keys: string[]; title: string; url: string }[];
  };
  const feed = body.alerts.filter((a) => a.keys.some((k) => k.startsWith('feed:')));
  const hour = chicagoHour();
  if (hour >= 8 && hour < 20) {
    expect(feed).toHaveLength(1);
    expect(feed[0]?.title).toBe('A feed looks stopped');
    expect(feed[0]?.url).toBe('/diagnostics?tab=feeds');
    expect(feed[0]?.keys[0]).toMatch(/^feed:task-closer:\d{4}-\d{2}-\d{2}$/);
  } else {
    // Quiet hours: nothing until 8am.
    expect(feed).toEqual([]);
  }
  await shell.dispose();

  // Leave the demo as it was for the rest of the suite.
  const off = await page.evaluate(async (device) => {
    const res = await fetch('/api/push/desktop', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device }),
    });
    return res.status;
  }, DEVICE);
  expect(off).toBe(200);
  await page.getByRole('button', { name: 'Turn off feed notices' }).click();
  await expect(page.getByText('Feed notices are off.')).toBeVisible();
});

test('cards whose feeds are on time say nothing about being out of date', async ({ page }) => {
  await page.goto('/follow-ups');
  await expect(page.getByText('Waiting on you', { exact: true })).toBeVisible();
  await expect(page.getByText(/Checked /).first()).toBeVisible();
  await expect(page.getByText('may be out of date')).toHaveCount(0);
});
