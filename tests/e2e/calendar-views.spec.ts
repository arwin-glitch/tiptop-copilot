import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The new Calendar views, behind the "New calendar (preview)" switch, over
 * the demo's in-memory mock calendar: nothing here can reach Google. The day
 * list stays the default; the switch opens Day, Week and Month like Google
 * Calendar; events are made by dragging, edited, deleted; and every change
 * that involves guests asks whether to email them.
 *
 * The switch is remembered for the demo user, so the last test turns it off
 * again and the day list's own specs find the day list.
 */

const SIGNED_IN = path.resolve('test-results', 'calendar-views-state.json');
const TZ = 'America/Chicago';

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

/** A day key `n` days from today in the demo's zone. */
function dayFromToday(n: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const grid = (page: Page, view: 'day' | 'week' | 'month') =>
  page.locator(`[data-calendar-view="${view}"]`);

const chip = (page: Page, title: string | RegExp) =>
  page.locator('[data-event-chip]').filter({ hasText: title });

async function dragOnColumn(page: Page, date: string, fromHour: number, toHour: number) {
  const column = grid(page, 'day').locator(`[data-date="${date}"]`);
  await column.scrollIntoViewIfNeeded();
  const box = (await column.boundingBox())!;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + fromHour * 48 + 2);
  await page.mouse.down();
  await page.mouse.move(x, box.y + (fromHour + 0.5) * 48, { steps: 4 });
  await page.mouse.move(x, box.y + toHour * 48 - 2, { steps: 4 });
  await page.mouse.up();
}

test('the day list stays the default, and the switch opens the new views and is remembered', async ({
  page,
}) => {
  await page.goto('/calendar');
  await expect(page.getByRole('navigation', { name: 'Day' }).getByRole('link')).toHaveCount(7);
  await page.getByRole('switch', { name: 'New calendar (preview)' }).click();
  await page.waitForURL(/\/calendar\?view=week&date=\d{4}-\d{2}-\d{2}$/);
  await expect(grid(page, 'week')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'New calendar (preview)' })).toBeChecked();

  // Google's calendars down the side: the main one first, Google's own names.
  const list = page.locator('[data-tour="calendar-list"]');
  await expect(list.getByRole('checkbox')).toHaveCount(5);
  await expect(list.locator('label').first()).toContainText('nick@tiptop.demo');
  await expect(list.getByRole('checkbox', { name: 'TipTop team' })).toBeChecked();
  await expect(list.getByRole('checkbox', { name: /Deal flow \(shared\)/ })).not.toBeChecked();

  await page.screenshot({ path: 'test-results/calendar-views-week.png', fullPage: true });

  // A plain /calendar now opens the new views: the switch is remembered.
  await page.goto('/calendar');
  await expect(grid(page, 'week')).toBeVisible();
});

test('moves to any date, back or ahead, with the buttons, the keys and the date picker', async ({
  page,
}) => {
  await page.goto(`/calendar?view=week&date=${dayFromToday(0)}`);
  const heading = page.locator('[data-tour="calendar-views"] h2');
  const thisWeek = await heading.textContent();
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect(heading).not.toHaveText(thisWeek!);
  await page.getByRole('button', { name: 'Previous week' }).click();
  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(page).toHaveURL(new RegExp(`date=${dayFromToday(-14).slice(0, 4)}`));
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(heading).toHaveText(thisWeek!);

  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('m');
  await expect(grid(page, 'month')).toBeVisible();
  await expect(page).toHaveURL(/view=month/);
  await page.keyboard.press('d');
  await expect(grid(page, 'day')).toBeVisible();
  await page.keyboard.press('j');
  await expect(page).toHaveURL(new RegExp(`date=${dayFromToday(1)}`));
  await page.keyboard.press('t');
  await expect(page).toHaveURL(new RegExp(`date=${dayFromToday(0)}`));
  await page.keyboard.press('w');
  await expect(grid(page, 'week')).toBeVisible();

  // The date picker goes to any month.
  await page.getByRole('button', { name: 'Pick a date' }).click();
  const picker = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: 'Next month' }) });
  await picker.getByRole('button', { name: 'Next month' }).click();
  await picker.getByRole('button', { name: 'Next month' }).click();
  await picker.locator('button[aria-label*=" 15, "]').click();
  await expect(page).toHaveURL(/date=\d{4}-\d{2}-15/);
});

test('month view packs a busy day and offers the rest under "+N more"', async ({ page }) => {
  const busy = dayFromToday(3);
  await page.goto(`/calendar?view=month&date=${busy}`);
  await expect(grid(page, 'month')).toBeVisible();
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${busy}T12:00:00Z`));
  const more = grid(page, 'month').getByRole('button', {
    name: new RegExp(`^\\d+ more on ${day}$`),
  });
  await expect(more).toBeVisible();
  await expect(more).toHaveText(/^\+\d+ more$/);
  await page.screenshot({ path: 'test-results/calendar-views-month.png', fullPage: true });
  await more.click();
  await expect(page.getByRole('dialog').getByText('Demo day: closing drinks')).toBeVisible();
});

test('drag on the grid to make an event, then edit its guests: Google’s question comes first', async ({
  page,
}) => {
  const day = dayFromToday(2);
  const title = `Views check ${Date.now()}`;
  await page.goto(`/calendar?view=day&date=${day}`);
  await expect(grid(page, 'day')).toBeVisible();
  await dragOnColumn(page, day, 10, 11);

  const quick = page.getByRole('dialog', { name: 'New event' });
  await expect(quick).toBeVisible();
  await expect(quick).toContainText('10am – 11am');
  await page.screenshot({ path: 'test-results/calendar-views-quick.png' });
  await quick.getByLabel('Title').fill(title);
  await quick.getByRole('button', { name: 'Save' }).click();
  await expect(chip(page, title)).toBeVisible();
  await expect(page.getByText('Saved.')).toBeVisible();

  // Edit: add a guest. Saving asks whether to send invitations.
  await chip(page, title).click();
  const panel = page.getByRole('dialog', { name: title });
  await expect(panel.getByText('Block')).toBeVisible();
  await panel.getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit event' });
  await editor.getByLabel('Guests').fill('guest.one@example.org');
  await editor.getByLabel('Guests').press('Enter');
  await expect(editor.getByRole('list', { name: 'Guests added' })).toContainText(
    'guest.one@example.org',
  );
  await page.screenshot({ path: 'test-results/calendar-views-editor.png' });
  await editor.getByRole('button', { name: 'Save' }).click();
  const ask = page.getByRole('dialog', { name: 'Send invitation emails to guests?' });
  await expect(ask).toBeVisible();
  await page.screenshot({ path: 'test-results/calendar-views-prompt.png' });
  await expect(ask.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  await expect(ask.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await ask.getByRole('button', { name: "Don't send" }).click();
  await expect(page.getByText('Saved.').last()).toBeVisible();

  // With a guest on it, it is now a meeting, and any change asks again.
  await chip(page, title).click();
  await expect(page.getByRole('dialog', { name: title }).getByText('1 guest')).toBeVisible();
  await page.screenshot({ path: 'test-results/calendar-views-panel.png' });
  await expect(
    page.getByRole('dialog', { name: title }).getByText('Meeting', { exact: true }),
  ).toBeVisible();
  await page.getByRole('dialog', { name: title }).getByRole('button', { name: 'Edit' }).click();
  await page
    .getByRole('dialog', { name: 'Edit event' })
    .getByLabel('Title')
    .fill(`${title} (moved)`);
  await page
    .getByRole('dialog', { name: 'Edit event' })
    .getByRole('button', { name: 'Save' })
    .click();
  const update = page.getByRole('dialog', { name: 'Send update emails to guests?' });
  await expect(update).toBeVisible();
  // Cancel: nothing changes, the editor stays open.
  await update.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit event' })).toBeVisible();
  await page
    .getByRole('dialog', { name: 'Edit event' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  await expect(chip(page, `${title} (moved)`)).toHaveCount(0);

  // Delete: with a guest on it, it asks about cancellations.
  await chip(page, title).click();
  await page.getByRole('dialog', { name: title }).getByRole('button', { name: 'Delete' }).click();
  const cancel = page.getByRole('dialog', { name: 'Send cancellation emails to guests?' });
  await expect(cancel).toBeVisible();
  await cancel.getByRole('button', { name: "Don't send" }).click();
  await expect(chip(page, title)).toHaveCount(0);
  await expect(page.getByText('Deleted.')).toBeVisible();
});

test('drag an event to move it, and its bottom edge to change its length', async ({ page }) => {
  const day = dayFromToday(5);
  const title = `Move check ${Date.now()}`;
  await page.goto(`/calendar?view=day&date=${day}`);
  await dragOnColumn(page, day, 9, 10);
  const quick = page.getByRole('dialog', { name: 'New event' });
  await quick.getByLabel('Title').fill(title);
  await quick.getByRole('button', { name: 'Save' }).click();
  const event = chip(page, title);
  await expect(event).toHaveAccessibleName(/9am – 10am/);

  // Move: grab it and drop it two hours later. No guests, so no question.
  const box = (await event.boundingBox())!;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(x, box.y + 10 + 48, { steps: 5 });
  await page.mouse.move(x, box.y + 10 + 96, { steps: 5 });
  await page.mouse.up();
  await expect(event).toHaveAccessibleName(/11am – 12pm/);

  // Resize: the bottom edge down an hour.
  const moved = (await event.boundingBox())!;
  await page.mouse.move(x, moved.y + moved.height - 2);
  await page.mouse.down();
  await page.mouse.move(x, moved.y + moved.height - 2 + 24, { steps: 4 });
  await page.mouse.move(x, moved.y + moved.height - 2 + 48, { steps: 4 });
  await page.mouse.up();
  await expect(event).toHaveAccessibleName(/11am – 1pm/);

  // A reload reads it back from the calendar where it was put.
  await page.reload();
  await expect(chip(page, title)).toHaveAccessibleName(/11am – 1pm/);
  await chip(page, title).click();
  await page.getByRole('dialog', { name: title }).getByRole('button', { name: 'Delete' }).click();
  await page
    .getByRole('dialog', { name: 'Delete this event?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(chip(page, title)).toHaveCount(0);
});

test('an event without guests is deleted after a plain confirm', async ({ page }) => {
  const day = dayFromToday(4);
  const title = `Solo block ${Date.now()}`;
  await page.goto(`/calendar?view=day&date=${day}`);
  await dragOnColumn(page, day, 13, 14);
  const quick = page.getByRole('dialog', { name: 'New event' });
  await quick.getByLabel('Title').fill(title);
  await quick.getByRole('button', { name: 'Save' }).click();
  await expect(chip(page, title)).toBeVisible();
  await chip(page, title).click();
  await page.getByRole('dialog', { name: title }).getByRole('button', { name: 'Delete' }).click();
  const sure = page.getByRole('dialog', { name: 'Delete this event?' });
  await expect(sure).toBeVisible();
  await sure.getByRole('button', { name: 'Delete' }).click();
  await expect(chip(page, title)).toHaveCount(0);
});

test('a repeating event asks "This event" or "All events", and an organizer’s event is view-only', async ({
  page,
}) => {
  await page.goto(`/calendar?view=week&date=${dayFromToday(7)}`);
  await chip(page, 'Partner meeting').first().click();
  const panel = page.getByRole('dialog', { name: 'Partner meeting' });
  await expect(panel.getByText('Repeats')).toBeVisible();
  await panel.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('dialog', { name: 'Edit event' }).getByLabel('Location').fill('Board room');
  await page
    .getByRole('dialog', { name: 'Edit event' })
    .getByRole('button', { name: 'Save' })
    .click();
  const scope = page.getByRole('dialog', { name: 'Change a repeating event' });
  await expect(scope.getByRole('button', { name: 'This event' })).toBeVisible();
  await expect(scope.getByRole('button', { name: 'All events' })).toBeVisible();
  await expect(scope.getByRole('button', { name: /following/i })).toHaveCount(0);
  await scope.getByRole('button', { name: 'Cancel' }).click();
  await page
    .getByRole('dialog', { name: 'Edit event' })
    .getByRole('button', { name: 'Cancel' })
    .click();

  await page.goto(`/calendar?view=day&date=${dayFromToday(1)}`);
  await chip(page, 'Ledgerly board meeting').click();
  const board = page.getByRole('dialog', { name: 'Ledgerly board meeting' });
  await expect(
    board.getByText('Only the organizer (Maya Chen) can change this event.'),
  ).toBeVisible();
  await expect(board.getByRole('button', { name: 'Edit' })).toHaveCount(0);
});

test('turning a calendar off hides its events, and on brings them back', async ({ page }) => {
  await page.goto(`/calendar?view=day&date=${dayFromToday(3)}`);
  await expect(chip(page, 'Demo day: fintech block')).toBeVisible();
  const team = page
    .locator('[data-tour="calendar-list"]')
    .getByRole('checkbox', { name: 'TipTop team' });
  await team.uncheck();
  await expect(chip(page, 'Demo day: fintech block')).toHaveCount(0);
  await team.check();
  await expect(chip(page, 'Demo day: fintech block')).toBeVisible();
});

test('a phone opens on Day view with no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/calendar');
  await expect(grid(page, 'day')).toBeVisible();
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
  await page.screenshot({ path: 'test-results/calendar-views-phone.png', fullPage: true });
  await page.getByRole('button', { name: 'Next day' }).click();
  await expect(page).toHaveURL(new RegExp(`view=day&date=${dayFromToday(1)}`));
});

test('the parity check compares the two readers and changes nothing', async ({ page }) => {
  await page.goto('/diagnostics?tab=parity');
  await expect(page.getByRole('heading', { name: 'Calendar parity' })).toBeVisible();
  await expect(page.getByText(/They match|difference/).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/calendar-views-parity.png', fullPage: true });
  await expect(page.getByRole('button', { name: 'Check' })).toBeVisible();
});

test('the switch goes back to the day list, and that is remembered too', async ({ page }) => {
  await page.goto('/calendar?view=week');
  await page.getByRole('switch', { name: 'New calendar (preview)' }).click();
  await page.waitForURL(/\/calendar$/);
  await expect(page.getByRole('navigation', { name: 'Day' }).getByRole('link')).toHaveCount(7);
  await page.goto('/calendar');
  await expect(page.getByRole('navigation', { name: 'Day' })).toBeVisible();
});
