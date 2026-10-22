import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { pickTime } from './booking-calendar-helpers';

/**
 * The booking link v2 (D-078) in a browser, over the demo, at 1440 and at a
 * 390px phone: a visitor books a call with a guest and it is booked at once
 * ("You're booked with Nick"), the booking page remembers it, the booking's
 * own page shows when, where and who, Reschedule moves it to another time,
 * and Cancel with a note cancels it. The demo's calendar is the in-memory
 * mock: nothing reaches Google, and nothing is emailed.
 */

const SHOTS = process.env.BOOKING_SHOTS_DIR ?? path.resolve('test-results', 'booking-v2-shots');
const shot = (name: string, width: number) => path.join(SHOTS, `booking-v2-${name}-${width}.png`);

test.describe.configure({ mode: 'serial' });

/** A visitor from its own invented address, so other specs' per-address brakes never trip. */
async function visitor(browser: Browser, baseURL: string | undefined, width: number) {
  const phone = width < 768;
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { 'cf-connecting-ip': `198.51.100.${width === 1440 ? 61 : 62}` },
    viewport: { width, height: phone ? 844 : 900 },
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
    colorScheme: 'light',
  });
  return { context, page: await context.newPage() };
}

/** The last time on the last day offered: clear of the days the calendar specs use. */
async function pickLastTime(page: Page) {
  await pickTime(page, 'last', 'last');
}

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

for (const width of [1440, 390]) {
  test(`book, see it, reschedule and cancel with a note at ${width}px`, async ({
    browser,
  }, testInfo) => {
    const { context, page } = await visitor(browser, testInfo.project.use.baseURL, width);
    const email = `jordan.${width}@example.com`;
    await page.goto('/meet/nick');
    await expect(page.getByText('Booked straight onto the calendar')).toBeVisible();
    await pickLastTime(page);
    await page.getByLabel('Name', { exact: true }).fill(`Jordan Lane ${width}`);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel(/^Company/).fill('Northwind Labs');
    await page.getByRole('button', { name: 'Add guests' }).click();
    await page.getByLabel(/^Guests/).fill(`partner.${width}@example.com`);
    await page.getByLabel(/^Guests/).press('Enter');
    await expect(page.getByRole('list', { name: 'Guests' })).toContainText(
      `partner.${width}@example.com`,
    );
    await page
      .getByLabel('What would you like to talk about?')
      .fill('A short intro to what we are building.');
    await page.getByRole('button', { name: 'Book meeting' }).click();

    // Booked at once: the confirmation names no person who confirms anything.
    await expect(page.getByRole('heading', { name: "You're booked with Nick" })).toBeVisible();
    await expect(
      page.getByText(`The calendar invitation is on its way to ${email}.`),
    ).toBeVisible();
    await expect(page.getByText('30-min Google Meet')).toBeVisible();
    await expect(page.getByText(`partner.${width}@example.com`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add to calendar' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/confirm|review|approv/i);
    await expectNoSidewaysScroll(page);
    await page.screenshot({
      animations: 'disabled',
      path: shot('confirmation', width),
      fullPage: true,
    });

    // Add to calendar hands over an .ics file.
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Add to calendar' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.ics$/);

    // The booking page remembers it on this device.
    const manage = page.getByRole('link', { name: 'Reschedule or cancel' });
    const manageHref = await manage.getAttribute('href');
    expect(manageHref).toMatch(/^\/meet\/nick\/b\/[A-Za-z0-9_-]{43}$/);
    await page.goto('/meet/nick');
    await expect(page.getByText(/You have a meeting with Nick Avery on/)).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: shot('banner', width), fullPage: true });
    await page.getByRole('link', { name: 'See, reschedule or cancel' }).click();

    // The booking's own page.
    await expect(page).toHaveURL(new RegExp(`${manageHref}$`));
    await expect(
      page.getByRole('heading', { name: 'You have a meeting with Nick Avery' }),
    ).toBeVisible();
    await expect(page.getByText('30-min Google Meet')).toBeVisible();
    await expect(page.getByRole('link', { name: /meet\.google\.com/ })).toBeVisible();
    await expect(page.getByText(`partner.${width}@example.com`)).toBeVisible();
    await expectNoSidewaysScroll(page);
    await page.screenshot({ animations: 'disabled', path: shot('manage', width), fullPage: true });

    // Reschedule: the same picker, another time, and the same event moves.
    await page.getByRole('button', { name: 'Reschedule' }).click();
    const times = page.getByRole('radiogroup', { name: 'Time' });
    await expect(times.getByRole('radio').first()).toBeVisible();
    await times.getByRole('radio').first().click();
    await page.screenshot({
      animations: 'disabled',
      path: shot('reschedule', width),
      fullPage: true,
    });
    await page.getByRole('button', { name: /^Move to / }).click();
    await expect(
      page.getByText(/^Rescheduled to .*Everyone invited gets the update from the calendar\.$/),
    ).toBeVisible();
    await page.screenshot({
      animations: 'disabled',
      path: shot('rescheduled', width),
      fullPage: true,
    });

    // Cancel, with a note for Nick.
    await page.getByRole('button', { name: 'Cancel meeting' }).click();
    await page.getByLabel(/^Note to Nick/).fill('Something came up on our side. Sorry!');
    await page.getByRole('button', { name: 'Cancel meeting' }).click();
    await expect(page.getByRole('heading', { name: 'This meeting was cancelled' })).toBeVisible();
    await expect(page.getByText(/^Cancelled\. .*and Nick gets your note\.$/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reschedule' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Book a new time' })).toBeVisible();
    await expectNoSidewaysScroll(page);
    await page.screenshot({
      animations: 'disabled',
      path: shot('cancelled', width),
      fullPage: true,
    });

    // Forgotten on this device once cancelled.
    await page.goto('/meet/nick');
    await expect(page.getByRole('heading', { level: 1, name: 'Nick Avery' })).toBeVisible();
    await expect(page.getByText(/You have a meeting with Nick Avery on/)).toHaveCount(0);
    await context.close();
  });
}

test('a booking page that is not one says so, and links back', async ({ browser }, testInfo) => {
  const { context, page } = await visitor(browser, testInfo.project.use.baseURL, 1440);
  await page.goto(`/meet/nick/b/${'x'.repeat(43)}`);
  await expect(page.getByRole('heading', { name: 'This booking is not here' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to the booking page' })).toHaveAttribute(
    'href',
    '/meet/nick',
  );
  await context.close();
});
