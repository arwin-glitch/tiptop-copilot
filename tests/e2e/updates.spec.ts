import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The Updates tab over the invented demo workspace: every long body starts
 * collapsed, a channel the bot cannot read says exactly how to fix it, and a
 * link with an unsafe scheme is inert text.
 */

// One demo sign-in for the whole file: demo entry is capped at 60 a minute
// across the suite, and the suite already runs close to that.
const SIGNED_IN = path.resolve('test-results', 'updates-state.json');

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

const h1 = (page: import('@playwright/test').Page) =>
  page.getByRole('heading', { level: 1, name: 'Updates', exact: true });

test('the Updates tab is in the main navigation', async ({ page }) => {
  await page.goto('/today');
  const nav = page.getByRole('navigation', { name: 'Main' }).first();
  await nav.getByRole('link', { name: 'Updates' }).click();
  await page.waitForURL(/\/updates/);
  await expect(h1(page)).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Updates' })).toHaveAttribute('aria-current', 'page');
});

test('the latest view shows each source and nothing it should hide', async ({ page }) => {
  await page.goto('/updates');
  for (const name of [/^Harbor Angels ·/, /^Pitchline ·/, /^Scout Desk ·/, /^Weekly digest ·/]) {
    await expect(page.getByRole('heading', { name })).toBeVisible();
  }
  // textContent, not innerText: it includes what sits inside closed <details>.
  for (const url of ['/updates', '/updates?view=dealflow', '/updates?view=digests']) {
    await page.goto(url);
    await expect(
      page.getByRole('region', { name: 'Sources' }).getByText('Live').first(),
    ).toBeVisible();
    const text = (await page.locator('main').textContent()) ?? '';
    expect(text).not.toContain('Ledger:');
    expect(text).not.toContain('Sent using');
    expect(text).not.toMatch(/Roster v1\b/i);
  }
});

test('report sections stay collapsed and an unsafe link is inert', async ({ page }) => {
  await page.goto('/updates?view=dealflow&source=harbor');
  const deal = page.getByText('Quillmark Labs');
  await expect(deal).toBeHidden();

  await page.locator('summary', { hasText: /^New deals · 3/ }).click();
  await expect(deal).toBeVisible();

  await expect(page.getByRole('link', { name: 'Unsafe link' })).toHaveCount(0);
  const deadlines = page.locator('summary', { hasText: /^Upcoming deadlines & meetings/ });
  await deadlines.click();
  await expect(deadlines.locator('xpath=..').getByText('Unsafe link')).toBeVisible();

  const rels = await page
    .locator('main a[target="_blank"]')
    .evaluateAll((anchors) => anchors.map((a) => a.getAttribute('rel') ?? ''));
  expect(rels.length).toBeGreaterThan(0);
  for (const rel of rels) expect(rel).toContain('noreferrer');
});

test('the Digests view pins the roster and keeps each update collapsed', async ({ page }) => {
  await page.goto('/updates');
  await page.getByRole('link', { name: 'Digests', exact: true }).click();
  await expect(page).toHaveURL(/view=digests/);
  await expect(page.getByRole('heading', { name: 'Roster v2' })).toBeVisible();
  // The routine's open question stays in view on the latest run.
  await expect(page.getByText('Needs your call')).toBeVisible();

  const consent = page.getByText('Board consent due Thursday');
  await expect(consent).toBeHidden();
  await page.locator('summary', { hasText: /^Updates · 3/ }).click();
  await expect(consent).toBeHidden();
  await page.locator('summary', { hasText: /^Cobalt Orchard/ }).click();
  await expect(consent).toBeVisible();

  await page.locator('summary', { hasText: /^Notes · 1/ }).click();
  await expect(page.getByText('Correction', { exact: true })).toBeVisible();
});

test('a channel the bot cannot read says how to fix it', async ({ page }) => {
  await page.goto('/updates?view=dealflow');
  const tile = page.getByRole('listitem').filter({ hasText: 'Syndicate Inbox' });
  await expect(tile).toContainText('Invite needed');
  await expect(page.getByText('/invite @copilot_demo_bot')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Open #syndicate-dealflow in Slack' }),
  ).toHaveAttribute('href', /^https:\/\/demo-workspace\.slack\.com\/archives\/CDEMO0000Y1/);
});

test('refresh re-checks Slack and keeps the page', async ({ page }) => {
  await page.goto('/updates');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText(/Updates refreshed|latest copy/)).toBeVisible();
  await expect(h1(page)).toBeVisible();
});

test('the tab offers no way to send anything', async ({ page }) => {
  await page.goto('/updates');
  await expect(h1(page)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Send( |$)/ })).toHaveCount(0);
});
