/**
 * Every feed the app is filled by, and how often each is expected.
 *
 * Copilot's cards are written by cloud routines and scheduled jobs that the
 * app cannot see run: the routines post to the private Slack relay channels
 * (the app reads them back), and the jobs call the app's /api/cron routes. A
 * routine that stops posting leaves its card showing the last good copy with
 * nothing to say it is old. This list is what the watchdog
 * (`lib/services/feed-health.ts`) checks each feed against.
 *
 * Pure data and no server-only imports: the Diagnostics page, the cards'
 * "may be out of date" hint and the unit tests all read it.
 *
 * The schedules are the producers' own (their cron lines, mostly in UTC, so
 * an hour earlier in Central after the clocks go back). A cadence here is
 * deliberately looser than the schedule: a routine that starts late is not
 * a stopped one.
 */

/** How far back the relay channels are read for each feed's newest post. */
export const RELAY_WINDOW_DAYS = 30;

/** Where a feed's posts arrive, or what writes its timestamp. */
export type FeedSource =
  /** The private deal relay channel (DEAL_RELAY_CHANNEL_ID). */
  | 'deal-relay'
  /** The briefing and Ask relay channel (ASK_RELAY_CHANNEL_ID). */
  | 'ask-relay'
  /** The Reports tab's channels (`lib/updates/sources.ts`). */
  | 'reports'
  /** A scheduled job that calls the app. */
  | 'job'
  /** Deliveries to the app's own webhook, with a scheduled catch-up. */
  | 'webhook';

export type FeedCadence =
  /** Posts only when there is something new: quiet is normal, never late. */
  | { kind: 'event' }
  /** Answers when asked: late or stopped only while a question waits. */
  | { kind: 'on-demand'; lateAfterMinutes: number; stoppedAfterMinutes: number }
  | {
      kind: 'every';
      /** Hours between posts when all is well, counted on active days and hours only. */
      hours: number;
      /** Slack past `hours` before the feed counts as late. */
      graceHours: number;
      /** Counted hours past which it counts as stopped; two runs missed by default. */
      stoppedAfterHours?: number;
      /** Weekdays it runs on (0 = Sunday); every day when left out. */
      days?: readonly number[];
      /** Local hours it runs in, from and until (exclusive); all day when left out. */
      activeHours?: readonly [number, number];
      /** The timezone those days and hours are read in; the owner's when left out. */
      timeZone?: string;
    };

export type StaticFeedId =
  | 'priorities'
  | 'follow-ups'
  | 'relationships'
  | 'lp-pipeline'
  | 'portfolio-health'
  | 'portfolio-jobs'
  | 'students'
  | 'intros'
  | 'week-ahead'
  | 'email-queue'
  | 'deal-sorter'
  | 'task-closer'
  | 'meeting-recaps'
  | 'scheduling'
  | 'lp-update'
  | 'overview'
  | 'recap'
  | 'task-suggest'
  | 'portfolio-adds'
  | 'ask-answers'
  | 'meeting-notes'
  | 'daily-job'
  | 'affinity-sync'
  | 'push-sender';

/** A Reports channel's feed is `reports:<source key>`. */
export type FeedId = StaticFeedId | `reports:${string}`;

export interface FeedDef {
  id: FeedId;
  /** What it is called on the Diagnostics page. */
  name: string;
  source: FeedSource;
  /** The cards and pages it fills, as they are labelled in the app. */
  fills: readonly string[];
  /** When it runs, in plain words. */
  schedule: string;
  cadence: FeedCadence;
}

const DAILY = { kind: 'every', hours: 24, graceHours: 6 } as const;
/**
 * Twice a day is rarely twelve hours apart: a morning and an afternoon run
 * leave a gap of up to fifteen hours overnight, so the grace covers that and
 * a late start on top.
 */
const TWICE_DAILY = { kind: 'every', hours: 12, graceHours: 6 } as const;
/**
 * The daily job runs at 11:00 UTC and again at 21:30 and 22:30 UTC, and
 * GitHub starts scheduled runs late, sometimes by hours.
 */
const DAILY_JOB = { kind: 'every', hours: 12, graceHours: 6 } as const;
/**
 * Once a week: late after ten days, the age at which the Jobs tab calls its
 * scan overdue (`JOBS_STALE_AFTER_DAYS`), and stopped once two runs are missed.
 */
const WEEKLY = { kind: 'every', hours: 7 * 24, graceHours: 3 * 24 } as const;
/**
 * Mondays and Thursdays: at most four days between runs (Thursday to
 * Monday), late after five, the age at which the Students tab calls its scan
 * overdue (`STUDENTS_STALE_AFTER_DAYS`), and stopped once two runs are missed.
 * No `days` here: the gap is counted on every day, not only on run days.
 */
const TWICE_WEEKLY = { kind: 'every', hours: 4 * 24, graceHours: 24 } as const;

/**
 * The fixed feeds, in the order the Diagnostics page lists feeds of the same
 * status. The Reports channels follow, one feed each, from their own source
 * list (`reportFeeds`).
 *
 * Since early October every routine below runs every day, weekends included
 * (their prompts may still say "each weekday"; the cron is what counts).
 */
export const FEEDS: readonly FeedDef[] = [
  {
    id: 'overview',
    name: 'Morning brief',
    source: 'ask-relay',
    fills: ['Today: briefing card', 'Calendar: meeting dossier'],
    schedule: 'Every morning, about 6am Central',
    cadence: DAILY,
  },
  {
    id: 'recap',
    name: 'Afternoon recap',
    source: 'ask-relay',
    fills: ['Today: briefing card'],
    schedule: 'Every afternoon, about 3pm Central',
    cadence: DAILY,
  },
  {
    id: 'priorities',
    name: 'Top priorities',
    source: 'deal-relay',
    fills: ['Today: Top priorities', 'Phone and desktop alerts: money items, the morning top 3'],
    schedule: 'Twice a day, morning and afternoon',
    cadence: TWICE_DAILY,
  },
  {
    id: 'follow-ups',
    name: 'Follow-up tracker',
    source: 'deal-relay',
    fills: ["Follow-ups: You're waiting on"],
    schedule: 'Every morning',
    cadence: DAILY,
  },
  {
    id: 'relationships',
    name: 'Relationship radar',
    source: 'deal-relay',
    fills: [
      'Follow-ups: Waiting on you',
      'Network: Going cold',
      'Phone and desktop alerts: who is waiting',
    ],
    schedule: 'Every morning',
    cadence: DAILY,
  },
  {
    id: 'email-queue',
    name: 'Email queue',
    source: 'deal-relay',
    fills: ['Follow-ups: the email session'],
    schedule: 'Through the day; each post carries only new or changed emails',
    // Each run posts only what changed, so a quiet inbox can skip a run.
    cadence: { kind: 'every', hours: 24, graceHours: 24 },
  },
  {
    id: 'deal-sorter',
    name: 'Deal sorter',
    source: 'deal-relay',
    fills: ['Deals'],
    schedule: 'Twice a day, early morning and afternoon',
    cadence: TWICE_DAILY,
  },
  {
    id: 'task-closer',
    name: 'Task closer',
    source: 'deal-relay',
    fills: ['Tasks: closing tasks that are done', 'Today: At a glance'],
    schedule: 'Every day at 3pm Central',
    cadence: DAILY,
  },
  {
    id: 'portfolio-health',
    name: 'Portfolio health',
    source: 'deal-relay',
    fills: ['Portfolio: Health', 'Phone and desktop alerts: companies at risk'],
    schedule: 'Every morning',
    cadence: DAILY,
  },
  {
    id: 'portfolio-jobs',
    name: 'Portfolio jobs',
    source: 'deal-relay',
    fills: ['Portfolio: Jobs', 'Company pages: Open roles'],
    schedule: 'Once a week, Monday morning; a long list comes in numbered parts',
    // A run split into parts repeats its run_at on every part, and any part
    // the Jobs tab can read counts as the run being seen.
    cadence: WEEKLY,
  },
  {
    id: 'students',
    name: 'Students & interns',
    source: 'deal-relay',
    fills: ['Network: Students & interns'],
    schedule: 'Twice a week, Monday and Thursday morning; a long list comes in numbered parts',
    // Like Jobs: every part repeats its run_at, and any part the tab can read
    // counts as the run being seen.
    cadence: TWICE_WEEKLY,
  },
  {
    id: 'lp-pipeline',
    name: 'LP pipeline',
    source: 'deal-relay',
    fills: ['Fund II: LP pipeline'],
    schedule: 'Every morning',
    cadence: DAILY,
  },
  {
    id: 'intros',
    name: 'Intros tracker',
    source: 'deal-relay',
    fills: ['Network: Intros'],
    schedule: 'Every morning',
    cadence: DAILY,
  },
  {
    id: 'week-ahead',
    name: 'Week ahead',
    source: 'deal-relay',
    fills: ['Meetings: Week ahead', 'Calendar: prep notes'],
    schedule: 'Every morning',
    cadence: DAILY,
  },
  {
    id: 'meeting-recaps',
    name: 'Meeting recaps',
    source: 'deal-relay',
    fills: ['Follow-ups: Meeting recaps'],
    schedule: 'After external meetings, when a recap was drafted',
    cadence: { kind: 'event' },
  },
  {
    id: 'scheduling',
    name: 'Scheduling drafts',
    source: 'deal-relay',
    fills: ['Follow-ups: Scheduling drafts'],
    schedule: 'Twice a day, when an email asks to find a time',
    cadence: { kind: 'event' },
  },
  {
    id: 'lp-update',
    name: 'Quarterly LP update',
    source: 'deal-relay',
    fills: ['Fund II: LP update draft'],
    schedule: 'Once a quarter',
    cadence: { kind: 'every', hours: 92 * 24, graceHours: 7 * 24 },
  },
  {
    id: 'task-suggest',
    name: 'Task suggestions',
    source: 'ask-relay',
    fills: ['Tasks'],
    schedule: 'Checks twice a day; posts only when it finds a new task',
    cadence: { kind: 'event' },
  },
  {
    id: 'portfolio-adds',
    name: 'New portfolio companies',
    source: 'ask-relay',
    fills: ['Portfolio: Companies'],
    schedule: 'Checks twice a day; posts only when an investment closes',
    cadence: { kind: 'event' },
  },
  {
    id: 'ask-answers',
    name: 'Ask answers',
    source: 'ask-relay',
    fills: ['Ask', 'The chat bubble'],
    schedule: 'When a question is asked; usually answered within a minute or two',
    cadence: { kind: 'on-demand', lateAfterMinutes: 15, stoppedAfterMinutes: 60 },
  },
  {
    id: 'meeting-notes',
    name: 'Meeting notes',
    source: 'webhook',
    fills: ['Meetings: Notes', 'Calendar: meeting dossier', 'Ask'],
    schedule: 'Minutes after each recorded meeting, with a catch-up every half hour',
    // Arrives only when a meeting was recorded, so a quiet week is normal.
    cadence: { kind: 'event' },
  },
  {
    id: 'daily-job',
    name: 'Daily job',
    source: 'job',
    fills: ['Mail sync and the Gmail watch renewal', 'The backstop pull of every relay'],
    schedule: 'Every morning and afternoon, from the scheduler (often a little late)',
    cadence: DAILY_JOB,
  },
  {
    id: 'affinity-sync',
    name: 'Affinity sync',
    source: 'job',
    fills: ['Knowledge: Affinity lists', 'The Affinity tabs on Deals, Fund II, Portfolio, Network'],
    schedule: 'Every morning, after the daily job',
    cadence: { kind: 'every', hours: 24, graceHours: 8 },
  },
  {
    id: 'push-sender',
    name: 'Alert sender',
    source: 'job',
    fills: ['Phone alerts', 'Meeting reminders on phones'],
    schedule: 'Every minute, 6am to 9pm Central',
    // The sender calls the app only in those hours; the app notes it at most
    // every ten minutes (`JOB_HEARTBEAT_EVERY_MS`).
    cadence: {
      kind: 'every',
      hours: 1,
      graceHours: 1,
      stoppedAfterHours: 3,
      activeHours: [6, 21],
      timeZone: 'America/Chicago',
    },
  },
];

/** What a Reports channel needs to become a feed: `UpdateSource`'s own fields. */
export interface ReportSourceLike {
  key: string;
  label: string;
  /** `dealflow` reports, or a `digest`. */
  group?: string;
  cadence: string;
  staleAfterDays: number;
}

/**
 * A Reports channel as a feed. Late once its newest report is older than the
 * channel's own `staleAfterDays` (where the Reports tab already calls it
 * overdue); stopped at roughly twice that.
 */
export function reportFeed(source: ReportSourceLike): FeedDef {
  const days = Math.max(1, source.staleAfterDays);
  return {
    id: `reports:${source.key}`,
    name: source.group === 'digest' ? source.label : `${source.label} dealflow`,
    source: 'reports',
    fills: ['Reports: Dealflow & digests'],
    schedule: source.cadence,
    cadence: { kind: 'every', hours: (days - 1) * 24, graceHours: 24 },
  };
}

const BY_ID = new Map<string, FeedDef>(FEEDS.map((f) => [f.id, f]));

/** A fixed feed's definition. */
export function feedDef(id: StaticFeedId): FeedDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`Unknown feed: ${id}`);
  return def;
}

/** The relay markers each feed's posts start with (`*_V1`), for the page and the tests. */
export const FEED_MARKERS: Partial<Record<StaticFeedId, readonly string[]>> = {
  priorities: ['PRIORITIES_V1'],
  'follow-ups': ['FOLLOWUPS_V1'],
  relationships: ['RELATIONSHIPS_V1'],
  'lp-pipeline': ['LP_PIPELINE_V1'],
  'portfolio-health': ['PORTFOLIO_HEALTH_V1'],
  'portfolio-jobs': ['JOBS_V1'],
  students: ['STUDENTS_V1'],
  intros: ['INTROS_V1'],
  'week-ahead': ['WEEK_AHEAD_V1'],
  'email-queue': ['EMAIL_QUEUE_V1'],
  'deal-sorter': ['DEAL_SORTER_RUN_V1'],
  'task-closer': ['TASK_CLOSER_RUN_V1'],
  'meeting-recaps': ['MEETING_FOLLOWUP_V1'],
  scheduling: ['SCHEDULING_V1'],
  'lp-update': ['LP_UPDATE_DRAFT_V1'],
  overview: ['BRIEFING_PAYLOAD_V1'],
  recap: ['BRIEFING_PAYLOAD_V1'],
  'task-suggest': ['TASK_ADD_V1'],
  'portfolio-adds': ['PORTFOLIO_ADD_V1'],
  'ask-answers': ['ASK_ANSWER_V1'],
};
