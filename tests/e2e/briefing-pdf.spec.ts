import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The Today cards' "Open full briefing / dossier" opens a PDF the app builds
 * from the routine's text, not the routine's claude.ai artifact, which is
 * private to Arwin's account. The demo seeds one brief and one dossier.
 */

const SIGNED_IN = path.resolve('test-results', 'briefing-pdf-state.json');

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

test('the briefing and dossier cards open a PDF the app builds itself', async ({ page }) => {
  await page.goto('/today');
  for (const name of ['Open full briefing (PDF)', 'Open full dossier (PDF)']) {
    const link = page.getByRole('link', { name });
    await expect(link).toBeVisible();
    const href = (await link.getAttribute('href')) ?? '';
    expect(href).toMatch(/^\/api\/briefings\/(morning|afternoon|dossier)\/pdf/);

    // Fetched from inside the page, as a click would be: the production-build
    // session cookie is Secure, which a browser sends to localhost but
    // Playwright's request client does not.
    const result = await page.evaluate(async (url) => {
      const response = await fetch(url);
      const head = new Uint8Array(await response.arrayBuffer()).slice(0, 5);
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        head: String.fromCharCode(...head),
      };
    }, href);
    expect(result).toEqual({ status: 200, type: 'application/pdf', head: '%PDF-' });
  }
  // The private artifact is never linked from the app.
  await expect(page.locator('a[href*="claude.ai/artifact"]')).toHaveCount(0);
});

test('the PDF is not served without a session', async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const response = await context.request.get('/api/briefings/morning/pdf');
  expect(response.status()).toBe(401);
  await context.close();
});
