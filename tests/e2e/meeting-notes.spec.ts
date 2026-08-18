import { expect, test, type Page } from '@playwright/test';

/**
 * Meeting notes from Granola, as the reader meets them.
 *
 * The ingestion path is covered at the service level; what these assert is the
 * surfacing contract — a note appears on the company and deal it belongs to,
 * names its provenance, and renders its body as text. The fixtures contain one
 * note for the Ledgerly portfolio company and one for the Girder AI deal, both
 * linked by attendee domain exactly the way a webhook delivery would be.
 */

const DEMO = {
  girderDeal: '00000000-0000-4000-8000-000000000065',
  ledgerly: '00000000-0000-4000-8000-0000000000c8',
};

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

test.beforeEach(async ({ page }) => {
  await enterDemo(page);
});

test('a portfolio company shows its meeting notes, with provenance', async ({ page }) => {
  await page.goto(`/portfolio/${DEMO.ledgerly}`);
  await expect(page.getByRole('heading', { name: 'Ledgerly' })).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Meetings' })).toBeVisible();
  await expect(page.getByText('Ledgerly — pre-board sync with Maya')).toBeVisible();
  // Where it came from is stated, not implied.
  await expect(page.getByText('from Granola').first()).toBeVisible();

  // The body is behind a disclosure and renders as text.
  await page.getByText('Read the note').first().click();
  await expect(page.getByText(/14 months at current burn/)).toBeVisible();
});

test('a deal shows its meeting notes under Sources', async ({ page }) => {
  await page.goto(`/deals/${DEMO.girderDeal}`);
  await expect(page.getByRole('heading', { name: 'Girder AI' })).toBeVisible();

  await page.getByRole('tab', { name: 'Sources' }).click();
  await expect(page.getByText('Girder AI — reference call debrief with Tom')).toBeVisible();
  await expect(page.getByText('Tom Whitfield', { exact: false }).first()).toBeVisible();
});

test('a company with no notes says so instead of showing a blank', async ({ page }) => {
  // Stonebridge has no fixture note.
  await page.goto('/portfolio');
  await page.getByRole('link', { name: 'Stonebridge Ops', exact: true }).click();
  await page.waitForURL(/\/portfolio\//);

  await expect(page.getByText('No meeting notes yet')).toBeVisible();
});
