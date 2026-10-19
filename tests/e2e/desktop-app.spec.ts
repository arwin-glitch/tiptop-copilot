import { resolve } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * The desktop app, simulated: a page with the shell's flag is "the app", and
 * a separate context with no flag is "the system browser". The demo's start
 * route points at its own callback page instead of Google, so the hand-off
 * runs for real between the two.
 *
 * In the real shell, navigating to the sign-in URL opens the system browser
 * and leaves the app's page in place. Here the app's navigation to the
 * callback is caught and answered 204 (which leaves the page as it was), and
 * the captured URL is opened in the "browser".
 */

const EMPTY = { cookies: [], origins: [] };
const SIGNED_IN = resolve('test-results', 'desktop-app-state.json');

/** The shell's flag, as an init script; its argument is the app's version. */
function markAsDesktopApp(version: string) {
  Object.defineProperty(window, '__TIPTOP_DESKTOP__', { value: version });
}

async function openApp(browser: Browser, baseURL: string | undefined) {
  // No service worker: once it controls the page, its fetches bypass
  // page.route, and the callback would really load in "the app".
  const context = await browser.newContext({
    baseURL,
    storageState: EMPTY,
    serviceWorkers: 'block',
  });
  await context.addInitScript(markAsDesktopApp, '0.1.0');
  const page = await context.newPage();
  let captured = '';
  await page.route('**/desktop/callback**', (route) => {
    captured = route.request().url();
    return route.fulfill({ status: 204 });
  });
  return { context, page, sentToBrowser: () => captured };
}

/** Click Sign in in the app; the URL the shell would hand to the browser. */
async function startSignIn(page: Page, sentToBrowser: () => string): Promise<string> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  await expect(
    page.getByRole('heading', { name: 'Finish signing in using your browser' }),
  ).toBeVisible();
  await expect.poll(sentToBrowser).not.toBe('');
  return sentToBrowser();
}

async function openBrowser(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, storageState: EMPTY });
  return { context, page: await context.newPage() };
}

async function shownCode(page: Page): Promise<string> {
  await expect(page.getByRole('heading', { name: 'Your sign-in code' })).toBeVisible();
  const code = ((await page.getByTestId('desktop-match-code').textContent()) ?? '').trim();
  expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}$/);
  return code;
}

test.describe('signing in to the desktop app', () => {
  test.use({ storageState: EMPTY });
  let contexts: BrowserContext[] = [];
  test.afterEach(async () => {
    await Promise.all(contexts.map((c) => c.close()));
    contexts = [];
  });

  test('the browser shows a code, and typing it in the app signs the app in', async ({
    browser,
  }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    const app = await openApp(browser, baseURL);
    const web = await openBrowser(browser, baseURL);
    contexts.push(app.context, web.context);

    const url = await startSignIn(app.page, app.sentToBrowser);
    expect(new URL(url).pathname).toBe('/desktop/callback');
    await web.page.goto(url);
    const code = await shownCode(web.page);
    await expect(web.page.getByRole('button', { name: 'I didn’t start this' })).toBeVisible();

    // The app notices on its next check, and asks for the code.
    const field = app.page.getByLabel('Sign-in code');
    await expect(field).toBeVisible();
    await field.fill(code.toLowerCase());
    await app.page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await app.page.waitForURL(/\/today/);

    // The browser was never signed in, and its page now says it is over.
    await web.page.reload();
    await expect(web.page.getByRole('heading', { name: 'This sign-in is finished' })).toBeVisible();
    await expect(web.page.getByTestId('desktop-match-code')).toHaveCount(0);
  });

  test('three wrong codes stop the sign-in in both places', async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    const app = await openApp(browser, baseURL);
    const web = await openBrowser(browser, baseURL);
    contexts.push(app.context, web.context);

    await web.page.goto(await startSignIn(app.page, app.sentToBrowser));
    const code = await shownCode(web.page);
    const wrong = code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';

    const field = app.page.getByLabel('Sign-in code');
    await expect(field).toBeVisible();
    const submit = app.page.getByRole('button', { name: 'Sign in', exact: true });
    await field.fill(wrong);
    await submit.click();
    await expect(app.page.getByText('That code didn’t match. 2 tries left.')).toBeVisible();
    await field.fill(wrong);
    await submit.click();
    await expect(app.page.getByText('That code didn’t match. 1 try left.')).toBeVisible();
    await field.fill(wrong);
    await submit.click();
    await expect(
      app.page.getByText(
        'That code didn’t match three times, so sign-in stopped to keep you safe.',
      ),
    ).toBeVisible();
    await expect(app.page.getByRole('button', { name: 'Try again' })).toBeVisible();

    await web.page.reload();
    await expect(web.page.getByRole('heading', { name: 'This sign-in was stopped' })).toBeVisible();
  });

  test('“I didn’t start this” in the browser stops the app’s sign-in', async ({
    browser,
  }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    const app = await openApp(browser, baseURL);
    const web = await openBrowser(browser, baseURL);
    contexts.push(app.context, web.context);

    await web.page.goto(await startSignIn(app.page, app.sentToBrowser));
    await shownCode(web.page);
    await web.page.getByRole('button', { name: 'I didn’t start this' }).click();
    await web.page.waitForURL(/\/desktop\/done\?result=cancelled/);
    await expect(web.page.getByRole('heading', { name: 'Sign-in stopped' })).toBeVisible();

    await expect(app.page.getByText('Sign-in was stopped in the browser.')).toBeVisible();
    await expect(app.page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('cancelling at Google cancels in both places', async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    const app = await openApp(browser, baseURL);
    const web = await openBrowser(browser, baseURL);
    contexts.push(app.context, web.context);

    const url = await startSignIn(app.page, app.sentToBrowser);
    await web.page.goto(url.replace('code=demo', 'error=access_denied'));
    await expect(web.page.getByRole('heading', { name: 'Sign-in was cancelled' })).toBeVisible();
    await expect(web.page.getByTestId('desktop-match-code')).toHaveCount(0);
    await expect(app.page.getByText('Sign-in was cancelled in the browser.')).toBeVisible();
  });

  test('an unknown link says expired and shows no code', async ({ page }) => {
    await page.goto('/desktop/callback?h=bogus&code=whatever');
    await expect(
      page.getByRole('heading', { name: 'This sign-in link has expired' }),
    ).toBeVisible();
    await expect(page.getByTestId('desktop-match-code')).toHaveCount(0);
  });

  test('a normal browser’s login page has no desktop sign-in', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Enter demo workspace' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toHaveCount(0);
  });
});

test.describe('the download page', () => {
  // One demo sign-in for these: demo entry is rate-limited across the suite.
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

  test('offers both installers through Copilot, with the first-time steps', async ({ page }) => {
    await page.goto('/download');
    await expect(page.getByRole('heading', { level: 1, name: 'Desktop app' })).toBeVisible();

    const mac = page.getByRole('region', { name: 'Mac' });
    const windows = page.getByRole('region', { name: 'Windows' });
    await expect(mac.getByRole('link', { name: 'Download for Mac' })).toHaveAttribute(
      'href',
      '/api/desktop/download/mac',
    );
    await expect(windows.getByRole('link', { name: 'Download for Windows' })).toHaveAttribute(
      'href',
      '/api/desktop/download/windows',
    );
    await expect(mac.getByRole('heading', { name: 'First time on a Mac' })).toBeVisible();
    await expect(windows.getByRole('heading', { name: 'First time on Windows' })).toBeVisible();
    await expect(mac.getByText(/click Open Anyway/)).toBeVisible();
    await expect(windows.getByText(/click More info, then Run anyway/)).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Rather skip the security steps?' }),
    ).toBeVisible();
    // The version on offer is not known here, so the claim carries its version.
    await expect(page.getByText(/From version 0\.2\.0 the app updates itself:/)).toBeVisible();
    await expect(mac.getByText(/^From version 0\.2\.0 you do this once:/)).toBeVisible();
    await expect(page.locator('a[href*="github.com"]')).toHaveCount(0);

    // The demo has no installers: the route comes back with a plain notice.
    await page.goto('/api/desktop/download/mac');
    await page.waitForURL(/\/download\?unavailable=mac$/);
    await expect(page.getByText('The Mac app isn’t ready yet. Check back soon.')).toBeVisible();
  });

  test('inside the desktop app, it shows the version and no browser-only options', async ({
    page,
  }) => {
    await page.addInitScript(markAsDesktopApp, '0.1.0');
    await page.goto('/download');
    await expect(page.getByText('You’re using the desktop app, version 0.1.0.')).toBeVisible();
    // The app is what Download offers, so neither menu lists it.
    await expect(page.locator('nav[aria-label="Main"] a[href="/download"]')).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Rather skip the security steps?' }),
    ).toHaveCount(0);

    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Preferences' }).click();
    await expect(page.getByText('Update the app to get desktop alerts.')).toBeVisible();
    await expect(page.getByText('Phone alerts', { exact: true })).toHaveCount(0);
    await expect(page.getByText('You’re using the desktop app, version 0.1.0.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Check for a new version' })).toHaveAttribute(
      'href',
      '/download',
    );
  });

  test('an app too old to update itself is told it updates itself from 0.2.0', async ({ page }) => {
    await page.addInitScript(markAsDesktopApp, '0.1.0');
    await page.goto('/download');
    await expect(page.getByText(/From version 0\.2\.0 the app updates itself\./)).toBeVisible();
    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Preferences' }).click();
    await expect(page.getByText('From version 0.2.0 the app updates itself.')).toBeVisible();
  });

  test('from 0.2.0 the app installs its own updates, with no download link', async ({ page }) => {
    await page.addInitScript(markAsDesktopApp, '0.2.0');
    await page.goto('/download');
    await expect(page.getByText('You’re using the desktop app, version 0.2.0.')).toBeVisible();
    await expect(
      page.getByText(/installs its own updates: when a new version is ready/),
    ).toBeVisible();
    await expect(page.getByText(/quit the app first/)).toHaveCount(0);

    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Preferences' }).click();
    await expect(
      page.getByText(
        'You’re using the desktop app, version 0.2.0. It installs its own updates: when a new version is ready, it asks to restart.',
      ),
    ).toBeVisible();
    await expect(
      page.getByText(/use Check for Updates… in the File menu on Windows/),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Check for a new version' })).toHaveCount(0);
  });

  test('from 0.3.0 Check for Updates… is under the menu at the top left', async ({ page }) => {
    // The main window's menu bar became the top bar's menu button on Windows.
    await page.addInitScript(markAsDesktopApp, '0.3.0');
    await page.goto('/download');
    await expect(
      page.getByText(
        /use Check for Updates… in the menu at the top left on Windows \(under File\)/,
      ),
    ).toBeVisible();

    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Preferences' }).click();
    await expect(
      page.getByText(
        'To look now, use Check for Updates… in the menu at the top left on Windows (under File) or the TipTop Copilot menu on a Mac.',
      ),
    ).toBeVisible();
    await expect(page.getByText(/in the File menu on Windows/)).toHaveCount(0);
  });

  test('in a browser, Settings points to the desktop app', async ({ page }) => {
    await page.goto('/settings');
    // Both menus list Download in a browser (the sidebar under System).
    await expect(page.locator('nav[aria-label="Main"] a[href="/download"]')).toHaveCount(2);
    await page.getByRole('tab', { name: 'Preferences' }).click();
    await expect(page.getByRole('link', { name: 'Get the desktop app' })).toHaveAttribute(
      'href',
      '/download',
    );
  });
});

test.describe('the desktop app’s updater', () => {
  // A plain HTTP client inside the app: no session and no cookies.
  test.use({ storageState: EMPTY });

  test('checks and downloads without signing in, while installers stay signed in', async ({
    request,
  }) => {
    const nothingNew = await request.get('/api/desktop/update/darwin/aarch64/0.2.0');
    expect(nothingNew.status()).toBe(204);
    expect(nothingNew.headers()['cache-control']).toBe('no-store');

    const unknown = await request.get('/api/desktop/update/linux/x86_64/0.2.0');
    expect(unknown.status()).toBe(400);

    // The demo publishes nothing: not found, rather than "sign in".
    const file = await request.get('/api/desktop/update-file/mac/0.2.1');
    expect(file.status()).toBe(404);
    expect(await file.json()).toMatchObject({ ok: false, error: { code: 'not_found' } });

    const installer = await request.get('/api/desktop/download/mac', { maxRedirects: 0 });
    expect(installer.status()).toBe(401);
  });
});
