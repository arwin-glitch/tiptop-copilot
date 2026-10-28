import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The Inbox's deep link over the invented demo workspace: `/inbox?thread=<id>`
 * (a thread or a message id, from a "Kraken" email link anywhere in the app)
 * opens that conversation in the reading pane even when it is not in the
 * inbox, without marking it read; closing it puts the address back; a bad or
 * unknown id says it couldn't open the email, with the list still there.
 */

const SIGNED_IN = path.resolve('test-results', 'inbox-deep-link-state.json');

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

test('a message id opens its archived thread in the reading pane, and Back puts the address back', async ({
  page,
}) => {
  const modify: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/inbox/modify')) modify.push(r.url());
  });

  // Nick's reply to Rafael: a message id, in a thread that is not in the inbox.
  await page.goto('/inbox?thread=0f00000000005302');
  const pane = page.getByRole('region', { name: 'Reading pane' });
  await expect(pane.getByRole('heading', { level: 2 })).toHaveText(
    'Summer analyst internship at TipTop?',
  );
  await expect(pane).toContainText("We aren't running a formal internship this summer");
  // Archived: offered back to the inbox, not archived again.
  await expect(pane.getByRole('button', { name: 'Move to inbox' })).toBeVisible();
  await expect(pane.getByRole('link', { name: 'Open in Gmail' })).toHaveAttribute(
    'href',
    /#all\/0f00000000005301$/,
  );
  // The list is still there beside it.
  await expect(
    page.getByRole('region', { name: 'Conversations' }).getByRole('listitem').first(),
  ).toBeVisible();

  await pane.getByRole('button', { name: 'Back to the list' }).click();
  await expect(pane.getByText('Pick a conversation to read it here.')).toBeVisible();
  await expect.poll(() => new URL(page.url()).search).toBe('');
  // Opening by link changed nothing in Gmail.
  expect(modify).toEqual([]);
});

test("a bad or unknown id says it couldn't open the email, never an error page", async ({
  page,
}) => {
  await page.goto('/inbox?thread=not-an-email');
  const alert = page.getByRole('alert').filter({ hasText: 'Couldn’t open that email.' });
  await expect(alert).toContainText("That link doesn't point at an email.");
  await expect(alert.getByRole('link', { name: 'Try in Gmail' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Conversations' })).toBeVisible();

  const res = await page.goto('/inbox?thread=0f00000000009999');
  expect(res?.status()).toBe(200);
  const unknown = page.getByRole('alert').filter({ hasText: 'Couldn’t open that email.' });
  await expect(unknown).toContainText("That email isn't in the mailbox");
  await expect(unknown.getByRole('link', { name: 'Try in Gmail' })).toHaveAttribute(
    'href',
    /#all\/0f00000000009999$/,
  );
  await unknown.getByRole('button', { name: 'Dismiss' }).click();
  await expect(unknown).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).search).toBe('');
});

/** The demo's Vetrix deal and its intro email (Kraken's own synced ids). */
const VETRIX_DEAL = '00000000-0000-4000-8000-000000000064';
const VETRIX_INTRO = '00000000-0000-4000-8000-000000000190';

test("a deal's source email opens in Kraken by its synced id, where it was a dead link", async ({
  page,
}) => {
  await page.goto(`/deals/${VETRIX_DEAL}`);
  await page.getByRole('tab', { name: 'Sources' }).click();
  const copilot = page.getByRole('link', { name: /^Open in Kraken: Intro: Vetrix/ }).first();
  await expect(copilot).toHaveAttribute('href', `/inbox?thread=${VETRIX_INTRO}`);
  await expect(
    page.getByRole('link', { name: /^Open in Gmail: Intro: Vetrix/ }).first(),
  ).toHaveAttribute('href', `/inbox?thread=${VETRIX_INTRO}&open=gmail`);

  await copilot.click();
  await page.waitForURL((url) => url.pathname === '/inbox');
  const pane = page.getByRole('region', { name: 'Reading pane' });
  await expect(pane.getByRole('heading', { level: 2 })).toHaveText(
    'Intro: Vetrix (vertical AI for veterinary practice)',
  );
});

/** The demo LP's question about Q3 reporting (Kraken's own synced id for the email). */
const LP_QUESTION = '00000000-0000-4000-8000-000000000195';

test('an email in the Today outlook\u2019s top priorities opens in Kraken or Gmail', async ({
  page,
}) => {
  await page.goto('/today');
  await expect(page.getByRole('heading', { name: 'Outlook' })).toBeVisible();
  const copilot = page
    .getByRole('link', { name: /^Open in Kraken: Elena Ward: LP question on Q3/ })
    .first();
  await expect(copilot).toHaveAttribute('href', `/inbox?thread=${LP_QUESTION}`);
  await expect(
    page.getByRole('link', { name: /^Open in Gmail: Elena Ward: LP question on Q3/ }).first(),
  ).toHaveAttribute('href', `/inbox?thread=${LP_QUESTION}&open=gmail`);

  await copilot.click();
  await page.waitForURL((url) => url.pathname === '/inbox');
  await expect(
    page.getByRole('region', { name: 'Reading pane' }).getByRole('heading', { level: 2 }),
  ).toHaveText('LP question on Q3 reporting timeline');
});

test('a synced email\u2019s Gmail link goes on to Gmail, and an old ?message= link still opens', async ({
  page,
}) => {
  // Where the app sends the browser, read before it leaves: the test never opens Gmail.
  const OPEN_GMAIL = /\/inbox\?thread=[^&]+&open=gmail$/;
  let target: string | undefined;
  await page.route(OPEN_GMAIL, async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    target =
      res.headers()['location'] ??
      /http-equiv="refresh" content="\d+;url=([^"]+)"/.exec(await res.text())?.[1];
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Stopped here</p>' });
  });
  await page.goto(`/inbox?thread=${VETRIX_INTRO}&open=gmail`);
  await expect.poll(() => target).toBeDefined();
  const gmail = new URL(target!.replace(/&amp;/g, '&'));
  expect(gmail.origin).toBe('https://mail.google.com');
  expect(gmail.searchParams.get('authuser')).toBe('nick@tiptop.demo');
  expect(gmail.hash).toMatch(/^#all\/[0-9a-f]{16}$/);
  await page.unroute(OPEN_GMAIL);

  // A brief or bookmark saved before the Inbox read ?thread=.
  await page.goto(`/inbox?message=${VETRIX_INTRO}`);
  const pane = page.getByRole('region', { name: 'Reading pane' });
  await expect(pane.getByRole('heading', { level: 2 })).toHaveText(
    'Intro: Vetrix (vertical AI for veterinary practice)',
  );

  // A synced id nothing has: said plainly, with no Gmail to try.
  await page.goto('/inbox?thread=00000000-0000-4000-8000-00000000ffff&open=gmail');
  const unknown = page.getByRole('alert').filter({ hasText: 'Couldn’t open that email.' });
  await expect(unknown).toContainText("That email isn't in the mailbox");
  await expect(unknown.getByRole('link', { name: 'Try in Gmail' })).toHaveCount(0);
});
