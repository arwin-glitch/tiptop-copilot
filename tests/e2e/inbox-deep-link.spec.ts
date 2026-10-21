import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The Inbox's deep link over the invented demo workspace: `/inbox?thread=<id>`
 * (a thread or a message id, from a "Copilot" email link anywhere in the app)
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
