import { expect, test, type Page } from '@playwright/test';

/**
 * Relationship intelligence on record profiles, lists and Network.
 *
 * Demo mode only, against the invented relationship history in
 * lib/demo/relationship-fixtures.ts and the CRM fixtures it matches: a strong
 * founder relationship (Ada Brennan at Brindle Health), the investor who
 * introduced her, an LP and a family office going quiet, and a company with
 * no mail at all whose last contact comes from Affinity. What is asserted is
 * what a unit test cannot see: the panels render with their evidence, links
 * go where they say, and the optional list columns arrive when turned on.
 */

// Fixed demo ids (demoCrmId('record', n) = 1700 + n, in hex).
const ADA = '/lists/records/00000000-0000-4000-8000-0000000006b4';
const BRINDLE = '/lists/records/00000000-0000-4000-8000-0000000006a4';
const GULLWING = '/lists/records/00000000-0000-4000-8000-0000000006a7';

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

test.beforeEach(async ({ page }) => {
  await enterDemo(page);
});

test('a person’s profile shows the relationship panel with its evidence', async ({ page }) => {
  await page.goto(ADA);
  await expect(page.getByRole('heading', { level: 1, name: 'Ada Brennan' })).toBeVisible();

  const panel = page.getByRole('region', { name: 'Relationship' });
  await expect(panel.locator('[data-strength="strong"]')).toBeVisible();
  await expect(panel.getByTestId('relationship-evidence')).toContainText(
    /5 threads, last .+; 3 meetings, last .+; next meeting/,
  );

  // The arithmetic is one click away and adds up to the number shown.
  await panel.getByText(/^Why \d+\?$/).click();
  const why = panel.getByRole('table', { name: 'How the relationship score was counted' });
  await expect(why).toBeVisible();
  await expect(why.getByRole('rowheader', { name: '5 two-way threads' })).toBeVisible();
  await expect(why.getByRole('rowheader', { name: '3 meetings held' })).toBeVisible();

  await expect(panel.locator('[data-smart-field="next_meeting"]')).not.toContainText('—');
  await expect(panel.locator('[data-smart-field="first_email"]')).not.toContainText('Affinity');

  // A thread in the timeline, in Kraken's Inbox or in Gmail.
  const thread = panel.getByRole('link', {
    name: 'Open in Gmail: Customer reference for diligence',
  });
  await expect(thread).toHaveAttribute('href', /mail\.google\.com.*#all\/de0a000000000005$/);
  await expect(thread).toHaveAttribute('target', '_blank');
  await expect(
    panel.getByRole('link', { name: 'Open in Kraken: Customer reference for diligence' }),
  ).toHaveAttribute('href', '/inbox?thread=de0a000000000005');
});

test('a company’s profile shows who Nick knows there and who can intro', async ({ page }) => {
  await page.goto(BRINDLE);
  await expect(page.getByRole('heading', { level: 1, name: 'Brindle Health' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Relationship' }).locator('[data-strength="strong"]'),
  ).toBeVisible();

  const intro = page.getByRole('region', { name: 'Who can intro' });
  await expect(intro.getByRole('link', { name: 'Ada Brennan' })).toHaveAttribute('href', ADA);
  await expect(intro.getByText('Cyrus Vale', { exact: true })).toBeVisible();
  await expect(intro.getByText('Hana Kuroda', { exact: true })).toBeVisible();
  // The deeper Gmail lookup Fund II uses is still one click away.
  await expect(intro.getByRole('button', { name: 'Who can intro?' })).toBeVisible();
});

test('with no mail, the profile shows no score and Affinity’s last contact, marked', async ({
  page,
}) => {
  await page.goto(GULLWING);
  const panel = page.getByRole('region', { name: 'Relationship' });
  // Nothing on record is not a zero: no number, no meter, and the reason in words.
  const unscored = panel.getByTestId('relationship-unscored');
  await expect(unscored).toContainText('No score yet');
  await expect(unscored).toContainText('Affinity last recorded contact on');
  await expect(panel).not.toContainText('/ 100');
  await expect(panel.locator('[data-strength]')).toHaveCount(0);
  await expect(panel.locator('[data-smart-field="last_contact"]')).toContainText('from Affinity');
});

test('Network shows strength badges and its own going-cold list', async ({ page }) => {
  await page.goto('/network?tab=people');
  const row = page.getByRole('row', { name: /Ada Brennan/ });
  await expect(row.locator('[data-strength="strong"]')).toBeVisible();

  await page.goto('/network?tab=cold');
  const main = page.getByRole('main');
  await expect(main.getByText('Desmond Achterberg', { exact: true })).toBeVisible();
  await expect(main.getByText('Maren Solberg', { exact: true })).toBeVisible();

  await main.getByRole('link', { name: '90 days' }).click();
  await page.waitForURL(/days=90/);
  await expect(main.getByText('Desmond Achterberg', { exact: true })).toHaveCount(0);
});

test('a list can show relationship columns for the rows on screen', async ({ page }) => {
  await page.goto('/lists');
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Deal Pipeline/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Deal Pipeline' })).toBeVisible();

  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader', { name: 'Strength' })).toHaveCount(0);

  await page.getByRole('button', { name: /^Relationship/ }).click();
  await page.getByRole('checkbox', { name: 'Strength' }).check();
  await page.getByRole('checkbox', { name: 'Last contact' }).check();
  await page.keyboard.press('Escape');

  await expect(table.getByRole('columnheader', { name: 'Strength' })).toBeVisible();
  const brindle = table.getByRole('row', { name: /Brindle Health/ });
  await expect(brindle.locator('[data-strength="strong"]')).toBeVisible();
  const gullwing = table.getByRole('row', { name: /Gullwing Logistics/ });
  await expect(gullwing.locator('[data-relationship-column="last_contact"]')).toContainText(
    'Affinity',
  );
});

test('a failed load of the relationship columns says so and can be retried', async ({ page }) => {
  let fail = true;
  await page.route(/\/api\/crm\/relationships\?/, async (route) => {
    if (!fail) return route.fallback();
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: { code: 'provider_unavailable', message: "Mail and calendar couldn't be read." },
      }),
    });
  });
  await page.goto('/lists');
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Deal Pipeline/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Deal Pipeline' })).toBeVisible();
  await page.getByRole('button', { name: /^Relationship/ }).click();
  await page.getByRole('checkbox', { name: 'Strength' }).check();
  await page.keyboard.press('Escape');

  // Never a row of dashes that reads as "no relationship".
  const alert = page.getByTestId('relationship-columns-error');
  await expect(alert).toContainText("Mail and calendar couldn't be read.");
  const brindle = page.getByRole('table').getByRole('row', { name: /Brindle Health/ });
  await expect(brindle.locator('[data-relationship-column="strength"]')).toContainText(
    'Unavailable',
  );

  fail = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(brindle.locator('[data-strength="strong"]')).toBeVisible();
  await expect(alert).toHaveCount(0);

  // Leave the columns off for the next test, as the list started.
  await page.getByRole('button', { name: /^Relationship/ }).click();
  await page.getByRole('checkbox', { name: 'Strength' }).uncheck();
  await page.keyboard.press('Escape');
});
