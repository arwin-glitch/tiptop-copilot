import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The proof check for tasks ticked by hand, and the company chip on tasks,
 * over the invented demo tasks.
 *
 * The demo has three deliverables a person ticked: the shortlist sent to
 * Maya was seen ("Seen sent"); the LP letter for Riley and the reply to Tom
 * were never sent, so the app's own check (run by the first Tasks view)
 * flags both "Ticked, not seen sent" on Completed and on Today, each with
 * "It's done" and "Reopen". Tasks this file creates start with "ZZ e2e" and
 * are deleted again; what a test changes in the demo it puts back, so the
 * specs after it see Completed as it was (the four demo rows).
 */

const SEEN = 'Send Maya the Series A investor shortlist';
const FLAG_DONE = 'Review the Q3 LP letter draft so Riley can send it';
const FLAG_REOPEN = 'Reply to Tom about the Girder AI reference list';
const LOOMSTACK = 'Send LoomStack pass note';
const PREFIX = 'ZZ e2e';

const SIGNED_IN = path.resolve('test-results', 'tasks-proof-check-state.json');

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

// Put back what a test (even one that failed partway) changed: the reply to
// Tom ticked again if it was left open, and every task this file made deleted.
test.afterEach(async ({ page }) => {
  await gotoTasks(page);
  const t = tabs(page);
  const tom = row(t.todoPanel, FLAG_REOPEN);
  if ((await tom.count()) > 0) {
    await tom.getByRole('button', { name: 'Mark complete' }).click();
    await expect(tom).toHaveCount(0);
  }
  const mine = row(t.todoPanel, PREFIX);
  for (let left = await mine.count(); left > 0; left--) {
    await menu(page, mine.first(), 'Delete');
    await expect(mine).toHaveCount(left - 1);
  }
});

async function gotoTasks(page: Page, url = '/tasks') {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
}

function tabs(page: Page) {
  return {
    todo: page.getByRole('tab', { name: /^To do/ }),
    completed: page.getByRole('tab', { name: /^Completed/ }),
    todoPanel: page.getByRole('tabpanel', { name: /^To do/ }),
    completedPanel: page.getByRole('tabpanel', { name: /^Completed/ }),
  };
}

function toast(page: Page, text: string) {
  return page.locator('[data-sonner-toast]').filter({ hasText: text });
}

function row(panel: Locator, title: string) {
  return panel.getByRole('listitem').filter({ hasText: title });
}

function chip(item: Locator) {
  return item.locator('[data-company-chip]');
}

async function menu(page: Page, item: Locator, entry: string) {
  await item.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: entry }).click();
}

function notSeenCard(page: Page) {
  return page.getByRole('region', { name: /^Ticked, not seen sent/ });
}

test('Completed says what was seen sent, and flags what was not', async ({ page }) => {
  await gotoTasks(page, '/tasks?view=completed');
  const t = tabs(page);
  await expect(t.completed).toHaveAccessibleName(/^Completed 4$/);

  const seen = row(t.completedPanel, SEEN);
  // The sent email, in Copilot or in Gmail.
  await expect(seen).toContainText(/Seen sent · email to Maya, [A-Z][a-z]{2} \d{1,2}/);
  const seenNote = seen.getByRole('link', {
    name: /^Open in Gmail: Seen sent · email to Maya, [A-Z][a-z]{2} \d{1,2}$/,
  });
  await expect(seenNote).toBeVisible();
  await expect(seenNote).toHaveAttribute('href', /^https:\/\/mail\.google\.com\/mail\/\?authuser=/);
  await expect(
    seen.getByRole('link', { name: /^Open in Copilot: Seen sent · email to Maya/ }),
  ).toHaveAttribute('href', /^\/inbox\?thread=[0-9a-f]+$/);
  await expect(seen.getByText('Ticked, not seen sent')).toHaveCount(0);
  await expect(seen.getByRole('button', { name: /^It's done/ })).toHaveCount(0);
  await expect(chip(seen)).toHaveText('Ledgerly');

  const riley = row(t.completedPanel, FLAG_DONE);
  await expect(riley.getByText('Ticked, not seen sent')).toBeVisible();
  await expect(riley).toContainText('no email to Riley seen since');
  await expect(riley.getByRole('button', { name: `It's done: ${FLAG_DONE}` })).toBeVisible();
  await expect(riley.getByRole('button', { name: `Reopen ${FLAG_DONE}` })).toBeVisible();
  await expect(chip(riley)).toHaveCount(0);

  const tom = row(t.completedPanel, FLAG_REOPEN);
  await expect(tom.getByText('Ticked, not seen sent')).toBeVisible();
  await expect(tom).toContainText('no email to Tom seen since');
  await expect(chip(tom)).toHaveText('Girder AI');
  await expect(chip(tom)).toHaveAttribute('href', /^\/deals\//);
});

test('Today lists the flagged tasks, and Reopen puts one back on To do', async ({ page }) => {
  await page.goto('/today');
  const card = notSeenCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: /^Ticked, not seen sent · 2$/ })).toBeVisible();
  await expect(card.getByRole('listitem')).toHaveCount(2);
  // Outside Top priorities and the glance cards.
  await expect(
    page.getByRole('region', { name: 'At a glance' }).getByText(FLAG_REOPEN),
  ).toHaveCount(0);

  const tom = card.getByRole('listitem').filter({ hasText: FLAG_REOPEN });
  await expect(chip(tom)).toHaveText('Girder AI');
  await tom.getByRole('button', { name: `Reopen ${FLAG_REOPEN}` }).click();
  await expect(toast(page, 'Reopened')).toBeVisible();
  await expect(card.getByRole('heading', { name: /^Ticked, not seen sent · 1$/ })).toBeVisible();

  await gotoTasks(page);
  const t = tabs(page);
  const open = row(t.todoPanel, FLAG_REOPEN);
  await expect(open).toBeVisible();
  // Ticked again it starts a new window: no flag. (afterEach would do the same.)
  await open.getByRole('button', { name: 'Mark complete' }).click();
  await expect(toast(page, 'Marked complete')).toBeVisible();
  await t.completed.click();
  const again = row(t.completedPanel, FLAG_REOPEN);
  await expect(again).toContainText('Completed just now');
  await expect(again.getByText('Ticked, not seen sent')).toHaveCount(0);
});

test("It's done clears the flag for good, here and on Today", async ({ page }) => {
  await gotoTasks(page, '/tasks?view=completed');
  const t = tabs(page);
  const riley = row(t.completedPanel, FLAG_DONE);
  await riley.getByRole('button', { name: `It's done: ${FLAG_DONE}` }).click();
  await expect(toast(page, 'Marked as done')).toBeVisible();
  await expect(riley.getByText('Ticked, not seen sent')).toHaveCount(0);
  await expect(riley.getByRole('button', { name: /^It's done/ })).toHaveCount(0);
  // Still done: "It's done" never reopens anything.
  await expect(t.completed).toHaveAccessibleName(/^Completed 4$/);

  await page.reload();
  await expect(
    row(tabs(page).completedPanel, FLAG_DONE).getByText('Ticked, not seen sent'),
  ).toHaveCount(0);
  await page.goto('/today');
  await expect(page.getByRole('heading', { name: /^Good day/ })).toBeVisible();
  await expect(notSeenCard(page)).toHaveCount(0);
});

test('task rows show their company, and Edit chooses or clears one', async ({ page }) => {
  await gotoTasks(page);
  const t = tabs(page);
  await expect(chip(row(t.todoPanel, LOOMSTACK))).toHaveText('LoomStack');

  const title = `${PREFIX} send the data-room checklist`;
  await page.getByRole('button', { name: 'New follow-up' }).click();
  const create = page.getByRole('dialog', { name: 'New follow-up' });
  await create.getByLabel('What needs doing').fill(title);
  await create.getByRole('button', { name: 'Create' }).click();
  await expect(toast(page, 'Follow-up created')).toBeVisible();
  const task = row(t.todoPanel, title);
  await expect(task).toBeVisible();
  await expect(chip(task)).toHaveCount(0);

  await menu(page, task, 'Edit…');
  const edit = page.getByRole('dialog', { name: 'Edit task' });
  await edit.getByLabel('Company').fill('quillm');
  await edit.getByRole('button', { name: /^Quillmark/ }).click();
  await expect(edit.getByRole('button', { name: 'Clear company Quillmark' })).toBeVisible();
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Task updated')).toBeVisible();
  await expect(chip(task)).toHaveText('Quillmark');
  await expect(chip(task)).toHaveAttribute('href', /^\/lists\/records\//);

  await menu(page, task, 'Edit…');
  await edit.getByRole('button', { name: 'Clear company Quillmark' }).click();
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Task updated')).toBeVisible();
  await expect(chip(task)).toHaveCount(0);
});

test("Today's due tasks show their company", async ({ page }) => {
  await page.goto('/today');
  const due = page.getByRole('button', { name: /^Tasks due/ });
  await expect(due).toBeVisible();
  if ((await due.getAttribute('aria-expanded')) !== 'true') await due.click();
  const section = page.locator(`[id="${await due.getAttribute('aria-controls')}"]`);
  const loom = section.getByRole('listitem').filter({ hasText: LOOMSTACK });
  await expect(chip(loom)).toHaveText('LoomStack');
  await expect(chip(loom)).toHaveAttribute('href', /^\/deals\//);
});
