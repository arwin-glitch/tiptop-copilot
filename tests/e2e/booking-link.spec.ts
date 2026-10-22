import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * The booking link (D-074) in a browser, over the demo: the public page at
 * /meet/nick with nobody signed in (desktop and a 390px phone, light and
 * dark), a 30-minute call and an in-person coffee at a listed place asked
 * for, the chatbot's guided helper filling the form (the visitor presses
 * Send), then Copilot's Calendar tab approving one and declining the other.
 * The demo's calendar is the in-memory mock: nothing reaches Google, and
 * nothing is emailed. Screenshots land in test-results/booking-*.png.
 */

const SIGNED_IN = path.resolve('test-results', 'booking-link-state.json');
const shot = (name: string) => path.resolve('test-results', `booking-${name}.png`);

test.describe.configure({ mode: 'serial' });

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

/** A visitor: no session at all. */
async function visitor(browser: Browser, baseURL: string | undefined, options = {}) {
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
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
  const days = page.getByRole('radiogroup', { name: 'Day' });
  await expect(days.getByRole('radio').first()).toBeVisible();
  await days.getByRole('radio').last().click();
  await expect(days.getByRole('radio').last()).toHaveAttribute('aria-checked', 'true');
  const times = page.getByRole('radiogroup', { name: 'Time' });
  await times.getByRole('radio').last().click();
  await expect(times.getByRole('radio', { checked: true })).toHaveCount(1);
}

async function fillAboutYou(page: Page, name: string, email: string, company: string) {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel(/^Company/).fill(company);
  await page
    .getByLabel('What would you like to talk about?')
    .fill('A short intro to what we are building.');
}

/** Booking requests open from the button over the Calendar page's header, in a drawer. */
async function openRequests(page: Page) {
  await page.goto('/calendar');
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
  await expect(page.getByText(/30-min Google Meet ·/)).toBeVisible();
  await expect(
    page.getByText('Nothing is on the calendar yet. Watch your inbox for the invitation.'),
  ).toBeVisible();
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
  await expect(page.getByText(/Coffee, 1 hour · .* · Juniper & Rye Coffee/)).toBeVisible();
  await context.close();
});

test('the chatbot’s guided helper fills the form, and the visitor presses Send', async ({
  browser,
}, testInfo) => {
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
  // No model in the demo: the guided buttons, no free-text box.
  await expect(chat.getByRole('textbox')).toHaveCount(0);

  await chat.getByRole('button', { name: 'About TipTop VC (Demo)' }).click();
  await expect(
    chat.getByText('TipTop VC (Demo) is an invented fund', { exact: false }),
  ).toBeVisible();

  await chat.getByRole('button', { name: 'Find a time' }).click();
  await chat.getByRole('button', { name: '30-min Google Meet' }).click();
  const times = chat.getByRole('group', { name: 'Open times' }).last();
  await expect(times.getByRole('button').first()).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: shot('chatbot-guided') });
  await times.getByRole('button').first().click();
  await expect(chat.getByText(/in the form\. Add your name and email there/)).toBeVisible();
  await chat.getByRole('button', { name: 'Close chat' }).click();

  await expect(page.getByText('Arwin filled in the form for you.', { exact: false })).toBeVisible();
  await expect(
    page.getByRole('radiogroup', { name: 'Time' }).getByRole('radio', { checked: true }),
  ).toHaveCount(1);
  // Nothing was sent until the visitor presses Send.
  await fillAboutYou(page, 'Jordan Chat', 'jordan.chat@example.com', 'Northbeam');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(
    page.getByRole('heading', {
      name: "Request sent. You'll get a calendar invitation once the time is booked.",
    }),
  ).toBeVisible();
  await context.close();
});

test.describe('in Copilot', () => {
  test.use({ storageState: SIGNED_IN, viewport: { width: 1366, height: 900 } });

  test('Today says how many requests wait, and links to them', async ({ page }) => {
    await page.goto('/today');
    const line = page.getByText(/\d+ booking requests? waiting\./);
    await expect(line).toBeVisible();
    await page.getByRole('link', { name: 'Review in Calendar →' }).click();
    await expect(page).toHaveURL(/\/calendar#booking-requests$/);
    // The link opens the drawer itself.
    const drawer = page.getByRole('dialog', { name: 'Booking requests' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('listitem').first()).toBeVisible();
    // Closed, it stays closed on a reload, and the calendar is where it was.
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page).toHaveURL(/\/calendar$/);
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

  test('the button sits beside the title, on a phone too, and moves nothing', async ({ page }) => {
    await page.goto('/calendar');
    const button = page.getByRole('button', { name: /^Booking requests/ });
    await expect(button).toBeVisible();
    await page.screenshot({
      animations: 'disabled',
      path: shot('copilot-calendar-header'),
      clip: { x: 0, y: 0, width: 1366, height: 320 },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const phone = page.getByRole('button', { name: /^Requests/ });
    await expect(phone).toBeVisible();
    const tour = (await page.getByRole('button', { name: 'Tour this page' }).boundingBox())!;
    const box = (await phone.boundingBox())!;
    expect(box.x).toBeGreaterThan(tour.x + tour.width);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await expectNoSidewaysScroll(page);
    await page.screenshot({ animations: 'disabled', path: shot('copilot-calendar-phone') });
  });

  test('Settings has the Booking link tab, off-switch and all', async ({ page }) => {
    await page.goto('/settings?tab=booking');
    await expect(page.getByRole('tab', { name: 'Booking link' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('switch', { name: 'Take bookings' })).toBeChecked();
    await page.getByRole('tab', { name: 'Chatbot' }).click();
    await expect(page.getByLabel('Public FAQ for the chatbot')).toHaveValue(/invented fund/);
    await expect(page.getByLabel('Monthly AI cost cap (US$)')).toHaveValue('20');
    await page.screenshot({ animations: 'disabled', path: shot('copilot-settings') });
  });
});
