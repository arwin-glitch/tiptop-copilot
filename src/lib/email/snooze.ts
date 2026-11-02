import { addDaysToKey, localClock, wallTimeToUtc } from '@/lib/util/time';

/**
 * Snooze for the Inbox tab, the pure parts: the preset wake times (Gmail's
 * own menu), the picked time, and the checks the route holds a wake time to.
 * Safe on both sides: the menu runs these in the browser, in the reader's own
 * zone, and the route checks the same rules again.
 *
 * Gmail's API has no snooze, so Kraken keeps it (lib/services/inbox-snooze.ts):
 * snoozing takes the thread out of the inbox and keeps a row with the wake
 * time; at the wake time the thread comes back, unread.
 */

/** A wake time can be at most this far ahead. */
export const SNOOZE_MAX_DAYS = 365;
const DAY_MS = 86_400_000;
/** The morning the day presets wake at, Gmail's 8:00 AM. */
const MORNING_HOUR = 8;
/** "Later today" is not offered from this hour on (6 PM). */
const LATER_TODAY_UNTIL_HOUR = 18;

/** What the Snooze button says until the table's migration has been run. */
export const SNOOZE_NOT_SET_UP = 'Snooze needs a database update. Nothing was changed.';

export type SnoozePresetId = 'later' | 'tomorrow' | 'weekend' | 'nextWeek';

export interface SnoozePreset {
  id: SnoozePresetId;
  label: string;
  /** The wake time, as an instant. */
  at: Date;
}

/** 0 = Sunday … 6 = Saturday, for a `YYYY-MM-DD` calendar day. */
function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T12:00:00Z`).getUTCDay();
}

/** The instant `hour`:00 reads on `dateKey` in `timeZone` (a skipped hour moves on by one). */
function at(dateKey: string, hour: number, timeZone: string): Date {
  return (
    wallTimeToUtc(dateKey, hour, 0, timeZone) ??
    wallTimeToUtc(dateKey, Math.min(23, hour + 1), 0, timeZone) ??
    new Date(`${dateKey}T${String(hour).padStart(2, '0')}:00:00Z`)
  );
}

/**
 * Gmail's snooze menu, worked out on the wall clock in `timeZone`:
 * - Later today: three hours on, rounded up to the hour; not from 6 PM on.
 * - Tomorrow: 8:00 AM tomorrow.
 * - This weekend: Saturday 8:00 AM; not on a Saturday or Sunday.
 * - Next week: Monday 8:00 AM (a week on, when today is Monday).
 */
export function snoozePresets(now: Date, timeZone: string): SnoozePreset[] {
  const clock = localClock(now, timeZone);
  const today = clock.dateKey;
  const weekday = weekdayOf(today);
  const out: SnoozePreset[] = [];

  if (clock.hour < LATER_TODAY_UNTIL_HOUR) {
    const later = new Date(now.getTime() + 3 * 3_600_000);
    const c = localClock(later, timeZone);
    const exact = c.minute === 0 && later.getUTCSeconds() === 0 && later.getUTCMilliseconds() === 0;
    const hour = exact ? c.hour : c.hour + 1;
    const wake =
      hour >= 24 ? at(addDaysToKey(c.dateKey, 1), 0, timeZone) : at(c.dateKey, hour, timeZone);
    out.push({ id: 'later', label: 'Later today', at: wake });
  }

  out.push({
    id: 'tomorrow',
    label: 'Tomorrow',
    at: at(addDaysToKey(today, 1), MORNING_HOUR, timeZone),
  });

  if (weekday >= 1 && weekday <= 5) {
    out.push({
      id: 'weekend',
      label: 'This weekend',
      at: at(addDaysToKey(today, 6 - weekday), MORNING_HOUR, timeZone),
    });
  }

  const toMonday = (1 - weekday + 7) % 7 || 7;
  out.push({
    id: 'nextWeek',
    label: 'Next week',
    at: at(addDaysToKey(today, toMonday), MORNING_HOUR, timeZone),
  });
  return out;
}

/**
 * A native `datetime-local` value (`YYYY-MM-DDTHH:MM`, seconds optional) as
 * the instant it reads in `timeZone`. Null for anything else, or a time the
 * clocks skip.
 */
export function pickedWakeAt(value: string, timeZone: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  if (!m) return null;
  return wallTimeToUtc(m[1]!, Number(m[2]), Number(m[3]), timeZone);
}

/** The `datetime-local` value an instant reads as in `timeZone` (the picker's `min`). */
export function toDateTimeLocal(date: Date, timeZone: string): string {
  const c = localClock(date, timeZone);
  return `${c.dateKey}T${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;
}

export type WakeCheck = { ok: true; at: Date } | { ok: false; message: string };

/** A wake time must be a real instant, in the future, and at most a year ahead. */
export function checkWakeAt(value: string | Date, now: Date): WakeCheck {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return { ok: false, message: 'Pick a date and time.' };
  if (date.getTime() <= now.getTime()) {
    return { ok: false, message: 'Pick a time in the future.' };
  }
  if (date.getTime() > now.getTime() + SNOOZE_MAX_DAYS * DAY_MS) {
    return { ok: false, message: 'Snooze can be at most a year ahead.' };
  }
  return { ok: true, at: date };
}

/**
 * When a snoozed thread comes back, for the toast and the Snoozed tab:
 * "Tue, 8:00 AM" within the coming week, with the date beyond it
 * ("Mon, Nov 16, 8:00 AM").
 */
export function formatWake(date: Date | string, timeZone: string, now: Date = new Date()): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const far = d.getTime() - now.getTime() >= 6 * DAY_MS;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    ...(far ? { month: 'short', day: 'numeric' } : {}),
    ...(d.getUTCFullYear() !== now.getUTCFullYear() && far ? { year: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}
