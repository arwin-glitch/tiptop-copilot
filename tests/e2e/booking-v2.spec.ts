import path from 'node:path';
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

/**
 * The whole booking link v2 demo flow (D-078), in a browser, at 1440 and at a
 * 390px phone: the Booking tab switches a month on (and only its days offer
 * times on the public page) and off (none); the page books a call on the
 * saved Zoom link (the label, never the link) with two guests at once; the
 * confirmation hands over an .ics file and the booking's own page; that page
 * says "You have a meeting with Nick", moves the SAME event and cancels it
 * with a note, which Copilot shows on the Booking tab and on Today. Plus a
 * coffee at a listed place, a booking made in the chat, and an answer from
 * the written list. The demo calendar is the in-memory mock: nothing reaches
 * Google and nothing is emailed. Every person, address and link is invented.
 *
 * Each visitor comes from its own invented address (cf-connecting-ip), so
 * the per-address brakes of the other booking specs never trip this one.
 */

const SIGNED_IN = path.resolve('test-results', 'booking-v2-state.json');
const SHOTS = process.env.BOOKING_SHOTS_DIR ?? path.resolve('test-results', 'booking-v2-shots');
const shot = (name: string) => path.join(SHOTS, `booking-v2-flow-${name}.png`);
const ZOOM = 'https://example.zoom.us/j/5550001234?pwd=fictional';
const PERSON_CONFIRMS =
  /will confirm|confirms your|someone will review|Arwin will|until .* approves/i;

test.describe.configure({ mode: 'serial' });

let address = 10;

async function visitor(browser: Browser, baseURL: string | undefined, width: number) {
  const phone = width < 768;
  address += 1;
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    viewport: { width, height: phone ? 844 : 900 },
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
    colorScheme: 'light',
    timezoneId: 'America/Chicago',
    extraHTTPHeaders: { 'cf-connecting-ip': `203.0.113.${address}` },
  });
  return { context, page: await context.newPage() };
}

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

async function copilot(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({
    baseURL,
    storageState: SIGNED_IN,
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
  });
}

/** The public page's open call times, as the page asks for them. */
async function callSlots(request: APIRequestContext): Promise<string[]> {
  const res = await request.get('/api/meet/nick/slots?type=call', {
    headers: { 'cf-connecting-ip': '203.0.113.250' },
  });
  const json = (await res.json()) as { slots?: { start: string }[] };
  return (json.slots ?? []).map((s) => s.start);
}

/** `YYYY-MM` of an instant in Central time, the host's zone. */
const centralMonth = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date(iso))
    .slice(0, 7);

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

/** A day in the middle of what is offered, then its first time. */
async function pickMiddleTime(page: Page, which: 'first' | 'last' = 'first') {
  const days = page.getByRole('radiogroup', { name: 'Day' });
  await expect(days.getByRole('radio').first()).toBeVisible();
  const count = await days.getByRole('radio').count();
  await days
    .getByRole('radio')
    .nth(Math.floor(count / 2))
    .click();
  const times = page.getByRole('radiogroup', { name: 'Time' });
  await (
    which === 'first' ? times.getByRole('radio').first() : times.getByRole('radio').last()
  ).click();
  await expect(times.getByRole('radio', { checked: true })).toHaveCount(1);
}

test('the Booking tab switches months on and off, and the public page follows', async ({
  browser,
}, testInfo) => {
  const context = await copilot(browser, testInfo.project.use.baseURL);
  const page = await context.newPage();
  await page.goto('/booking?tab=availability');
  const months = page.locator('[data-tour="booking-months"] button[data-month]');
  await expect(months).toHaveCount(12);
  const names = (await months.evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-month')),
  )) as string[];

  // Close all: no month open, no times anywhere.
  await page.getByRole('button', { name: 'Close all' }).click();
  await expect(page.getByText('Every month is off')).toBeVisible();
  await expect(page.getByTestId('open-months')).toContainText('No month is open');
  expect(await callSlots(page.request)).toEqual([]);

  // Only the month two out: only its days offer times.
  const twoOut = names[2]!;
  await months.nth(2).click();
  await expect(months.nth(2)).toHaveAttribute('data-state', 'open');
  await expect(page.getByTestId(`month-count-${twoOut}`)).toHaveText(/^[1-9]\d* times?$/);
  const only = await callSlots(page.request);
  expect(only.length).toBeGreaterThan(0);
  expect(new Set(only.map(centralMonth))).toEqual(new Set([twoOut]));
  await expect(page.getByRole('grid').locator('[data-open="yes"]').first()).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: shot('month-two-out'), fullPage: true });

  // Close it again: none. "Why no times?" says the month is not open.
  await months.nth(2).click();
  await expect(months.nth(2)).toHaveAttribute('data-state', 'off');
  expect(await callSlots(page.request)).toEqual([]);
  await page.goto('/booking');
  await expect(page.locator('[data-check="months"]')).toContainText('No month is open');
  await expect(
    page.locator('[data-tour="booking-why"] [data-reason="month_closed"]').first(),
  ).toBeVisible();

  // Open November (next month here): the preview shows its times.
  await page.goto('/booking?tab=availability');
  await months.nth(1).click();
  await expect(months.nth(1)).toHaveAttribute('data-state', 'open');
  await expect(page.getByRole('heading', { name: /: what visitors see$/ })).toContainText(
    new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(
      new Date(`${names[1]}-15T12:00:00Z`),
    ),
  );
  await expect(page.getByRole('grid').locator('[data-open="yes"]').first()).toBeVisible();
  // And this month back on: the default again (this month and next).
  await months.nth(0).click();
  await expect(months.nth(0)).toHaveAttribute('data-state', 'open');
  await expect(page.getByTestId('open-months')).toContainText('Open:');
  await page.screenshot({ animations: 'disabled', path: shot('months-default'), fullPage: true });

  // Calls go on a saved Zoom link from here on (restored to Google Meet at the end).
  await page.goto('/booking?tab=profile');
  await page.getByLabel('Video link for calls').fill(ZOOM);
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText(/saved/i).first()).toBeVisible();
  await context.close();
});

for (const width of [1440, 390]) {
  test(`a call with two guests on the Zoom link, moved and cancelled, seen in Copilot at ${width}px`, async ({
    browser,
  }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    const { context, page } = await visitor(browser, baseURL, width);
    const name = `Riley Stone ${width}`;
    const email = `riley.${width}@example.com`;
    await page.goto('/meet/nick');
    // What a call is on, by name: never the link itself.
    await expect(page.getByText('30-min Zoom call').first()).toBeVisible();
    expect(await page.content()).not.toContain('zoom.us');
    await expect(page.locator('body')).not.toContainText(PERSON_CONFIRMS);
    await pickMiddleTime(page, width === 1440 ? 'first' : 'last');
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel(/^Company/).fill('Brightwater Labs');
    await page.getByRole('button', { name: 'Add guests' }).click();
    for (const guest of [`ana.${width}@example.com`, `kit.${width}@example.com`]) {
      await page.getByRole('textbox', { name: /^Guests/ }).fill(guest);
      await page.getByRole('textbox', { name: /^Guests/ }).press('Enter');
    }
    await expect(page.getByRole('list', { name: 'Guests' }).getByRole('listitem')).toHaveCount(2);
    await page.getByRole('button', { name: 'Book meeting' }).click();

    // Booked at once.
    await expect(page.getByRole('heading', { name: "You're booked with Nick" })).toBeVisible();
    await expect(page.getByText('30-min Zoom call').first()).toBeVisible();
    await expect(page.getByText(`ana.${width}@example.com`)).toBeVisible();
    await expect(page.getByText(`kit.${width}@example.com`)).toBeVisible();
    expect(await page.content()).not.toContain('zoom.us');
    await expect(page.locator('body')).not.toContainText(PERSON_CONFIRMS);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Add to calendar' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.ics$/);
    await expectNoSidewaysScroll(page);
    await page.screenshot({ animations: 'disabled', path: shot(`confirmation-${width}`) });
    const manageHref = (await page
      .getByRole('link', { name: 'Reschedule or cancel' })
      .getAttribute('href'))!;
    expect(manageHref).toMatch(/^\/meet\/nick\/b\/[A-Za-z0-9_-]{43}$/);

    // The booking's own page: who, when, where.
    await page.goto(manageHref);
    await expect(
      page.getByRole('heading', { name: /^You have a meeting with Nick/ }),
    ).toBeVisible();
    await expect(page.getByText('30-min Zoom call').first()).toBeVisible();
    await expect(page.getByText(`kit.${width}@example.com`)).toBeVisible();
    await expectNoSidewaysScroll(page);
    await page.screenshot({
      animations: 'disabled',
      path: shot(`manage-${width}`),
      fullPage: true,
    });

    // Copilot sees it booked, with its event in Google Calendar.
    const nick = await copilot(browser, baseURL);
    const tab = await nick.newPage();
    await tab.goto('/booking?tab=bookings');
    const item = tab.getByRole('listitem', { name: `Booking with ${name}` });
    await expect(item.getByText('Booked', { exact: true })).toBeVisible();
    await expect(item.getByText(`ana.${width}@example.com`)).toBeVisible();
    const eventLink = await item
      .getByRole('link', { name: 'Google Calendar' })
      .getAttribute('href');
    expect(eventLink).toMatch(/^https:\/\/www\.google\.com\/calendar\/event\?eid=/);

    // Reschedule: the same event moves.
    await page.getByRole('button', { name: 'Reschedule' }).click();
    const times = page.getByRole('radiogroup', { name: 'Time' });
    await expect(times.getByRole('radio').first()).toBeVisible();
    await times.getByRole('radio').first().click();
    await page.getByRole('button', { name: /^Move to / }).click();
    await expect(page.getByText(/^Rescheduled to /)).toBeVisible();
    await tab.reload();
    await expect(item.getByText('Moved once')).toBeVisible();
    expect(await item.getByRole('link', { name: 'Google Calendar' }).getAttribute('href')).toBe(
      eventLink,
    );

    // Cancel with a note for Nick.
    const note = `Something came up at Brightwater, sorry (${width}).`;
    await page.getByRole('button', { name: 'Cancel meeting' }).click();
    await page.getByLabel(/^Note to Nick/).fill(note);
    await page.getByRole('button', { name: 'Cancel meeting' }).click();
    await expect(page.getByRole('heading', { name: 'This meeting was cancelled' })).toBeVisible();
    await expect(page.getByText(/and Nick gets your note\.$/)).toBeVisible();
    await expectNoSidewaysScroll(page);

    // Nick sees it: the Booking tab with the note, and the Today line.
    await tab.reload();
    await expect(item.getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(item.getByText(note)).toBeVisible();
    await tab.goto('/today');
    await expect(tab.getByText(/Booking link, last day: .*cancellation/)).toBeVisible();
    await expect(tab.getByText(note)).toBeVisible();
    await nick.close();
    await context.close();
  });
}

test('an hour in person: coffee at a listed place', async ({ browser }, testInfo) => {
  const { context, page } = await visitor(browser, testInfo.project.use.baseURL, 1440);
  await page.goto('/meet/nick');
  await page.getByText('1 hour in person').click();
  await page
    .getByRole('radiogroup', { name: 'Coffee, lunch or dinner' })
    .getByRole('radio', { name: 'Coffee' })
    .click();
  await pickMiddleTime(page, 'last');
  await page.getByLabel(/Juniper & Rye Coffee/).check();
  await page.getByLabel('Name', { exact: true }).fill('Dana Reyes');
  await page.getByLabel('Email', { exact: true }).fill('dana.reyes@example.com');
  await page.getByRole('button', { name: 'Book meeting' }).click();
  await expect(page.getByRole('heading', { name: "You're booked with Nick" })).toBeVisible();
  await expect(page.getByText('Juniper & Rye Coffee').first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText(PERSON_CONFIRMS);
  await page.screenshot({ animations: 'disabled', path: shot('coffee-1440') });
  // Freed again, so the day's caps stay open for the specs after this one.
  await page.getByRole('link', { name: 'Reschedule or cancel' }).click();
  await page.getByRole('button', { name: 'Cancel meeting' }).click();
  await page.getByRole('button', { name: 'Cancel meeting' }).click();
  await expect(page.getByRole('heading', { name: 'This meeting was cancelled' })).toBeVisible();
  await context.close();
});

for (const width of [1440, 390]) {
  test(`the chat books a call and answers from the list at ${width}px`, async ({
    browser,
  }, testInfo) => {
    const { context, page } = await visitor(browser, testInfo.project.use.baseURL, width);
    await page.goto('/meet/nick');
    await page.getByRole('button', { name: /Ask Arwin/ }).click();
    const chat = page.getByRole('dialog', { name: /Arwin/ });
    await expect(chat).toBeVisible();

    // An answer from the written list, no AI.
    const input = chat.getByRole('textbox', { name: 'Ask Arwin a question' });
    await input.fill('What stage do you invest in?');
    await input.press('Enter');
    await expect(chat.getByText('Stage: pre-seed and seed software companies.')).toBeVisible();

    // Booked through the same route as the form: at once, with its own page.
    await chat.getByRole('button', { name: 'Book a 30-min call' }).last().click();
    const times = chat.getByRole('group', { name: 'Open times' }).last();
    await expect(times.getByRole('button').first()).toBeVisible();
    await times
      .getByRole('button')
      .nth(width === 1440 ? 1 : 3)
      .click();
    const form = chat.getByRole('form', { name: 'Your details' });
    await form.getByLabel('Name', { exact: true }).fill(`Casey Chat ${width}`);
    await form.getByLabel('Email', { exact: true }).fill(`casey.chat.${width}@example.com`);
    await form.getByRole('button', { name: /^Book / }).click();
    const card = chat.locator('[data-booking-status="booked"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('30-min Zoom call');
    await expect(chat).not.toContainText(PERSON_CONFIRMS);
    const manage = card.getByRole('link', { name: 'Reschedule or cancel' });
    const href = (await manage.getAttribute('href'))!;
    expect(href).toMatch(/^\/meet\/nick\/b\/[A-Za-z0-9_-]{43}$/);
    await expectNoSidewaysScroll(page);
    await page.screenshot({ animations: 'disabled', path: shot(`chat-${width}`) });

    // Cancelled from its own page, so nothing is left holding a day.
    await page.goto(href);
    await expect(
      page.getByRole('heading', { name: /^You have a meeting with Nick/ }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Cancel meeting' }).click();
    await page.getByRole('button', { name: 'Cancel meeting' }).click();
    await expect(page.getByRole('heading', { name: 'This meeting was cancelled' })).toBeVisible();
    await context.close();
  });
}

test('back to Google Meet for calls (the other specs expect it)', async ({ browser }, testInfo) => {
  const context = await copilot(browser, testInfo.project.use.baseURL);
  const page = await context.newPage();
  await page.goto('/booking?tab=profile');
  await page.getByLabel('Video link for calls').fill('');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText(/saved/i).first()).toBeVisible();
  await page.goto('/meet/nick');
  await expect(page.getByText('30-min Google Meet').first()).toBeVisible();
  await context.close();
});
