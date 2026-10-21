import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Portfolio > Jobs over the invented demo workspace: open roles founders keep
 * sending, from the weekly jobs scan's snapshot. Filters live in the URL, a
 * role's blurb copies for sharing, its source emails open in Gmail, and a
 * company's page counts its open roles and links to them.
 */

const SIGNED_IN = path.resolve('test-results', 'portfolio-jobs-state.json');

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

test('Jobs lists active roles first, filters by status and search, all in the URL', async ({
  page,
}) => {
  await page.goto('/portfolio');
  const tabs = page.getByRole('navigation', { name: 'Portfolio sections' });
  await tabs.getByRole('link', { name: /^Jobs/ }).click();
  await page.waitForURL((url) => url.searchParams.get('tab') === 'jobs');

  const jobs = page.getByRole('region', { name: 'Open roles at portfolio companies' });
  await expect(jobs.getByRole('heading', { name: 'VP Sales' })).toBeVisible();
  await expect(jobs.getByRole('heading', { name: 'Founding Engineer' })).toBeVisible();
  // Filled and closed roles wait behind their own chips.
  await expect(jobs.getByRole('heading', { name: 'Product Designer' })).toHaveCount(0);
  const status = jobs.getByRole('group', { name: 'Filter roles by status' });
  await expect(status.getByRole('link', { name: /^Active/ })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // One role's card: status, the founder's words, how often, who to send to.
  const founding = jobs.getByRole('listitem').filter({ hasText: 'Founding Engineer' }).first();
  await expect(founding).toContainText('Active');
  await expect(founding).toContainText('Three months in, two offers declined on comp');
  await expect(founding).toContainText('Sent 5 times');
  await expect(founding.getByRole('link', { name: 'dev@stonebridgeops.demo' })).toHaveAttribute(
    'href',
    'mailto:dev@stonebridgeops.demo',
  );
  await expect(founding.getByRole('link', { name: /^Job posting/ })).toHaveAttribute(
    'href',
    'https://stonebridgeops.demo/jobs/founding-engineer',
  );

  // Source emails open in Nick's mailbox in Gmail.
  await founding.getByText('Source emails (3)').click();
  const sources = founding.getByRole('list', { name: /^Source emails for Founding Engineer/ });
  await expect(sources.getByRole('link').first()).toHaveAttribute(
    'href',
    /^https:\/\/mail\.google\.com\/mail\/\?authuser=.+#all\/0f0000000000b201$/,
  );

  await status.getByRole('link', { name: /^Filled/ }).click();
  await page.waitForURL((url) => url.searchParams.get('status') === 'filled');
  await expect(jobs.getByRole('heading', { name: 'Product Designer' })).toBeVisible();
  await expect(jobs.getByRole('heading', { name: 'VP Sales' })).toHaveCount(0);
  await expect(jobs).toContainText('Hired, starts on the 3rd');

  await status.getByRole('link', { name: /^All/ }).click();
  await page.waitForURL((url) => url.searchParams.get('status') === 'all');
  await page.getByRole('searchbox', { name: 'Search open roles' }).fill('founding');
  await page.waitForURL((url) => url.searchParams.get('q') === 'founding');
  await expect(jobs.getByRole('heading', { level: 3 })).toHaveCount(1);
  await expect(jobs.getByRole('heading', { name: 'Founding Engineer' })).toBeVisible();
  // The status filter survives the search.
  expect(new URL(page.url()).searchParams.get('status')).toBe('all');
});

test('Copy blurb puts the role, company, place and link on the clipboard', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/portfolio?tab=jobs');
  await page
    .getByRole('button', { name: 'Copy blurb: Founding Engineer at Stonebridge Ops' })
    .click();
  await expect(page.getByText('Copied. Paste it wherever you are sharing the role.')).toBeVisible();
  // Windows' clipboard hands lines back with CRLF endings.
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.replace(/\r\n/g, '\n')).toBe(
    'Founding Engineer at Stonebridge Ops\nAustin, TX · Remote\nhttps://stonebridgeops.demo/jobs/founding-engineer',
  );
});

test("a company's page counts its open roles and links to them on Jobs", async ({ page }) => {
  await page.goto('/portfolio?tab=companies');
  await page.getByRole('link', { name: /^Ledgerly/ }).click();
  await page.waitForURL(/\/portfolio\/[0-9a-f-]+$/);

  // The role the founder dropped from the latest update is not counted as open.
  const open = page.getByRole('link', { name: 'Open roles (1)' });
  await expect(open).toBeVisible();
  await expect(page.getByRole('list', { name: 'Open roles' })).toContainText('VP Sales');
  await open.click();
  await page.waitForURL(
    (url) =>
      url.searchParams.get('tab') === 'jobs' && url.searchParams.get('company') === 'Ledgerly',
  );
  const jobs = page.getByRole('region', { name: 'Open roles at portfolio companies' });
  await expect(jobs.getByRole('heading', { level: 3 })).toHaveCount(1);
  await expect(jobs.getByRole('heading', { name: 'VP Sales' })).toBeVisible();
  const company = jobs.getByRole('group', { name: 'Filter roles by company' });
  await expect(company.getByRole('link', { name: /^Ledgerly/ })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Probably filled shows the role that went quiet, still filtered to the company.
  await jobs
    .getByRole('group', { name: 'Filter roles by status' })
    .getByRole('link', { name: /^Probably filled/ })
    .click();
  await page.waitForURL((url) => url.searchParams.get('status') === 'probably_filled');
  await expect(jobs.getByRole('heading', { name: 'Senior Data Engineer' })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('company')).toBe('Ledgerly');
});
