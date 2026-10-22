import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * A click on any event in the new Calendar views opens Google Calendar's
 * event card beside it (a sheet from the bottom on a phone), with Google's
 * options as they apply: Edit, Delete, Duplicate, Email guests, its colour,
 * Going? for an invitation, Join and Copy the Meet link, Open in Google
 * Calendar. All over the demo's in-memory mock calendar: nothing here can
 * reach Google, and nothing emails anyone.
 *
 * Also Google's layout: titles wrap in narrow columns, the quick editor opens
 * beside the slot just dragged (which stays drawn), and a drag across days
 * makes one event over all of them in Month and in Week's all-day row.
 */

const SIGNED_IN = path.resolve('test-results', 'calendar-event-card-state.json');
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

async function dragOnColumn(
  page: Page,
  view: 'day' | 'week',
  date: string,
  fromHour: number,
  toHour: number,
) {
  const column = grid(page, view).locator(`[data-date="${date}"]`);
  await column.scrollIntoViewIfNeeded();
  const box = (await column.boundingBox())!;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + fromHour * 48 + 2);
  await page.mouse.down();
  await page.mouse.move(x, box.y + (fromHour + 0.5) * 48, { steps: 4 });
  await page.mouse.move(x, box.y + toHour * 48 - 2, { steps: 4 });
  await page.mouse.up();
}

/** Drag from the empty lower part of one cell to another's. */
async function dragAcross(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height - 6);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height - 6, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height - 6, { steps: 6 });
  await page.mouse.up();
}

/**
 * Every write the page sends to the calendar routes, as sent: what the
 * server is asked to do, so a test fails if the page asks for more than the
 * person chose (a notify they did not pick, a field beside the colour).
 */
function recordWrites(page: Page) {
  const writes: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' || !/\/api\/(calendar|inbox)\//.test(r.url())) return;
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

/** Side by side, not on top: the card does not cover what it is about. */
function beside(card: { x: number; width: number }, target: { x: number; width: number }) {
  return card.x >= target.x + target.width - 2 || card.x + card.width <= target.x + 2;
}

/** A new event from a drag; on `calendar` (its name) rather than the main one, if given. */
async function newEvent(
  page: Page,
  day: string,
  fromHour: number,
  title: string,
  calendar?: string,
) {
  await page.goto(`/calendar?view=day&date=${day}`);
  await expect(grid(page, 'day')).toBeVisible();
  await dragOnColumn(page, 'day', day, fromHour, fromHour + 1);
  const quick = page.getByRole('dialog', { name: 'New event' });
  await quick.getByLabel('Title').fill(title);
  if (calendar) await quick.getByLabel('Calendar').selectOption({ label: calendar });
  await quick.getByRole('button', { name: 'Save' }).click();
  await expect(chip(page, title)).toBeVisible();
  // Saved: it has the id Google gave it.
  await expect(chip(page, title)).not.toHaveAttribute('data-event-key', /pending-/);
}

async function deleteEvent(page: Page, title: string) {
  await chip(page, title).first().click();
  await page
    .getByRole('dialog', { name: title })
    .getByRole('button', { name: 'Delete event' })
    .click();
  await page
    .getByRole('dialog', { name: 'Delete this event?' })
    .getByRole('button', { name: 'Delete' })
    .click();
}

test('a click on an event opens Google’s card beside it, with Google’s options', async ({
  page,
}) => {
  await page.goto(`/calendar?view=week&date=${dayFromToday(0)}`);
  const event = chip(page, 'Founder office hours');
  await event.click();
  const card = page.getByRole('dialog', { name: 'Founder office hours' });
  await expect(card).toBeVisible();

  for (const name of ['Edit event', 'Delete event', 'Duplicate', 'Email guests', 'Close']) {
    await expect(card.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(card.getByRole('link', { name: 'Join with Google Meet' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Copy Meet link' })).toBeVisible();
  await expect(
    card.getByRole('radiogroup', { name: 'Event colour' }).getByRole('radio'),
  ).toHaveCount(12);
  await expect(card.getByRole('link', { name: /Open in Google Calendar/ }).first()).toBeVisible();
  // What Google shows, and Copilot's verdict with the ping.
  await expect(card.getByText('Central Time')).toBeVisible();
  await expect(card.getByText('1 guest', { exact: true })).toBeVisible();
  await expect(card.getByText('TipTop team')).toBeVisible();
  await expect(card.getByText('Meeting', { exact: true })).toBeVisible();
  await expect(card.getByText(/Pings 5 min before/)).toBeVisible();
  // Nick organizes it: nothing to answer.
  await expect(card.getByRole('group', { name: 'Going?' })).toHaveCount(0);

  // Beside the event, not a centred dialog over the calendar.
  const e = (await event.boundingBox())!;
  const c = (await card.boundingBox())!;
  expect(beside(c, e)).toBe(true);
  await expect(card).not.toHaveAttribute('aria-modal', 'true');
  await page.screenshot({ path: 'test-results/calendar-card.png' });

  // A press on an empty slot only closes the card, as in Google Calendar.
  const allDay = grid(page, 'week').locator(`[data-all-day-date="${dayFromToday(0)}"]`);
  const box = (await allDay.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 3);
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'New event' })).toHaveCount(0);

  // A click on another event moves the card to it, and that card stays open.
  await event.click();
  await expect(card).toBeVisible();
  await chip(page, 'Portfolio check-in').click();
  const other = page.getByRole('dialog', { name: 'Portfolio check-in' });
  await expect(other).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(other).toBeVisible();

  // Esc closes it too.
  await page.keyboard.press('Escape');
  await expect(other).toHaveCount(0);
});

test('titles wrap over whole words where a chip has room, and take one line where it is narrow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The demo's conference day, twelve days out.
  await page.goto(`/calendar?view=week&date=${dayFromToday(12)}`);
  // The flight is tall and nearly a column wide: its title wraps, word by word.
  const wide = chip(page, 'Travel: flight to Denver').locator('[data-chip-title]');
  await expect(wide).toBeVisible();
  expect((await wide.boundingBox())!.height).toBeGreaterThan(20);
  await expect(wide).toHaveCSS('white-space', 'normal');
  await expect(wide).toHaveCSS('overflow-wrap', 'normal');
  await expect(wide).toHaveCSS('word-break', 'normal');
  // Three meetings at noon share the width: a narrow chip's title is one line, cut with an ellipsis.
  const narrow = chip(page, 'LP check-in: Harborview').locator('[data-chip-title]');
  await expect(narrow).toHaveCSS('white-space', 'nowrap');
  await expect(narrow).toHaveCSS('text-overflow', 'ellipsis');
});

test('a colour from the card changes it at once, asks nothing, and stays', async ({ page }) => {
  const day = dayFromToday(6);
  const title = `Colour check ${Date.now()}`;
  // The team calendar has no colour labels, so its events take Google's eleven colours.
  await newEvent(page, day, 8, title, 'TipTop team');
  const writes = recordWrites(page);
  await chip(page, title).click();
  const card = page.getByRole('dialog', { name: title });
  await card.getByRole('radio', { name: 'Tomato' }).click();
  // No question: a colour emails nobody.
  await expect(
    page.getByRole('dialog', { name: /emails to guests|Send your response/ }),
  ).toHaveCount(0);
  await expect(card.getByRole('radio', { name: 'Tomato' })).toHaveAttribute('aria-checked', 'true');
  // The tick stands out on a dark swatch: white on Tomato, not the dark tick.
  await expect(card.getByRole('radio', { name: 'Tomato' }).locator('svg')).toHaveCSS(
    'color',
    'rgb(255, 255, 255)',
  );
  await expect(chip(page, title)).toHaveCSS('border-top-color', 'rgb(220, 33, 39)');
  // The page asked for the colour and nothing else: no notify, no other field.
  expect(writes).toHaveLength(1);
  expect(writes[0]!.method).toBe('PATCH');
  expect(Object.keys(writes[0]!.body ?? {}).sort()).toEqual([
    'calendarId',
    'colorId',
    'eventId',
    'kind',
    'scope',
  ]);
  expect(writes[0]!.body).toMatchObject({ kind: 'color', colorId: '11', scope: 'this' });
  await page.screenshot({ path: 'test-results/calendar-card-colour.png' });

  await page.reload();
  await expect(chip(page, title)).toHaveCSS('border-top-color', 'rgb(220, 33, 39)');
  await deleteEvent(page, title);
  await expect(chip(page, title)).toHaveCount(0);
});

test('Duplicate opens the editor prefilled and saves a new event; with guests it asks first', async ({
  page,
}) => {
  const day = dayFromToday(6);
  const title = `Dup check ${Date.now()}`;
  await newEvent(page, day, 10, title);
  const writes = recordWrites(page);
  await chip(page, title).click();
  await page
    .getByRole('dialog', { name: title })
    .getByRole('button', { name: 'Duplicate' })
    .click();
  const editor = page.getByRole('dialog', { name: 'Duplicate event' });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Title')).toHaveValue(title);
  await expect(editor.getByLabel('Start time')).toHaveValue('10:00');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(chip(page, title)).toHaveCount(2);
  // A new event (one create), and the original is not touched.
  expect(writes.map((w) => w.method)).toEqual(['POST']);
  expect(writes[0]!.body).toMatchObject({ notify: 'dont_send' });
  expect(writes[0]!.body).not.toHaveProperty('eventId');
  await deleteEvent(page, title);
  await deleteEvent(page, title);
  await expect(chip(page, title)).toHaveCount(0);

  // With guests, saving the copy asks Google's invitations question; Cancel makes nothing.
  await page.goto(`/calendar?view=day&date=${dayFromToday(0)}`);
  await chip(page, 'Founder office hours').click();
  await page
    .getByRole('dialog', { name: 'Founder office hours' })
    .getByRole('button', { name: 'Duplicate' })
    .click();
  const copy = page.getByRole('dialog', { name: 'Duplicate event' });
  await expect(copy.getByRole('list', { name: 'Guests added' })).toContainText(
    'jordan@tiptop.demo',
  );
  await copy.getByRole('button', { name: 'Save' }).click();
  const ask = page.getByRole('dialog', { name: 'Send invitation emails to guests?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(copy).toBeVisible();
  await copy.getByRole('button', { name: 'Cancel' }).click();
  await expect(chip(page, 'Founder office hours')).toHaveCount(1);
  // Cancel in the invitations question sent nothing at all.
  expect(writes.filter((w) => w.method === 'POST')).toHaveLength(1);
});

test('a Duplicate that fails to save reopens as "Duplicate event", with what was typed', async ({
  page,
}) => {
  const day = dayFromToday(6);
  const title = `Dup fail ${Date.now()}`;
  await newEvent(page, day, 12, title);
  // The save is refused before it reaches even the demo calendar.
  await page.route('**/api/calendar/events', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 502,
          json: { ok: false, error: { message: 'Google Calendar did not answer. Try again.' } },
        })
      : route.continue(),
  );
  await chip(page, title).click();
  await page
    .getByRole('dialog', { name: title })
    .getByRole('button', { name: 'Duplicate' })
    .click();
  const editor = page.getByRole('dialog', { name: 'Duplicate event' });
  await editor.getByLabel('Title').fill(`${title} copy`);
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Google Calendar did not answer. Try again.')).toBeVisible();
  // Back as it was: still the duplicate, not a new event.
  await expect(editor).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'New event' })).toHaveCount(0);
  await expect(editor.getByLabel('Title')).toHaveValue(`${title} copy`);
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(chip(page, `${title} copy`)).toHaveCount(0);
  await page.unroute('**/api/calendar/events');
  await deleteEvent(page, title);
  await expect(chip(page, title)).toHaveCount(0);
});

test('Going? asks whether to tell the organizer, and Cancel writes nothing', async ({ page }) => {
  await page.goto(`/calendar?view=day&date=${dayFromToday(1)}`);
  await chip(page, 'Ledgerly board meeting').click();
  const card = page.getByRole('dialog', { name: 'Ledgerly board meeting' });
  const going = card.getByRole('group', { name: 'Going?' });
  const yes = going.getByRole('button', { name: 'Yes', exact: true });
  const maybe = going.getByRole('button', { name: 'Maybe', exact: true });
  await expect(yes).toHaveAttribute('aria-pressed', 'false');
  // Google's details: guests and their answers, the place, the description's link, the file.
  await expect(card.getByText('2 guests', { exact: true })).toBeVisible();
  await expect(card.getByText('· 1 yes, 1 maybe')).toBeVisible();
  await expect(card.getByText('Organizer', { exact: true })).toHaveCount(0);
  await expect(card.getByText('Organizer: Maya Chen')).toBeVisible();
  await expect(card.getByRole('link', { name: '500 Example Blvd, Austin' })).toHaveAttribute(
    'href',
    /^https:\/\/www\.google\.com\/maps\/search\//,
  );
  await expect(card.getByRole('link', { name: 'board agenda' })).toHaveAttribute(
    'href',
    'https://docs.google.com/document/d/demo-ledgerly-agenda',
  );
  await expect(card.getByRole('link', { name: 'Ledgerly Q3 board deck.pdf' })).toBeVisible();
  // Only the organizer can change it: no Edit or Delete, but a colour and Duplicate.
  await expect(card.getByRole('button', { name: 'Edit event' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Delete event' })).toHaveCount(0);
  await expect(card.getByRole('radiogroup', { name: 'Event colour' })).toBeVisible();

  const writes = recordWrites(page);
  await yes.click();
  const ask = page.getByRole('dialog', { name: 'Send your response to the organizer?' });
  await expect(ask).toBeVisible();
  await expect(ask.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  await expect(ask.getByRole('button', { name: "Don't send" })).toBeVisible();
  // Send is never the default: Enter on the question as it opens is not Send.
  await expect(ask.getByRole('button', { name: 'Send', exact: true })).not.toBeFocused();
  await page.screenshot({ path: 'test-results/calendar-card-rsvp.png' });
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  // Esc on the question is Cancel too.
  await yes.click();
  await expect(ask).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ask).toHaveCount(0);
  // Nothing changed, on the card or on the calendar, and nothing was sent.
  await expect(card).toBeVisible();
  await expect(yes).toHaveAttribute('aria-pressed', 'false');
  expect(writes).toEqual([]);
  await page.reload();
  await chip(page, 'Ledgerly board meeting').click();
  await expect(yes).toHaveAttribute('aria-pressed', 'false');

  // Maybe, Don't send: saved, and nobody is told.
  await maybe.click();
  await ask.getByRole('button', { name: "Don't send" }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(maybe).toHaveAttribute('aria-pressed', 'true');
  expect(writes).toHaveLength(1);
  expect(writes[0]!.method).toBe('PATCH');
  expect(writes[0]!.body).toEqual({
    kind: 'respond',
    calendarId: expect.any(String),
    eventId: 'demoteamboard',
    scope: 'this',
    response: 'tentative',
    notify: 'dont_send',
  });
  await page.reload();
  await chip(page, 'Ledgerly board meeting').click();
  await expect(maybe).toHaveAttribute('aria-pressed', 'true');
});

test('a read-only event shows its details and only what writes nothing', async ({ page }) => {
  await page.goto(`/calendar?view=week&date=${dayFromToday(5)}`);
  await chip(page, 'Founders Day (demo)').click();
  const card = page.getByRole('dialog', { name: 'Founders Day (demo)' });
  await expect(card).toBeVisible();
  await expect(card.getByText(/This calendar is view-only for this account/)).toBeVisible();
  for (const name of ['Edit event', 'Delete event', 'Duplicate']) {
    await expect(card.getByRole('button', { name })).toHaveCount(0);
  }
  await expect(card.getByRole('radiogroup', { name: 'Event colour' })).toHaveCount(0);
  await expect(card.getByRole('group', { name: 'Going?' })).toHaveCount(0);
  await expect(card.getByRole('link', { name: /Open in Google Calendar/ }).first()).toBeVisible();
});

test('Email guests opens a draft to the guests; nothing sends without its own tap', async ({
  page,
}) => {
  await page.goto(`/calendar?view=day&date=${dayFromToday(0)}`);
  const writes = recordWrites(page);
  await chip(page, 'Founder office hours').click();
  await page
    .getByRole('dialog', { name: 'Founder office hours' })
    .getByRole('button', { name: 'Email guests' })
    .click();
  const compose = page.getByRole('dialog', { name: 'Email guests' });
  await expect(compose).toBeVisible();
  await expect(compose.getByLabel('To')).toHaveValue('jordan@tiptop.demo');
  await expect(compose.getByLabel('Subject')).toHaveValue('Founder office hours');
  // The demo cannot send: it offers Copy for Gmail, never a hidden send.
  await expect(compose.getByRole('button', { name: 'Copy for Gmail' })).toBeVisible();
  await expect(compose.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  await compose.getByRole('button', { name: 'Close' }).click();
  await expect(compose).toHaveCount(0);
  // Opening and closing the draft sent nothing anywhere.
  expect(writes).toEqual([]);
});

test('a meeting’s latest emails on its card offer Copilot or Gmail', async ({ page }) => {
  // The demo mailbox has no email with these guests, so the context answer is
  // stubbed with a fictional thread; the card draws whatever the route says.
  await page.route('**/api/calendar/context?**', (route) =>
    route.fulfill({
      json: {
        ok: true,
        found: true,
        context: {
          dossier: null,
          prep: null,
          recent: [
            {
              id: '18f0a1b2c3d4e5f6',
              subject: 'Reference call notes',
              at: new Date().toISOString(),
            },
          ],
        },
      },
    }),
  );
  await page.goto(`/calendar?view=day&date=${dayFromToday(0)}`);
  const title = 'Girder AI — reference call debrief';
  await chip(page, title).click();
  const card = page.getByRole('dialog', { name: title });
  await expect(card.getByText('Latest emails with them', { exact: true })).toBeVisible();
  await expect(
    card.getByRole('link', { name: 'Open in Copilot: Reference call notes' }),
  ).toHaveAttribute('href', '/inbox?thread=18f0a1b2c3d4e5f6');
  const gmail = card.getByRole('link', { name: 'Open in Gmail: Reference call notes' });
  await expect(gmail).toHaveAttribute(
    'href',
    /^https:\/\/mail\.google\.com\/mail\/\?authuser=[^#]+#all\/18f0a1b2c3d4e5f6$/,
  );
  await expect(gmail).toHaveAttribute('target', '_blank');
});

test('the quick editor opens beside the dragged slot, which stays drawn', async ({ page }) => {
  const day = '2027-03-10';
  await page.goto(`/calendar?view=week&date=${day}`);
  await expect(grid(page, 'week')).toBeVisible();
  await dragOnColumn(page, 'week', day, 10, 11);
  const quick = page.getByRole('dialog', { name: 'New event' });
  await expect(quick).toBeVisible();
  await expect(quick).toContainText('10am – 11am');
  const slot = page.locator('[data-new-event]');
  await expect(slot).toBeVisible();
  await expect(slot).toContainText('(No title)');
  expect(beside((await quick.boundingBox())!, (await slot.boundingBox())!)).toBe(true);
  await page.screenshot({ path: 'test-results/calendar-quick-editor.png' });

  // More options goes on to the full editor with what was typed.
  await quick.getByLabel('Title').fill('Not kept');
  await quick.getByRole('button', { name: 'More options' }).click();
  const full = page.getByRole('dialog', { name: 'New event' });
  await expect(full.getByLabel('Title')).toHaveValue('Not kept');
  await expect(full.getByLabel('Location')).toBeVisible();
  await full.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('[data-new-event]')).toHaveCount(0);
  await expect(chip(page, 'Not kept')).toHaveCount(0);
});

test('drag across days in Month makes one event over all of them', async ({ page }) => {
  const title = `Offsite ${Date.now()}`;
  await page.goto('/calendar?view=month&date=2027-03-10');
  const month = grid(page, 'month');
  await expect(month).toBeVisible();
  await dragAcross(
    page,
    month.locator('[data-date="2027-03-09"]'),
    month.locator('[data-date="2027-03-11"]'),
  );
  const quick = page.getByRole('dialog', { name: 'New event' });
  await expect(quick).toBeVisible();
  await expect(quick).toContainText('Tuesday, March 9 – Thursday, March 11');
  // The days stay marked while the quick editor is open.
  await expect(month.locator('[data-marked]')).toHaveCount(3);
  await page.screenshot({ path: 'test-results/calendar-month-range.png' });
  await quick.getByLabel('Title').fill(title);
  await quick.getByRole('button', { name: 'Save' }).click();
  const bar = chip(page, title);
  await expect(bar).toHaveCount(1);
  await expect(bar).toHaveAccessibleName(/all day/);
  const cell = (await month.locator('[data-date="2027-03-10"]').boundingBox())!;
  expect((await bar.boundingBox())!.width).toBeGreaterThan(cell.width * 2.5);
  await deleteEvent(page, title);
  await expect(chip(page, title)).toHaveCount(0);
});

test('drag across days in the week’s all-day row makes a multi-day event', async ({ page }) => {
  const title = `Trip ${Date.now()}`;
  await page.goto('/calendar?view=week&date=2027-03-10');
  const week = grid(page, 'week');
  await dragAcross(
    page,
    week.locator('[data-all-day-date="2027-03-08"]'),
    week.locator('[data-all-day-date="2027-03-10"]'),
  );
  const quick = page.getByRole('dialog', { name: 'New event' });
  await expect(quick).toContainText('Monday, March 8 – Wednesday, March 10');
  await expect(page.locator('[data-new-event]')).toBeVisible();
  await quick.getByLabel('Title').fill(title);
  await quick.getByRole('button', { name: 'Save' }).click();
  await expect(chip(page, title)).toHaveAccessibleName(/all day/);
  await deleteEvent(page, title);
  await expect(chip(page, title)).toHaveCount(0);
});

test('on a phone the card is a sheet from the bottom of the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/calendar?view=day&date=${dayFromToday(1)}`);
  await chip(page, 'Ledgerly board meeting').click();
  const sheet = page.getByRole('dialog', { name: 'Ledgerly board meeting' });
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(box.y + box.height).toBeGreaterThan(844 - 4);
  expect(box.width).toBeGreaterThan(380);
  await expect(sheet.getByRole('group', { name: 'Going?' })).toBeVisible();
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
  await page.screenshot({ path: 'test-results/calendar-card-phone.png' });
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
});
