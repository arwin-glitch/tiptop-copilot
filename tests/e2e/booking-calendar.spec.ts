import path from 'node:path';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { bookingCalendar, pickOpenDay } from './booking-calendar-helpers';

/**
 * The public booking page's calendar card (D-078), at 1440 (three columns:
 * the host's card, the form, the calendar) and at a 390px phone (the
 * calendar above the times), light and dark: open days with their counts,
 * a fully booked day, days not offered, the device's own meeting linking to
 * its page, month arrows that stop at the open months, keyboard moves, and
 * the day picked in the calendar driving the time list. Only day states
 * reach the page, never why a day is closed. Every visitor is invented, each
 * from its own invented address; every booking made here is cancelled.
 */

const SHOTS = process.env.BOOKING_SHOTS_DIR ?? path.resolve('test-results', 'booking-calendar');
const shot = (name: string) => path.join(SHOTS, `booking-calendar-${name}.png`);

test.describe.configure({ mode: 'serial' });

let address = 40;

async function visitor(
  browser: Browser,
  baseURL: string | undefined,
  width: number,
  colorScheme: 'light' | 'dark' = 'light',
) {
  const phone = width < 768;
  address += 1;
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    viewport: { width, height: phone ? 844 : 900 },
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
    colorScheme,
    timezoneId: 'America/Chicago',
    extraHTTPHeaders: { 'cf-connecting-ip': `203.0.113.${address}` },
  });
  return { context, page: await context.newPage() };
}

interface Slot {
  start: string;
  end: string;
}

/** The call slots and day states the page gets, as an outside caller would read them. */
async function callSlots(request: APIRequestContext) {
  const res = await request.get('/api/meet/nick/slots?type=call', {
    headers: { 'cf-connecting-ip': '203.0.113.251' },
  });
  return (await res.json()) as {
    slots: Slot[];
    days: { date: string; state: string }[];
    months: string[];
  };
}

/** A booking made straight through the request route (another visitor), for its page token. */
async function bookDirect(
  request: APIRequestContext,
  baseURL: string,
  start: string,
  n: number,
): Promise<string> {
  const res = await request.post('/api/meet/nick/request', {
    headers: { origin: baseURL, 'cf-connecting-ip': `203.0.113.${120 + n}` },
    data: {
      name: `Filler Visitor ${n}`,
      email: `filler.${n}.${Date.now()}@example.com`,
      type: 'call',
      start,
      timeZone: 'America/Chicago',
      source: 'form',
    },
  });
  const json = (await res.json()) as { ok: boolean; manageUrl?: string };
  expect(json.ok, JSON.stringify(json)).toBe(true);
  return json.manageUrl!.split('/').pop()!;
}

async function cancelDirect(request: APIRequestContext, baseURL: string, token: string, n: number) {
  const res = await request.post(`/api/meet/nick/booking/${token}/cancel`, {
    headers: { origin: baseURL, 'cf-connecting-ip': `203.0.113.${120 + n}` },
    data: { note: '' },
  });
  expect(res.ok()).toBe(true);
}

const chicagoDay = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

test('the slots API gives the card day states and months, and nothing else', async ({
  request,
}) => {
  const json = await callSlots(request);
  expect(json.months.length).toBeGreaterThan(0);
  expect(json.days.length).toBeGreaterThan(0);
  for (const day of json.days) {
    expect(Object.keys(day).sort()).toEqual(['date', 'state']);
    expect(['open', 'booked', 'off']).toContain(day.state);
  }
  const open = new Set(json.slots.map((s) => chicagoDay(s.start)));
  for (const day of json.days) expect(day.state === 'open').toBe(open.has(day.date));
});

for (const width of [1440, 390]) {
  test(`open, booked and not-offered days, and your meeting, at ${width}px`, async ({
    browser,
    request,
  }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL!;
    // Fill one far-off day up to its cap (two link bookings): it shows as booked.
    const before = await callSlots(request);
    const lastDay = [...new Set(before.slots.map((s) => chicagoDay(s.start)))].at(-1)!;
    const dayTimes = before.slots.filter((s) => chicagoDay(s.start) === lastDay);
    const fillers = [
      await bookDirect(request, baseURL, dayTimes[0]!.start, width === 1440 ? 1 : 3),
      await bookDirect(request, baseURL, dayTimes.at(-1)!.start, width === 1440 ? 2 : 4),
    ];
    const after = await callSlots(request);
    expect(after.days.find((d) => d.date === lastDay)?.state).toBe('booked');

    const { context, page } = await visitor(browser, baseURL, width);
    await page.goto('/meet/nick');
    const calendar = bookingCalendar(page);
    await expect(calendar).toBeVisible();
    await expect(calendar.getByRole('grid')).toHaveAttribute(
      'aria-label',
      /^Open days for a 30-min /,
    );
    if (width >= 1280) {
      // Three columns: the calendar is the right-hand card, beside the form.
      const card = page.getByRole('complementary', { name: 'Calendar' });
      await expect(card).toBeVisible();
      const form = await page.locator('form').boundingBox();
      const box = await card.boundingBox();
      expect(box!.x).toBeGreaterThan(form!.x + form!.width - 1);
      expect(box!.y).toBeLessThan(400);
    } else {
      // On a phone it sits above the times.
      await expect(page.getByRole('complementary', { name: 'Calendar' })).toBeHidden();
      const cal = await calendar.boundingBox();
      const times = await page.getByRole('radiogroup', { name: 'Time' }).boundingBox();
      expect(cal!.y + cal!.height).toBeLessThanOrEqual(times!.y + 1);
      expect(cal!.height).toBeLessThan(520);
    }

    // Open days speak their count; a weekend day is not offered and cannot be picked.
    const open = calendar.locator('button[data-state="open"]');
    await expect(open.first()).toHaveAttribute(
      'aria-label',
      /^\w+day \d{1,2} \w+, \d+ open times?$/,
    );
    const off = calendar.locator('button[data-state="off"]').first();
    await expect(off).toHaveAttribute('aria-label', /, not offered$/);
    await expect(off).toHaveAttribute('aria-disabled', 'true');

    // The day picked in the calendar is the day the times are for.
    const day = await pickOpenDay(page, 'first');
    const label = (await day.getAttribute('aria-label'))!;
    const count = Number(/, (\d+) open times?$/.exec(label)![1]);
    const times = page.getByRole('radiogroup', { name: 'Time' });
    await expect(times.getByRole('radio')).toHaveCount(count);

    // Keyboard: the arrows move between days.
    await day.focus();
    const key = (await day.getAttribute('data-day'))!;
    await page.keyboard.press('ArrowRight');
    const next = new Date(`${key}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const nextKey = next.toISOString().slice(0, 10);
    if (nextKey.slice(0, 7) === key.slice(0, 7)) {
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-day')))
        .toBe(nextKey);
    }

    // The arrows go only to open months; the last one has the full day.
    const nextMonth = calendar.getByRole('button', { name: 'Next open month' });
    while (await nextMonth.isEnabled()) await nextMonth.click();
    await expect(nextMonth).toBeDisabled();
    const full = calendar.locator(`button[data-day="${lastDay}"]`);
    await expect(full).toHaveAttribute('data-state', 'booked');
    await expect(full).toHaveAttribute('aria-label', /, fully booked$/);
    await expect(full).toContainText('Booked');
    await expectNoSidewaysScroll(page);
    await page.screenshot({ animations: 'disabled', path: shot(`days-${width}`) });

    // Book one: back on the page, its day is "Your meeting", a link to its page.
    await page.goto('/meet/nick');
    await pickOpenDay(page, 'middle');
    await times.getByRole('radio').first().click();
    await page.getByLabel('Name', { exact: true }).fill(`Morgan Calendar ${width}`);
    await page.getByLabel('Email', { exact: true }).fill(`morgan.calendar.${width}@example.com`);
    await page.getByRole('button', { name: 'Book meeting' }).click();
    await expect(page.getByRole('heading', { name: "You're booked with Nick" })).toBeVisible();
    const manageHref = (await page
      .getByRole('link', { name: 'Reschedule or cancel' })
      .getAttribute('href'))!;
    await page.goto('/meet/nick');
    await expect(page.getByText(/^You have a meeting with Nick/)).toBeVisible();
    const mine = bookingCalendar(page).locator('a[data-state="mine"]');
    // It may be in a later month than the one shown first.
    const forward = bookingCalendar(page).getByRole('button', { name: 'Next open month' });
    while ((await mine.count()) === 0 && (await forward.isEnabled())) await forward.click();
    await expect(mine).toHaveAttribute('href', manageHref);
    await expect(mine).toHaveAttribute('aria-label', /, your meeting: see, reschedule or cancel$/);
    await expect(bookingCalendar(page).getByText('Your meeting', { exact: true })).toBeVisible();
    await page.screenshot({
      animations: 'disabled',
      path: shot(`mine-${width}`),
      fullPage: width < 768,
    });

    // Everything made here is cancelled again.
    await page.goto(manageHref);
    await page.getByRole('button', { name: 'Cancel meeting' }).click();
    await page.getByRole('button', { name: 'Cancel meeting' }).click();
    await expect(page.getByRole('heading', { name: 'This meeting was cancelled' })).toBeVisible();
    for (const [i, token] of fillers.entries()) {
      await cancelDirect(request, baseURL, token, (width === 1440 ? 1 : 3) + i);
    }
    await context.close();
  });
}

test('dark mode on a phone: the card reads, and nothing scrolls sideways', async ({
  browser,
}, testInfo) => {
  const { context, page } = await visitor(browser, testInfo.project.use.baseURL, 390, 'dark');
  await page.goto('/meet/nick');
  await expect(bookingCalendar(page)).toBeVisible();
  await pickOpenDay(page, 'first');
  await expectNoSidewaysScroll(page);
  await page.screenshot({ animations: 'disabled', path: shot('dark-390'), fullPage: true });
  await context.close();
});
