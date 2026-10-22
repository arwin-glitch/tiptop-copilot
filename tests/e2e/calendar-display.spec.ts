import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * One clear look for every event, Google's colour labels, and a "How you
 * got here" that finds the reason (D-070), over the demo's in-memory mock
 * calendar: nothing here can reach Google, and nothing emails anyone.
 *
 * - The named labels of the calendars shown are filter chips above the grid,
 *   in Google's order, one line with "More" on a computer, remembered; each
 *   event shows its label name, on the chip and the card. A colour slot
 *   nobody named is no chip and no name (D-072): its events show under
 *   "Unlabelled", drawn in its colour.
 * - The card's label picker: named chips, then the unnamed colours as plain
 *   dots; a chip or a dot sends one PATCH, the label and nothing else.
 * - A suggested label shows on the card and is applied only on a tap.
 * - A Key explains the looks: faded once over, outlined with a "?" while
 *   not answered, striped for maybe, struck through when declined, and a
 *   block is drawn like any other event (no dashes, no grey).
 * - A guest-less registration finds its ticket email, with the Copilot and
 *   Gmail links; an event nothing explains says what was checked and offers
 *   the Inbox search.
 *
 * It runs after calendar-default.spec.ts (which wants a person who has
 * chosen nothing) and before calendar-event-card.spec.ts, which answers the
 * board meeting this spec shows as not answered yet. It leaves no label
 * filter and no label behind.
 */

const SIGNED_IN = path.resolve('test-results', 'calendar-display-state.json');
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

const chip = (page: Page, title: string | RegExp) =>
  page.locator('[data-event-chip]').filter({ hasText: title });

const legend = (page: Page) => page.getByRole('group', { name: 'Labels' });

/** The label chips the legend's row shows (the rest are behind "More"). */
const chipsInRow = (page: Page) =>
  legend(page).locator('button[aria-pressed]').filter({ visible: true });

/** Every label chip's name, in order: the row's, then those behind "More". */
async function legendNames(page: Page): Promise<string[]> {
  const row = await chipsInRow(page).allTextContents();
  const more = legend(page).locator('[data-label-more]');
  if (!(await more.isVisible())) return row.map((t) => t.trim());
  await more.click();
  const rest = await page
    .getByRole('group', { name: 'More labels' })
    .getByRole('button')
    .allTextContents();
  await page.keyboard.press('Escape');
  return [...row, ...rest].map((t) => t.trim());
}

/** A label chip, in the row or behind "More" (opened, so press Escape after). */
async function labelChip(page: Page, name: string): Promise<Locator> {
  const inRow = legend(page).getByRole('button', { name, exact: true });
  if (await inRow.isVisible()) return inRow;
  await legend(page).locator('[data-label-more]').click();
  return page
    .getByRole('group', { name: 'More labels' })
    .getByRole('button', { name, exact: true });
}

/** The named labels, in Google's order (Flamingo, Tomato, ... Graphite), then "Unlabelled". */
const LEGEND = [
  'Diligence',
  'Personal',
  'Founders',
  'Event',
  'Travel',
  'Portfolio',
  'VCs',
  'LPs',
  'Internal',
  'Unlabelled',
];

/** The main calendar's colours nobody named, as Google calls them, in the picker's order. */
const MAIN_COLOURS = [
  'Radicchio',
  'Cherry blossom',
  'Cocoa',
  'Pumpkin',
  'Mango',
  'Citron',
  'Avocado',
  'Pistachio',
  'Eucalyptus',
  'Cobalt',
  'Lavender',
  'Blueberry',
  'Wisteria',
  'Amethyst',
  'Birch',
];

/** Every write the page sends to the calendar routes, as sent. */
function recordWrites(page: Page) {
  const writes: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' || !/\/api\/(calendar|inbox)\//.test(r.url())) return;
    if (r.url().includes('/api/calendar/prefs')) return;
    let body: Record<string, unknown> | null = null;
    try {
      body = r.postDataJSON() as Record<string, unknown> | null;
    } catch {
      body = null;
    }
    writes.push({ method: r.method(), url: new URL(r.url()).pathname, body });
  });
  return writes;
}

/** No label filter left behind for the tests after this one (the demo user is shared). */
async function clearFilter(page: Page) {
  const showAll = legend(page).getByRole('button', { name: 'Show all' });
  if (await showAll.count()) {
    const saved = page.waitForResponse((r) => r.url().includes('/api/calendar/prefs'));
    await showAll.click();
    await saved;
  }
}

test('the named labels are a legend above the grid, in Google’s order; a tap filters, remembered', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/calendar?view=week&date=${dayFromToday(0)}`);
  const labels = legend(page);
  await expect(labels).toBeVisible();
  // Every named label once (Travel is on two calendars, main and Personal: one chip),
  // in Google's order, then Unlabelled; no colour slot is a chip.
  expect(await legendNames(page)).toEqual(LEGEND);
  await expect(page.getByText(/Unnamed label/)).toHaveCount(0);
  // The label's name on the chip, after the time.
  await expect(chip(page, 'Ledgerly board prep').locator('[data-chip-label]')).toHaveText(
    ' · Portfolio',
  );

  try {
    const portfolio = await labelChip(page, 'Portfolio');
    const saved = page.waitForResponse((r) => r.url().includes('/api/calendar/prefs'));
    await portfolio.click();
    await saved;
    await expect(portfolio).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(chip(page, 'Ledgerly board prep')).toBeVisible();
    await expect(chip(page, 'Founder office hours')).toHaveCount(0);
    await expect(chip(page, 'Girder AI — reference call debrief')).toHaveCount(0);

    // Remembered, like the other calendar choices; Month filters too.
    await page.goto(`/calendar?view=month&date=${dayFromToday(0)}`);
    await expect(await labelChip(page, 'Portfolio')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(chip(page, 'Ledgerly board prep')).toBeVisible();
    await expect(chip(page, 'Founder office hours')).toHaveCount(0);

    // Unlabelled as well: the two together (in Week, where today has room for them all).
    await page.goto(`/calendar?view=week&date=${dayFromToday(0)}`);
    await (await labelChip(page, 'Unlabelled')).click();
    await page.keyboard.press('Escape');
    await expect(chip(page, 'Founder office hours').first()).toBeVisible();
    await expect(chip(page, 'Ledgerly board prep')).toBeVisible();
    await expect(chip(page, 'TipTop internal — pipeline review')).toHaveCount(0);
  } finally {
    await clearFilter(page);
  }
  await expect(chip(page, 'TipTop internal — pipeline review')).toBeVisible();
});

test('a colour nobody named is no label: drawn in it, filtered as Unlabelled, no name shown', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The family trip carries Personal's unnamed Lavender.
  await page.goto(`/calendar?view=week&date=${dayFromToday(9)}`);
  const trip = chip(page, 'Family trip').first();
  await expect(trip).toBeVisible();
  await expect(trip).toHaveCSS('background-color', 'rgb(121, 134, 203)');
  await expect(chip(page, 'Family trip').locator('[data-chip-label]')).toHaveCount(0);
  await expect(trip).not.toHaveAttribute('aria-label', /label/);

  try {
    await (await labelChip(page, 'Unlabelled')).click();
    await page.keyboard.press('Escape');
    await expect(trip).toBeVisible();
    await (await labelChip(page, 'Unlabelled')).click();
    await page.keyboard.press('Escape');
    await (await labelChip(page, 'Travel')).click();
    await page.keyboard.press('Escape');
    await expect(chip(page, 'Family trip')).toHaveCount(0);
  } finally {
    await clearFilter(page);
  }

  // Its card calls it by its colour, and the picker ticks that colour's dot.
  await trip.click();
  const card = page.getByRole('dialog', { name: 'Family trip' });
  await expect(card.locator('[data-event-label]')).toHaveText('Colour: Lavender');
  const picker = card.getByRole('radiogroup', { name: 'Event label' });
  await expect(picker.getByRole('radio', { name: 'Lavender' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(picker.getByRole('radio', { name: 'No label' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(card.getByText(/Unnamed/)).toHaveCount(0);
});

test('on a computer the legend is one line, and "More" holds the rest', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/calendar?view=week&date=${dayFromToday(0)}`);
  const labels = legend(page);
  const more = labels.locator('[data-label-more]');
  await expect(more).toBeVisible();
  // One line: the row is a chip tall.
  expect((await labels.boundingBox())!.height).toBeLessThanOrEqual(34);
  const inRow = (await chipsInRow(page).allTextContents()).map((t) => t.trim());
  expect(inRow.length).toBeGreaterThan(2);
  expect(inRow).toEqual(LEGEND.slice(0, inRow.length));
  const hidden = LEGEND.length - inRow.length;
  await expect(more).toHaveAccessibleName(`${hidden} more labels`);
  await more.click();
  const rest = page.getByRole('group', { name: 'More labels' });
  // The row and "More" together: every chip once, in order.
  await expect(rest.getByRole('button')).toHaveText(LEGEND.slice(inRow.length));
  await page.screenshot({ path: 'test-results/calendar-legend-more.png' });

  // A chip picked behind "More" lights it up, and nothing moves; Show all clears it.
  try {
    const saved = page.waitForResponse((r) => r.url().includes('/api/calendar/prefs'));
    await rest.getByRole('button', { name: 'Unlabelled', exact: true }).click();
    await saved;
    await page.keyboard.press('Escape');
    await expect(more).toHaveAccessibleName(`${hidden} more labels, 1 picked`);
    expect((await chipsInRow(page).allTextContents()).map((t) => t.trim())).toEqual(inRow);
  } finally {
    await clearFilter(page);
  }
  await expect(more).toHaveAccessibleName(`${hidden} more labels`);
});

test('the card names the label; its picker shows the named labels, then plain colour dots', async ({
  page,
}) => {
  await page.goto(`/calendar?view=day&date=${dayFromToday(0)}`);
  await chip(page, 'Ledgerly board prep').click();
  const card = page.getByRole('dialog', { name: 'Ledgerly board prep' });
  await expect(card.locator('[data-event-label]')).toHaveText('Label: Portfolio');
  const picker = card.getByRole('radiogroup', { name: 'Event label' });
  // Nine named chips in Google's order, fifteen dots, and No label.
  await expect(picker.getByRole('radio')).toHaveCount(25);
  const dots = picker.locator('[data-label-colour]');
  await expect(dots).toHaveCount(15);
  const named = await picker
    .getByRole('radio')
    .evaluateAll((els) =>
      els
        .filter((el) => !el.hasAttribute('data-label-colour'))
        .map((el) => el.textContent?.trim() ?? ''),
    );
  expect(named).toEqual([...LEGEND.slice(0, -1), 'No label']);
  // A dot has no text, only Google's name for its colour.
  expect(await dots.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))).toEqual(
    MAIN_COLOURS,
  );
  expect(await dots.evaluateAll((els) => els.map((el) => el.textContent?.trim()))).toEqual(
    MAIN_COLOURS.map(() => ''),
  );
  await expect(card.getByText(/Unnamed/)).toHaveCount(0);
  await expect(picker.getByRole('radio', { name: 'Portfolio' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(picker.getByRole('radio', { name: 'No label' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  // Labels replace Google's eleven colours on a calendar that has them.
  await expect(card.getByRole('radiogroup', { name: 'Event colour' })).toHaveCount(0);
  await expect(card.getByRole('link', { name: /Edit labels in Google Calendar/ })).toHaveAttribute(
    'href',
    /^https:\/\/calendar\.google\.com\//,
  );
  await page.screenshot({ path: 'test-results/calendar-card-labels.png' });
});

test('picking a label sends one PATCH with the label alone, asks nothing, and stays', async ({
  page,
}) => {
  const day = dayFromToday(6);
  const title = `Label check ${Date.now()}`;
  await page.goto(`/calendar?view=day&date=${day}`);
  const column = page.locator(`[data-calendar-view="day"] [data-date="${day}"]`);
  await column.scrollIntoViewIfNeeded();
  const box = (await column.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 8 * 48 + 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 8.5 * 48, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2, box.y + 9 * 48 - 2, { steps: 4 });
  await page.mouse.up();
  const quick = page.getByRole('dialog', { name: 'New event' });
  await quick.getByLabel('Title').fill(title);
  await quick.getByRole('button', { name: 'Save' }).click();
  await expect(chip(page, title)).not.toHaveAttribute('data-event-key', /pending-/);

  const writes = recordWrites(page);
  await chip(page, title).click();
  const card = page.getByRole('dialog', { name: title });
  await card
    .getByRole('radiogroup', { name: 'Event label' })
    .getByRole('radio', { name: 'Travel' })
    .click();
  // No question: a label emails nobody.
  await expect(
    page.getByRole('dialog', { name: /emails to guests|Send your response|repeating/ }),
  ).toHaveCount(0);
  await expect(card.locator('[data-event-label]')).toHaveText('Label: Travel');
  // Travel's colour, Google's own: the label wins over the calendar's.
  await expect(chip(page, title)).toHaveCSS('border-top-color', 'rgb(11, 128, 67)');
  await expect(chip(page, title)).toHaveCSS('background-color', 'rgb(11, 128, 67)');
  expect(writes).toHaveLength(1);
  expect(writes[0]!.method).toBe('PATCH');
  expect(Object.keys(writes[0]!.body ?? {}).sort()).toEqual([
    'calendarId',
    'eventId',
    'kind',
    'labelId',
    'scope',
  ]);
  expect(writes[0]!.body).toMatchObject({
    kind: 'label',
    scope: 'this',
    labelId: expect.any(String),
  });

  await page.reload();
  await expect(chip(page, title).locator('[data-chip-label]')).toHaveText(' · Travel');
  await chip(page, title).click();
  await page
    .getByRole('dialog', { name: title })
    .getByRole('button', { name: 'Delete event' })
    .click();
  await page
    .getByRole('dialog', { name: 'Delete this event?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(chip(page, title)).toHaveCount(0);
});

test('picking a colour dot sends one PATCH with that slot alone, asks nothing, and stays', async ({
  page,
}) => {
  const day = dayFromToday(6);
  const title = `Dot check ${Date.now()}`;
  await page.goto(`/calendar?view=day&date=${day}`);
  const column = page.locator(`[data-calendar-view="day"] [data-date="${day}"]`);
  await column.scrollIntoViewIfNeeded();
  const box = (await column.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10 * 48 + 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 10.5 * 48, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2, box.y + 11 * 48 - 2, { steps: 4 });
  await page.mouse.up();
  const quick = page.getByRole('dialog', { name: 'New event' });
  await quick.getByLabel('Title').fill(title);
  await quick.getByRole('button', { name: 'Save' }).click();
  await expect(chip(page, title)).not.toHaveAttribute('data-event-key', /pending-/);

  const writes = recordWrites(page);
  await chip(page, title).click();
  const card = page.getByRole('dialog', { name: title });
  const answer = page.waitForResponse(
    (r) => r.url().includes('/api/calendar/events') && r.request().method() === 'PATCH',
  );
  await card
    .getByRole('radiogroup', { name: 'Event label' })
    .getByRole('radio', { name: 'Cobalt' })
    .click();
  const response = await answer;
  // No question: a colour emails nobody.
  await expect(
    page.getByRole('dialog', { name: /emails to guests|Send your response|repeating/ }),
  ).toHaveCount(0);
  await expect(card.locator('[data-event-label]')).toHaveText('Colour: Cobalt');
  await expect(chip(page, title)).toHaveCSS('background-color', 'rgb(66, 133, 244)');
  await expect(chip(page, title).locator('[data-chip-label]')).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.method).toBe('PATCH');
  expect(Object.keys(writes[0]!.body ?? {}).sort()).toEqual([
    'calendarId',
    'eventId',
    'kind',
    'labelId',
    'scope',
  ]);
  expect(writes[0]!.body).toMatchObject({ kind: 'label', scope: 'this' });
  expect(writes[0]!.body).not.toHaveProperty('notify');
  // Google's answer: the slot's id, a label with no name.
  const saved = (await response.json()) as {
    event: { labelId: string; label: { name: string | null } };
  };
  expect(saved.event.labelId).toBe(writes[0]!.body!.labelId);
  expect(saved.event.label.name).toBeNull();

  // The mock, like Google, applies eventLabelId only on a write with
  // eventLabelVersion=1: the colour still there after a reload says it was sent.
  await page.reload();
  await expect(chip(page, title)).toHaveCSS('background-color', 'rgb(66, 133, 244)');
  await chip(page, title).click();
  await expect(
    page
      .getByRole('dialog', { name: title })
      .getByRole('radiogroup', { name: 'Event label' })
      .getByRole('radio', { name: 'Cobalt' }),
  ).toHaveAttribute('aria-checked', 'true');
  await page
    .getByRole('dialog', { name: title })
    .getByRole('button', { name: 'Delete event' })
    .click();
  await page
    .getByRole('dialog', { name: 'Delete this event?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(chip(page, title)).toHaveCount(0);
});

test('a suggested label shows on the card and is applied only on a tap', async ({ page }) => {
  await page.goto(`/calendar?view=day&date=${dayFromToday(0)}`);
  const writes = recordWrites(page);
  await chip(page, 'Girder AI — reference call debrief').click();
  const card = page.getByRole('dialog', { name: 'Girder AI — reference call debrief' });
  const suggestion = card.locator('[data-suggested-label]');
  await expect(suggestion).toContainText('Suggested label:');
  await expect(suggestion).toContainText('Diligence');
  await expect(suggestion).toContainText('a deal in the pipeline in diligence');
  await expect(card.locator('[data-event-label]')).toHaveText('No label');
  // Showing a suggestion writes nothing.
  await page.waitForTimeout(300);
  expect(writes).toEqual([]);

  await suggestion.getByRole('button', { name: 'Use the suggested label Diligence' }).click();
  await expect(card.locator('[data-event-label]')).toHaveText('Label: Diligence');
  await expect(suggestion).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.body).toMatchObject({ kind: 'label', labelId: expect.any(String) });
  expect(writes[0]!.body).not.toHaveProperty('notify');

  // Back to no label, as the demo had it.
  await card
    .getByRole('radiogroup', { name: 'Event label' })
    .getByRole('radio', { name: 'No label' })
    .click();
  await expect(card.locator('[data-event-label]')).toHaveText('No label');
  expect(writes[1]!.body).toMatchObject({ kind: 'label', labelId: null });
});

test('the Key explains how events look, and the labels', async ({ page }) => {
  await page.goto(`/calendar?view=week&date=${dayFromToday(0)}`);
  await page.getByRole('button', { name: /^Key/ }).click();
  const key = page.locator('[data-calendar-key]');
  await expect(key).toBeVisible();
  for (const text of [
    'Ended: it already happened.',
    'Not answered yet: Nick hasn’t answered the invitation.',
    'Maybe: Nick said maybe.',
    'Declined: Nick said no.',
    'Meeting: pings Nick’s phone 5 minutes before.',
    'A hold nobody has confirmed.',
  ]) {
    await expect(key.getByText(text)).toBeVisible();
  }
  await expect(key.getByText('Portfolio', { exact: true })).toBeVisible();
  // Named labels only: no colour without a name.
  await expect(key.locator('li', { hasText: /^(Cobalt|Lavender|Cherry blossom)$/ })).toHaveCount(0);
  await expect(key.getByText(/Unnamed/)).toHaveCount(0);
  await page.screenshot({ path: 'test-results/calendar-key.png' });
  await page.keyboard.press('Escape');
  await expect(key).toHaveCount(0);
});

test('past, not answered, maybe and declined look different; a block is not dashed or grey', async ({
  page,
}) => {
  // Yesterday: over, so faded.
  await page.goto(`/calendar?view=day&date=${dayFromToday(-1)}`);
  const recap = chip(page, 'Pipeline recap with Jordan');
  await expect(recap).toHaveAttribute('data-look', 'past');
  await expect(recap).toHaveCSS('opacity', '0.55');

  await page.goto(`/calendar?view=day&date=${dayFromToday(1)}`);
  // Not answered: Google's outline, the surface inside, a thick edge, and a "?".
  const board = chip(page, 'Ledgerly board meeting');
  await expect(board).toHaveAttribute('data-look', 'needsAction');
  await expect(board).toHaveCSS('border-left-width', '4px');
  await expect(board).not.toHaveCSS('background-color', 'rgb(22, 167, 101)');
  await expect(board).toContainText('?');
  // Maybe: stripes.
  const lunch = chip(page, 'LP lunch: Alder Endowment');
  await expect(lunch).toHaveAttribute('data-look', 'tentative');
  await expect(lunch).toHaveCSS('background-image', /repeating-linear-gradient/);
  // Declined: struck through and faded.
  const vendor = chip(page, 'Vendor demo: Quillstack');
  await expect(vendor).toHaveAttribute('data-look', 'declined');
  await expect(vendor.locator('[data-chip-title]')).toHaveCSS(
    'text-decoration-line',
    'line-through',
  );
  await expect(vendor).toHaveCSS('opacity', '0.5');
  // A block (a hold): filled with its colour like any event, solid edge, not faded.
  const hold = chip(page, 'Hold: dentist');
  await expect(hold).not.toHaveAttribute('data-look', /./);
  await expect(hold).toHaveCSS('border-top-style', 'solid');
  await expect(hold).toHaveCSS('background-color', 'rgb(246, 145, 178)');
  await expect(hold).toHaveCSS('opacity', '1');
  await expect(hold).toContainText('Hold');
  // A plain meeting looks the same as the block, bar the bell.
  await page.screenshot({ path: 'test-results/calendar-looks.png' });

  // The card says it in words.
  await board.click();
  const card = page.getByRole('dialog', { name: 'Ledgerly board meeting' });
  await expect(card.locator('[data-event-look]')).toHaveText('Not answered yet');
  await page.keyboard.press('Escape');
  await vendor.click();
  await expect(
    page.getByRole('dialog', { name: 'Vendor demo: Quillstack' }).locator('[data-event-look]'),
  ).toHaveText('Declined');
});

test('How you got here finds the ticket email for a guest-less registration', async ({ page }) => {
  await page.goto(`/calendar?view=day&date=${dayFromToday(2)}`);
  await chip(page, 'Harborlight Founders Mixer').click();
  const card = page.getByRole('dialog', { name: 'Harborlight Founders Mixer' });
  const origin = card.locator('[data-origin]');
  await expect(origin).toContainText('How you got here');
  await expect(origin).toContainText(/Registration email from Harborlight Events, \w{3} \d+/);
  // Both places to read it: Copilot's Inbox, and Gmail.
  const copilot = origin.getByRole('link', {
    name: 'Open in Copilot: Your ticket: Harborlight Founders Mixer',
  });
  const gmail = origin.getByRole('link', {
    name: 'Open in Gmail: Your ticket: Harborlight Founders Mixer',
  });
  await expect(copilot).toHaveAttribute('href', /^\/inbox\?thread=[0-9a-f-]{36}$/);
  await expect(gmail).toHaveAttribute('href', /^\/inbox\?thread=[0-9a-f-]{36}&open=gmail$/);
  // And a label to go with it, from the registration.
  await expect(card.locator('[data-suggested-label]')).toContainText('Event');
  await page.screenshot({ path: 'test-results/calendar-origin.png' });

  await copilot.click();
  await page.waitForURL(/\/inbox/);
  await expect(page.getByText('Your ticket: Harborlight Founders Mixer').first()).toBeVisible();
});

test('when nothing explains an event, it says what was checked and offers the Inbox search', async ({
  page,
}) => {
  await page.goto(`/calendar?view=day&date=${dayFromToday(12)}`);
  // Its top: the investor dinner is drawn over its lower part.
  await chip(page, 'Hotel check-in window').click({ position: { x: 12, y: 8 } });
  const card = page.getByRole('dialog', { name: 'Hotel check-in window' });
  const origin = card.locator('[data-origin]');
  await expect(origin).toContainText('How you got here: Copilot looked for a dossier note');
  await expect(origin).toContainText('and found nothing that explains it.');
  const search = origin.getByRole('link', { name: 'Search the Inbox for ‘Hotel window’' });
  await expect(search).toHaveAttribute('href', '/inbox?q=Hotel%20window');
  await search.click();
  await page.waitForURL(/\/inbox/);
  await expect(page.getByRole('searchbox')).toHaveValue('Hotel window');
  await expect(page.getByText('No mail matches that search.')).toBeVisible();
});

test('Diagnostics lists the named labels, and folds the colours without a name into one line', async ({
  page,
}) => {
  await page.goto('/diagnostics?tab=labels');
  const main = page.locator('[data-label-calendar="nick@tiptop.demo"]');
  await expect(main).toBeVisible();
  const rows = main.locator('tbody > tr:not([data-unnamed-labels])');
  await expect(rows.first()).toContainText('Diligence');
  await expect(main.getByText('Portfolio', { exact: true })).toBeVisible();
  const unnamed = main.locator('[data-unnamed-labels]');
  await expect(unnamed.locator('summary')).toContainText('+15 colours without a name');
  await expect(unnamed.getByText('Cobalt', { exact: true })).toBeHidden();
  await unnamed.locator('summary').click();
  await expect(unnamed.getByText('Cobalt', { exact: true })).toBeVisible();
  await expect(page.getByText(/Unnamed/)).toHaveCount(0);
  // Personal: three named, three colours without a name, the trip on Lavender.
  const personal = page.locator('[data-label-calendar="Personal"]');
  await expect(personal.locator('[data-unnamed-labels] summary')).toContainText(
    '+3 colours without a name',
  );
  await page.screenshot({ path: 'test-results/calendar-diagnostics-labels.png', fullPage: true });
});
