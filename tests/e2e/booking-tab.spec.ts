import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The Booking tab (D-078) in a browser, over the demo: the top-level tab in
 * the menu, its seven subtabs held in the URL, the Overview's big switch,
 * Instant (the default) or Approve first, the status checks and "Why no
 * times?"; the month planner (each month on its own switch, a day closed and
 * opened again, the live preview); the hours and rules; the Bookings list
 * (its API is mocked here, with invented people) with Cancel and a note;
 * Profile, Places, Chatbot and Calendars; Settings' old address and the
 * Calendar tab's shortcut. At 1440 and 390 wide, light and dark. The demo's
 * calendar is the in-memory mock: nothing reaches Google and nothing is
 * emailed. Every name, address and value here is invented.
 *
 * Screenshots land in BOOKING_SHOTS_DIR (else test-results) as
 * booking-v2-<name>.png.
 */

const SIGNED_IN = path.resolve('test-results', 'booking-tab-state.json');
const SHOTS = process.env.BOOKING_SHOTS_DIR ?? path.resolve('test-results');
const shot = (name: string) => path.join(SHOTS, `booking-v2-${name}.png`);

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

test.use({ storageState: SIGNED_IN, viewport: { width: 1440, height: 1000 } });

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

const subtabs = (page: Page) => page.getByRole('navigation', { name: 'Booking sections' });

/** Invented bookings for the mocked bookings API (the shared contract's LinkBooking). */
function bookings(now: Date) {
  const day = (n: number, h: number) => {
    const d = new Date(now.getTime() + n * 86_400_000);
    d.setUTCHours(h, 0, 0, 0);
    return d.toISOString();
  };
  const base = {
    company: null,
    guests: [] as string[],
    placeName: null,
    placeArea: null,
    note: null,
    deckUrl: null,
    cancelNote: null,
    source: 'form' as const,
    createdAt: day(-1, 15),
    rescheduledCount: 0,
    eventLink: null,
  };
  return [
    {
      ...base,
      id: '00000000-0000-4000-8000-00000000c001',
      status: 'booked',
      type: 'call',
      kind: null,
      startsAt: day(8, 15),
      endsAt: day(8, 15).replace(':00:00.000Z', ':30:00.000Z'),
      name: 'Robin Vale',
      email: 'robin.vale@example.com',
      company: 'Fernway Labs',
      guests: ['casey.ng@example.com'],
      note: 'An intro to what we are building in clinic scheduling.',
      deckUrl: 'https://deck.example/fernway',
      visitorTimeZone: 'America/New_York',
    },
    {
      ...base,
      id: '00000000-0000-4000-8000-00000000c002',
      status: 'held',
      type: 'in_person',
      kind: 'coffee',
      startsAt: day(9, 16),
      endsAt: day(9, 17),
      name: 'Morgan Ash',
      email: 'morgan.ash@example.com',
      placeName: 'Juniper & Rye Coffee',
      placeArea: 'Riverside',
      source: 'chatbot',
      rescheduledCount: 1,
    },
  ];
}

test('Booking sits in the menu after Calendar and opens on Overview', async ({ page }) => {
  await page.goto('/today');
  const nav = page.getByRole('navigation', { name: 'Main' }).first();
  const working = nav.getByRole('list', { name: 'Working' });
  const links = await working.getByRole('link').allTextContents();
  expect(links.map((t) => t.trim()).slice(-2)).toEqual(['Calendar', 'Booking']);
  await working.getByRole('link', { name: 'Booking', exact: true }).click();
  await page.waitForURL(/\/booking$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Booking' })).toBeVisible();
  await expect(subtabs(page).getByRole('link')).toHaveText([
    'Overview',
    'Availability',
    /^Bookings/,
    'Profile',
    'Places',
    'Chatbot',
    'Calendars',
  ]);
  await expect(subtabs(page).getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('Overview: the link, the big switch, Instant by default, the checks and why no times', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/booking');
  await expect(page.getByTestId('booking-url')).toHaveText(/\/meet\/nick$/);
  await expect(page.getByRole('switch', { name: 'Take bookings' })).toBeChecked();
  const mode = page.getByRole('radiogroup', { name: 'Booking mode' });
  await expect(mode.getByRole('radio', { name: /Instant/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(mode.getByRole('radio', { name: /Approve first/ })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  // No copy anywhere says a person has to confirm.
  await expect(page.getByText(/Arwin (will )?confirms?/i)).toHaveCount(0);

  const checks = page.locator('[data-check]');
  await expect(page.locator('[data-check="link"]')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('[data-check="editing"]')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('[data-check="places"]')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('[data-check="times"]')).toBeVisible();
  await expect(page.locator('[data-check="months"]')).toContainText('Open through');
  expect(await checks.count()).toBeGreaterThanOrEqual(6);

  // Why no times: each of the next 14 days, with a rule for every closed one.
  await page.getByRole('heading', { name: 'Why no times?' }).click();
  const days = page.locator('[data-tour="booking-why"] li[data-day]');
  await expect(days).toHaveCount(14);
  await expect(
    page.locator('[data-tour="booking-why"] [data-reason="weekday"]').first(),
  ).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: shot('overview-1440-light'),
    fullPage: true,
  });

  // Approve first is a switch away, and back.
  await mode.getByRole('radio', { name: /Approve first/ }).click();
  await expect(page.getByText('Bookings now wait for approval')).toBeVisible();
  await expect(mode.getByRole('radio', { name: /Approve first/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await mode.getByRole('radio', { name: /Instant/ }).click();
  await expect(page.getByText('Bookings now go straight on the calendar')).toBeVisible();

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.locator('[data-check="times"]')).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: shot('overview-1440-dark'),
    fullPage: true,
  });
});

test('Availability: each month on its own switch, a day closed and opened, the live preview', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/booking?tab=availability');
  const months = page.locator('[data-tour="booking-months"] li[data-month]');
  await expect(months).toHaveCount(7);
  // This month and next are open by default; the rest are not.
  await expect(months.nth(0)).toHaveAttribute('data-state', 'open');
  await expect(months.nth(1)).toHaveAttribute('data-state', 'open');
  await expect(months.nth(2)).toHaveAttribute('data-state', 'not_open');
  await expect(page.getByTestId('open-through')).toContainText('rolls on by itself');

  // The live preview fills the month grid.
  const grid = page.getByRole('grid');
  await expect(grid.locator('[data-open="yes"]').first()).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: shot('availability-1440-light'),
    fullPage: true,
  });

  // Open the third month: just that one.
  const third = months.nth(2);
  const thirdName = (await third.getAttribute('data-month'))!;
  await third.getByRole('switch').click();
  await expect(third).toHaveAttribute('data-state', 'open');
  await expect(page.getByTestId('open-through')).toContainText('fixed');
  // And close it again, then keep rolling.
  await third.getByRole('switch').click();
  await expect(third).toHaveAttribute('data-state', 'closed');
  await page.getByRole('button', { name: /Keep rolling/ }).click();
  await expect(page.getByTestId('open-through')).toContainText('rolls on by itself');
  expect(thirdName).toMatch(/^\d{4}-\d{2}$/);

  // A day with open times: close it, see it close, open it again.
  const openDay = grid.locator('[data-open="yes"]').first();
  const date = (await openDay.getAttribute('data-date'))!;
  await openDay.click();
  const panel = page.getByRole('region', { name: /^Day / });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Calls')).toBeVisible();
  await panel.getByRole('switch', { name: /^Close / }).click();
  await expect(grid.locator(`[data-date="${date}"]`)).toHaveAttribute('data-open', 'no');
  await expect(panel.locator('[data-reason="date_closed"]').first()).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: shot('availability-day-closed'),
    fullPage: true,
  });
  await panel.getByRole('switch', { name: /^Close / }).click();
  await expect(grid.locator(`[data-date="${date}"]`)).toHaveAttribute('data-open', 'yes');

  // The filter shows one kind at a time.
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Coffee' }).click();
  await expect(
    page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Coffee' }),
  ).toHaveAttribute('aria-pressed', 'true');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expect(page.getByRole('grid').locator('[data-open="yes"]').first()).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: shot('availability-1440-dark'),
    fullPage: true,
  });
});

test('Availability: the hours keep to their bounds, the rules have a save', async ({ page }) => {
  await page.goto('/booking?tab=availability&view=hours');
  await expect(page.getByRole('tab', { name: 'Hours' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('8:00 AM to 6:00 PM Central; dinner 6-7 PM.')).toBeVisible();
  await expect(page.getByLabel('Calls (30 minutes) between')).toHaveAttribute('min', '08:00');
  await page.screenshot({
    animations: 'disabled',
    path: shot('availability-hours'),
    fullPage: true,
  });
  await page.getByRole('tab', { name: 'Rules' }).click();
  await expect(page).toHaveURL(/view=rules/);
  await expect(page.getByLabel('Notice (hours)')).toHaveValue('24');
  await expect(page.getByRole('button', { name: 'Save rules' })).toBeDisabled();
  await page.getByLabel('Notice (hours)').fill('48');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByText('Rules saved')).toBeVisible();
  await page.getByLabel('Notice (hours)').fill('24');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByText('Rules saved').first()).toBeVisible();
});

test('Bookings: who, when, where, guests and status, Cancel with a note', async ({ page }) => {
  const now = new Date();
  let cancelled: { id: string; body: unknown } | null = null;
  await page.route('**/api/booking/bookings?scope=*', async (route) => {
    const scope = new URL(route.request().url()).searchParams.get('scope');
    await route.fulfill({
      json: { ok: true, bookings: scope === 'upcoming' ? bookings(now) : [] },
    });
  });
  await page.route('**/api/booking/bookings/*/cancel', async (route) => {
    const id = route.request().url().split('/').at(-2)!;
    cancelled = { id, body: route.request().postDataJSON() };
    await route.fulfill({ json: { ok: true } });
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/booking?tab=bookings');
  const robin = page.getByRole('listitem', { name: 'Booking with Robin Vale' });
  await expect(robin).toBeVisible();
  await expect(robin.getByText('Booked', { exact: true })).toBeVisible();
  await expect(robin.getByText('Fernway Labs')).toBeVisible();
  await expect(robin.getByText('casey.ng@example.com')).toBeVisible();
  await expect(robin.getByText(/their time/)).toBeVisible();
  await expect(robin.getByRole('link', { name: /Deck/ })).toHaveAttribute(
    'href',
    'https://deck.example/fernway',
  );
  await expect(robin.getByRole('link', { name: 'Open in Calendar' })).toHaveAttribute(
    'href',
    /\/calendar\?view=day&date=\d{4}-\d{2}-\d{2}$/,
  );
  const morgan = page.getByRole('listitem', { name: 'Booking with Morgan Ash' });
  await expect(morgan.getByText('Held', { exact: true })).toBeVisible();
  await expect(morgan.getByText(/Juniper & Rye Coffee, Riverside/)).toBeVisible();
  await expect(morgan.getByText('Moved once')).toBeVisible();
  // The demo's requests wait for approval in the drawer they always had.
  await expect(page.locator('[data-tour="booking-waiting"]')).toContainText('waiting for approval');
  await page.screenshot({
    animations: 'disabled',
    path: shot('bookings-1440-light'),
    fullPage: true,
  });

  await robin.getByRole('button', { name: 'Cancel' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel with Robin Vale?' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Note (optional)').fill('Sorry, a clash came up.');
  await dialog.getByRole('button', { name: 'Cancel the booking' }).click();
  await expect(page.getByText('Cancelled. Google Calendar tells them.')).toBeVisible();
  expect(cancelled).toEqual({
    id: '00000000-0000-4000-8000-00000000c001',
    body: { note: 'Sorry, a clash came up.' },
  });

  await page.getByRole('tab', { name: 'Messages' }).click();
  await expect(page).toHaveURL(/scope=messages/);
  await expect(page.getByText('No messages')).toBeVisible();

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/booking?tab=bookings');
  await expect(page.getByRole('listitem', { name: 'Booking with Robin Vale' })).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: shot('bookings-1440-dark'),
    fullPage: true,
  });
});

test('Bookings: the approve-first drawer opens from the old Calendar link', async ({ page }) => {
  await page.goto('/calendar#booking-requests');
  await page.waitForURL(/\/booking\?tab=bookings#booking-requests$/);
  const drawer = page.getByRole('dialog', { name: 'Booking requests' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('listitem').first()).toBeVisible();
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toHaveCount(0);
});

test('Profile, Places, Chatbot and Calendars', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/booking?tab=profile');
  await expect(page.getByLabel('Name shown')).toHaveValue('Nick Avery');
  await expect(page.getByRole('button', { name: 'Save profile' })).toBeDisabled();
  await page.screenshot({ animations: 'disabled', path: shot('profile'), fullPage: true });

  await subtabs(page).getByRole('link', { name: 'Places' }).click();
  await expect(page.getByLabel('Home city')).toHaveValue('Harbor City');
  await expect(page.getByRole('textbox', { name: 'Place 1' })).toHaveValue('Juniper & Rye Coffee');
  await page.screenshot({ animations: 'disabled', path: shot('places'), fullPage: true });

  await subtabs(page).getByRole('link', { name: 'Chatbot' }).click();
  await expect(page.getByText('Arwin on the booking page')).toBeVisible();
  await expect(
    page.getByText('TipTop VC (Demo) is an invented fund', { exact: false }),
  ).toBeVisible();

  await subtabs(page).getByRole('link', { name: 'Calendars' }).click();
  const list = page.locator('[data-tour="booking-calendars"] li[data-calendar]');
  await expect(list.first()).toBeVisible();
  const main = list.filter({ hasText: 'always counts' });
  await expect(main.getByRole('switch')).toBeChecked();
  await expect(main.getByRole('switch')).toBeDisabled();
  const shared = list.filter({ hasText: 'Deal flow' });
  await expect(shared.getByRole('switch')).not.toBeChecked();
  await shared.getByRole('switch').click();
  await expect(page.getByText(/now blocks his time/)).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: shot('calendars'), fullPage: true });
  await shared.getByRole('switch').click();
  await expect(page.getByText(/no longer blocks his time/)).toBeVisible();
});

test('Settings links here, its old address redirects, the Calendar has a shortcut', async ({
  page,
}) => {
  await page.goto('/settings?tab=booking');
  await page.waitForURL(/\/booking$/);
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Booking link' }).click();
  await expect(page.getByRole('link', { name: 'Open the Booking tab' })).toHaveAttribute(
    'href',
    '/booking',
  );
  await page.goto('/calendar');
  const shortcut = page.getByRole('link', { name: /^Booking link/ });
  await expect(shortcut).toBeVisible();
  await shortcut.click();
  await page.waitForURL(/\/booking$/);
});

test.describe('on a 390px phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  for (const tab of ['overview', 'availability', 'bookings', 'calendars'] as const) {
    test(`${tab}: no sideways scroll, light and dark`, async ({ page }) => {
      if (tab === 'bookings') {
        const now = new Date();
        await page.route('**/api/booking/bookings?scope=*', (route) =>
          route.fulfill({ json: { ok: true, bookings: bookings(now) } }),
        );
      }
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto(tab === 'overview' ? '/booking' : `/booking?tab=${tab}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Booking' })).toBeVisible();
      if (tab === 'availability') {
        await expect(page.getByRole('grid').locator('[data-open="yes"]').first()).toBeVisible();
      }
      if (tab === 'overview') await expect(page.locator('[data-check="times"]')).toBeVisible();
      if (tab === 'bookings') {
        await expect(page.getByRole('listitem', { name: 'Booking with Robin Vale' })).toBeVisible();
      }
      if (tab === 'calendars') {
        await expect(page.locator('li[data-calendar]').first()).toBeVisible();
      }
      await expectNoSidewaysScroll(page);
      await page.screenshot({
        animations: 'disabled',
        path: shot(`${tab}-390-dark`),
        fullPage: true,
      });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'Booking' })).toBeVisible();
      if (tab === 'availability') {
        await expect(page.getByRole('grid').locator('[data-open="yes"]').first()).toBeVisible();
      }
      if (tab === 'overview') await expect(page.locator('[data-check="times"]')).toBeVisible();
      if (tab === 'bookings') {
        await expect(page.getByRole('listitem', { name: 'Booking with Robin Vale' })).toBeVisible();
      }
      if (tab === 'calendars') {
        await expect(page.locator('li[data-calendar]').first()).toBeVisible();
      }
      await expectNoSidewaysScroll(page);
      await page.screenshot({
        animations: 'disabled',
        path: shot(`${tab}-390-light`),
        fullPage: true,
      });
    });
  }
});
