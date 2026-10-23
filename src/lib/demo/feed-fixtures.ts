import type { FeedInputs, RelaySighting } from '@/lib/services/feed-health';
import type { StaticFeedId } from '@/lib/feeds/registry';
import { DEMO_UPDATE_SOURCES } from './updates-fixtures';

/**
 * Demo mode only: when each feed was last seen, relative to `now`, so the
 * Feeds tab and the feed notices have something real-looking to show. Most
 * feeds are on time; the deal sorter is a run late, the task closer has
 * missed three days (so it "looks stopped"), and two feeds have never
 * posted (the quarterly LP update, and new portfolio companies, which only
 * post when an investment closes). The week ahead's newest post had one
 * meeting it could not read, skipped while the rest showed (D-073).
 */
export function demoFeedInputs(now: Date): FeedInputs {
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  const seen = (hours: number): RelaySighting => ({ at: hoursAgo(hours), unreadableAt: null });
  const dealRelay: Partial<Record<StaticFeedId, RelaySighting>> = {
    priorities: seen(3),
    'follow-ups': seen(6),
    relationships: seen(7),
    'lp-pipeline': seen(8),
    'portfolio-health': seen(8),
    // The weekly jobs scan, two days ago (as the demo Jobs tab says).
    'portfolio-jobs': seen(50),
    // The twice-weekly students scan, yesterday (as the demo Students tab says).
    students: seen(30),
    intros: seen(9),
    'week-ahead': { ...seen(9), skipped: 1 },
    'email-queue': seen(10),
    'deal-sorter': seen(20),
    'task-closer': seen(74),
    'meeting-recaps': seen(26),
    scheduling: seen(50),
  };
  const askRelay: Partial<Record<StaticFeedId, RelaySighting>> = {
    overview: seen(5),
    recap: seen(20),
    'task-suggest': seen(12),
    'ask-answers': seen(0.7),
  };
  return {
    readAt: now.toISOString(),
    dealRelay: { state: 'ok', seen: dealRelay },
    askRelay: { state: 'ok', seen: askRelay },
    reports: DEMO_UPDATE_SOURCES.map((source) => ({
      source,
      state: 'ok',
      lastPostAt: hoursAgo(source.group === 'digest' ? 2 * 24 : 4 * 24),
      reason: null,
    })),
    jobs: { 'daily-job': hoursAgo(4), 'push-sender': hoursAgo(0.1) },
    affinity: { configured: true, lastRunAt: hoursAgo(3) },
    notes: { configured: true, lastAt: hoursAgo(5) },
    ask: { configured: true, waitingSince: null },
    // Copilot Notes (D-076): the demo meeting was recorded nine days ago.
    capture: { configured: true, lastAt: hoursAgo(9 * 24), stuck: 0 },
  };
}
