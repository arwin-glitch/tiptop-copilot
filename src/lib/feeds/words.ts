import type { FeedRow } from '@/lib/services/feed-health';
import { formatDateTime, relativeTime } from '@/lib/util/time';
import { RELAY_WINDOW_DAYS, type FeedCadence } from './registry';
import { intervalWords } from './status';

/**
 * A feed's state in plain words, for the Feeds tab: when it was last seen,
 * what was expected, and why it is late or cannot be checked. Pure.
 */

const DAY_NAMES = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
];

/** "Mondays, Wednesdays and Fridays"; Monday to Friday is "weekdays". */
function dayWords(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.join() === '1,2,3,4,5') return 'weekdays';
  const names = sorted.map((d) => DAY_NAMES[d]).filter((n): n is string => Boolean(n));
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    : (names[0] ?? '');
}

function hourWords(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

/** "at least every day", "at least every hour, 6am to 9pm": what an `every` cadence expects. */
export function expectedWords(cadence: FeedCadence): string | null {
  const interval = intervalWords(cadence);
  if (!interval || cadence.kind !== 'every') return null;
  const hours = cadence.activeHours
    ? `, ${hourWords(cadence.activeHours[0])} to ${hourWords(cadence.activeHours[1])}`
    : '';
  const days = cadence.days ? ` on ${dayWords(cadence.days)}` : '';
  return `at least ${interval}${hours}${days}`;
}

function waitedWords(since: string, now: Date): string {
  const minutes = Math.max(1, Math.round((now.getTime() - Date.parse(since)) / 60_000));
  if (minutes < 120) return `${minutes} minutes`;
  return `${Math.round(minutes / 60)} hours`;
}

type RowLike = Pick<
  FeedRow,
  'def' | 'status' | 'lastSeen' | 'unreadableAt' | 'skipped' | 'waitingSince' | 'reason'
>;

/**
 * "2 items in the newest post were skipped...": a post that was read, less
 * the items in it that could not be (D-073). Null when none were skipped.
 */
export function skippedWords(row: Pick<FeedRow, 'skipped' | 'unreadableAt'>): string | null {
  const n = row.skipped ?? 0;
  if (n <= 0) return null;
  const items = n === 1 ? '1 item' : `${n} items`;
  const were = n === 1 ? 'was' : 'were';
  // With a newer unreadable post, the copy shown is not the newest.
  if (row.unreadableAt) return `${items} in the copy it kept ${were} skipped.`;
  return `${items} in the newest post ${were} skipped because ${n === 1 ? 'it' : 'they'} could not be read; the rest of the post is showing.`;
}

export function feedRowSummary(row: RowLike, now: Date, timeZone: string): string {
  const { def } = row;
  switch (row.status) {
    case 'off':
      return row.reason ?? 'Not set up on this deployment.';
    case 'unknown':
      return `Can't check right now. ${row.reason ?? ''}`.trim();
    case 'never':
      if (def.source === 'webhook') return 'Nothing has arrived yet.';
      if (def.cadence.kind === 'every' && def.cadence.hours > RELAY_WINDOW_DAYS * 24) {
        // A quarterly feed is out of the window for most of the quarter.
        return `No post in the last ${RELAY_WINDOW_DAYS} days, which is normal for a feed that runs less often than that.`;
      }
      if (def.cadence.kind === 'event' || def.cadence.kind === 'on-demand') {
        return `No post in the last ${RELAY_WINDOW_DAYS} days, which is normal when there was nothing new.`;
      }
      if (def.source === 'job') {
        return 'No run noted yet. The app notes each run, so this fills in after the next one.';
      }
      if (def.source === 'reports') return "No report found in the channel's recent history.";
      return `No post found in the last ${RELAY_WINDOW_DAYS} days. It may not be set up yet, or it stopped before then.`;
  }
  const parts: string[] = [];
  if (row.waitingSince && row.status !== 'ok') {
    parts.push(`A question has waited ${waitedWords(row.waitingSince, now)} for its answer.`);
  }
  if (row.lastSeen) {
    parts.push(
      `Last seen ${relativeTime(row.lastSeen, now)} (${formatDateTime(row.lastSeen, timeZone)}).`,
    );
  }
  const expected = expectedWords(def.cadence);
  if (expected && row.status === 'late') parts.push(`Expected ${expected}; one run looks missed.`);
  if (expected && row.status === 'stopped') {
    parts.push(`Expected ${expected}; at least two runs look missed.`);
  }
  if (row.unreadableAt) {
    parts.push(
      `A newer post (${formatDateTime(row.unreadableAt, timeZone)}) could not be read, so its card kept the older copy.`,
    );
  }
  const skipped = skippedWords(row);
  if (skipped) parts.push(skipped);
  if (parts.length === 0) return 'On time.';
  return parts.join(' ');
}

/** "1 feed looks stopped and 2 are late.", or null when nothing is wrong. */
export function feedReportHeadline(rows: readonly Pick<FeedRow, 'status'>[]): string | null {
  const stopped = rows.filter((r) => r.status === 'stopped').length;
  const late = rows.filter((r) => r.status === 'late').length;
  const lines: string[] = [];
  if (stopped) lines.push(`${stopped} ${stopped === 1 ? 'feed looks' : 'feeds look'} stopped`);
  if (late) {
    lines.push(
      stopped
        ? `${late} ${late === 1 ? 'is' : 'are'} late`
        : `${late} ${late === 1 ? 'feed is' : 'feeds are'} late`,
    );
  }
  return lines.length ? `${lines.join(' and ')}.` : null;
}

/**
 * What heads the tab when nothing is late or stopped. Never "on time" while
 * some feed can't be checked: a read that failed has not shown it is.
 */
export function feedReportAllClear(rows: readonly Pick<FeedRow, 'status'>[]): string {
  const unknown = rows.filter((r) => r.status === 'unknown').length;
  if (!unknown) return 'Nothing looks late or stopped.';
  return `Nothing looks late or stopped, but ${unknown} ${unknown === 1 ? "feed can't" : "feeds can't"} be checked right now.`;
}
