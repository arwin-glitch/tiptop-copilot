import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { pickTime } from './booking-calendar-helpers';

/**
 * The booking link (D-074) in a browser, over the demo: the public page at
 * /meet/nick with nobody signed in (desktop and a 390px phone, light and
 * dark), a 30-minute call and an in-person coffee at a listed place asked
 * for, the chatbot's guided helper filling the form (the visitor presses
 * Send), then Copilot's Calendar tab approving one and declining the other,
 * and last, Approve first switched off again (booking at once, the default,
 * D-078) booking straight away.
 * The demo's calendar is the in-memory mock: nothing reaches Google, and
 * nothing is emailed. Screenshots land in test-results/booking-*.png.
 */

const SIGNED_IN = path.resolve('test-results', 'booking-link-state.json');
const shot = (name: string) => path.resolve('test-results', `booking-${name}.png`);

test.describe.configure({ mode: 'serial' });

/**
 * This spec walks the approve-first flow (D-074), an option since D-078:
 * Settings > Booking link > Rules turns it on for the spec and off after it,
 * so the rest of the suite sees the default (booked at once).
 */
/** Approve first is an option on the Booking tab's Overview (D-078), off by default. */
async function setApproveFirst(page: Page, on: boolean) {
  await page.goto('/booking');
  const mode = page.getByRole('radiogroup', { name: 'Booking mode' });
  const radio = mode.getByRole('radio', { name: on ? /Approve first/ : /Instant/ });
  await expect(radio).toBeVisible();
  if ((await radio.getAttribute('aria-checked')) !== 'true') {
    await radio.click();
    await expect(
      page.getByText(
        on ? 'Bookings now wait for approval' : 'Bookings now go straight on the calendar',
      ),
    ).toBeVisible();
  }
  await expect(radio).toHaveAttribute('aria-checked', 'true');
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
  await setApproveFirst(page, true);
  await context.close();
});

test.afterAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: SIGNED_IN,
  });
  await setApproveFirst(await context.newPage(), false);
  await context.close();
});

let address = 20;

/**
 * A visitor: no session at all, from its own invented address
 * (cf-connecting-ip), so the other booking specs' per-address brakes never
 * trip this one.
 */
async function visitor(browser: Browser, baseURL: string | undefined, options = {}) {
  address += 1;
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { 'cf-connecting-ip': `198.51.100.${address}` },
    ...options,
  });
  return { context, page: await context.newPage() };
}

async function pickFirstTime(page: Page) {
  const times = page.getByRole('radiogroup', { name: 'Time' });
  await expect(times.getByRole('radio').first()).toBeVisible();
  await times.getByRole('radio').first().click();
  await expect(times.getByRole('radio', { checked: true })).toHaveCount(1);
}

/**
 * The last time on the last day offered: the call this spec approves lands
 * on the demo's shared mock calendar, so it goes about three weeks out, clear
 * of the days the calendar specs drag events on.
 */
async function pickLastTime(page: Page) {
  await pickTime(page, 'last', 'last');
}

async function fillAboutYou(page: Page, name: string, email: string, company: string) {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel(/^Company/).fill(company);
  await page
    .getByLabel('What would you like to talk about?')
    .fill('A short intro to what we are building.');
}

/**
 * Booking requests (Approve first) open from the button on the Booking
 * tab's Bookings subtab, in a drawer (D-078: it left the Calendar header).
 */
async function openRequests(page: Page) {
  await page.goto('/booking?tab=bookings');
  const button = page.getByRole('button', { name: /^Booking requests/ });
  await expect(button).toBeVisible();
  await button.click();
  const drawer = page.getByRole('dialog', { name: 'Booking requests' });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

test('the public page opens with nobody signed in, in its own TipTop face', async ({
  browser,
}, testInfo) => {
  const { context, page } = await visitor(browser, testInfo.project.use.baseURL, {
    viewport: { width: 1280, height: 900 },
    colorScheme: 'light',
  });
  await page.goto('/meet/nick');
  await expect(page).toHaveURL(/\/meet\/nick$/);
  await expect(page).toHaveTitle('Meet with Nick Avery');
  await expect(page.getByRole('heading', { level: 1, name: 'Nick Avery' })).toBeVisible();
  await expect(page.getByText('Partner, TipTop VC (Demo)')).toBeVisible();
  await expect(page.getByText('Scheduling by TipTop Copilot')).toBeVisible();
  // The chatbot is tagged AI.
  const launcher = page.getByRole('button', { name: /Ask Arwin/ });
  await expect(launcher).toBeVisible();
  await expect(launcher.locator('[data-ai-tag]')).toBeVisible();
  // Times are labelled with the visitor's zone.
  await expect(page.getByText('Times shown in')).toBeVisible();
  await expect(
    page.getByRole('radiogroup', { name: 'Time' }).getByRole('radio').first(),
  ).toBeVisible();
  // Nothing about the host's calendar is on the page: only open times.
  await expect(page.getByText('Ledgerly board meeting')).toHaveCount(0);
  await page.screenshot({
    animations: 'disabled',
    path: shot('public-desktop-light'),
    fullPage: true,
  });

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(
    page.getByRole('radiogroup', { name: 'Time' }).getByRole('radio').first(),
  ).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: shot('public-desktop-dark'),
    fullPage: true,
  });
  await context.close();
});

test('on a 390px phone: no sideways scroll, and a 30-minute call asked for', async ({
  browser,
}, testInfo) => {
  const { context, page } = await visitor(browser, testInfo.project.use.baseURL, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  });
  await page.goto('/meet/nick');
  await expect(page.getByRole('heading', { level: 1, name: 'Nick Avery' })).toBeVisible();
  await expect(
    page.getByRole('radiogroup', { name: 'Time' }).getByRole('radio').first(),
  ).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.screenshot({
    animations: 'disabled',
    path: shot('public-phone-dark'),
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await expect(
    page.getByRole('radiogroup', { name: 'Time' }).getByRole('radio').first(),
  ).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: shot('public-phone-light'),
    fullPage: true,
  });

  await pickLastTime(page);
  await fillAboutYou(page, 'Casey Call', 'casey.call@example.com', 'Brightwell Labs');
  await page.getByLabel(/^Deck link/).fill('https://deck.example/brightwell');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(
    page.getByRole('heading', {
      name: "Request sent. You'll get a calendar invitation once the time is booked.",
    }),
  ).toBeVisible();
  await expect(page.getByText('30-min Google Meet')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/confirm|review|approv/i);
  await expectNoSidewaysScroll(page);
  await context.close();
});

test('an hour in person: coffee at one of the listed places', async ({ browser }, testInfo) => {
  const { context, page } = await visitor(browser, testInfo.project.use.baseURL, {
    viewport: { width: 1280, height: 900 },
  });
  await page.goto('/meet/nick');
  await page.getByRole('button', { name: /1 hour in person/ }).click();
  await expect(page.getByRole('radio', { name: 'Coffee', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await pickFirstTime(page);
  await page.getByRole('radio', { name: /Juniper & Rye Coffee/ }).check();
  await fillAboutYou(page, 'Morgan Coffee', 'morgan.coffee@example.com', 'Quillfield');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(
    page.getByRole('heading', {
      name: "Request sent. You'll get a calendar invitation once the time is booked.",
    }),
  ).toBeVisible();
  await expect(page.getByText('Coffee, 1 hour at Juniper & Rye Coffee')).toBeVisible();
  await context.close();
});

test('the assistant books in the chat itself (D-078)', async ({ browser }, testInfo) => {
  // The assistant's own flows are covered in booking-chat.spec.ts; this keeps
  // the chat-booked request the Copilot side checks below ("Jordan Chat").
  const { context, page } = await visitor(browser, testInfo.project.use.baseURL, {
    viewport: { width: 1280, height: 900 },
  });
  await page.goto('/meet/nick');
  await page.getByRole('button', { name: /Ask Arwin/ }).click();
  const chat = page.getByRole('dialog', { name: /Arwin/ });
  await expect(chat).toBeVisible();
  await expect(
    chat.getByText("Hi, I'm Arwin, Nick's AI scheduling assistant.", { exact: false }),
  ).toBeVisible();
  await expect(chat.getByText('Arwin is an AI assistant.', { exact: false })).toBeVisible();

  await chat.getByRole('button', { name: 'Book a 30-min call' }).click();
  const times = chat.getByRole('group', { name: 'Open times' }).last();
  await expect(times.getByRole('button').first()).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: shot('chatbot-guided') });
  await times.getByRole('button').first().click();
  const form = chat.getByRole('form', { name: 'Your details' });
  await form.getByLabel('Name', { exact: true }).fill('Jordan Chat');
  await form.getByLabel('Email', { exact: true }).fill('jordan.chat@example.com');
  await form.getByLabel('Company (optional)').fill('Northbeam');
  await form.getByRole('button', { name: /^Book / }).click();
  await expect(chat.locator('[data-booking-status]')).toBeVisible();
  await context.close();
});

test.describe('in Copilot', () => {
  test.use({ storageState: SIGNED_IN, viewport: { width: 1366, height: 900 } });

  test('Today says how many requests wait, and links to them', async ({ page }) => {
    await page.goto('/today');
    const line = page.getByText(/\d+ booking requests? waiting\./);
    await expect(line).toBeVisible();
    await page.getByRole('link', { name: 'Review in Booking →' }).click();
    // Straight to the Booking tab's requests drawer (D-078).
    await expect(page).toHaveURL(/\/booking\?tab=bookings#booking-requests$/);
    // The link opens the drawer itself.
    const drawer = page.getByRole('dialog', { name: 'Booking requests' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('listitem').first()).toBeVisible();
    // Closed, it stays closed on a reload.
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page).toHaveURL(/\/booking\?tab=bookings$/);
  });

  test('approve the call: re-checked, then on the calendar with the invite sent', async ({
    page,
  }) => {
    const panel = await openRequests(page);
    const call = panel.getByRole('listitem', { name: 'Request from Casey Call' });
    await expect(call).toBeVisible();
    await expect(call.getByText('Brightwell Labs')).toBeVisible();
    await expect(call.getByText('A short intro to what we are building.')).toBeVisible();
    await expect(call.getByRole('link', { name: /Deck/ })).toHaveAttribute(
      'href',
      'https://deck.example/brightwell',
    );
    await expect(
      panel
        .getByRole('listitem', { name: 'Request from Jordan Chat' })
        .getByText('Filled with the chatbot'),
    ).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: shot('copilot-panel') });

    // Nobody checked the address, and Approve emails it: one more tap to be sure.
    await expect(call.getByText('Email not checked')).toBeVisible();
    await call.getByRole('button', { name: 'Approve' }).click();
    const confirm = call.getByRole('group', { name: 'Confirm approval' });
    await expect(confirm).toContainText('email an invitation to casey.call@example.com');
    await confirm.getByRole('button', { name: 'Yes, approve' }).click();
    await expect(
      page.getByText("Added to Nick's calendar. The invitation went to the requester."),
    ).toBeVisible();
    await expect(panel.getByRole('listitem', { name: 'Request from Casey Call' })).toHaveCount(0);
  });

  test('decline the coffee: marked declined, a decline email to read, nothing sent', async ({
    page,
  }) => {
    const panel = await openRequests(page);
    const coffee = panel.getByRole('listitem', { name: 'Request from Morgan Coffee' });
    await expect(coffee.getByText(/Coffee, 1 hour in person/)).toBeVisible();
    await expect(coffee.getByText('Juniper & Rye Coffee', { exact: false })).toBeVisible();
    await coffee.getByRole('button', { name: 'Decline' }).click();
    await expect(coffee.getByText('Declined. Nothing was sent.')).toBeVisible();
    await coffee.getByRole('button', { name: 'Write a decline email' }).click();
    // The drawer makes way for the compose window, which sends nothing on its own.
    await expect(panel).toHaveCount(0);
    const composer = page.getByRole('dialog', { name: /Decline email/ });
    await expect(composer).toBeVisible();
    await expect(composer.getByLabel('To')).toHaveValue('morgan.coffee@example.com');
    await expect(composer.getByLabel('Subject')).toHaveValue('Your meeting request with Nick');
    await expect(composer.getByText('Written and signed as Arwin', { exact: false })).toBeVisible();
    await expect(composer.getByRole('button', { name: 'Arwin', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.screenshot({ animations: 'disabled', path: shot('copilot-decline-draft') });
  });

  test('the Calendar tab keeps a small Booking link shortcut, on a phone too, moving nothing', async ({
    page,
  }) => {
    await page.goto('/calendar');
    const shortcut = page.getByRole('link', { name: /^Booking link/ });
    await expect(shortcut).toBeVisible();
    await expect(shortcut).toHaveAttribute('href', '/booking');
    await page.screenshot({
      animations: 'disabled',
      path: shot('copilot-calendar-header'),
      clip: { x: 0, y: 0, width: 1366, height: 320 },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(shortcut).toBeVisible();
    const tour = (await page.getByRole('button', { name: 'Tour this page' }).boundingBox())!;
    const box = (await shortcut.boundingBox())!;
    expect(box.x).toBeGreaterThan(tour.x + tour.width);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await expectNoSidewaysScroll(page);
    await page.screenshot({ animations: 'disabled', path: shot('copilot-calendar-phone') });
  });

  test('the Booking tab has the off-switch, and the chatbot its answers', async ({ page }) => {
    // Settings' old address lands on the Booking tab (D-078).
    await page.goto('/settings?tab=booking');
    await page.waitForURL(/\/booking$/);
    await expect(page.getByRole('switch', { name: 'Take bookings' })).toBeChecked();
    await page
      .getByRole('navigation', { name: 'Booking sections' })
      .getByRole('link', { name: 'Chatbot' })
      .click();
    await expect(page.getByLabel('Answer 1')).toHaveValue(/TipTop VC \(Demo\) is an invented fund/);
    // Zero spend: no money field on the chatbot settings, and it says it's free.
    await expect(page.getByLabel('Monthly AI cost cap (US$)')).toHaveCount(0);
    await expect(page.getByText('Free: no API key.', { exact: false })).toBeVisible();
    await expect(page.getByText(/US\$|AI cost|AI budget|cost cap/i)).toHaveCount(0);
    await page.screenshot({ animations: 'disabled', path: shot('copilot-settings') });
  });
});

/**
 * Booking at once (D-078, which superseded the D-074 Instant switch): this
 * spec runs with Approve first on, so it turns it off on the Booking tab,
 * books from the public page at 1440 and on a 390px phone, cancels each
 * booking from its own page (so the link's daily cap stays free for the
 * specs after it), and turns Approve first back on whatever happens. Each
 * booking goes about three weeks out (pickLastTime), clear of the days the
 * calendar specs use.
 */
test.describe('Instant booking', () => {
  test.use({ storageState: SIGNED_IN, viewport: { width: 1440, height: 900 } });

  async function setInstant(page: Page, on: boolean) {
    await setApproveFirst(page, !on);
  }

  test('on: a free time is booked straight away, at 1440 and on a 390px phone', async ({
    page,
    browser,
  }, testInfo) => {
    await setInstant(page, true);
    try {
      const visitors = [
        {
          name: 'Riley Instant',
          email: 'riley.instant@example.com',
          size: 'desktop',
          options: { viewport: { width: 1440, height: 900 } },
        },
        {
          name: 'Sam Phone',
          email: 'sam.phone@example.com',
          size: 'phone',
          options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
        },
      ];
      for (const who of visitors) {
        const { context, page: guest } = await visitor(browser, testInfo.project.use.baseURL, {
          ...who.options,
          // An Eastern visitor: the time is said in their zone and in Central.
          timezoneId: 'America/New_York',
        });
        await guest.goto('/meet/nick');
        await pickLastTime(guest);
        await fillAboutYou(guest, who.name, who.email, 'Kestrel Works');
        await guest.getByRole('button', { name: 'Book meeting' }).click();
        await expect(guest.getByRole('heading', { name: "You're booked with Nick" })).toBeVisible();
        await expect(guest.getByText('30-min Google Meet').first()).toBeVisible();
        // The time in their zone, and in Central.
        await expect(guest.getByText(/Eastern Time/).first()).toBeVisible();
        await expect(guest.getByText(/Central Time \(Chicago\)/).first()).toBeVisible();
        await expect(
          guest.getByText(`The calendar invitation is on its way to ${who.email}.`),
        ).toBeVisible();
        // Nobody is said to confirm or review it.
        await expect(guest.getByText(/confirm|review|approv/i)).toHaveCount(0);
        await expectNoSidewaysScroll(guest);
        await guest.screenshot({
          animations: 'disabled',
          path: shot(`instant-booked-${who.size}`),
          fullPage: true,
        });
        await guest.getByRole('link', { name: 'Reschedule or cancel' }).click();
        await guest.getByRole('button', { name: 'Cancel meeting' }).click();
        await guest.getByRole('button', { name: 'Cancel meeting' }).click();
        await expect(
          guest.getByRole('heading', { name: 'This meeting was cancelled' }),
        ).toBeVisible();
        await context.close();
      }
      // Booked, so neither waits on the Calendar tab.
      const panel = await openRequests(page);
      await expect(panel.getByRole('listitem', { name: 'Request from Riley Instant' })).toHaveCount(
        0,
      );
      await expect(panel.getByRole('listitem', { name: 'Request from Sam Phone' })).toHaveCount(0);
    } finally {
      await setInstant(page, false);
    }
  });
});
