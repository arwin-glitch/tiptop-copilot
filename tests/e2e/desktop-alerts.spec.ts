import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  alertCalls,
  FAKE_DEVICE,
  markAsAlertsDesktop,
  shellCalls,
  type AlertsShellOptions,
} from '../helpers/desktop-alerts';

/**
 * Desktop alerts (desktop 0.4.0) in Settings > Preferences, over the demo
 * workspace, with the shell simulated (tests/helpers/desktop-alerts.ts): the
 * phone card in a browser, the update line in an older app, turning this
 * computer on and off (also across a tab switch before the page refreshed),
 * a computer Copilot no longer has, the blocked copy, a click on an alert
 * opening its page, and signing out turning the computer off.
 */

const EMPTY = { cookies: [], origins: [] };
const SIGNED_IN = resolve('test-results', 'desktop-alerts-state.json');
const TOKEN_RE = /^tcdsk_[0-9a-f]{32}_([0-9a-f]{32})_[A-Za-z0-9_-]{43}$/;

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

async function preferences(page: Page, options?: AlertsShellOptions) {
  if (options) await page.addInitScript(markAsAlertsDesktop, options);
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Preferences' }).click();
}

test('in a browser, the phone card as before', async ({ page }) => {
  await preferences(page);
  await expect(page.getByText('Phone alerts', { exact: true })).toBeVisible();
  await expect(page.getByText('Desktop alerts', { exact: true })).toHaveCount(0);
});

test('an app before 0.4.0 is told to update, and nothing asks its shell', async ({ page }) => {
  await preferences(page, { version: '0.3.0' });
  await expect(page.getByText('Update the app to get desktop alerts.')).toBeVisible();
  await expect(
    page.getByText('Phone alerts are separate: turn them on from Copilot on your phone.'),
  ).toBeVisible();
  await expect(page.getByText('Phone alerts', { exact: true })).toHaveCount(0);
  expect(await alertCalls(page)).toEqual([]);
});

test('turn this computer on, test it, and turn it off', async ({ page, playwright, baseURL }) => {
  await preferences(page, {});
  await expect(page.getByText('Desktop alerts', { exact: true })).toBeVisible();
  await expect(page.getByText('Phone alerts', { exact: true })).toHaveCount(0);

  // Hold back the page's refresh after Enable, so the list stays the one
  // from before it.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === '/settings',
    async (route) => {
      if (route.request().headers()['rsc']) await held;
      // The page may have given up on a held request meanwhile.
      await route.continue().catch(() => {});
    },
  );
  await page.getByRole('button', { name: 'Enable alerts on this computer' }).click();

  await expect(page.getByText('On for this computer.', { exact: true })).toBeVisible();
  await expect(page.getByText('Desktop alerts are on for this computer.')).toBeVisible();

  // Leaving the tab and coming back unmounts and remounts the card with
  // that old list: it asks Copilot, which still has the computer on.
  const checked = page.waitForRequest((request) =>
    request.url().includes(`/api/push/desktop?device=${FAKE_DEVICE}`),
  );
  await page.getByRole('tab', { name: 'Integrations' }).click();
  await page.getByRole('tab', { name: 'Preferences' }).click();
  await checked;
  await expect(page.getByText('On for this computer.', { exact: true })).toBeVisible();
  release();
  await expect(page.getByText(/^Windows \(ID ee00\) · on since .+ · this computer$/)).toBeVisible();
  const calls = await alertCalls(page);
  expect(calls[0]).toBe('alerts_state');
  expect(calls.filter((cmd) => cmd !== 'alerts_state')).toEqual([
    'alerts_request_permission',
    'alerts_turn_on',
  ]);

  // The token went to the shell, for this device, and the page kept no copy.
  const turnOn = (await shellCalls(page)).find(([cmd]) => cmd === 'alerts_turn_on');
  const token = String(turnOn?.[1].token);
  expect(TOKEN_RE.exec(token)?.[1]).toBe(FAKE_DEVICE);
  expect(await page.content()).not.toContain(token);

  // The shell's own ask: no session, just the token.
  const shell = await playwright.request.newContext({ baseURL, storageState: EMPTY });
  const asked = await shell.get('/api/desktop/alerts', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(asked.status()).toBe(200);
  const body = (await asked.json()) as { ok: boolean; alerts: unknown[]; pollAfterSeconds: number };
  expect(body.ok).toBe(true);
  expect(Array.isArray(body.alerts)).toBe(true);

  await page.getByRole('button', { name: 'Send a test' }).click();
  await expect.poll(() => alertCalls(page)).toContain('alerts_test');

  await page.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(page.getByText('Desktop alerts are off for this computer.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable alerts on this computer' })).toBeVisible();
  await expect(page.getByText(/· this computer$/)).toHaveCount(0);
  expect(await alertCalls(page)).toContain('alerts_turn_off');

  // Turned off on the server too: the token no longer works.
  const after = await shell.get('/api/desktop/alerts', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(after.status()).toBe(401);
  await shell.dispose();
});

test('a computer Copilot no longer has on is turned off here when Settings opens', async ({
  page,
}) => {
  await preferences(page, {
    device: 'deadbeef'.repeat(4),
    state: { on: true, permission: 'granted', platform: 'windows' },
  });
  await expect(page.getByRole('button', { name: 'Enable alerts on this computer' })).toBeVisible();
  const calls = await alertCalls(page);
  expect(calls.slice(0, 2)).toEqual(['alerts_state', 'alerts_turn_off']);
});

test('blocked notifications say where to allow them, on a Mac and on Windows', async ({ page }) => {
  await preferences(page, {
    frame: 'mac',
    state: { on: false, permission: 'denied', platform: 'mac' },
  });
  await expect(
    page.getByText(
      'Notifications are blocked for TipTop Copilot. Allow them in System Settings > Notifications > TipTop Copilot, then come back to this page.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable alerts on this computer' })).toHaveCount(0);
});

test('Windows says where too, and a second window sends you to the main one', async ({
  browser,
}) => {
  const windows = await browser.newPage({ storageState: SIGNED_IN });
  await preferences(windows, { state: { on: false, permission: 'denied', platform: 'windows' } });
  await expect(
    windows.getByText(
      'Notifications are off for TipTop Copilot. Turn them on in Windows Settings > System > Notifications (Notifications & actions on Windows 10), then come back to this page.',
    ),
  ).toBeVisible();
  await windows.close();

  const second = await browser.newPage({ storageState: SIGNED_IN });
  await preferences(second, { frame: null });
  await expect(
    second.getByText('Open Settings in the main window to turn desktop alerts on or off.'),
  ).toBeVisible();
  expect(await alertCalls(second)).toEqual([]);
  await second.close();
});

test('a click on an alert opens its page, and only an in-app one', async ({ page }) => {
  await page.addInitScript(markAsAlertsDesktop, {});
  await page.goto('/today');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const fire = (detail: unknown) =>
    page.evaluate((path) => {
      window.dispatchEvent(new CustomEvent('tiptop-desktop-open', { detail: path }));
    }, detail);

  for (const outside of ['//example.com', 'https://example.com', '/today#x', 42]) {
    await fire(outside);
  }
  await page.waitForTimeout(500);
  expect(new URL(page.url()).pathname).toBe('/today');

  await fire('/calendar');
  await page.waitForURL(/\/calendar$/);
});

test('signing out in the app turns this computer off first', async ({ browser, baseURL }) => {
  // Its own sign-in, so the shared one stays signed in for the other tests.
  const context = await browser.newContext({ baseURL, storageState: EMPTY });
  const page = await context.newPage();
  await page.addInitScript(markAsAlertsDesktop, {});
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/);
  expect(await alertCalls(page)).toContain('alerts_turn_off');
  await context.close();
});
