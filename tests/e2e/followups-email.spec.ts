import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The full email on Follow-ups and in the email session: collapsed to a few
 * lines behind "Show full email", the earlier messages on request, read from
 * Gmail (the demo's fictional threads) only when asked for.
 */

// One demo sign-in for the file, in its own state file (demo entry is capped
// at 60 a minute across the suite).
const SIGNED_IN = resolve('test-results', 'followups-email-state.json');

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

const EMAIL_API = '**/api/follow-ups/email?*';

/** What a toggle's aria-controls names. */
async function controlled(page: Page, toggle: Locator): Promise<Locator> {
  const id = await toggle.getAttribute('aria-controls');
  expect(id).toBeTruthy();
  return page.locator(`[id="${id}"]`);
}

/** A Follow-ups row itself, never a message listed inside its open email. */
const row = (page: Page, section: string, who: string) =>
  page.getByRole('region', { name: section }).locator(':scope > ul > li').filter({ hasText: who });

test('a Follow-ups row opens its full email, four lines first, earlier messages on request', async ({
  page,
}) => {
  await page.goto('/follow-ups');
  const priya = row(page, "You're waiting on", 'Priya Natarajan');
  const show = priya.getByRole('button', { name: /^Show email/ });
  await expect(show).toBeVisible();
  // Nothing is read until it is asked for.
  await expect(priya.getByRole('region', { name: /^Email: / })).toHaveCount(0);
  await show.click();

  const email = priya.getByRole('region', { name: /^Email: / });
  await expect(email).toBeVisible();
  // Nick wrote last on a thread he is waiting on.
  await expect(email.getByText('(you)')).toBeVisible();
  // The row shows the subject in full on a computer, so the email does not repeat it.
  await expect(email.getByRole('heading')).toHaveCount(0);
  const full = email.getByRole('button', { name: 'Show full email' });
  const body = await controlled(page, full);
  await expect(body).toHaveCSS('-webkit-line-clamp', '4');
  await full.click();
  await expect(email.getByRole('button', { name: 'Show less' })).toBeVisible();
  await expect(body).toHaveCSS('-webkit-line-clamp', 'none');

  await email.getByRole('button', { name: 'Show earlier messages (1)' }).click();
  const earlier = await controlled(
    page,
    email.getByRole('button', { name: 'Hide earlier messages' }),
  );
  await expect(earlier.getByRole('listitem')).toHaveCount(1);
  await expect(earlier).toContainText('Priya Natarajan');

  // One email open at a time: opening Marcus's closes Priya's.
  const marcus = row(page, "You're waiting on", 'Marcus Webb');
  await marcus.getByRole('button', { name: /^Show email/ }).click();
  const marcusEmail = marcus.getByRole('region', { name: /^Email: / });
  await expect(marcusEmail).toBeVisible();
  await expect(email).toHaveCount(0);
  await expect(priya.getByRole('button', { name: /^Show email/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  // The second Hide email, at the foot of the email, closes it too.
  const hide = marcus.getByRole('button', { name: /^Hide email/ });
  await expect(hide).toHaveCount(2);
  await hide.last().click();
  await expect(marcusEmail).toHaveCount(0);

  // A meeting recap comes from Granola, not an email: no control.
  const recaps = page.getByRole('region', { name: 'Meeting recaps' });
  await expect(recaps.getByRole('listitem').first()).toBeVisible();
  await expect(recaps.getByRole('button', { name: /Show email/ })).toHaveCount(0);
});

test('the email session shows the email beside the reply, and the next one at once', async ({
  page,
}) => {
  await page.goto('/follow-ups/session');
  const card = page.getByRole('article', { name: 'Email from Dana Whitfield' });
  const email = card.getByRole('region', { name: /^Email: / });
  await expect(email).toBeVisible();
  const reply = card.getByRole('textbox', { name: 'Reply' });
  // Side by side on a wide screen: the reply is never pushed below the email.
  const emailBox = (await email.boundingBox())!;
  const replyBox = (await reply.boundingBox())!;
  expect(emailBox.x + emailBox.width).toBeLessThanOrEqual(replyBox.x);
  expect(replyBox.y).toBeLessThan(emailBox.y + 80);
  // The subject is the card's own line already, so it is not repeated.
  await expect(email.getByRole('heading')).toHaveCount(0);

  await email.getByRole('button', { name: 'Show earlier messages (2)' }).click();
  const earlier = await controlled(
    page,
    email.getByRole('button', { name: 'Hide earlier messages' }),
  );
  await expect(earlier.getByRole('listitem')).toHaveCount(2);
  // A demo attachment is named, not a link to a file that is not there.
  await expect(email.getByText('run-of-show.pdf')).toBeVisible();
  await expect(email.getByRole('link', { name: /run-of-show\.pdf/ })).toHaveCount(0);

  // L for later: the next card's email, read ahead, is there.
  await page.keyboard.press('l');
  const next = page.getByRole('article', { name: 'Email from Ledgerly Billing' });
  const nextEmail = next.getByRole('region', { name: /^Email: / });
  await expect(nextEmail).toBeVisible();

  // Answered from far down the card, the next card still opens at its top.
  await nextEmail.getByRole('button', { name: 'Show full email' }).click();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const heading = next.getByRole('heading', { level: 2 });
  expect((await heading.boundingBox())!.y).toBeLessThan(0);
  await next.getByRole('button', { name: 'Later' }).click();
  await expect(next).toHaveCount(0);
  const third = page.getByRole('article', { name: /^Email from / });
  await expect(third.getByRole('region', { name: /^Email: / })).toBeVisible();
  const thirdHeading = (await third.getByRole('heading', { level: 2 }).boundingBox())!;
  expect(thirdHeading.y).toBeGreaterThanOrEqual(0);
  expect(thirdHeading.y + thirdHeading.height).toBeLessThanOrEqual(page.viewportSize()!.height);

  // "Later" is saved in the suite's shared demo store. Put Dana and Ledgerly
  // back ("stop" keeps an email Nick's without parking it), so a retry, or a
  // later spec, finds the session as it started.
  const reset = await page.evaluate(async () => {
    const statuses: number[] = [];
    for (const id of ['0f0000000000c101', '0f0000000000c102']) {
      const res = await fetch('/api/email-session/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, answer: 'stop' }),
      });
      statuses.push(res.status);
    }
    return statuses;
  });
  expect(reset).toEqual([200, 200]);
});

test('on a phone the sender keeps to one line, the subject shows, the toggle is easy to tap', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/follow-ups/session');
  const email = page.getByRole('article', { name: /^Email from / }).getByRole('region', {
    name: /^Email: /,
  });
  await expect(email).toBeVisible();
  // The time drops below the name rather than the name breaking mid-word.
  const sender = email.locator('[data-sender]');
  expect(await sender.evaluate((el) => el.getClientRects().length)).toBe(1);

  await page.goto('/follow-ups');
  const priya = row(page, "You're waiting on", 'Priya Natarajan');
  const show = priya.getByRole('button', { name: /^Show email/ });
  const gmail = priya.getByRole('link', { name: /^Open in Gmail/ });
  // Hit-testing needs it on screen, clear of the bottom navigation.
  await show.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const showBox = (await show.boundingBox())!;
  const gmailBox = (await gmail.boundingBox())!;
  // The toggle answers a tap a little above and below its text, and the
  // Gmail link above it keeps its own.
  const hit = (x: number, y: number) =>
    page.evaluate(
      ([px, py]) => {
        const el = document.elementFromPoint(px!, py!);
        return el?.closest('button, a')?.textContent?.trim() ?? '';
      },
      [x, y],
    );
  const cx = showBox.x + showBox.width / 2;
  expect(await hit(cx, showBox.y - 8)).toBe('Show email');
  expect(await hit(cx, showBox.y + showBox.height + 8)).toBe('Show email');
  expect(await hit(gmailBox.x + gmailBox.width / 2, gmailBox.y + gmailBox.height - 2)).toBe(
    'Gmail',
  );

  await show.click();
  // The row cuts the subject short on a phone, so the email names it in full.
  await expect(
    priya
      .getByRole('region', { name: /^Email: / })
      .getByRole('heading', { name: 'Co-invest allocation on the Zeta round' }),
  ).toBeVisible();
});

test('a failed read says so, offers Try again only when it can help', async ({ page }) => {
  // Gmail busy: the app says it may pass.
  await page.route(EMAIL_API, (route) =>
    route.fulfill({
      status: 502,
      json: {
        ok: false,
        error: {
          code: 'provider_unavailable',
          message: "Gmail didn't answer.",
          retryable: true,
        },
      },
    }),
  );
  await page.goto('/follow-ups/session');
  const card = page.getByRole('article', { name: /^Email from / });
  await expect(card.getByText("Gmail didn't answer.")).toBeVisible();
  await expect(card.getByRole('link', { name: /^Open in Gmail/ })).toBeVisible();
  await expect(card.getByRole('link', { name: /^Open in Copilot/ })).toBeVisible();
  await page.unroute(EMAIL_API);
  await card.getByRole('button', { name: 'Try again' }).click();
  await expect(card.getByRole('region', { name: /^Email: / })).toBeVisible();

  // Gmail not connected: a 503, but trying again cannot fix that.
  await page.route(EMAIL_API, (route) =>
    route.fulfill({
      status: 503,
      json: {
        ok: false,
        error: {
          code: 'not_configured',
          message: "Gmail isn't connected, so the email can't be shown here.",
        },
      },
    }),
  );
  await page.goto('/follow-ups');
  const marcus = row(page, "You're waiting on", 'Marcus Webb');
  await marcus.getByRole('button', { name: /^Show email/ }).click();
  await expect(marcus.getByText("Gmail isn't connected")).toBeVisible();
  await expect(marcus.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});
