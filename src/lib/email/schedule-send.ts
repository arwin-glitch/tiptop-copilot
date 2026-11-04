import { addDaysToKey, localClock, wallTimeToUtc } from '@/lib/util/time';

/**
 * Schedule send for the Inbox, the pure parts: Gmail's preset times, the
 * checks a send time is held to, and the honest window Kraken can keep.
 *
 * Gmail's API has no scheduled send, so Kraken keeps the email and sends it
 * itself (lib/services/inbox-scheduled.ts). What sends it is the phone-alert
 * job's loop (.github/workflows/push-alerts.yml), which calls the app once a
 * minute from 6 AM to 9 PM Central; the Inbox list and the daily job also
 * send anything due when they run. So a send goes out within a few minutes
 * of its time during those hours, and a time set overnight goes out when the
 * loop wakes at 6 AM Central (or sooner, if the Inbox is opened).
 */

/** How far ahead a send can be scheduled. */
export const SCHEDULE_MAX_DAYS = 365;
const DAY_MS = 86_400_000;
/** A scheduled time must be at least this far ahead (Gmail's own minimum is a minute or two). */
export const SCHEDULE_MIN_LEAD_MS = 60_000;

/** The honest window: the loop calls once a minute, and a send can wait out one slow pass. */
export const SEND_WINDOW_MINUTES = 3;
/** The hours the sender's loop runs, in Central time (push-alerts.yml LOOP_FROM_HOUR / LOOP_UNTIL_HOUR). */
export const SENDER_HOURS = { from: 6, until: 21, zone: 'America/Chicago' } as const;

/** What the Schedule option says until the table's migration has been run. */
export const SCHEDULE_NOT_SET_UP =
  'Schedule send needs a database update before it can be used. Nothing was scheduled.';

export type SchedulePresetId = 'tomorrowMorning' | 'tomorrowAfternoon' | 'mondayMorning';

export interface SchedulePreset {
  id: SchedulePresetId;
  label: string;
  at: Date;
}

function at(dateKey: string, hour: number, timeZone: string): Date {
  return (
    wallTimeToUtc(dateKey, hour, 0, timeZone) ??
    wallTimeToUtc(dateKey, Math.min(23, hour + 1), 0, timeZone) ??
    new Date(`${dateKey}T${String(hour).padStart(2, '0')}:00:00Z`)
  );
}

const weekdayOf = (dateKey: string) => new Date(`${dateKey}T12:00:00Z`).getUTCDay();

/**
 * Gmail's schedule-send menu on the wall clock in `timeZone`: tomorrow at
 * 8:00 AM, tomorrow at 1:00 PM, and next Monday at 8:00 AM (left out when
 * tomorrow is Monday, which would repeat the first).
 */
export function schedulePresets(now: Date, timeZone: string): SchedulePreset[] {
  const today = localClock(now, timeZone).dateKey;
  const tomorrow = addDaysToKey(today, 1);
  const out: SchedulePreset[] = [
    { id: 'tomorrowMorning', label: 'Tomorrow morning', at: at(tomorrow, 8, timeZone) },
    { id: 'tomorrowAfternoon', label: 'Tomorrow afternoon', at: at(tomorrow, 13, timeZone) },
  ];
  const toMonday = (1 - weekdayOf(today) + 7) % 7 || 7;
  if (toMonday !== 1) {
    out.push({
      id: 'mondayMorning',
      label: 'Monday morning',
      at: at(addDaysToKey(today, toMonday), 8, timeZone),
    });
  }
  return out;
}

export type SendAtCheck = { ok: true; at: Date } | { ok: false; message: string };

/** A send time must be a real instant, a minute or more ahead, and at most a year ahead. */
export function checkSendAt(value: string | Date, now: Date): SendAtCheck {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return { ok: false, message: 'Pick a date and time.' };
  if (date.getTime() < now.getTime() + SCHEDULE_MIN_LEAD_MS) {
    return { ok: false, message: 'Pick a time at least a minute from now.' };
  }
  if (date.getTime() > now.getTime() + SCHEDULE_MAX_DAYS * DAY_MS) {
    return { ok: false, message: 'Schedule send can be at most a year ahead.' };
  }
  return { ok: true, at: date };
}

/**
 * When a send at `date` will really go out, in words: "within about 3
 * minutes", or, outside the sender's hours, "at 6:00 AM Central (or when the
 * Inbox is next opened)".
 */
export function sendWindowNote(date: Date): string {
  const hour = localClock(date, SENDER_HOURS.zone).hour;
  if (hour >= SENDER_HOURS.from && hour < SENDER_HOURS.until) {
    return `Kraken sends it within about ${SEND_WINDOW_MINUTES} minutes of that time.`;
  }
  return 'That is outside Kraken’s sending hours (6 AM to 9 PM Central): it goes out at 6 AM Central, or sooner if the Inbox is opened.';
}

/** The short form for the Scheduled folder's notice. */
export const SEND_WINDOW_SUMMARY = `Scheduled emails go out within about ${SEND_WINDOW_MINUTES} minutes of their time, 6 AM to 9 PM Central. A time outside those hours goes out at 6 AM Central, or sooner if the Inbox is opened.`;
