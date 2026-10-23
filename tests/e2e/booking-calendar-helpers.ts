import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Picking a time on the public booking page's calendar card (D-078), for
 * the booking specs: the card that is showing (the right-hand column on a
 * wide screen, above the times on a phone), its open days, and the times of
 * the day picked.
 */

/** The calendar card on show at this width. */
export function bookingCalendar(page: Page): Locator {
  return page.locator('[data-testid="booking-calendar"]:visible');
}

/** Go to the last month that has an open day. */
async function lastOpenMonth(calendar: Locator) {
  const next = calendar.getByRole('button', { name: 'Next open month' });
  while (await next.isEnabled()) await next.click();
  const prev = calendar.getByRole('button', { name: 'Previous open month' });
  while ((await calendar.locator('button[data-state="open"]').count()) === 0) {
    if (!(await prev.isEnabled())) break;
    await prev.click();
  }
}

/**
 * Pick an open day: the first one shown, or, in the last month open on the
 * link (far ahead, clear of the days the calendar specs drag events on),
 * its middle or its last open day.
 */
export async function pickOpenDay(page: Page, which: 'first' | 'middle' | 'last' = 'first') {
  const calendar = bookingCalendar(page);
  await expect(calendar).toBeVisible();
  if (which !== 'first') await lastOpenMonth(calendar);
  const open = calendar.locator('button[data-state="open"]');
  await expect(open.first()).toBeVisible();
  const count = await open.count();
  const day =
    which === 'first'
      ? open.first()
      : which === 'last'
        ? open.last()
        : open.nth(Math.floor(count / 2));
  await day.click();
  await expect(day).toHaveAttribute('aria-pressed', 'true');
  return day;
}

/** Pick a day, then its first or last time. */
export async function pickTime(
  page: Page,
  day: 'first' | 'middle' | 'last' = 'first',
  time: 'first' | 'last' = 'first',
) {
  await pickOpenDay(page, day);
  const times = page.getByRole('radiogroup', { name: 'Time' });
  await (
    time === 'first' ? times.getByRole('radio').first() : times.getByRole('radio').last()
  ).click();
  await expect(times.getByRole('radio', { checked: true })).toHaveCount(1);
}
