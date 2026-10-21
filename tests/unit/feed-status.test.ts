import { describe, expect, it } from 'vitest';
import { FEED_MARKERS, FEEDS, feedDef, reportFeed, type FeedCadence } from '@/lib/feeds/registry';
import {
  cadenceStatus,
  countedHours,
  intervalWords,
  mayBeOutOfDate,
  STATUS_ORDER,
  stoppedAfterHours,
} from '@/lib/feeds/status';
import { expectedWords } from '@/lib/feeds/words';

/**
 * The feed watchdog's status logic: on time, late after the grace period,
 * stopped once a second run is missed, never seen, and time counted only on
 * the days and hours a producer runs (weekends, overnight).
 */

const TZ = 'America/Chicago';
const at = (iso: string) => new Date(iso);
const hoursBefore = (now: Date, hours: number) =>
  new Date(now.getTime() - hours * 3_600_000).toISOString();

const DAILY: FeedCadence = { kind: 'every', hours: 24, graceHours: 6 };
const WEEKDAYS: FeedCadence = {
  kind: 'every',
  hours: 24,
  graceHours: 6,
  days: [1, 2, 3, 4, 5],
};
const DAYTIME: FeedCadence = {
  kind: 'every',
  hours: 1,
  graceHours: 1,
  stoppedAfterHours: 3,
  activeHours: [6, 21],
  timeZone: TZ,
};

describe('an every-day feed', () => {
  // Wednesday Oct 21, noon in Chicago (daylight time, UTC-5).
  const now = at('2026-10-21T17:00:00Z');

  it('is on time within its interval and grace', () => {
    expect(cadenceStatus(DAILY, hoursBefore(now, 2), now, TZ)).toBe('ok');
    expect(cadenceStatus(DAILY, hoursBefore(now, 29.9), now, TZ)).toBe('ok');
  });

  it('is late past the grace period, one run missed', () => {
    expect(cadenceStatus(DAILY, hoursBefore(now, 30.5), now, TZ)).toBe('late');
    expect(cadenceStatus(DAILY, hoursBefore(now, 53.9), now, TZ)).toBe('late');
  });

  it('is stopped once a second run is missed', () => {
    expect(stoppedAfterHours(DAILY as Extract<FeedCadence, { kind: 'every' }>)).toBe(54);
    expect(cadenceStatus(DAILY, hoursBefore(now, 54.5), now, TZ)).toBe('stopped');
    expect(cadenceStatus(DAILY, hoursBefore(now, 24 * 20), now, TZ)).toBe('stopped');
  });

  it('is never seen without a post, or with an unreadable time', () => {
    expect(cadenceStatus(DAILY, null, now, TZ)).toBe('never');
    expect(cadenceStatus(DAILY, 'not a time', now, TZ)).toBe('never');
  });

  it('reads a post from the future (a clock ahead) as on time', () => {
    expect(cadenceStatus(DAILY, hoursBefore(now, -1), now, TZ)).toBe('ok');
    expect(countedHours(hoursBefore(now, -1), now, DAILY as never, TZ)).toBe(0);
  });
});

describe('a weekday-only feed', () => {
  it('is not late over the weekend', () => {
    // Last post Friday Oct 16, 9am Chicago; now Monday Oct 19, 8am Chicago.
    const friday = '2026-10-16T14:00:00Z';
    const monday = at('2026-10-19T13:00:00Z');
    // 71 hours on the clock, but only Friday's last 15 and Monday's first 8 count.
    expect(countedHours(friday, monday, WEEKDAYS as never, TZ)).toBeCloseTo(23, 0);
    expect(cadenceStatus(WEEKDAYS, friday, monday, TZ)).toBe('ok');
    // The same gap on an every-day feed is a stopped feed.
    expect(cadenceStatus(DAILY, friday, monday, TZ)).toBe('stopped');
  });

  it('is late on Monday afternoon when Monday morning brought nothing', () => {
    const friday = '2026-10-16T14:00:00Z';
    // Monday 4pm Chicago: 15 + 16 = 31 counted hours, past 24 + 6.
    expect(cadenceStatus(WEEKDAYS, friday, at('2026-10-19T21:00:00Z'), TZ)).toBe('late');
  });

  it('is stopped by Tuesday when two weekdays brought nothing', () => {
    const friday = '2026-10-16T14:00:00Z';
    // Tuesday 3pm Chicago: 15 + 24 + 15 = 54+ counted hours.
    expect(cadenceStatus(WEEKDAYS, friday, at('2026-10-20T20:30:00Z'), TZ)).toBe('stopped');
  });

  it('counts nothing at all across a whole weekend', () => {
    // Saturday 1am to Sunday 11pm Chicago.
    expect(
      countedHours('2026-10-17T06:00:00Z', at('2026-10-19T04:00:00Z'), WEEKDAYS as never, TZ),
    ).toBe(0);
  });
});

describe('a daytime-only feed (6am to 9pm)', () => {
  it('is not late overnight', () => {
    // Last heard 8:55pm Chicago; now 6:30am the next day.
    expect(cadenceStatus(DAYTIME, '2026-10-21T01:55:00Z', at('2026-10-21T11:30:00Z'), TZ)).toBe(
      'ok',
    );
  });

  it('is late after two daytime hours of silence, and stopped after three', () => {
    const last = '2026-10-21T14:00:00Z'; // 9am Chicago
    expect(cadenceStatus(DAYTIME, last, at('2026-10-21T16:30:00Z'), TZ)).toBe('late');
    expect(cadenceStatus(DAYTIME, last, at('2026-10-21T17:30:00Z'), TZ)).toBe('stopped');
  });

  it('reads its hours in its own timezone, whatever the owner is in', () => {
    // 8pm to 11:30pm in Chicago is one daytime hour; in Los Angeles (6pm to
    // 9:30pm) it would be three, and late.
    const last = '2026-10-22T01:00:00Z';
    const now = at('2026-10-22T04:30:00Z');
    expect(cadenceStatus(DAYTIME, last, now, 'America/Los_Angeles')).toBe('ok');
    expect(
      cadenceStatus({ ...DAYTIME, timeZone: undefined }, last, now, 'America/Los_Angeles'),
    ).toBe('late');
  });
});

describe('feeds without a schedule', () => {
  const now = at('2026-10-21T17:00:00Z');

  it('an event feed is never late, however quiet', () => {
    const event: FeedCadence = { kind: 'event' };
    expect(cadenceStatus(event, hoursBefore(now, 24 * 25), now, TZ)).toBe('ok');
    expect(cadenceStatus(event, null, now, TZ)).toBe('never');
  });

  it('an on-demand feed is late or stopped only while a request waits', () => {
    const ask: FeedCadence = { kind: 'on-demand', lateAfterMinutes: 15, stoppedAfterMinutes: 60 };
    const lastAnswer = hoursBefore(now, 30);
    expect(cadenceStatus(ask, lastAnswer, now, TZ)).toBe('ok');
    expect(cadenceStatus(ask, lastAnswer, now, TZ, hoursBefore(now, 0.1))).toBe('ok');
    expect(cadenceStatus(ask, lastAnswer, now, TZ, hoursBefore(now, 0.5))).toBe('late');
    expect(cadenceStatus(ask, lastAnswer, now, TZ, hoursBefore(now, 1.5))).toBe('stopped');
    expect(cadenceStatus(ask, null, now, TZ)).toBe('never');
  });
});

describe('the "may be out of date" hint on a card', () => {
  const now = at('2026-10-21T17:00:00Z');

  it('shows only once the card’s feed looks stopped', () => {
    expect(mayBeOutOfDate('relationships', hoursBefore(now, 10), now)).toBe(false);
    expect(mayBeOutOfDate('relationships', hoursBefore(now, 40), now)).toBe(false);
    expect(mayBeOutOfDate('relationships', hoursBefore(now, 60), now)).toBe(true);
    expect(mayBeOutOfDate('relationships', null, now)).toBe(false);
  });

  it('never shows for a feed that only posts when there is news', () => {
    expect(mayBeOutOfDate('meeting-recaps', hoursBefore(now, 24 * 20), now)).toBe(false);
  });
});

describe('the registry', () => {
  it('has unique ids, a schedule and what each feed fills', () => {
    const ids = FEEDS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const feed of FEEDS) {
      expect(feed.name.length, feed.id).toBeGreaterThan(0);
      expect(feed.schedule.length, feed.id).toBeGreaterThan(0);
      expect(feed.fills.length, feed.id).toBeGreaterThan(0);
    }
  });

  it('names the relay marker of every feed that comes through a relay channel', () => {
    for (const feed of FEEDS) {
      if (feed.source !== 'deal-relay' && feed.source !== 'ask-relay') continue;
      expect(FEED_MARKERS[feed.id as keyof typeof FEED_MARKERS], feed.id).toBeDefined();
    }
  });

  it('keeps every scheduled feed a little looser than its own schedule', () => {
    for (const feed of FEEDS) {
      if (feed.cadence.kind !== 'every') continue;
      expect(feed.cadence.graceHours, feed.id).toBeGreaterThan(0);
      expect(stoppedAfterHours(feed.cadence), feed.id).toBeGreaterThan(
        feed.cadence.hours + feed.cadence.graceHours,
      );
    }
  });

  it('does not call a twice-a-day feed late across its overnight gap', () => {
    // An afternoon post at 3:40pm Chicago, and the next morning's not in yet
    // at 7:10am: 15.5 hours, the longest gap a morning-and-afternoon routine has.
    const afternoon = '2026-10-20T20:40:00Z';
    const morning = at('2026-10-21T12:10:00Z');
    expect(cadenceStatus(feedDef('priorities').cadence, afternoon, morning, TZ)).toBe('ok');
    // Both of the next day's runs missed is a stopped feed.
    expect(
      cadenceStatus(feedDef('priorities').cadence, afternoon, at('2026-10-22T03:00:00Z'), TZ),
    ).toBe('stopped');
  });

  it('reads a Reports channel as late exactly when the Reports tab calls it overdue', () => {
    const weekly = reportFeed({
      key: 'example',
      label: 'Example Angels',
      group: 'dealflow',
      cadence: 'Weekly · Fri',
      staleAfterDays: 8,
    });
    expect(weekly.name).toBe('Example Angels dealflow');
    expect(
      reportFeed({
        key: 'digest',
        label: 'Example Digest',
        group: 'digest',
        cadence: 'Mon',
        staleAfterDays: 5,
      }).name,
    ).toBe('Example Digest');
    const now = at('2026-10-21T17:00:00Z');
    const days = (d: number) => hoursBefore(now, d * 24);
    expect(weekly.id).toBe('reports:example');
    expect(cadenceStatus(weekly.cadence, days(7.9), now, TZ)).toBe('ok');
    expect(cadenceStatus(weekly.cadence, days(8.1), now, TZ)).toBe('late');
    expect(cadenceStatus(weekly.cadence, days(15.1), now, TZ)).toBe('stopped');
  });

  it('sorts the worst first', () => {
    expect(STATUS_ORDER[0]).toBe('stopped');
    expect(STATUS_ORDER.indexOf('late')).toBeLessThan(STATUS_ORDER.indexOf('ok'));
  });

  it('says what each cadence expects in plain words', () => {
    expect(intervalWords(feedDef('relationships').cadence)).toBe('every day');
    expect(intervalWords(feedDef('priorities').cadence)).toBe('every 12 hours');
    expect(intervalWords(feedDef('meeting-recaps').cadence)).toBeNull();
    expect(expectedWords(feedDef('push-sender').cadence)).toBe('at least every hour, 6am to 9pm');
    expect(expectedWords(WEEKDAYS)).toBe('at least every day on weekdays');
    expect(expectedWords({ kind: 'every', hours: 24, graceHours: 6, days: [5, 1] })).toBe(
      'at least every day on Mondays and Fridays',
    );
  });
});
