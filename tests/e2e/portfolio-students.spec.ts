import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Portfolio > Students & interns over the invented demo workspace: the
 * twice-weekly students scan's snapshot. Open items show by default, what is
 * on Arwin stands out and filters to itself, a close deadline is flagged,
 * filters live in the URL, and every source is only its two links (Copilot
 * or Gmail), never the email's text.
 */

const SIGNED_IN = path.resolve('test-results', 'portfolio-students-state.json');

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

test('Students sits right after Jobs and shows what is open, with what is on Arwin first to see', async ({
  page,
}) => {
  await page.goto('/portfolio?tab=jobs');
  const tabs = page.getByRole('navigation', { name: 'Portfolio sections' });
  const labels = (await tabs.getByRole('link').allInnerTexts()).map((t) => t.trim());
  const jobsAt = labels.findIndex((l) => l.startsWith('Jobs'));
  expect(labels[jobsAt + 1]).toMatch(/^Students & interns/);
  await tabs.getByRole('link', { name: /^Students & interns/ }).click();
  await page.waitForURL((url) => url.searchParams.get('tab') === 'students');

  const students = page.getByRole('region', { name: 'Students and interns' });
  for (const who of ['Tessa Marlow', 'Brightwater University', 'Lena Hart', 'Rafael Ortiz']) {
    await expect(students.getByRole('heading', { name: who })).toBeVisible();
  }
  // Done waits behind its own chip.
  await expect(students.getByRole('heading', { name: 'Halden Business School' })).toHaveCount(0);
  const status = students.getByRole('group', { name: 'Filter by status' });
  await expect(status.getByRole('link', { name: /^Open/ })).toHaveAttribute('aria-current', 'page');

  // The mentoring item's next step is Arwin's: its own badge, and the callout above.
  const tessa = students.getByRole('listitem').filter({ hasText: 'Tessa Marlow' }).first();
  await expect(tessa).toContainText('On Arwin');
  await expect(tessa).toContainText('Book the first 30-min call with Tessa');
  await expect(tessa).toContainText('Nick agreed to: Two 30-min calls');
  await expect(students).toContainText('1 open item has its next step on Arwin.');

  // The program's registration deadline is nine days out: flagged.
  const lab = students.getByRole('listitem').filter({ hasText: 'Venture Capital Lab' }).first();
  await expect(lab).toContainText('Due in 9 days');
  await expect(lab).toContainText('Waiting on Nick');

  await students.getByRole('link', { name: 'Show it' }).click();
  await page.waitForURL((url) => url.searchParams.get('owner') === 'arwin');
  await expect(students.getByRole('heading', { level: 3 })).toHaveCount(1);
  await expect(students.getByRole('heading', { name: 'Tessa Marlow' })).toBeVisible();
  await page.screenshot({ path: 'test-results/portfolio-students.png', fullPage: true });
});

test('kind, status and search filters live in the URL', async ({ page }) => {
  await page.goto('/portfolio?tab=students');
  const students = page.getByRole('region', { name: 'Students and interns' });

  await students
    .getByRole('group', { name: 'Filter by kind' })
    .getByRole('link', { name: /^Intern requests/ })
    .click();
  await page.waitForURL((url) => url.searchParams.get('kind') === 'intern_request');
  await expect(students.getByRole('heading', { level: 3 })).toHaveCount(2);
  const rafael = students.getByRole('listitem').filter({ hasText: 'Rafael Ortiz' }).first();
  await expect(rafael).toContainText('Replied');
  await expect(rafael).toContainText('Nick replied');
  const lena = students.getByRole('listitem').filter({ hasText: 'Lena Hart' }).first();
  await expect(lena).toContainText('New');
  await expect(lena).toContainText('No reply from Nick yet');

  await page.goto('/portfolio?tab=students&status=done');
  await expect(students.getByRole('heading', { name: 'Halden Business School' })).toBeVisible();
  await expect(students.getByRole('heading', { level: 3 })).toHaveCount(1);

  await page.goto('/portfolio?tab=students&status=all');
  await page.getByRole('searchbox', { name: 'Search students and programs' }).fill('coffee');
  await page.waitForURL((url) => url.searchParams.get('q') === 'coffee');
  await expect(students.getByRole('heading', { level: 3 })).toHaveCount(1);
  await expect(students.getByRole('heading', { name: 'Lena Hart' })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('status')).toBe('all');
});

test("a source is only its two links, and Copilot opens the thread in the Inbox's reading pane", async ({
  page,
}) => {
  await page.goto('/portfolio?tab=students');
  const students = page.getByRole('region', { name: 'Students and interns' });
  const tessa = students.getByRole('listitem').filter({ hasText: 'Tessa Marlow' }).first();

  const gmail = tessa.getByRole('link', {
    name: 'Open in Gmail: Mentoring this fall (Tessa Marlow)',
  });
  await expect(gmail).toHaveAttribute(
    'href',
    /^https:\/\/mail\.google\.com\/mail\/\?authuser=.+#all\/0f00000000005102$/,
  );
  await expect(gmail).toHaveAttribute('target', '_blank');
  // The email's text never comes along with the link.
  await expect(students).not.toContainText('Would two 30-minute calls work');
  await expect(students).not.toContainText('Happy to. Two 30-minute calls works.');

  await tessa
    .getByRole('link', { name: 'Open in Copilot: Mentoring this fall (Tessa Marlow)' })
    .click();
  await page.waitForURL(/\/inbox\?thread=0f00000000005102$/);
  const pane = page.getByRole('region', { name: 'Reading pane' });
  await expect(pane.getByRole('heading', { level: 2 })).toHaveText('Mentoring this fall');
  // Nick's reply, the newest message, opens; Tessa's ask sits above it.
  await expect(pane).toContainText('Happy to. Two 30-minute calls works.');
  await expect(pane.getByRole('button', { name: /^Tessa Marlow/ })).toBeVisible();
  await expect(pane.getByRole('link', { name: 'Open in Gmail' })).toBeVisible();
});
