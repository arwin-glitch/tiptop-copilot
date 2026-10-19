import { addDaysToKey, localDateKey, wallTimeToUtc } from '@/lib/util/time';

/**
 * The Create follow-up dialog's due date, read in the reader's profile
 * timezone like every other "today" in the app. Not the browser's own clock:
 * a browser elsewhere would put the default on another day, and 5 PM on a
 * picked day would be 5 PM wherever the laptop happens to be.
 *
 * Pure, and outside the dialog, so it can be tested on its own.
 */

/** Days ahead the dialog suggests. */
const DEFAULT_DAYS_AHEAD = 2;
/** A follow-up picked by date falls due at 5 PM that day. */
const DUE_HOUR = 17;

/** The suggested due date, `YYYY-MM-DD`: two days after today in `timeZone`. */
export function defaultDueDate(now: Date, timeZone: string): string {
  return addDaysToKey(localDateKey(now, timeZone), DEFAULT_DAYS_AHEAD);
}

/** A picked `YYYY-MM-DD` as the instant it falls due, 5 PM that day in `timeZone`. */
export function dueDateToInstant(dateKey: string, timeZone: string): string | undefined {
  return wallTimeToUtc(dateKey, DUE_HOUR, 0, timeZone)?.toISOString();
}
