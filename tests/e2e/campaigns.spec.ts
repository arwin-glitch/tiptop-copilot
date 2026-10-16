import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Campaigns: tracked bulk email, over the invented demo workspace.
 *
 * Demo mode sends through a sender that sends nothing (no network call of any
 * kind), so the whole flow can be driven here: the report of the sent Q3
 * update, then a new campaign from a CRM list through the review screen and
 * the one tap, its paced batches, and its report. Plus the public tracking
 * endpoints, which must answer without a session and never redirect anywhere
 * that was not in a campaign.
 */

// One demo sign-in for the whole file: demo entry is capped at 60 a minute.
const SIGNED_IN = path.resolve('test-results', 'campaigns-state.json');

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

test.describe('signed in', () => {
  test.use({ storageState: SIGNED_IN });

  test('Fund II lists campaigns with open, click and reply rates', async ({ page }) => {
    await page.goto('/fund-ii');
    const tabs = page.getByRole('navigation', { name: 'Fund II sections' });
    await tabs.getByRole('link', { name: 'Campaigns' }).click();
    await page.waitForURL(/\/fund-ii\?tab=campaigns/);
    await expect(tabs.getByRole('link', { name: 'Campaigns' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    const table = page.getByRole('region', { name: 'Campaigns' });
    const row = table.getByRole('row', { name: /Q3 LP update/ });
    // 8 sent: 6 opened, 3 clicked, 2 replied.
    await expect(row.getByRole('cell').nth(0)).toHaveText('8');
    await expect(row.getByRole('cell').nth(1)).toHaveText('75%');
    await expect(row.getByRole('cell').nth(3)).toHaveText('25%');
    await expect(table.getByRole('row', { name: /Fund II first close note/ })).toContainText(
      'Draft',
    );
    // Who unsubscribed, with a way to put them back.
    const unsubscribed = page.getByRole('list', { name: 'Unsubscribed addresses' });
    await expect(unsubscribed).toContainText('hana@riverlight.example');
    await expect(unsubscribed.getByRole('button', { name: 'Resubscribe' })).toBeVisible();

    await row.getByRole('link', { name: 'Q3 LP update' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Q3 LP update' })).toBeVisible();
    await page
      .getByRole('group', { name: 'Show recipients' })
      .getByRole('button', { name: /^Replied/ })
      .click();
    const results = page.getByRole('list', { name: 'Recipient results' });
    await expect(results.getByRole('listitem')).toHaveCount(2);
    await expect(results).toContainText('Maren Solberg');
    await expect(results).toContainText('Gabriel Stroud');
    await page
      .getByRole('group', { name: 'Show recipients' })
      .getByRole('button', { name: /^Bounced or failed/ })
      .click();
    await expect(results.getByRole('listitem')).toHaveCount(1);
    await expect(results).toContainText('Bounced');
  });

  test('a sent campaign opens with its receipt, and Issues shows who needs a look', async ({
    page,
  }) => {
    await page.goto('/fund-ii?tab=campaigns');
    const row = page
      .getByRole('region', { name: 'Campaigns' })
      .getByRole('row', { name: /Q3 LP update/ });
    // The list reads like the receipt: 8 people, 1 bounced.
    await expect(row).toContainText('7/8');
    await expect(row).toContainText('1 issue');

    await row.getByRole('link', { name: 'Q3 LP update' }).click();
    const receipt = page.getByRole('region', { name: 'Campaign receipt' });
    await expect(receipt.getByRole('heading', { name: 'Sent, 1 needs a look' })).toBeVisible();
    // Three tiles: when, how many reached people, how many need a look.
    await expect(receipt.getByText('Sent', { exact: true })).toBeVisible();
    await expect(receipt.locator('time')).toHaveAttribute('title', /\d{4}(,| at) \d{1,2}:\d{2}/);
    await expect(receipt.getByText('Delivered', { exact: true })).toBeVisible();
    await expect(receipt.getByText('7 / 8')).toBeVisible();
    const issues = receipt.getByRole('button', { name: /^Issues/ });
    await expect(issues).toContainText('1 bounced');
    // The opens, clicks and replies stay below it.
    await expect(page.getByText('Opened', { exact: true }).first()).toBeVisible();

    await issues.click();
    await expect(
      page
        .getByRole('group', { name: 'Show recipients' })
        .getByRole('button', { name: /^Bounced or failed/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    const results = page.getByRole('list', { name: 'Recipient results' });
    await expect(results.getByRole('listitem')).toHaveCount(1);
    await expect(results).toContainText('Wren Halloway');
    await expect(page.getByRole('heading', { level: 2, name: 'Recipients' })).toBeInViewport();
  });

  test('a new campaign goes from a list to a confirmed, paced send and its report', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/fund-ii?tab=campaigns');
    await page.getByRole('button', { name: 'New campaign' }).first().click();
    await page.waitForURL(/\/fund-ii\/campaigns\/[0-9a-f-]{36}$/);

    // Recipients: the LP Pipeline, minus the LP who unsubscribed last time.
    await page.getByLabel('List', { exact: true }).selectOption({ label: 'LP Pipeline (5)' });
    await page.getByRole('button', { name: 'Add people from this list' }).click();
    await expect(page.getByText('Added 4 people. Left out: 1 unsubscribed.')).toBeVisible();
    const recipients = page.getByRole('list', { name: 'Recipients' });
    await expect(recipients.getByRole('listitem')).toHaveCount(4);
    await expect(recipients).not.toContainText('Hana Kuroda');

    // Message, previewed as the first recipient.
    await page.getByRole('button', { name: 'Next: the message' }).click();
    await page.getByLabel('Campaign name').fill('Fund II update (e2e)');
    await page.getByLabel('Subject').fill('Fund II for {{company|you}}');
    await page
      .getByLabel('Email', { exact: true })
      .fill('Hi {{first_name|there}},\n\nThe letter: [read it](https://tiptop.example/fund-ii).');
    const preview = page.getByRole('region', { name: 'Preview' });
    await expect(preview).toContainText('Fund II for Oakhaven Capital');
    await expect(preview).toContainText('Hi Maren,');
    await expect(preview.getByRole('link', { name: 'read it' })).toHaveAttribute(
      'href',
      'https://tiptop.example/fund-ii',
    );
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    // Tracking is on and the unsubscribe line off unless switched.
    await expect(page.getByRole('switch', { name: 'Track opens and clicks' })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Add an unsubscribe link' })).not.toBeChecked();

    await page.getByRole('button', { name: 'Send test to me' }).click();
    await expect(page.getByText(/Demo: a test to nick@tiptop\.demo was made/)).toBeVisible();

    // Review: the exact count, sender, subject and a sample, then one tap.
    await page.getByRole('button', { name: 'Next: review' }).click();
    const review = page.getByRole('region', { name: 'Send to 4 people?' });
    await expect(review).toBeVisible();
    await expect(review).toContainText('4 people');
    await expect(review).toContainText('nick@tiptop.demo');
    await expect(review).toContainText('Fund II for {{company|you}}');
    await expect(review.getByRole('region', { name: /Sample/ })).toContainText('Hi Maren,');
    await expect(review).toContainText('Opens and clicks');
    await expect(review).not.toContainText('If you would rather not get these emails');
    await review.getByRole('button', { name: 'Send to 4 people' }).click();

    // Sending: paced batches while the page is open, then the report.
    await expect(page.getByRole('progressbar', { name: 'Campaign progress' })).toBeVisible();
    // The toast has the real numbers, and the page opens on its receipt.
    await expect(page.getByText('Campaign sent: 4 of 4, no issues.')).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      page.getByRole('heading', { level: 1, name: 'Fund II update (e2e)' }),
    ).toBeVisible();
    const receipt = page.getByRole('region', { name: 'Campaign receipt' });
    await expect(receipt.getByRole('heading', { name: 'Sent to everyone' })).toBeVisible();
    await expect(receipt.getByText('4 / 4')).toBeVisible();
    await expect(receipt.getByRole('button', { name: /^Issues/ })).toHaveCount(0);
    await expect(receipt).toContainText('Nothing bounced or failed');
    await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();
    const results = page.getByRole('list', { name: 'Recipient results' });
    await expect(results.getByRole('listitem')).toHaveCount(4);
    await expect(results.getByText('Sent', { exact: true })).toHaveCount(4);

    await page.goto('/fund-ii?tab=campaigns');
    const row = page
      .getByRole('region', { name: 'Campaigns' })
      .getByRole('row', { name: /Fund II update \(e2e\)/ });
    await expect(row.getByRole('cell').nth(0)).toHaveText('4');
  });

  test('leaving the page while it sends asks first, then pauses the campaign', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/fund-ii?tab=campaigns');
    await page.getByRole('button', { name: 'New campaign' }).first().click();
    await page.waitForURL(/\/fund-ii\/campaigns\/[0-9a-f-]{36}$/);
    const url = page.url();

    const addresses = Array.from({ length: 8 }, (_, i) => `lp${i + 1}@leave.example`);
    await page.getByLabel('Email addresses').fill(addresses.join('\n'));
    await page.getByRole('button', { name: 'Add 8 pasted' }).click();
    await expect(page.getByText('Added 8 people.')).toBeVisible();
    await page.getByRole('button', { name: 'Next: the message' }).click();
    await page.getByLabel('Campaign name').fill('Leave test (e2e)');
    await page.getByLabel('Subject').fill('A short note');
    await page.getByLabel('Email', { exact: true }).fill('Hi {{first_name|there}},\n\nA note.');
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next: review' }).click();
    await page.getByRole('button', { name: 'Send to 8 people' }).click();
    await expect(page.getByRole('heading', { name: /^Sending/ })).toBeVisible();

    // An in-app link asks first; staying keeps it sending.
    const back = page.getByRole('link', { name: 'Campaigns', exact: true });
    page.once('dialog', (dialog) => void dialog.dismiss());
    await back.click();
    await expect(page.getByRole('heading', { name: /^Sending/ })).toBeVisible();
    expect(page.url()).toBe(url);

    // Leaving anyway pauses it, and the list says so rather than "Sending".
    page.once('dialog', (dialog) => void dialog.accept());
    await back.click();
    await page.waitForURL(/\/fund-ii\?tab=campaigns/);
    const row = page
      .getByRole('region', { name: 'Campaigns' })
      .getByRole('row', { name: /Leave test \(e2e\)/ });
    await expect(async () => {
      await page.reload();
      await expect(row).toContainText('Paused', { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    await page.goto(url);
    await expect(page.getByText(/Paused when the sending page was left/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Resume \(\d+ left\)$/ })).toBeVisible();
  });

  test('a draft cannot be confirmed with a stale review', async ({ page }) => {
    // The page's own request context carries the session.
    const res = await page.request.post(
      '/api/campaigns/00000000-0000-4000-8000-0000000007d1/confirm',
      { data: { version: '2001-01-01T00:00:00.000Z', recipients: 1, subject: 'x', from: 'nick' } },
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
    await page.goto('/fund-ii/campaigns/00000000-0000-4000-8000-0000000007d1');
    await expect(page.getByRole('navigation', { name: 'Campaign steps' })).toBeVisible();
  });
});

test.describe('public tracking endpoints', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('campaign APIs answer nobody without a session', async ({ request }) => {
    const res = await request.post('/api/campaigns', { data: {} });
    expect(res.status()).toBe(401);
  });

  test('the open pixel is a gif for anyone, valid token or not', async ({ request }) => {
    const res = await request.get('/t/o/not-a-real-token');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/gif');
    expect(res.headers()['cache-control']).toContain('no-store');
  });

  test('a click link never redirects without a valid token and a campaign link', async ({
    request,
  }) => {
    const res = await request.get('/t/c/not-a-real-token?u=https%3A%2F%2Fevil.example%2F', {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(404);
    expect(res.headers()['location']).toBeUndefined();
    expect(await res.text()).toContain('This link is not valid');
    // A link checker's HEAD gets the same answer.
    const head = await request.head('/t/c/not-a-real-token?u=https%3A%2F%2Fevil.example%2F', {
      maxRedirects: 0,
    });
    expect(head.status()).toBe(404);
    expect(head.headers()['location']).toBeUndefined();
  });

  test('unsubscribe changes nothing on open, and a test email says so', async ({ request }) => {
    const bad = await request.get('/t/u/not-a-real-token');
    expect(bad.status()).toBe(404);
    const test_ = await request.get('/t/u/test');
    expect(test_.status()).toBe(200);
    expect(await test_.text()).toContain('This was a test email');
  });
});
