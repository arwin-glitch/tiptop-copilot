import { localClock } from '@/lib/util/time';
import { feedDef, type FeedCadence, type StaticFeedId } from './registry';

/**
 * How a feed is doing, from when it was last seen and what it was expected
 * to do. Pure, for the watchdog, the cards and the tests.
 *
 * - `ok`: seen within its cadence (or, for a feed that only posts when there
 *   is something new, seen at all).
 * - `late`: one run overdue, past the grace period.
 * - `stopped`: a second run missed as well. The only status that notifies.
 * - `never`: not seen in the history the app can read.
 * - `unknown`: the app could not look (Slack refused, a read failed).
 * - `off`: not set up on this deployment (no token, no key).
 *
 * Time is counted only on the days and hours a producer runs: a producer
 * that runs on weekdays alone is not late on a Sunday, and the alert sender
 * (6am to 9pm) is not late overnight.
 */

export type FeedStatus = 'ok' | 'late' | 'stopped' | 'never' | 'unknown' | 'off';

/** Worst first: how the page sorts and what a summary leads with. */
export const STATUS_ORDER: readonly FeedStatus[] = [
  'stopped',
  'late',
  'unknown',
  'never',
  'ok',
  'off',
];

export const STATUS_LABEL: Record<FeedStatus, string> = {
  ok: 'Running',
  late: 'Late',
  stopped: 'Looks stopped',
  never: 'Not seen',
  unknown: "Can't check",
  off: 'Off',
};

const HOUR_MS = 3_600_000;
/** The counting step on a cadence with active days or hours. */
const STEP_MS = 15 * 60_000;

type EveryCadence = Extract<FeedCadence, { kind: 'every' }>;

function isActive(at: Date, cadence: EveryCadence, timeZone: string): boolean {
  if (!cadence.days && !cadence.activeHours) return true;
  const clock = localClock(at, timeZone);
  if (cadence.days) {
    const weekday = new Date(`${clock.dateKey}T00:00:00Z`).getUTCDay();
    if (!cadence.days.includes(weekday)) return false;
  }
  if (cadence.activeHours) {
    const [from, until] = cadence.activeHours;
    if (clock.hour < from || clock.hour >= until) return false;
  }
  return true;
}

/**
 * Hours from `since` to `now` that count against an `every` cadence: all of
 * them, or only those on its active days and hours (in steps of a quarter
 * hour, read at the start of each step). Stops adding once past `capHours`,
 * since nothing above the stopped threshold changes the answer.
 */
export function countedHours(
  since: string,
  now: Date,
  cadence: EveryCadence,
  ownerTimeZone: string,
  capHours = Number.POSITIVE_INFINITY,
): number {
  const from = Date.parse(since);
  const to = now.getTime();
  if (Number.isNaN(from) || to <= from) return 0;
  if (!cadence.days && !cadence.activeHours) return (to - from) / HOUR_MS;
  const timeZone = cadence.timeZone ?? ownerTimeZone;
  const cap = capHours * HOUR_MS;
  let counted = 0;
  for (let t = from; t < to && counted <= cap; t += STEP_MS) {
    if (isActive(new Date(t), cadence, timeZone)) counted += Math.min(STEP_MS, to - t);
  }
  return counted / HOUR_MS;
}

/** Counted hours past which an `every` feed is stopped. */
export function stoppedAfterHours(cadence: EveryCadence): number {
  return cadence.stoppedAfterHours ?? cadence.hours * 2 + cadence.graceHours;
}

/**
 * A feed's status from the newest post (or run) seen, with nothing else
 * known. `lastSeen` null means none was found. For an on-demand feed pass
 * `waitingSince`, when the oldest unanswered request was made.
 */
export function cadenceStatus(
  cadence: FeedCadence,
  lastSeen: string | null,
  now: Date,
  ownerTimeZone: string,
  waitingSince: string | null = null,
): FeedStatus {
  if (cadence.kind === 'event') return lastSeen ? 'ok' : 'never';
  if (cadence.kind === 'on-demand') {
    const since = waitingSince ? Date.parse(waitingSince) : Number.NaN;
    if (!Number.isNaN(since)) {
      const minutes = (now.getTime() - since) / 60_000;
      if (minutes >= cadence.stoppedAfterMinutes) return 'stopped';
      if (minutes >= cadence.lateAfterMinutes) return 'late';
      return 'ok';
    }
    return lastSeen ? 'ok' : 'never';
  }
  if (!lastSeen || Number.isNaN(Date.parse(lastSeen))) return 'never';
  const stopAt = stoppedAfterHours(cadence);
  const counted = countedHours(lastSeen, now, cadence, ownerTimeZone, stopAt);
  if (counted > stopAt) return 'stopped';
  if (counted > cadence.hours + cadence.graceHours) return 'late';
  return 'ok';
}

/**
 * Whether a card filled by `feed` should say it may be out of date: its own
 * "checked" time (the routine's run_at) is old enough that the feed looks
 * stopped. Only scheduled feeds can; a quiet event feed never does.
 */
export function mayBeOutOfDate(
  feed: StaticFeedId,
  checkedAt: string | null | undefined,
  now: Date,
  ownerTimeZone = 'UTC',
): boolean {
  if (!checkedAt) return false;
  const { cadence } = feedDef(feed);
  if (cadence.kind !== 'every') return false;
  return cadenceStatus(cadence, checkedAt, now, ownerTimeZone) === 'stopped';
}

/** "every day", "every 12 hours": an `every` cadence's interval, for the page. */
export function intervalWords(cadence: FeedCadence): string | null {
  if (cadence.kind !== 'every') return null;
  const { hours } = cadence;
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? 'every day' : `every ${days} days`;
  }
  return hours === 1 ? 'every hour' : `every ${hours} hours`;
}
