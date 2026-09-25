import path from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';

/**
 * The Tasks page's To do and Completed tabs, over the invented demo tasks.
 *
 * Both lists come from one server render and the tabs switch in the browser,
 * with the tab kept in the URL (`?view=completed`), so a reload, a shared
 * link and Back keep it. Ticking a task off moves it to Completed, and Reopen
 * moves it back.
 */

const LOOMSTACK = 'Send LoomStack pass note';
const RECRUITER = 'Introduce Dev to a founding-engineer recruiter';

// One demo sign-in for the whole file: demo entry is capped at 60 a minute
// across the suite.
const SIGNED_IN = path.resolve('test-results', 'tasks-completed-state.json');

test.beforeAll(async ({ browser }, testInfo) => {
  // An explicit empty state, or this context would inherit the file's
  // `storageState` below and try to read the file it is about to write.
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

async function gotoTasks(page: Page, url = '/tasks') {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Tasks and drafts' })).toBeVisible();
}

function tabs(page: Page) {
  return {
    todo: page.getByRole('tab', { name: /^To do/ }),
    completed: page.getByRole('tab', { name: /^Completed/ }),
    // An inactive panel is hidden, so each of these only resolves while its tab is open.
    todoPanel: page.getByRole('tabpanel', { name: /^To do/ }),
    completedPanel: page.getByRole('tabpanel', { name: /^Completed/ }),
  };
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

test('?view=completed opens the Completed tab, empty to begin with', async ({ page }) => {
  await gotoTasks(page, '/tasks?view=completed');
  const { todo, completed, todoPanel, completedPanel } = tabs(page);
  await expect(completed).toHaveAttribute('aria-selected', 'true');
  await expect(todo).toHaveAttribute('aria-selected', 'false');
  await expect(completedPanel.getByText('Nothing completed yet')).toBeVisible();
  await expect(todoPanel).toBeHidden();
  // The page-level empty state belongs to To do alone.
  await expect(page.getByText('Nothing outstanding')).toBeHidden();
});

test('a completed task moves to Completed, and Reopen brings it back to To do', async ({
  page,
}) => {
  await gotoTasks(page);
  const { completed, todo, todoPanel, completedPanel } = tabs(page);
  await expect(todo).toHaveAttribute('aria-selected', 'true');
  await expect(completed).toHaveAccessibleName(/^Completed\s*0$/);

  const open = todoPanel.getByRole('listitem').filter({ hasText: LOOMSTACK });
  await open.getByRole('button', { name: 'Mark complete' }).click();
  await expect(page.getByText('Marked complete', { exact: true })).toBeVisible();
  await expect(open).toHaveCount(0);
  await expect(completed).toHaveAccessibleName(/^Completed\s*1$/);

  await completed.click();
  await expect(page).toHaveURL(/\/tasks\?view=completed$/);
  const today = completedPanel.getByRole('heading', { name: /^Today/ });
  await expect(today).toBeVisible();
  const done = completedPanel.getByRole('listitem').filter({ hasText: LOOMSTACK });
  await expect(done).toContainText('Completed just now');
  await expect(done.getByRole('link', { name: LOOMSTACK })).toHaveAttribute('href', /^\/deals\//);
  await expect(done.getByText(LOOMSTACK)).not.toHaveCSS('text-decoration-line', 'line-through');

  await done.getByRole('button', { name: `Reopen ${LOOMSTACK}` }).click();
  await expect(page.getByText('Reopened', { exact: true })).toBeVisible();
  await expect(completedPanel.getByText('Nothing completed yet')).toBeVisible();
  // Reopening does not switch tabs; the task is waiting on To do.
  await expect(completed).toHaveAttribute('aria-selected', 'true');
  await todo.click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(todoPanel.getByRole('listitem').filter({ hasText: LOOMSTACK })).toBeVisible();
});

test('switching tabs needs no server render, and Back returns to To do', async ({ page }) => {
  await gotoTasks(page);
  const { todo, completed, todoPanel, completedPanel } = tabs(page);
  await expect(todoPanel).toBeVisible();
  // Let the load's own link prefetches finish.
  await page.waitForLoadState('networkidle');

  const rsc: string[] = [];
  page.on('request', (request) => {
    if (isTasksRsc(request)) rsc.push(request.url());
  });

  await completed.click();
  await expect(page).toHaveURL(/\/tasks\?view=completed$/);
  await expect(completedPanel).toBeVisible();
  await expect(todoPanel).toBeHidden();

  // Arrow keys move between the tabs, as a tablist should.
  await completed.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(todo).toBeFocused();
  await expect(todo).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\/tasks$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/tasks\?view=completed$/);
  await expect(completed).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(todo).toHaveAttribute('aria-selected', 'true');
  await expect(todoPanel).toBeVisible();

  await page.waitForTimeout(500);
  expect(rsc).toEqual([]);

  // A reload keeps the tab the URL holds.
  await page.goForward();
  await expect(completed).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(completed).toHaveAttribute('aria-selected', 'true');
  await expect(completedPanel).toBeVisible();
});

test('a tab click lands at once while a row action is refreshing the page', async ({ page }) => {
  await gotoTasks(page);
  const { todo, completed, todoPanel, completedPanel } = tabs(page);

  // Every /tasks server render after the load is held until `release`.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname === '/tasks',
    async (route) => {
      if (isTasksRsc(route.request())) await held;
      await route.fallback();
    },
  );

  const refresh = page.waitForRequest(isTasksRsc);
  await todoPanel
    .getByRole('listitem')
    .filter({ hasText: RECRUITER })
    .getByRole('button', { name: 'Mark complete' })
    .click();
  await refresh;

  // Held, the refresh never lands on its own: these fail if a click waits for it.
  await completed.click();
  await expect(completed).toHaveAttribute('aria-selected', 'true', { timeout: 1_000 });
  await expect(completedPanel).toBeVisible({ timeout: 1_000 });
  await todo.click();
  await expect(todoPanel).toBeVisible({ timeout: 1_000 });
  await completed.click();
  await expect(completedPanel).toBeVisible({ timeout: 1_000 });
  // The URL waits for the refresh, rather than freezing the page behind it.
  await expect(page).toHaveURL(/\/tasks$/);

  release();
  await expect(page).toHaveURL(/\/tasks\?view=completed$/);
  const done = completedPanel.getByRole('listitem').filter({ hasText: RECRUITER });
  await expect(done).toBeVisible();

  // Leave the demo task open for the rest of the suite.
  await done.getByRole('button', { name: `Reopen ${RECRUITER}` }).click();
  await expect(page.getByText('Reopened', { exact: true })).toBeVisible();
  await todo.click();
  await expect(todoPanel.getByRole('listitem').filter({ hasText: RECRUITER })).toBeVisible();
});
