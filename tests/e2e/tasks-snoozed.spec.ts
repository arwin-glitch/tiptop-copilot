import path from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';

/**
 * The Tasks page's Snoozed tab, the Undo in the task toasts, and the line an
 * automatic close leaves on the Completed tab, over the invented demo tasks:
 * one snoozed until later this week, one closed by the task-closer routine.
 */

const SNOOZED = 'Ask Tom for the Girder AI onboarding numbers';
const AUTO_CLOSED = 'Answer the LP question on the Q3 reporting timeline';
const LOOMSTACK = 'Send LoomStack pass note';

// One demo sign-in for the whole file: demo entry is capped at 60 a minute.
const SIGNED_IN = path.resolve('test-results', 'tasks-snoozed-state.json');

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

// Put back what a test (even one that failed partway) moved: completed rows
// other than the auto-closed one are reopened, and the snoozed task, if it is
// on To do, is snoozed again.
test.afterEach(async ({ page }) => {
  await gotoTasks(page, '/tasks?view=completed');
  const { completedPanel, todo, todoPanel } = tabs(page);
  const reopen = completedPanel
    .getByRole('listitem')
    .filter({ hasNotText: AUTO_CLOSED })
    .getByRole('button', { name: /^Reopen / });
  for (let left = await reopen.count(); left > 0; left--) {
    await reopen.first().click();
    await expect(reopen).toHaveCount(left - 1);
  }
  await todo.click();
  const woken = todoPanel.getByRole('listitem').filter({ hasText: SNOOZED });
  if ((await woken.count()) > 0) {
    await woken.getByRole('button', { name: 'Snooze for 3 days' }).click();
    await expect(woken).toHaveCount(0);
  }
});

async function gotoTasks(page: Page, url = '/tasks') {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Tasks and drafts' })).toBeVisible();
}

function tabs(page: Page) {
  return {
    todo: page.getByRole('tab', { name: /^To do/ }),
    snoozed: page.getByRole('tab', { name: /^Snoozed/ }),
    completed: page.getByRole('tab', { name: /^Completed/ }),
    todoPanel: page.getByRole('tabpanel', { name: /^To do/ }),
    snoozedPanel: page.getByRole('tabpanel', { name: /^Snoozed/ }),
    completedPanel: page.getByRole('tabpanel', { name: /^Completed/ }),
  };
}

function toast(page: Page, text: string) {
  return page.locator('[data-sonner-toast]').filter({ hasText: text });
}

/** A server render of /tasks: a navigation or a refresh, not a prefetch. */
function isTasksRsc(request: Request): boolean {
  const headers = request.headers();
  return (
    request.method() === 'GET' &&
    new URL(request.url()).pathname === '/tasks' &&
    headers['rsc'] === '1' &&
    !headers['next-router-prefetch']
  );
}

test('the Snoozed tab opens at once, and the snoozed task is only there', async ({ page }) => {
  await gotoTasks(page);
  const { todo, snoozed, todoPanel, snoozedPanel } = tabs(page);
  await expect(snoozed).toHaveAccessibleName(/^Snoozed 1$/);
  await expect(todoPanel.getByRole('listitem').filter({ hasText: SNOOZED })).toHaveCount(0);
  await page.waitForLoadState('networkidle');

  const rsc: string[] = [];
  page.on('request', (request) => {
    if (isTasksRsc(request)) rsc.push(request.url());
  });

  await snoozed.click();
  await expect(snoozed).toHaveAttribute('aria-selected', 'true', { timeout: 1_000 });
  await expect(snoozedPanel).toBeVisible({ timeout: 1_000 });
  await expect(page).toHaveURL(/\/tasks\?view=snoozed$/);
  const row = snoozedPanel.getByRole('listitem').filter({ hasText: SNOOZED });
  await expect(row).toContainText(/Wakes .+ · \d+d from now/);
  await expect(row.getByRole('link', { name: SNOOZED })).toHaveAttribute('href', /^\/deals\//);
  await expect(row.getByRole('button', { name: `Unsnooze ${SNOOZED}` })).toBeVisible();

  await todo.click();
  await expect(todoPanel).toBeVisible({ timeout: 1_000 });
  await page.waitForTimeout(500);
  expect(rsc).toEqual([]);
});

test('?view=snoozed survives a reload and Back', async ({ page }) => {
  await gotoTasks(page, '/tasks?view=snoozed');
  const { todo, snoozed, snoozedPanel, todoPanel } = tabs(page);
  await expect(snoozed).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(snoozed).toHaveAttribute('aria-selected', 'true');
  await expect(snoozedPanel).toBeVisible();

  await todo.click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(todoPanel).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/tasks\?view=snoozed$/);
  await expect(snoozed).toHaveAttribute('aria-selected', 'true');
  await expect(snoozedPanel).toBeVisible();
});

test('Unsnooze moves the task to To do, and Undo snoozes it again until the same time', async ({
  page,
}) => {
  await gotoTasks(page, '/tasks?view=snoozed');
  const { todo, snoozed, todoPanel, snoozedPanel } = tabs(page);
  const row = snoozedPanel.getByRole('listitem').filter({ hasText: SNOOZED });
  const wakes = (await row.getByText(/^Wakes /).textContent())?.split(' · ')[0];
  const before = Number(/(\d+)$/.exec((await todo.textContent()) ?? '')?.[1]);

  await row.getByRole('button', { name: `Unsnooze ${SNOOZED}` }).click();
  await expect(toast(page, 'Back on To do')).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(snoozedPanel.getByText('Nothing snoozed')).toBeVisible();
  await expect(snoozed).toHaveAccessibleName(/^Snoozed 0$/);
  await expect(todo).toHaveAccessibleName(new RegExp(`^To do ${before + 1}$`));
  await todo.click();
  await expect(todoPanel.getByRole('listitem').filter({ hasText: SNOOZED })).toBeVisible();

  await toast(page, 'Back on To do').getByRole('button', { name: 'Undo' }).click();
  await expect(toast(page, 'Snoozed again')).toBeVisible();
  await expect(todoPanel.getByRole('listitem').filter({ hasText: SNOOZED })).toHaveCount(0);
  await snoozed.click();
  await expect(row).toBeVisible();
  await expect(row).toContainText(wakes!);
  // When the last toast closes, it hands focus back to the tab clicked before
  // Undo (To do). That must not switch the tab.
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 10_000 });
  await expect(snoozed).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\/tasks\?view=snoozed$/);
});

test('PageDown and PageUp switch tabs as they move focus', async ({ page }) => {
  await gotoTasks(page);
  const { todo, completed, todoPanel, completedPanel } = tabs(page);
  await todo.focus();
  await page.keyboard.press('PageDown');
  await expect(completed).toBeFocused();
  await expect(completed).toHaveAttribute('aria-selected', 'true');
  await expect(completedPanel).toBeVisible();
  await page.keyboard.press('PageUp');
  await expect(todo).toBeFocused();
  await expect(todo).toHaveAttribute('aria-selected', 'true');
  await expect(todoPanel).toBeVisible();
});

test('Undo in the "Marked complete" toast brings the task back', async ({ page }) => {
  await gotoTasks(page);
  const { todoPanel, completed } = tabs(page);
  await expect(completed).toHaveAccessibleName(/^Completed 1$/);
  const row = todoPanel.getByRole('listitem').filter({ hasText: LOOMSTACK });
  await row.getByRole('button', { name: 'Mark complete' }).click();
  await expect(toast(page, 'Marked complete')).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(completed).toHaveAccessibleName(/^Completed 2$/);

  await toast(page, 'Marked complete').getByRole('button', { name: 'Undo' }).click();
  await expect(toast(page, 'Back on your list')).toBeVisible();
  await expect(row).toBeVisible();
  await expect(completed).toHaveAccessibleName(/^Completed 1$/);
});

test('completing a snoozed task can be undone back to its snooze', async ({ page }) => {
  await gotoTasks(page, '/tasks?view=snoozed');
  const { snoozedPanel, completed } = tabs(page);
  const row = snoozedPanel.getByRole('listitem').filter({ hasText: SNOOZED });
  const wakes = (await row.getByText(/^Wakes /).textContent())?.split(' · ')[0];

  await row.getByRole('button', { name: 'Mark complete' }).click();
  await expect(toast(page, 'Marked complete')).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(completed).toHaveAccessibleName(/^Completed 2$/);

  await toast(page, 'Marked complete').getByRole('button', { name: 'Undo' }).click();
  await expect(toast(page, 'Snoozed again')).toBeVisible();
  await expect(row).toBeVisible();
  await expect(row).toContainText(wakes!);
  await expect(completed).toHaveAccessibleName(/^Completed 1$/);
});

test('Completed says why a task closed automatically, beside Reopen', async ({ page }) => {
  await gotoTasks(page, '/tasks?view=completed');
  const row = tabs(page).completedPanel.getByRole('listitem').filter({ hasText: AUTO_CLOSED });
  await expect(row.getByText('Suggested', { exact: true })).toBeVisible();
  const evidence = row.getByRole('link', { name: /^Closed automatically · email sent / });
  await expect(evidence).toHaveAttribute(
    'href',
    'https://mail.google.com/mail/?authuser=nick@tiptop.demo#all/18c0de0a1b2c3d4e',
  );
  await expect(evidence).toHaveAttribute('target', '_blank');
  await expect(row).toContainText('Sent the LP the Q3 reporting dates; they replied with thanks.');
  await expect(row.getByRole('button', { name: `Reopen ${AUTO_CLOSED}` })).toBeVisible();
});
