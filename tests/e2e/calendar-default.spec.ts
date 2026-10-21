import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The Calendar tab's default and its busy-day layout, over the demo's mock
 * calendar (nothing here reaches Google).
 *
 * The Day, Week and Month views are what a plain /calendar opens for someone
 * who never touched the "New calendar" switch; turning it off keeps the day
 * list, and that is remembered; ?view=list and old ?day= links are the day
 * list. This file runs before the other calendar specs (it sorts first), so
 * the first test sees a person with nothing chosen, and the switch is left on.
 *
 * On the demo's conference day, long overlapping blocks lie under short
 * meetings, as on a real busy day: the overlap layout must keep every chip at
 * least MIN_CHIP_PX wide, never break a title inside a word, fold what does
 * not fit into a "+N", and keep a phone from scrolling sideways.
 */

const SIGNED_IN = path.resolve('test-results', 'calendar-default-state.json');
const TZ = 'America/Chicago';
/** BUSY_DAY_OFFSET in lib/calendar/mock-calendar.ts. */
const BUSY_DAY = 12;
/** MIN_CHIP_PX in lib/calendar/grid.ts. */
const MIN_CHIP_PX = 36;

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

function dayFromToday(n: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const grid = (page: Page, view: 'day' | 'week' | 'month') =>
  page.locator(`[data-calendar-view="${view}"]`);
const dayList = (page: Page) => page.getByRole('navigation', { name: 'Day' });
const toggle = (page: Page) => page.getByRole('switch', { name: 'New calendar' });

/** Each chip and "+N" on a day: its drawn width, and whether it was cascaded. */
async function chipsOn(page: Page, date: string) {
  return page.locator(`[data-date="${date}"]`).evaluate((column) =>
    [...column.querySelectorAll<HTMLElement>('[data-event-chip], [data-event-fold]')].map((el) => ({
      label: el.getAttribute('aria-label') ?? '',
      width: el.getBoundingClientRect().width,
      cascaded: el.hasAttribute('data-cascaded'),
      fold: el.hasAttribute('data-event-fold'),
    })),
  );
}

/** How every title, and every word in it, may break: [word-break, overflow-wrap]. */
async function titleBreaks(page: Page) {
  return page.evaluate(() => {
    const els = document.querySelectorAll<HTMLElement>('[data-event-chip], [data-event-chip] *');
    return [
      ...new Set(
        [...els].map((el) => {
          const cs = getComputedStyle(el);
          return `${cs.wordBreak}|${cs.overflowWrap}`;
        }),
      ),
    ];
  });
}

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

test('with nothing chosen, /calendar opens the new views, Week on a computer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/calendar');
  await expect(grid(page, 'week')).toBeVisible();
  await expect(toggle(page)).toBeChecked();
  await expect(dayList(page)).toHaveCount(0);
  // The page says nothing about a preview any more.
  await expect(page.locator('main').getByText(/preview/i)).toHaveCount(0);
});

test('?view=list and an old ?day= link open the day list', async ({ page }) => {
  await page.goto('/calendar?view=list');
  await expect(dayList(page).getByRole('link')).toHaveCount(7);
  await expect(toggle(page)).not.toBeChecked();
  // With the new views the default, the day list's own Today stays on the day list.
  await expect(dayList(page).getByRole('link', { name: 'Today' })).toHaveAttribute(
    'href',
    '/calendar?view=list',
  );
  const tomorrow = dayFromToday(1);
  await page.goto(`/calendar?day=${tomorrow}`);
  await expect(dayList(page).locator('[aria-current="date"]')).toHaveAttribute(
    'href',
    `/calendar?day=${tomorrow}`,
  );
});

test('turning the switch off keeps the day list, remembered, and on brings the views back', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/calendar');
  await toggle(page).click();
  await page.waitForURL(/\/calendar$/);
  await expect(dayList(page).getByRole('link')).toHaveCount(7);
  await page.goto('/calendar');
  await expect(dayList(page)).toBeVisible();
  await expect(dayList(page).getByRole('link', { name: 'Today' })).toHaveAttribute(
    'href',
    '/calendar',
  );
  // An address that names a view still opens it.
  await page.goto('/calendar?view=month');
  await expect(grid(page, 'month')).toBeVisible();

  // On again (the default), for the specs that follow.
  await page.goto('/calendar');
  await toggle(page).click();
  await page.waitForURL(/\/calendar\?view=week&date=\d{4}-\d{2}-\d{2}$/);
  await page.goto('/calendar');
  await expect(grid(page, 'week')).toBeVisible();
});

test('a busy day: long blocks cascade under meetings, no chip under the minimum, no word broken', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const busy = dayFromToday(BUSY_DAY);
  await page.goto(`/calendar?view=week&date=${busy}`);
  await expect(grid(page, 'week')).toBeVisible();
  await expect(page.locator(`[data-date="${busy}"] [data-event-chip]`).first()).toBeVisible();

  const chips = await chipsOn(page, busy);
  expect(chips.length).toBeGreaterThanOrEqual(10);
  for (const c of chips) {
    expect(c.width, c.label).toBeGreaterThanOrEqual(MIN_CHIP_PX - 0.5);
  }
  // A meeting over the conference day is drawn on top of it, still wide.
  const column = (await page.locator(`[data-date="${busy}"]`).boundingBox())!.width;
  const coffee = chips.find((c) => c.label.includes('Coffee with Avery Brooks'))!;
  expect(coffee.cascaded).toBe(true);
  expect(coffee.width).toBeGreaterThan(column / 2);

  for (const rule of await titleBreaks(page)) {
    expect(rule).toBe('normal|normal');
  }
  // A word too long for its chip is cut with an ellipsis, not broken.
  const long = page
    .locator('[data-event-chip]')
    .filter({ hasText: 'Superconductivityroundtable' })
    .locator('[data-chip-title]');
  await expect(long).toHaveCSS('text-overflow', 'ellipsis');
  expect(await long.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});

test('a "+N" holds what does not fit beside the others and lists it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const busy = dayFromToday(BUSY_DAY);
  await page.goto(`/calendar?view=week&date=${busy}`);
  await expect(grid(page, 'week')).toBeVisible();
  const column = page.locator(`[data-date="${busy}"]`);
  await expect(column.locator('[data-event-chip]').first()).toBeVisible();
  const chips = await chipsOn(page, busy);
  for (const c of chips) expect(c.width, c.label).toBeGreaterThanOrEqual(MIN_CHIP_PX - 0.5);

  // Three meetings at noon, two slots: the first, and a "+2" for the others.
  const more = column.getByRole('button', { name: /^2 more events from 12pm$/ });
  await expect(more).toHaveText('+2');
  await more.click();
  const list = page.getByRole('dialog');
  await expect(list.getByText('Panel run-through')).toBeVisible();

  // A press on empty time elsewhere only closes the list, as in Google: no new event.
  const otherDay = page
    .locator(`[data-calendar-view="week"] [data-date]:not([data-date="${busy}"])`)
    .first();
  const box = (await otherDay.boundingBox())!;
  const scrolled = await page
    .locator('[data-calendar-view="week"] .overflow-y-auto')
    .evaluate((el) => el.scrollTop);
  await page.mouse.click(box.x + box.width / 2, box.y + scrolled + 40);
  await expect(list).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'New event' })).toHaveCount(0);
  await expect(page.locator('[data-new-event]')).toHaveCount(0);

  await more.click();
  await list.getByRole('button', { name: /Quick sync: Jordan/ }).click();
  await expect(page.getByRole('dialog', { name: 'Quick sync: Jordan' })).toBeVisible();
  // Pressing in the list made nothing new.
  await expect(page.locator('[data-new-event]')).toHaveCount(0);
});

test('a phone: the busy week fits without scrolling sideways, titles cut whole', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const busy = dayFromToday(BUSY_DAY);
  await page.goto(`/calendar?view=week&date=${busy}`);
  await expect(grid(page, 'week')).toBeVisible();
  await expect(page.locator(`[data-date="${busy}"] [data-event-chip]`).first()).toBeVisible();
  await expectNoSidewaysScroll(page);
  for (const rule of await titleBreaks(page)) {
    expect(rule).toBe('normal|normal');
  }
  // Seven columns on a phone: two to a column at most, never a hairline.
  for (const c of await chipsOn(page, busy)) {
    expect(c.width, c.label).toBeGreaterThanOrEqual(14);
  }
  // The plain address opens Day there, like Google's app.
  await page.goto('/calendar');
  await expect(grid(page, 'day')).toBeVisible();
  await expectNoSidewaysScroll(page);
});
