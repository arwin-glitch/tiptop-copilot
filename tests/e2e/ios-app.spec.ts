import { resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  dropSecureCookies,
  fireIosEvent,
  iosCalls,
  IOS_APP_UA,
  IPHONE_SAFARI_UA,
  markAsIosApp,
  saveSignedIn,
  setIosState,
  type IosShellOptions,
} from '../helpers/ios-app';

/**
 * The iPhone app (ios-app/), simulated over the demo workspace: WebKit at an
 * iPhone's size with the app's user agent (the 'ios' project), and the
 * Capacitor shell's plugins stood in for (tests/helpers/ios-app.ts). The
 * flags set before first paint, the browser sign-in with the "Open TipTop
 * Copilot" return, what the app hides and why, its alerts card, a tap on an
 * alert, links that would leave for Safari, and the home-screen web app's
 * "Send alerts here instead". Every token and person here is invented.
 */

const EMPTY = { cookies: [], origins: [] };
const SIGNED_IN = resolve('test-results', 'ios-app-state.json');
const DEAL = '00000000-0000-4000-8000-000000000064';
/** playwright.config.ts gives the e2e server this throwaway secret. */
const CRON = 'Bearer e2e-cron-secret-not-a-production-value-000000000';

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: EMPTY,
    userAgent: IOS_APP_UA,
  });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);
  await saveSignedIn(context, SIGNED_IN);
  await context.close();
});

// No service worker: once it controls a page, its requests bypass page.route
// (and the routes that stand in for Zoom and for Safari's hand-off).
test.use({ storageState: SIGNED_IN, userAgent: IOS_APP_UA, serviceWorkers: 'block' });

/** The alert job asks for the outbox with a working APNs key, as it does every minute. */
async function senderAsks(page: Page) {
  const res = await page.request.get('/api/cron/push?scope=meetings&apns=1', {
    headers: { authorization: CRON },
  });
  expect(res.status()).toBe(200);
}

async function inApp(page: Page, path: string, options: IosShellOptions = {}) {
  await page.addInitScript(markAsIosApp, options);
  await page.goto(path);
}

async function preferences(page: Page, options: IosShellOptions = {}) {
  await inApp(page, '/settings', options);
  await page.getByRole('tab', { name: 'Preferences' }).click();
}

/** Turn the alerts card off again, so the next test starts with none. */
async function turnOffIfOn(page: Page) {
  const off = page.getByRole('button', { name: 'Turn off' });
  if (await off.isVisible()) {
    await off.click();
    await expect(page.getByRole('button', { name: 'Turn on alerts on this iPhone' })).toBeVisible();
  }
}

test.describe('before first paint', () => {
  test.use({ storageState: EMPTY });

  test('the app is flagged, moved under the status bar, and signs in through the browser', async ({
    page,
  }) => {
    await inApp(page, '/login');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-ios-app', '');
    // 1.0.0 saves downloads through the share sheet: nothing hidden for that.
    await expect(html).not.toHaveAttribute('data-ios-no-downloads');
    // The strip behind the clock: fixed, above everything, in the page's colour.
    const strip = await page.evaluate(() => {
      const style = getComputedStyle(document.body, '::before');
      return { position: style.position, zIndex: style.zIndex, top: style.top };
    });
    expect(strip).toEqual({ position: 'fixed', zIndex: '80', top: '0px' });
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
  });

  test('Safari on the same iPhone gets no flag and no app sign-in', async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: EMPTY,
      userAgent: IPHONE_SAFARI_UA,
    });
    const page = await context.newPage();
    await page.goto('/login');
    await expect(page.locator('html')).not.toHaveAttribute('data-ios-app');
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toHaveCount(0);
    await context.close();
  });
});

/** The app, signed out, with its navigation to the callback caught as the shell's hand-off to Safari would be. */
async function openSignedOutApp(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({
    baseURL,
    storageState: EMPTY,
    userAgent: IOS_APP_UA,
    serviceWorkers: 'block',
  });
  await dropSecureCookies(context);
  await context.addInitScript(markAsIosApp, {});
  const page = await context.newPage();
  let captured = '';
  await page.route('**/desktop/callback**', (route) => {
    captured = route.request().url();
    return route.fulfill({ status: 204 });
  });
  return { context, page, sentToSafari: () => captured };
}

test.describe('signing in to the iPhone app', () => {
  test.use({ storageState: EMPTY });

  test('Safari shows the code and an Open TipTop Copilot button that signs the app in', async ({
    browser,
  }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    const app = await openSignedOutApp(browser, baseURL);
    const safari = await browser.newContext({
      baseURL,
      storageState: EMPTY,
      userAgent: IPHONE_SAFARI_UA,
    });
    try {
      await app.page.goto('/login');
      // A code arriving with no sign-in open is ignored.
      await fireIosEvent(app.page, 'App', 'appUrlOpen', {
        url: 'vc.tiptop.copilot://signin?code=AB2C',
      });
      await app.page.getByRole('button', { name: 'Sign in with Google' }).click();
      await expect(
        app.page.getByText('Then tap Open TipTop Copilot there, or type the 4-character code'),
      ).toBeVisible();
      await expect.poll(app.sentToSafari).not.toBe('');

      const web = await safari.newPage();
      await web.goto(app.sentToSafari());
      await expect(web.getByRole('heading', { name: 'Your sign-in code' })).toBeVisible();
      await expect(web.getByText('on your iPhone')).toBeVisible();
      const code = ((await web.getByTestId('desktop-match-code').textContent()) ?? '').trim();
      const open = web.getByTestId('ios-open-app');
      await expect(open).toHaveText('Open TipTop Copilot');
      await expect(open).toHaveAttribute('href', `vc.tiptop.copilot://signin?code=${code}`);

      // The tap comes back to the app as its App plugin's appUrlOpen.
      await fireIosEvent(app.page, 'App', 'appUrlOpen', {
        url: await open.getAttribute('href'),
      });
      await app.page.waitForURL(/\/today/);
    } finally {
      await app.context.close();
      await safari.close();
    }
  });

  test('a computer’s callback page has no app button', async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    const app = await openSignedOutApp(browser, baseURL);
    const computer = await browser.newContext({
      baseURL,
      storageState: EMPTY,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
    });
    try {
      await app.page.goto('/login');
      await app.page.getByRole('button', { name: 'Sign in with Google' }).click();
      await expect.poll(app.sentToSafari).not.toBe('');
      const web = await computer.newPage();
      await web.goto(app.sentToSafari());
      await expect(web.getByText('on this computer')).toBeVisible();
      await expect(web.getByTestId('ios-open-app')).toHaveCount(0);
    } finally {
      await app.context.close();
      await computer.close();
    }
  });
});

test.describe('what the app hides', () => {
  test('no Download tab, no desktop app link, no web push card; files still download', async ({
    page,
  }) => {
    await preferences(page);
    await expect(page.getByText('iPhone alerts', { exact: true })).toBeVisible();
    await expect(page.getByText('Phone alerts', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Add to Home Screen')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Get the desktop app' })).toBeHidden();
    await expect(page.getByText('Do this on your computer: open Copilot there')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download', exact: true })).toBeHidden();

    await page.goto('/download');
    await expect(
      page.getByText('Do this on your computer: open Copilot on your Mac or PC'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /Download for/ })).toHaveCount(0);

    await page.goto(`/deals/${DEAL}`);
    await expect(page.getByRole('link', { name: 'Export memo' })).toBeVisible();
  });

  test.describe('in an app that cannot save files', () => {
    test.use({ userAgent: IOS_APP_UA.replace('TipTopCopilotiOS/1.0.0', 'TipTopCopilotiOS/0.9.0') });

    test('downloads are hidden, and alerts ask for the update', async ({ page }) => {
      await inApp(page, `/deals/${DEAL}`);
      await expect(page.locator('html')).toHaveAttribute('data-ios-no-downloads', '');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Export memo' })).toBeHidden();
      await page.goto('/settings');
      await page.getByRole('tab', { name: 'Preferences' }).click();
      await expect(
        page.getByText('This version of the app can’t get alerts. Open TestFlight'),
      ).toBeVisible();
    });
  });

  test('Google connect says “do this on your computer”; Google sign-in points back to the app’s own', async ({
    page,
  }) => {
    await inApp(page, '/today');
    for (const [path, says] of [
      ['/api/integrations/google/start', 'Do this on your computer'],
      ['/api/auth/google', 'Go back and tap Sign in with Google'],
    ] as const) {
      const res = await page.request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(200);
      expect(await res.text()).toContain(says);
    }
  });
});

test.describe('iPhone alerts', () => {
  test('turned on from Settings, tested and turned off, never asking at launch', async ({
    page,
  }) => {
    await preferences(page);
    const turnOn = page.getByRole('button', { name: 'Turn on alerts on this iPhone' });
    await expect(turnOn).toBeVisible();
    expect((await iosCalls(page)).some(([, method]) => method === 'requestPermissions')).toBe(
      false,
    );

    const registered = page.waitForRequest(
      (r) => r.url().endsWith('/api/push/ios') && r.method() === 'POST',
    );
    await turnOn.click();
    const body = (await registered).postDataJSON() as Record<string, unknown>;
    expect(body).toMatchObject({
      token: 'c0ffee00'.repeat(8),
      version: '1.0.0',
      build: '7.1',
      builtDay: null,
      replaces: null,
    });
    await expect(page.getByText('On for this iPhone.', { exact: true })).toBeVisible();

    // Until the alert job has asked with a working Apple key, the app says
    // it cannot be reached, and a test would only wait.
    const unreachable = page.getByText('Copilot can’t send to this app yet');
    await expect(unreachable).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send a test alert' })).toBeDisabled();
    await senderAsks(page);
    await page.reload();
    await page.getByRole('tab', { name: 'Preferences' }).click();
    await expect(page.getByText('On for this iPhone.', { exact: true })).toBeVisible();
    await expect(unreachable).toHaveCount(0);
    await page.getByRole('button', { name: 'Send a test alert' }).click();
    await expect(page.getByText('Test alert on its way.')).toBeVisible();

    const removed = page.waitForRequest(
      (r) => r.url().endsWith('/api/push/ios') && r.method() === 'DELETE',
    );
    await page.getByRole('button', { name: 'Turn off' }).click();
    expect((await removed).postDataJSON()).toMatchObject({ reason: 'settings' });
    await expect(turnOn).toBeVisible();
  });

  test('notifications switched off in iOS Settings turn the iPhone off at Copilot', async ({
    page,
  }) => {
    await preferences(page);
    await page.getByRole('button', { name: 'Turn on alerts on this iPhone' }).click();
    await expect(page.getByText('On for this iPhone.', { exact: true })).toBeVisible();

    await setIosState(page, { permission: 'denied' });
    const removed = page.waitForRequest(
      (r) => r.url().endsWith('/api/push/ios') && r.method() === 'DELETE',
    );
    await page.reload();
    expect((await removed).postDataJSON()).toMatchObject({ reason: 'permission' });
    await page.getByRole('tab', { name: 'Preferences' }).click();
    await expect(page.getByText('Notifications are off for this app.')).toBeVisible();
  });

  test('a tap on an alert opens its page, and a meeting alert joins the call', async ({ page }) => {
    await inApp(page, '/today', { pendingTap: { actionId: 'tap', url: '/follow-ups' } });
    await page.waitForURL(/\/follow-ups/);

    // A dismissed notification and a path off the site do nothing.
    await fireIosEvent(page, 'PushNotifications', 'pushNotificationActionPerformed', {
      actionId: 'dismiss',
      notification: { data: { url: '/settings' } },
    });
    await fireIosEvent(page, 'PushNotifications', 'pushNotificationActionPerformed', {
      actionId: 'tap',
      notification: { data: { url: 'https://evil.example/' } },
    });
    await page.waitForTimeout(500);
    expect(new URL(page.url()).pathname).toBe('/follow-ups');

    let asked = '';
    await page.route(
      (url) => url.pathname === '/go/meeting',
      (route) => {
        asked = route.request().url();
        return route.fulfill({ json: { ok: true, url: 'https://zoom.us/j/1234567890' } });
      },
    );
    let joined = '';
    await page.route(
      (url) => url.hostname === 'zoom.us',
      (route) => {
        joined = route.request().url();
        return route.fulfill({ status: 204 });
      },
    );
    await fireIosEvent(page, 'PushNotifications', 'pushNotificationActionPerformed', {
      actionId: 'tap',
      notification: { data: { url: '/go/meeting?id=evt-fictional' } },
    });
    await expect.poll(() => joined).toBe('https://zoom.us/j/1234567890');
    expect(new URL(asked).searchParams.get('format')).toBe('json');
  });

  test('links to Copilot that open a new window stay in the app', async ({ page }) => {
    await inApp(page, '/today');
    await page.waitForLoadState('networkidle');
    let popups = 0;
    page.on('popup', () => popups++);
    // Outside what React renders, so a re-render cannot take it away.
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = '/help';
      link.target = '_blank';
      link.textContent = 'Fictional help link';
      link.style.cssText = 'position:fixed;top:40%;left:1rem;z-index:99;background:#fff';
      document.body.append(link);
    });
    await page.getByText('Fictional help link').click();
    await page.waitForURL(/\/help$/, { waitUntil: 'commit' });
    // Once the new page has hydrated, window.open is the app's own.
    await page.waitForFunction(() => !String(window.open).includes('[native code]'));
    await page.evaluate(() => window.open('/settings', '_blank'));
    await page.waitForURL(/\/settings$/, { waitUntil: 'commit' });
    expect(popups).toBe(0);
  });
});

test.describe('the home-screen web app on the same iPhone', () => {
  test('says the app has the alerts, and “Send alerts here instead” brings them back', async ({
    page,
    browser,
  }, testInfo) => {
    // The app turns alerts on first, and the alert job can reach it.
    await senderAsks(page);
    await preferences(page);
    await page.getByRole('button', { name: 'Turn on alerts on this iPhone' }).click();
    await expect(page.getByText('On for this iPhone.', { exact: true })).toBeVisible();

    // The home-screen web app: no app token, with web push on (stood in for).
    const pwa = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: SIGNED_IN,
      userAgent: IPHONE_SAFARI_UA,
      serviceWorkers: 'block',
    });
    await pwa.addInitScript(() => {
      const sub = {
        endpoint: 'https://web.push.apple.com/QFictionalHomeScreenEndpoint',
        toJSON: () => ({
          endpoint: 'https://web.push.apple.com/QFictionalHomeScreenEndpoint',
          keys: {
            p256dh:
              'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
            auth: 'tBHItJI5svbpez7KI4CCXg',
          },
        }),
      };
      const registration = { pushManager: { getSubscription: async () => sub } };
      Object.defineProperty(window, 'PushManager', { value: function PushManager() {} });
      Object.defineProperty(window, 'Notification', {
        value: Object.assign(function Notification() {}, { permission: 'granted' }),
      });
      Object.defineProperty(navigator, 'serviceWorker', {
        value: {
          getRegistration: async () => registration,
          register: async () => registration,
          ready: Promise.resolve(registration),
          addEventListener: () => {},
          removeEventListener: () => {},
        },
      });
    });
    const web = await pwa.newPage();
    try {
      const saved = web.waitForRequest(
        (r) => r.url().endsWith('/api/push/subscription') && r.method() === 'POST',
      );
      await web.goto('/settings');
      await web.getByRole('tab', { name: 'Preferences' }).click();
      // Saved again quietly, so Copilot knows it is an iPhone's.
      await saved;
      await web.reload();
      await web.getByRole('tab', { name: 'Preferences' }).click();
      await expect(web.getByText('On for this device.')).toBeVisible();
      await expect(
        web.getByText('Alerts now go to the TipTop Copilot iPhone app, so this home-screen app'),
      ).toBeVisible();
      await web.getByRole('button', { name: 'Send alerts here instead' }).click();
      await expect(
        web.getByText('Your alerts come here instead of the TipTop Copilot iPhone app.'),
      ).toBeVisible();

      // The app offers the way back.
      await page.reload();
      await page.getByRole('tab', { name: 'Preferences' }).click();
      await expect(
        page.getByText('Your alerts go to the home-screen web app instead'),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Send them to this app' }).click();
      await expect(page.getByText('Your alerts go to the home-screen web app instead')).toHaveCount(
        0,
      );
      await turnOffIfOn(page);
      await web.request.delete('/api/push/subscription', {
        data: { endpoint: 'https://web.push.apple.com/QFictionalHomeScreenEndpoint' },
      });
    } finally {
      await pwa.close();
    }
  });
});
