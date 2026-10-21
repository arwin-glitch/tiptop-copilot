import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Whose tasks the Tasks page shows, over the invented demo team, which is
 * shaped like a real one: the teammate (Riley) set the organization up and is
 * its first owner, but the mailbox the app reads is the demo user's, so the
 * organization's work is theirs: they are the principal. A routine's task,
 * posted the way the routines post one, lands on the principal; the filter
 * reads Everyone, the principal, then the teammate; and a row names its
 * assignee only when that is not the principal. The task this file posts
 * starts with "ZZ e2e" and is deleted again.
 */

/** The e2e server's TASK_BRIDGE_TOKEN (playwright.config.ts). */
const TOKEN = 'e2e-task-bridge-token-not-a-production-value';
const TEAMMATE = 'Riley';
const WIRE = 'Confirm the Tidewell pro-rata wire went out'; // the demo's one task for the teammate
const PREFIX = 'ZZ e2e';

const SIGNED_IN = path.resolve('test-results', 'tasks-principal-state.json');

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

test.afterEach(async ({ page }) => {
  await page.goto('/tasks');
  const panel = todoPanel(page);
  const rows = row(panel, PREFIX);
  for (let left = await rows.count(); left > 0; left--) {
    await rows.first().getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).press('Enter');
    await expect(rows).toHaveCount(left - 1);
  }
});

function todoPanel(page: Page): Locator {
  return page.getByRole('tabpanel', { name: /^To do/ });
}

function row(panel: Locator, title: string): Locator {
  return panel.getByRole('listitem').filter({ hasText: title });
}

test("a routine's task is the principal's, and the filter reads Everyone, the principal, the teammate", async ({
  page,
  request,
}, testInfo) => {
  // Posted as a routine posts one; unique per attempt, since a deleted title is never added again.
  const title = `${PREFIX} routine follow-up ${testInfo.retry}-${Date.now()}`;
  const posted = await request.post(
    `/api/integrations/tasks/webhook?token=${encodeURIComponent(TOKEN)}`,
    { data: { source: 'e2e-routine', tasks: [{ title, detail: 'Noticed in the inbox.' }] } },
  );
  expect(posted.ok()).toBe(true);
  expect(await posted.json()).toMatchObject({ ok: true, created: [title] });

  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  const panel = todoPanel(page);
  const who = panel.getByRole('group', { name: 'Whose tasks' });
  const options = who.getByRole('button');
  await expect(options).toHaveCount(3);
  const labels = await options.allTextContents();
  // Everyone, then the principal (the demo user), then the teammate who set the team up.
  expect(labels[0]).toBe('Everyone');
  expect(labels[2]).toBe(TEAMMATE);
  const principal = labels[1]!;
  expect(principal).not.toBe(TEAMMATE);

  // Everyone: the routine's task carries no name (it is the principal's);
  // the teammate's wire says whose it is.
  const routine = row(panel, title);
  await expect(routine).toBeVisible();
  await expect(routine).toContainText('Suggested');
  await expect(routine).not.toContainText(`· ${principal}`);
  await expect(routine).not.toContainText(`· ${TEAMMATE}`);
  await expect(row(panel, WIRE)).toContainText(`· ${TEAMMATE}`);

  // The principal's list has the routine's task, and not the teammate's.
  await who.getByRole('button', { name: principal, exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\?who=/);
  await expect(routine).toBeVisible();
  await expect(row(panel, WIRE)).toHaveCount(0);

  // The teammate's list has only what is theirs: every row names them.
  await who.getByRole('button', { name: TEAMMATE, exact: true }).click();
  await expect(routine).toHaveCount(0);
  await expect(row(panel, WIRE)).toBeVisible();
  // The task list only: Drafts sit under it on the same tab.
  const theirs = panel.locator('[data-tour="tasks-list"]').getByRole('listitem');
  const count = await theirs.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    await expect(theirs.nth(i)).toContainText(`· ${TEAMMATE}`);
  }

  await who.getByRole('button', { name: 'Everyone' }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(routine).toBeVisible();
});
