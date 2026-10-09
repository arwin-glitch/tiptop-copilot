import { expect, test } from '@playwright/test';

/** Nick's first visit after his leave: a one-time card on Today, and a small first session. */

test('Today shows the welcome-back card once, and the session starts at 10 minutes', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);

  const card = page.getByRole('region', { name: 'Welcome back. Three things are new.' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('link', { name: 'Start →' })).toHaveAttribute(
    'href',
    '/follow-ups/session',
  );
  await page.screenshot({ path: 'test-results/welcome-back.png', fullPage: false });

  await card.getByRole('button', { name: 'Got it' }).click();
  await expect(card).toBeHidden();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Welcome back. Three things are new.' }),
  ).toHaveCount(0);

  await page.goto('/follow-ups/session');
  await expect(page.getByRole('button', { name: '10 min' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
