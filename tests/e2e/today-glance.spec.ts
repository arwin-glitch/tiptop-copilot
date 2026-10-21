import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Today's "At a glance" cards over the invented demo tasks, one short line
 * each, with the full title as the tickbox's name. The demo's Top priorities
 * is always today's list and leads the page, so Do now steps aside and the
 * glance is Intros owed and Coming up. With no list for today all three show;
 * the demo cannot reach that, so the unit and integration tests hold it, the
 * three-across markup and Do now's overdue marks included. A tick completes
 * the task at once, with an Undo; the task then lives on the Tasks page's
 * Completed tab.
 */

const ELENA = 'Introduce Elena Marsh to Ben Adeyemi';
const CHRIS = 'Intro Chris Dalton to Ivy Lin and Sam Park';
const LUMEN = 'Lumen product walkthrough with the team';
// The demo's one task closed automatically; it stays completed throughout.
const AUTO_CLOSED = 'Answer the LP question on the Q3 reporting timeline';
// The demo's tasks ticked by hand for the proof check (Tasks → Completed): they stay
// completed throughout, like the auto-closed one.
const PROOF_TICKED = [
  'Send Maya the Series A investor shortlist',
  'Review the Q3 LP letter draft so Riley can send it',
  'Reply to Tom about the Girder AI reference list',
];
/** Completed rows that belong to the demo and are never reopened by clean-up. */
const DEMO_DONE = new RegExp([AUTO_CLOSED, ...PROOF_TICKED].join('|'));

// One demo sign-in for the whole file: demo entry is capped at 60 a minute
// across the suite.
const SIGNED_IN = path.resolve('test-results', 'today-glance-state.json');

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

// Every test starts with the demo's open tasks. Reopen whatever a test left
// completed, even one that failed partway, so the specs after it start clean.
test.afterEach(async ({ page }) => {
  await page.goto('/tasks?view=completed');
  const panel = page.getByRole('tabpanel', { name: /^Completed/ });
  await expect(panel).toBeVisible();
  const reopen = panel
    .getByRole('listitem')
    .filter({ hasNotText: DEMO_DONE })
    .getByRole('button', { name: /^Reopen / });
  for (let left = await reopen.count(); left > 0; left--) {
    await reopen.first().click();
    await expect(reopen).toHaveCount(left - 1);
  }
});

async function openGlance(page: Page) {
  await page.goto('/today');
  const glance = page.getByRole('region', { name: 'At a glance' });
  await expect(glance).toBeVisible();
  return glance;
}

test('Top priorities comes first, and Do now steps aside while it shows', async ({ page }) => {
  const glance = await openGlance(page);
  const priorities = page.getByRole('heading', { name: 'Top priorities', exact: true });
  await expect(priorities).toBeVisible();
  // Its own look, unchanged: ranked lines with a kind and a why.
  const card = page.locator('[data-tour="today-priorities"]');
  await expect(card.getByRole('listitem')).toHaveCount(3);
  await expect(card.getByText('Pay the Northwind invoice', { exact: true })).toBeVisible();
  await expect(card.getByText('Money', { exact: true })).toBeVisible();

  // Above the glance cards and the briefing below them.
  const top = (await priorities.boundingBox())?.y ?? Number.POSITIVE_INFINITY;
  expect(top).toBeLessThan((await glance.boundingBox())?.y ?? -1);
  const outlook = await page.getByRole('heading', { name: 'Outlook', exact: true }).boundingBox();
  expect(top).toBeLessThan(outlook?.y ?? -1);

  // One to-do list, not two: no Do now card anywhere on the page.
  await expect(page.getByRole('heading', { name: /^Do now/ })).toHaveCount(0);
  await expect(glance.getByRole('heading', { level: 3 })).toHaveCount(2);
});

test('two cards, each titled with its count, one short line per task', async ({ page }) => {
  const glance = await openGlance(page);
  await expect(glance.getByRole('heading', { name: 'Intros owed · 6' })).toBeVisible();
  await expect(glance.getByRole('heading', { name: 'Coming up · 4' })).toBeVisible();

  // Short labels on screen, the full title as the tickbox's name.
  await expect(glance.getByText('Priya → Omar', { exact: true })).toBeVisible();
  await expect(glance.getByText('Chris → Ivy + Sam P.', { exact: true })).toBeVisible();
  await expect(glance.getByRole('checkbox', { name: CHRIS })).toBeVisible();
  await expect(glance.getByText('Northwind note', { exact: true })).toBeVisible();
  await expect(glance.getByText(/^[A-Z][a-z]{2} \d{1,2} wk$/)).toBeVisible();

  // The demo's two overdue tasks were Do now's; none of these is overdue.
  await expect(glance.getByRole('img', { name: 'overdue' })).toHaveCount(0);
  await expect(glance.getByText(/3 PM Central|Auto-check/)).toBeVisible();

  // Four lines a card at most; two columns side by side on a desktop.
  await expect(glance.getByRole('checkbox')).toHaveCount(8);
  const [a, b] = await cardBoxes(page);
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
  expect(b!.x).toBeGreaterThan(a!.x);

  // Nothing above lists the overdue tasks now, so Tasks due opens on them.
  await expect(page.getByRole('button', { name: /Tasks due/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.getByText('2 overdue')).toBeVisible();
});

test('a tick completes the task: the count drops, Undo is offered, and it moves to Completed', async ({
  page,
}) => {
  const glance = await openGlance(page);
  const box = glance.getByRole('checkbox', { name: ELENA });
  await box.check();
  await expect(glance.getByRole('heading', { name: 'Intros owed · 5' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  // The refresh takes the line away.
  await expect(box).toHaveCount(0);

  await page.reload();
  await expect(glance.getByRole('heading', { name: 'Intros owed · 5' })).toBeVisible();
  await expect(glance.getByRole('checkbox', { name: ELENA })).toHaveCount(0);

  await page.goto('/tasks?view=completed');
  await expect(
    page
      .getByRole('tabpanel', { name: /^Completed/ })
      .getByRole('listitem')
      .filter({ hasText: ELENA }),
  ).toBeVisible();
});

test('Undo puts the task back on its card', async ({ page }) => {
  const glance = await openGlance(page);
  await glance.getByRole('checkbox', { name: CHRIS }).check();
  await expect(glance.getByRole('heading', { name: 'Intros owed · 5' })).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Back on your list', { exact: true })).toBeVisible();
  const box = glance.getByRole('checkbox', { name: CHRIS });
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();
  await expect(glance.getByRole('heading', { name: 'Intros owed · 6' })).toBeVisible();

  await page.reload();
  await expect(glance.getByRole('checkbox', { name: CHRIS })).toBeVisible();
});

test('"+N more" opens the full list on Tasks', async ({ page }) => {
  const glance = await openGlance(page);
  // Intros owed has six, four shown.
  await glance.getByRole('link', { name: '+2 more' }).click();
  await page.waitForURL(/\/tasks$/);
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
});

test('Space on a focused tickbox ticks it', async ({ page }) => {
  const glance = await openGlance(page);
  const box = glance.getByRole('checkbox', { name: LUMEN });
  await box.focus();
  await page.keyboard.press('Space');
  await expect(glance.getByRole('heading', { name: 'Coming up · 3' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
});

test('on a phone the cards stack under Top priorities, with no sideways scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const glance = await openGlance(page);
  const priorities = await page
    .getByRole('heading', { name: 'Top priorities', exact: true })
    .boundingBox();
  const [a, b] = await cardBoxes(page);
  expect(a!.y).toBeGreaterThan(priorities?.y ?? Number.POSITIVE_INFINITY);
  expect(Math.abs(a!.x - b!.x)).toBeLessThan(2);
  expect(b!.y).toBeGreaterThan(a!.y);
  expect(await everyLineShows(page)).toBe(true);
  await expect(glance.getByRole('heading', { name: /^Do now/ })).toHaveCount(0);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(2);
});

/** Where each card's heading is, by card. */
async function cardBoxes(page: Page) {
  const glance = page.getByRole('region', { name: 'At a glance' });
  const boxes = await Promise.all(
    ['Intros owed', 'Coming up'].map((name) =>
      glance.getByRole('heading', { name: new RegExp(`^${name}`) }).boundingBox(),
    ),
  );
  return boxes.map((box) => box ?? { x: -1, y: -1, width: 0, height: 0 });
}

/** True when no line on any card is cut short (one or two lines, never clipped). */
async function everyLineShows(page: Page): Promise<boolean> {
  return page
    .getByRole('region', { name: 'At a glance' })
    .locator('li span[title]')
    .evaluateAll((labels) =>
      labels.every((el) => el.scrollHeight <= el.clientHeight + 1 && el.textContent !== ''),
    );
}

test('the two cards sit side by side from the small breakpoint, every line whole', async ({
  page,
}) => {
  // Below it, one column, like a phone.
  await page.setViewportSize({ width: 600, height: 900 });
  await openGlance(page);
  const [narrowA, narrowB] = await cardBoxes(page);
  expect(Math.abs(narrowA!.x - narrowB!.x)).toBeLessThan(2);
  expect(narrowB!.y).toBeGreaterThan(narrowA!.y);

  // The narrowest two-column width, a tablet, a small laptop with the
  // sidebar and a 1280px laptop: two across, nothing cut.
  for (const viewport of [
    { width: 640, height: 900 },
    { width: 820, height: 1180 },
    { width: 1100, height: 800 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await openGlance(page);
    const [a, b] = await cardBoxes(page);
    expect(Math.abs(a!.y - b!.y), `${viewport.width}px`).toBeLessThan(2);
    expect(b!.x, `${viewport.width}px`).toBeGreaterThan(a!.x);
    expect(await everyLineShows(page), `${viewport.width}px`).toBe(true);
  }
});
