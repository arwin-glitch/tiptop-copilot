import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Task basics and the Money & legal tab, over the invented demo tasks.
 *
 * The demo has two money and legal tasks: a side letter quiet for ten days
 * (going stale) and a wire the auto-check called done on a booked call, which
 * proves nothing (needs proof). A money or legal task closes on proof. Any
 * task can be edited, assigned, snoozed to a chosen day and deleted, each
 * from its menu. Tasks this file creates start with "ZZ e2e" and are deleted
 * again, so the specs after it see the demo as it was.
 */

const SIDE_LETTER = 'Countersign the Quarrystone side letter';
const WIRE = 'Confirm the Tidewell pro-rata wire went out';
const LOOMSTACK = 'Send LoomStack pass note';
const PREFIX = 'ZZ e2e';

// One demo sign-in for the whole file: demo entry is capped at 60 a minute
// across the suite.
const SIGNED_IN = path.resolve('test-results', 'tasks-money-legal-state.json');

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

// Put back what a test (even one that failed partway) changed: the side
// letter reopened, and every task this file made deleted.
test.afterEach(async ({ page }) => {
  await gotoTasks(page, '/tasks?view=completed');
  const t = tabs(page);
  const reopen = t.completedPanel
    .getByRole('listitem')
    .filter({ hasText: new RegExp(`${SIDE_LETTER}|${PREFIX}`) })
    .getByRole('button', { name: /^Reopen / });
  for (let left = await reopen.count(); left > 0; left--) {
    await reopen.first().click();
    await expect(reopen).toHaveCount(left - 1);
  }
  await t.todo.click();
  await deleteAll(page, t.todoPanel);
  await t.snoozed.click();
  await deleteAll(page, t.snoozedPanel);
});

async function gotoTasks(page: Page, url = '/tasks') {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
}

function tabs(page: Page) {
  return {
    todo: page.getByRole('tab', { name: /^To do/ }),
    snoozed: page.getByRole('tab', { name: /^Snoozed/ }),
    completed: page.getByRole('tab', { name: /^Completed/ }),
    money: page.getByRole('tab', { name: /^Money & legal/ }),
    todoPanel: page.getByRole('tabpanel', { name: /^To do/ }),
    snoozedPanel: page.getByRole('tabpanel', { name: /^Snoozed/ }),
    completedPanel: page.getByRole('tabpanel', { name: /^Completed/ }),
    moneyPanel: page.getByRole('tabpanel', { name: /^Money & legal/ }),
  };
}

function toast(page: Page, text: string) {
  return page.locator('[data-sonner-toast]').filter({ hasText: text });
}

function row(panel: Locator, title: string) {
  return panel.getByRole('listitem').filter({ hasText: title });
}

/**
 * Opens a row's menu and picks an entry, from the keyboard: a menu opened on
 * a low row ends under the bottom-right toasts (8-second Undo ones among
 * them), and a pointer resting on a toast pauses it, so a click there would
 * wait for a toast that never leaves.
 */
async function menu(page: Page, item: Locator, entry: string) {
  await item.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: entry }).press('Enter');
}

async function deleteAll(page: Page, panel: Locator) {
  const rows = row(panel, PREFIX);
  for (let left = await rows.count(); left > 0; left--) {
    await menu(page, rows.first(), 'Delete');
    await expect(rows).toHaveCount(left - 1);
  }
}

async function createTask(page: Page, title: string) {
  await page.getByRole('button', { name: 'New follow-up' }).click();
  const dialog = page.getByRole('dialog', { name: 'New follow-up' });
  await dialog.getByLabel('What needs doing').fill(title);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(toast(page, 'Follow-up created')).toBeVisible();
}

/** A day `days` from now as the date picker takes it, in the browser's own zone. */
function dayFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

test('Money & legal keeps the demo money items, with why, what needs proof and what is going stale', async ({
  page,
}) => {
  await gotoTasks(page, '/tasks?view=money');
  const t = tabs(page);
  await expect(t.money).toHaveAttribute('aria-selected', 'true');
  await expect(t.money).toHaveAccessibleName(/^Money & legal 2$/);

  await expect(t.moneyPanel.getByRole('heading', { name: /^Needs proof/ })).toBeVisible();
  const wire = row(t.moneyPanel, WIRE);
  await expect(wire).toContainText('The auto-check marked it done · meeting booked');
  await expect(wire).toContainText('A call about the wire is booked for Thursday.');
  await expect(wire.getByText('Needs proof', { exact: true })).toBeVisible();
  await expect(wire.getByRole('button', { name: 'Close with proof' })).toBeVisible();

  const side = row(t.moneyPanel, SIDE_LETTER);
  await expect(side.getByText('Going stale · 10 days quiet')).toBeVisible();

  // The same marks on To do, where the rest of the list is.
  await t.todo.click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(
    row(t.todoPanel, SIDE_LETTER).getByText('Money & legal', { exact: true }),
  ).toBeVisible();
  await expect(row(t.todoPanel, LOOMSTACK).getByText('Money & legal', { exact: true })).toHaveCount(
    0,
  );
});

test('closing a money task asks for proof, and the proof shows where it was closed', async ({
  page,
}) => {
  await gotoTasks(page, '/tasks?view=money');
  const t = tabs(page);
  await row(t.moneyPanel, SIDE_LETTER).getByRole('button', { name: 'Mark complete' }).click();

  const dialog = page.getByRole('dialog', { name: 'Close with proof' });
  await expect(dialog).toBeVisible();
  const submit = dialog.getByRole('button', { name: 'Close with proof' });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('Link to the proof').fill('https://mail.example.com/mail/proof-1');
  await dialog.getByLabel('Note', { exact: true }).fill('Countersigned copy sent back');
  await submit.click();
  await expect(toast(page, 'Closed with proof')).toBeVisible();
  await expect(dialog).toHaveCount(0);

  const closed = row(t.moneyPanel, SIDE_LETTER);
  await expect(
    closed.getByRole('link', { name: /Closed with proof · mail\.example\.com/ }),
  ).toHaveAttribute('href', 'https://mail.example.com/mail/proof-1');
  await expect(t.money).toHaveAccessibleName(/^Money & legal 1$/);

  await t.completed.click();
  const done = row(t.completedPanel, SIDE_LETTER);
  await expect(done).toContainText('Closed with proof · mail.example.com');
  await expect(done).toContainText('Countersigned copy sent back');
});

test('"Not done" keeps a task the auto-check called done open, off Needs proof', async ({
  page,
}) => {
  await gotoTasks(page, '/tasks?view=money');
  const t = tabs(page);
  await row(t.moneyPanel, WIRE)
    .getByRole('button', { name: `Not done: ${WIRE}` })
    .click();
  await expect(toast(page, 'Kept open')).toBeVisible();
  await expect(t.moneyPanel.getByRole('heading', { name: /^Needs proof/ })).toHaveCount(0);
  await expect(row(t.moneyPanel, WIRE)).toBeVisible();
  await expect(row(t.moneyPanel, WIRE).getByText('Needs proof', { exact: true })).toHaveCount(0);
});

test('a task can be edited, assigned and filtered, snoozed to a day, and deleted with Undo', async ({
  page,
}) => {
  await gotoTasks(page);
  const t = tabs(page);
  await createTask(page, `${PREFIX} plan the team offsite`);
  await expect(row(t.todoPanel, `${PREFIX} plan the team offsite`)).toBeVisible();

  // Edit.
  await menu(page, row(t.todoPanel, `${PREFIX} plan the team offsite`), 'Edit…');
  const edit = page.getByRole('dialog', { name: 'Edit task' });
  await edit.getByLabel('What needs doing').fill(`${PREFIX} plan the spring offsite`);
  await edit.getByLabel('Detail').fill('Two days, near the office');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Task updated')).toBeVisible();
  const task = row(t.todoPanel, `${PREFIX} plan the spring offsite`);
  await expect(task).toContainText('Two days, near the office');

  // Assign, then filter by person.
  await task.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitemradio', { name: 'Riley Moreno' }).click();
  await expect(toast(page, 'Assigned to Riley')).toBeVisible();
  await expect(task).toContainText('· Riley');

  const who = t.todoPanel.getByRole('group', { name: 'Whose tasks' });
  await who.getByRole('button', { name: 'Riley', exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\?who=/);
  await expect(task).toBeVisible();
  await expect(row(t.todoPanel, LOOMSTACK)).toHaveCount(0);
  await who.getByRole('button', { name: 'Everyone' }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(row(t.todoPanel, LOOMSTACK)).toBeVisible();

  // Snooze to a chosen day: off To do, onto Snoozed with its wake date.
  await menu(page, task, 'Snooze until…');
  const snooze = page.getByRole('dialog', { name: 'Snooze until' });
  await snooze.getByLabel('Wake on').fill(dayFromNow(10));
  await snooze.getByRole('button', { name: 'Snooze', exact: true }).click();
  await expect(toast(page, 'Snoozed until')).toBeVisible();
  await expect(task).toHaveCount(0);

  await t.snoozed.click();
  const asleep = row(t.snoozedPanel, `${PREFIX} plan the spring offsite`);
  await expect(asleep).toContainText(/Wakes .+ · (9|10|11)d from now/);

  // Delete, Undo puts it back where it was, then delete it for good.
  await menu(page, asleep, 'Delete');
  await expect(asleep).toHaveCount(0);
  await toast(page, 'Task deleted').getByRole('button', { name: 'Undo' }).click();
  await expect(toast(page, 'Snoozed again')).toBeVisible();
  await expect(asleep).toBeVisible();
  // The clicked toast hands focus back as it closes, which would close a menu opened under it.
  await expect(toast(page, 'Task deleted')).toHaveCount(0);
  await menu(page, asleep, 'Delete');
  await expect(asleep).toHaveCount(0);
});

test('a keyword puts a new task on Money & legal, and its toggle takes it off', async ({
  page,
}) => {
  await gotoTasks(page);
  const t = tabs(page);
  const title = `${PREFIX} send the wire for the Brightkiln SPV`;
  await createTask(page, title);
  await expect(row(t.todoPanel, title).getByText('Money & legal', { exact: true })).toBeVisible();

  await t.money.click();
  await expect(page).toHaveURL(/\/tasks\?view=money$/);
  const item = row(t.moneyPanel, title);
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Money & legal' }).click();
  await expect(toast(page, 'Taken off Money & legal')).toBeVisible();
  await expect(item).toHaveCount(0);

  // Off the tab, an ordinary Mark complete closes it.
  await t.todo.click();
  await row(t.todoPanel, title).getByRole('button', { name: 'Mark complete' }).click();
  await expect(toast(page, 'Marked complete')).toBeVisible();
});
