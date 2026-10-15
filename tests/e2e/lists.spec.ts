import { expect, test, type Page } from '@playwright/test';

/**
 * Lists: the CRM that replaces Affinity, under Knowledge → Affinity lists.
 *
 * Demo mode only, against the invented lists in lib/demo/fixtures.ts (a deal
 * pipeline, an LP pipeline, a portfolio list, and one small list for each
 * other destination). What is asserted is the part a
 * unit test cannot see: that sorting and filtering really go through the
 * server and say so to assistive technology, that the board moves a card the
 * moment its status changes and the change survives a reload, that the side
 * panel and its note box work, and that a profile pulls a record's lists and
 * notes together.
 *
 * The suite shares one demo store, so the steps that write pick entries no
 * other step reads: Juniper Robotics changes status, Cobaltline gets a note,
 * Misc Imports is sent elsewhere and back.
 */

const LISTS = '/knowledge?tab=lists';

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

async function openDealPipeline(page: Page) {
  await page.goto(LISTS);
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Deal Pipeline/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Deal Pipeline' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await enterDemo(page);
});

test('Affinity lists sit under Knowledge, grouped by the page each one feeds', async ({ page }) => {
  await page.goto('/today');
  const nav = page.getByRole('navigation', { name: 'Main' }).first();
  // Lists left the main navigation.
  await expect(nav.getByRole('link', { name: 'Lists', exact: true })).toHaveCount(0);

  // The old address lands on the new tab.
  await page.goto('/lists');
  await page.waitForURL(/\/knowledge\?tab=lists$/);
  await expect(nav.getByRole('link', { name: 'Knowledge', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const tabs = page.getByRole('navigation', { name: 'Knowledge sections' });
  await expect(tabs.getByRole('link', { name: /^Affinity lists/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(tabs.getByRole('link', { name: /^Affinity import/ })).toHaveAttribute(
    'href',
    '/knowledge?tab=import',
  );

  const main = page.getByRole('main');
  // One group per page the lists feed, each linking to that page.
  const groups: [string, string | null][] = [
    ['Deals', '/deals'],
    ['Fund II', '/fund-ii'],
    ['Portfolio', '/portfolio'],
    ['Network', '/network'],
    ['Reference only', null],
  ];
  for (const [group, href] of groups) {
    const region = main.getByRole('region', { name: group, exact: true });
    await expect(region.getByRole('heading', { level: 2 })).toBeVisible();
    if (href) {
      await expect(region.getByRole('link', { name: `Open ${group}` })).toHaveAttribute(
        'href',
        href,
      );
    }
  }
  const deals = main.getByRole('region', { name: 'Deals', exact: true });
  await expect(deals.getByRole('link', { name: /^Deal Pipeline.*11 entries/ })).toBeVisible();
  await expect(deals.getByRole('link', { name: /^Climate Watch List/ })).toBeVisible();
  // The menu says what each list is, here the rules' choice.
  const where = deals.getByRole('combobox', { name: 'Where Deal Pipeline goes' });
  await expect(where).toHaveValue('');
  await expect(where.locator('option:checked')).toHaveText('Deal pipeline (auto)');
  await expect(
    main
      .getByRole('region', { name: 'Fund II', exact: true })
      .getByRole('link', { name: /^LP Pipeline.*5 entries/ }),
  ).toBeVisible();
  const portfolio = main.getByRole('region', { name: 'Portfolio', exact: true });
  await expect(portfolio.getByRole('link', { name: /^Portfolio.*4 entries/ })).toBeVisible();
  await expect(portfolio.getByRole('link', { name: /^Angel Investments/ })).toBeVisible();

  // The filter narrows by name and stays on the tab.
  await main.getByRole('searchbox', { name: 'Filter Affinity lists' }).pressSequentially('angel');
  await page.waitForURL(/q=angel/);
  await expect(main.getByRole('link', { name: /^Angel Investments/ })).toBeVisible();
  await expect(main.getByRole('link', { name: /^Deal Pipeline/ })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('tab')).toBe('lists');
});

test('a list is sent to another page by hand, and back to automatic', async ({ page }) => {
  await page.goto(LISTS);
  const main = page.getByRole('main');
  const reference = main.getByRole('region', { name: 'Reference only', exact: true });
  const network = main.getByRole('region', { name: 'Network', exact: true });
  await expect(reference.getByRole('link', { name: /^Misc Imports/ })).toBeVisible();

  await main
    .getByRole('combobox', { name: 'Where Misc Imports goes' })
    .selectOption({ label: 'Service providers' });
  await expect(page.getByText('Misc Imports now feeds Network')).toBeVisible();
  await expect(network.getByRole('link', { name: /^Misc Imports.*moved by hand/ })).toBeVisible();
  // No rule matched it, so the group it came from is gone.
  await expect(reference).toHaveCount(0);

  // Saved: still there after a reload, and the list's page says where it goes.
  await page.reload();
  await expect(
    page
      .getByRole('main')
      .getByRole('region', { name: 'Network', exact: true })
      .getByRole('link', { name: /^Misc Imports/ }),
  ).toBeVisible();
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Misc Imports/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Misc Imports' })).toBeVisible();
  await expect(page.getByText(/moved there by hand/)).toBeVisible();
  // The link lands on the tab that shows its rows, not the page's first tab.
  await expect(page.getByRole('main').getByRole('link', { name: 'Network' })).toHaveAttribute(
    'href',
    '/network?tab=providers',
  );

  // The breadcrumb leads back to the tab.
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Affinity lists' })
    .click();
  await page.waitForURL(/\/knowledge\?tab=lists$/);
  await page
    .getByRole('main')
    .getByRole('combobox', { name: 'Where Misc Imports goes' })
    .selectOption({ label: 'Reference only (auto)' });
  await expect(page.getByText('Misc Imports is kept here for reference only.')).toBeVisible();
  await expect(
    page
      .getByRole('main')
      .getByRole('region', { name: 'Reference only', exact: true })
      .getByRole('link', { name: /^Misc Imports/ }),
  ).toBeVisible();
});

test('a list sorts on the server, filters by status and searches', async ({ page }) => {
  await openDealPipeline(page);
  const table = page.getByRole('table');
  for (const column of ['Name', 'Status', 'Amount', 'Owners', 'Source Channel']) {
    await expect(table.getByRole('columnheader', { name: column })).toBeVisible();
  }
  await expect(table.locator('tbody tr')).toHaveCount(11);
  await expect(page.getByText('1–11 of 11')).toBeVisible();

  const name = table.getByRole('columnheader', { name: 'Name' });
  await name.getByRole('button').click();
  await page.waitForURL(/sort=title/);
  await expect(name).toHaveAttribute('aria-sort', 'ascending');
  const names = await table.locator('tbody th button').allInnerTexts();
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

  await name.getByRole('button').click();
  await page.waitForURL(/dir=desc/);
  await expect(name).toHaveAttribute('aria-sort', 'descending');
  await expect
    .poll(() => table.locator('tbody th button').allInnerTexts())
    .toEqual([...names].reverse());

  const chips = page.getByRole('group', { name: 'Filter by Status' });
  const diligence = chips.getByRole('button', { name: /^5\. Diligence/ });
  await diligence.click();
  await page.waitForURL(/status=/);
  await expect(diligence).toHaveAttribute('aria-pressed', 'true');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table.locator('tbody th button')).toHaveText(['Marrowgate Software', 'Cobaltline']);

  await page.getByRole('searchbox', { name: 'Search Deal Pipeline' }).pressSequentially('marrow');
  await page.waitForURL(/q=marrow/);
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table.locator('tbody th button')).toHaveText(['Marrowgate Software']);
});

test('the board lays out status columns and a status change moves the card', async ({ page }) => {
  await openDealPipeline(page);
  await page.getByRole('tab', { name: 'Board' }).click();
  await page.waitForURL(/view=board/);

  const board = page.getByRole('region', { name: 'Deal Pipeline by status' });
  await expect(board.getByRole('heading', { level: 2 })).toHaveText([
    /^1\. Sourced/,
    /^3\. First Meeting/,
    /^5\. Diligence/,
    /^10\. Invested/,
    /^Passed/,
  ]);

  const sourced = board.getByRole('region', { name: /^1\. Sourced/ });
  const meeting = board.getByRole('region', { name: /^3\. First Meeting/ });
  await expect(sourced.getByRole('button', { name: 'Juniper Robotics' })).toBeVisible();

  const select = board.getByRole('combobox', { name: 'Status for Juniper Robotics' });
  await select.selectOption('3. First Meeting');
  // Moved at once, before the save has come back.
  await expect(meeting.getByRole('button', { name: 'Juniper Robotics' })).toBeVisible();
  await expect(sourced.getByRole('button', { name: 'Juniper Robotics' })).toHaveCount(0);
  await expect(page.locator('p[aria-live="polite"]')).toHaveText(
    'Juniper Robotics: status set to 3. First Meeting.',
  );

  await page.reload();
  const reloaded = page.getByRole('region', { name: 'Deal Pipeline by status' });
  await expect(
    reloaded
      .getByRole('region', { name: /^3\. First Meeting/ })
      .getByRole('button', { name: 'Juniper Robotics' }),
  ).toBeVisible();
  await expect(reloaded.getByRole('combobox', { name: 'Status for Juniper Robotics' })).toHaveValue(
    '3. First Meeting',
  );
});

test('an entry opens a side panel with its fields and notes, and takes a new note', async ({
  page,
}) => {
  await openDealPipeline(page);
  await page.getByRole('table').getByRole('button', { name: 'Cobaltline' }).click();

  const panel = page.getByRole('dialog', { name: 'Cobaltline' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('link', { name: /Open profile/ })).toBeVisible();
  await expect(panel.getByText('Source Channel', { exact: true })).toBeVisible();
  await expect(panel.getByText('Diligence call', { exact: true })).toBeVisible();
  await expect(panel.getByText('Customer reference', { exact: true })).toBeVisible();

  const note = 'Security review booked for Thursday with the platform lead.';
  await panel.getByRole('textbox', { name: 'New note' }).fill(note);
  await panel.getByRole('button', { name: 'Add note' }).click();
  await expect(panel.getByText(note)).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'New note' })).toHaveValue('');

  // Saved, not just drawn: it is there after a reload too.
  await page.reload();
  await page.getByRole('table').getByRole('button', { name: 'Cobaltline' }).click();
  await expect(page.getByRole('dialog', { name: 'Cobaltline' }).getByText(note)).toBeVisible();
});

test('a profile shows every list a company is on and all its notes', async ({ page }) => {
  await page.goto(LISTS);
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Portfolio.*entries/ })
    .click();
  await page.getByRole('table').getByRole('button', { name: 'Hearthstone Payroll' }).click();
  await page
    .getByRole('dialog', { name: 'Hearthstone Payroll' })
    .getByRole('link', { name: /Open profile/ })
    .click();
  await page.waitForURL(/\/lists\/records\//);

  await expect(page.getByRole('heading', { level: 1, name: 'Hearthstone Payroll' })).toBeVisible();
  // A profile belongs to Knowledge now, with the way back to the lists.
  await expect(
    page
      .getByRole('navigation', { name: 'Main' })
      .first()
      .getByRole('link', { name: 'Knowledge', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', {
      name: 'Affinity lists',
    }),
  ).toHaveAttribute('href', '/knowledge?tab=lists');
  const lists = page.getByRole('region', { name: 'Lists' });
  await expect(lists.getByRole('link', { name: 'Deal Pipeline' })).toHaveCount(2);
  await expect(lists.getByRole('link', { name: 'Portfolio' })).toHaveCount(1);
  for (const status of ['10. Invested', '1. Sourced', 'Seed']) {
    await expect(lists.getByText(status, { exact: true })).toBeVisible();
  }
  await expect(lists.getByText(/Seed extension/)).toBeVisible();

  const notes = page.getByRole('region', { name: 'Notes' });
  await expect(notes.getByText('Board update')).toBeVisible();
  await expect(notes.getByText(/ARR up to \$1\.1M/)).toBeVisible();

  const gmail = page.getByRole('link', { name: 'Search Gmail' });
  await expect(gmail).toHaveAttribute('href', /mail\.google\.com.*hearthstone-payroll\.example/);
});

test('Ctrl+K finds CRM records under Lists and a profile links across to Portfolio', async ({
  page,
}) => {
  await page.goto(LISTS);
  await page.keyboard.press('Control+k');
  const search = page.getByRole('searchbox', { name: 'Search everything' });
  await search.fill('Ledgerly');

  const group = page.getByRole('group', { name: 'Lists' });
  await expect(group).toBeVisible();
  await group
    .getByRole('option', { name: /Ledgerly/ })
    .getByRole('button')
    .click();
  await page.waitForURL(/\/lists\/records\//);

  await expect(page.getByRole('heading', { level: 1, name: 'Ledgerly' })).toBeVisible();
  // The portfolio company shares its domain. (Earlier specs open /deals,
  // which mirrors the portfolio into Invested deals, so a deal may be listed
  // beside it; both are right.)
  const copilot = page.getByRole('region', { name: 'In Copilot' });
  const link = copilot.getByRole('link', { name: /^Ledgerly Portfolio/ });
  await expect(link).toHaveAttribute('href', /^\/portfolio\//);
  await expect(link).toContainText('same domain');
  await expect(page.getByText('Not on any list.')).toBeVisible();
});

test('hidden columns are remembered per list in this browser', async ({ page }) => {
  await openDealPipeline(page);
  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader', { name: 'Owners' })).toBeVisible();

  await page.getByRole('button', { name: /^Columns/ }).click();
  await page.getByRole('checkbox', { name: /Owners/ }).uncheck();
  await page.keyboard.press('Escape');
  await expect(table.getByRole('columnheader', { name: 'Owners' })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('table').getByRole('columnheader', { name: 'Amount' })).toBeVisible();
  await expect(page.getByRole('table').getByRole('columnheader', { name: 'Owners' })).toHaveCount(
    0,
  );

  await page.getByRole('button', { name: /^Columns/ }).click();
  await page.getByRole('button', { name: 'Show all' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('table').getByRole('columnheader', { name: 'Owners' })).toBeVisible();
});

test('"Add entry" adds a row with a status and opens it', async ({ page }) => {
  await openDealPipeline(page);
  await page.getByRole('button', { name: 'Add entry' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to Deal Pipeline' });
  await dialog.getByRole('textbox', { name: 'Deal name' }).fill('Tidewater Robotics — Seed');
  await dialog.getByRole('combobox', { name: 'Status' }).selectOption('1. Sourced');
  await dialog.getByRole('button', { name: 'Add entry' }).click();

  await expect(page.getByRole('dialog', { name: 'Tidewater Robotics — Seed' })).toBeVisible();
  await page.keyboard.press('Escape');
  const table = page.getByRole('table');
  await expect(table.getByRole('button', { name: 'Tidewater Robotics — Seed' })).toBeVisible();
  await expect(
    table.getByRole('combobox', { name: 'Status for Tidewater Robotics — Seed' }),
  ).toHaveValue('1. Sourced');
  await expect(page.getByText('1–12 of 12')).toBeVisible();
});

test('a status changed on a table row is saved and the chip counts follow', async ({ page }) => {
  await openDealPipeline(page);
  const chips = page.getByRole('group', { name: 'Filter by Status' });
  await expect(chips.getByRole('button', { name: /^Passed/ })).toHaveAccessibleName(/^Passed\s*2$/);

  const table = page.getByRole('table');
  await table.getByRole('combobox', { name: 'Status for Ferrowind Energy' }).selectOption('Passed');
  await expect(chips.getByRole('button', { name: /^Passed/ })).toHaveAccessibleName(/^Passed\s*3$/);

  await page.reload();
  await expect(
    page.getByRole('table').getByRole('combobox', { name: 'Status for Ferrowind Energy' }),
  ).toHaveValue('Passed');
});

test('a pipeline takes a stage nobody is in yet, in its place, and a list archives and comes back', async ({
  page,
}) => {
  await page.goto(LISTS);
  await page
    .getByRole('main')
    .getByRole('link', { name: /^LP Pipeline/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'LP Pipeline' })).toBeVisible();

  await page.getByRole('button', { name: 'Edit stages' }).click();
  const dialog = page.getByRole('dialog', { name: 'Stages of Status' });
  await dialog.getByRole('textbox', { name: 'New stage' }).fill('Meeting');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  // A new stage goes last; three moves put it after Contacted.
  for (let i = 0; i < 3; i++) {
    await dialog.getByRole('button', { name: 'Move Meeting up' }).click();
  }
  // An LP is committed, so that stage cannot be removed.
  await expect(dialog.getByRole('button', { name: 'Remove Committed' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Save stages' }).click();
  await expect(dialog).toBeHidden();

  const chips = page.getByRole('group', { name: 'Filter by Status' });
  await expect(chips.getByRole('button')).toHaveText([
    'All',
    /^Prospect/,
    /^Contacted/,
    /^Meeting\s*0$/,
    /^Soft Circle/,
    /^Committed/,
    /^Declined/,
  ]);

  // Archived, it leaves the lists; restored, it is back.
  await page.getByRole('button', { name: 'Archive list' }).click();
  await expect(page.getByRole('button', { name: 'Restore list' })).toBeVisible();
  await page.goto(LISTS);
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: /^LP Pipeline/ })).toBeHidden();
  await main.getByText('Archived lists').click();
  await main.getByRole('link', { name: /^LP Pipeline/ }).click();
  await page.getByRole('button', { name: 'Restore list' }).click();
  await expect(page.getByRole('button', { name: 'Archive list' })).toBeVisible();
  await page.goto(LISTS);
  await expect(page.getByRole('main').getByRole('link', { name: /^LP Pipeline/ })).toBeVisible();
});
