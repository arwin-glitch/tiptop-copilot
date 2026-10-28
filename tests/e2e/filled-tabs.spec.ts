import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Three tabs that read as empty although the data was there, filled from it
 * in the invented demo workspace:
 *  - Portfolio > Companies: each company's contacts from Affinity and the
 *    mail, with where each came from, and the last contact.
 *  - Portfolio > Requests: the asks in a company's own update email, read
 *    word for word, with who in the network could help (Affinity included).
 *  - Knowledge > Contacts: the imported contacts and Affinity's people
 *    counted together, linked to where Affinity's are listed.
 */

const SIGNED_IN = path.resolve('test-results', 'filled-tabs-state.json');

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

test('Portfolio > Companies shows contacts with where they came from', async ({ page }) => {
  await page.goto('/portfolio?tab=companies');
  const ledgerly = page.getByRole('link', { name: /^Ledgerly/ });
  await expect(ledgerly).toContainText('Maya Chen, CEO (from Affinity and your mail)');
  await expect(ledgerly).toContainText('Lena Ortiz (from your mail)');
  // A role inbox at the company's domain is never a contact.
  await expect(ledgerly).not.toContainText('hello@ledgerly.demo');
  await expect(ledgerly).toContainText(/Last contact /);

  const stonebridge = page.getByRole('link', { name: /^Stonebridge Ops/ });
  await expect(stonebridge).toContainText('Jonas Reyes (from your mail)');
  await expect(page.getByText('No contact recorded')).toHaveCount(0);

  // The profile lists every contact with its source.
  await ledgerly.click();
  await page.waitForURL(/\/portfolio\/[0-9a-f-]+$/);
  const contacts = page.getByRole('list', { name: 'Contacts' });
  await expect(contacts).toContainText('Lena Ortiz');
  await expect(contacts).toContainText('lena@ledgerly.demo · from your mail');
});

test('Portfolio > Requests shows asks read from an update, with who could help', async ({
  page,
}) => {
  await page.goto('/portfolio?tab=requests');
  // One card per update email: Ledgerly's two asks share one, in the order written.
  const asks = page.getByRole('list', { name: 'Asks from Ledgerly' });
  await expect(asks.getByRole('listitem').first()).toContainText(
    'Intros to Series A leads who know vertical AI in professional services',
  );
  const card = page.getByRole('listitem').filter({ has: asks });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Read from their update · 2 asks');
  await expect(card).toContainText('Under “Asks” in');
  // The update email offers both places to read it.
  await expect(
    card.getByRole('link', { name: /^Open in Gmail: .*Ledgerly October update/ }),
  ).toHaveAttribute('href', /mail\.google\.com/);
  await expect(
    card.getByRole('link', { name: /^Open in Kraken: .*Ledgerly October update/ }),
  ).toHaveAttribute('href', /^\/inbox\?thread=[0-9a-f]+$/);
  // One reply to the thread, and one click closes every ask on the card.
  await expect(card.getByRole('button', { name: 'Draft reply' })).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'Dismiss all' })).toBeVisible();

  const ask = asks
    .getByRole('listitem')
    .filter({ hasText: 'Intros to Series A leads who know vertical AI in professional services' });
  await expect(ask).toHaveCount(1);
  await expect(ask).toContainText('Investor introduction');

  // Who could help draws on Affinity's people too, each with the reason.
  const helpers = ask.getByRole('list', { name: 'Who could help Ledgerly' });
  await expect(helpers).toContainText('Hana Kuroda');
  await expect(helpers).toContainText('from Affinity');
  await expect(helpers).toContainText('On “Co-investor VCs” (Investors) in Affinity');

  // Stonebridge's numbered "How you can help:" list is read too; its signature is not.
  await expect(
    page.getByText('Referrals for a founding engineer with Rust and logistics experience'),
  ).toBeVisible();
  await expect(page.getByText('COO, Stonebridge Ops', { exact: true })).toHaveCount(0);

  // One ask dismissed on its own; the other stays open. Dismissed stays
  // dismissed: another view never reopens it.
  await ask.getByRole('button', { name: /^Dismiss the ask: Intros to Series A leads/ }).click();
  await expect(ask).toHaveCount(0);
  await expect(asks).toContainText('A VP Sales candidate who has sold into accounting firms');
  await page.reload();
  await expect(
    page.getByText('Intros to Series A leads who know vertical AI in professional services'),
  ).toHaveCount(0);
});

test('Knowledge > Contacts counts the network, Affinity included', async ({ page }) => {
  await page.goto('/knowledge?tab=contacts');
  await expect(
    page.getByText(/people for introductions: 4 you imported and \d+ from Affinity/),
  ).toBeVisible();
  const lists = page.getByRole('list', { name: 'Affinity lists that feed introductions' });
  await expect(lists.getByRole('link', { name: /^Investors/ })).toBeVisible();
  await expect(lists.getByRole('link', { name: /^Portfolio founders/ })).toBeVisible();
  // The imported contacts are still listed as before.
  await expect(page.getByRole('table', { name: 'Network contacts' })).toContainText(
    'Daniel Okafor',
  );

  await page.getByRole('searchbox', { name: 'Search contacts' }).fill('Kuroda');
  await expect(
    page.getByText(/1 person from Affinity in your introductions network matches “Kuroda”/),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Show them' }).click();
  await page.waitForURL(/\/network\?.*source=affinity/);
  await expect(page.getByRole('table', { name: 'People from Affinity' })).toContainText(
    'Hana Kuroda',
  );
});
