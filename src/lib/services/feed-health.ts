import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import { env, type AppEnv } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { demoFeedInputs } from '@/lib/demo/feed-fixtures';
import {
  FEEDS,
  RELAY_WINDOW_DAYS,
  reportFeed,
  type FeedDef,
  type FeedId,
  type ReportSourceLike,
  type StaticFeedId,
} from '@/lib/feeds/registry';
import { cadenceStatus, STATUS_ORDER, type FeedStatus } from '@/lib/feeds/status';
import { JOBS_MARKER } from '@/lib/portfolio/jobs';
import { STUDENTS_MARKER } from '@/lib/portfolio/students';
import { getUpdatesFeed } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import {
  readRelayWindow,
  slackTsToIso,
  type RelayReadState,
  type SlackMessage,
} from '@/lib/slack/relay-history';
import type { AuditEvent, ChatMessage, MeetingNote, Organization } from '@/lib/types/domain';
import { UPDATE_SOURCES } from '@/lib/updates/sources';
import { newId } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { unwrapSlackText } from '@/lib/util/slack-text';
import { localClock } from '@/lib/util/time';
import { getAffinitySyncStatus } from './affinity-sync';
import { parseAnswerMessage } from './ask-routine';
import { parseBriefingRelayMessage } from './briefing';
import { DEAL_HEARTBEAT_MARKER, isRelayOrganization, parseDealRelayMessage } from './deal-relay';
import {
  EMAIL_QUEUE_MARKER,
  FOLLOWUPS_MARKER,
  INTROS_MARKER,
  LP_PIPELINE_MARKER,
  LP_UPDATE_DRAFT_MARKER,
  MEETING_FOLLOWUP_MARKER,
  parseFollowUpMessage,
  PORTFOLIO_HEALTH_MARKER,
  PRIORITIES_MARKER,
  RELATIONSHIPS_MARKER,
  SCHEDULING_MARKER,
  WEEK_AHEAD_MARKER,
} from './follow-ups';
import { parsePortfolioRelayMessage } from './portfolio-ingest';
import { parseJobsMessage } from './portfolio-jobs';
import { parseStudentsMessage } from './portfolio-students';
import { parseTaskCloseMessage, TASK_CLOSER_RUN_MARKER } from './task-close';
import { parseTaskRelayMessage } from './task-ingest';
import { readUpdates } from './updates';

/**
 * The feed watchdog: when each feed in `lib/feeds/registry.ts` was last seen,
 * and whether that is on time (D-061).
 *
 * Read only from what already exists, so there is no schema change:
 *
 * - the relay channels' own history (the newest post per marker that its
 *   consumer can read, and any newer one it cannot), read as the cards' own
 *   pulls read it;
 * - the Reports channels' newest report (`readUpdates`, cached);
 * - the Affinity sync's saved state;
 * - the newest meeting note written (`meeting_notes.updated_at`);
 * - unanswered Ask questions (`chat_messages` left pending);
 * - and, for the two jobs that leave no other trace, one `audit_events` row
 *   each (`feeds.heartbeat`, replaced on every write), noted by their
 *   /api/cron routes.
 *
 * Nothing here is shown to the mailbox owner's phone: a feed that looks
 * stopped notifies only the computers of someone who turned feed notices on
 * for themselves (`feeds.notify`, one row per person), through the desktop
 * alerts they already have (`desktop-alerts.ts`), at most once a day per feed
 * on each computer, 8am to 8pm.
 *
 * Every read is caught on its own: a part that fails reads as "can't check",
 * never as stopped, and never as a failed page.
 */

export const HEARTBEAT_ACTION = 'feeds.heartbeat';
export const NOTICE_ACTION = 'feeds.notify';

export type JobId = 'daily-job' | 'push-sender';

/** How often each job's heartbeat row is rewritten at most, per server process. */
export const JOB_HEARTBEAT_EVERY_MS: Record<JobId, number> = {
  'daily-job': 0,
  'push-sender': 10 * 60_000,
};

const RELAY_MAX_PAGES = 5;
const RELAY_PAGE_SIZE = 200;
/** A question unanswered for longer than this is taken as abandoned, not waiting. */
const ASK_WAIT_LOOKBACK_MS = 24 * 3_600_000;
/** The `model` an answer settled from the Ask bridge is saved with (ask-bridge.ts). */
const ASK_BRIDGE_MODEL = 'claude-code-ask-bridge';

/** How old a read the Diagnostics page accepts. */
export const PAGE_MAX_AGE_MS = 2 * 60_000;
/** How old a read the desktop notices accept: a stopped feed is a matter of hours. */
export const NOTICE_MAX_AGE_MS = 30 * 60_000;
const WATCHERS_TTL_MS = 5 * 60_000;

/** Feed notices go out in these local hours only, like the other non-meeting alerts. */
export const NOTICE_FROM_HOUR = 8;
export const NOTICE_UNTIL_HOUR = 20;
export const NOTICE_KEY_PREFIX = 'feed:';
const NOTICE_BODY_MAX = 180;

/* ------------------------------------------------------------- the inputs */

/** One feed in a relay channel: its newest readable post, and a newer unreadable one. */
export interface RelaySighting {
  at: string | null;
  unreadableAt: string | null;
  /**
   * Items the newest readable post (every part of its run) left out because
   * they could not be read; the rest of it shows. Absent when none.
   */
  skipped?: number;
}

export type RelayRead =
  | { state: 'ok'; seen: Partial<Record<StaticFeedId, RelaySighting>> }
  | { state: 'unknown' | 'off'; reason: string };

export interface ReportRead {
  source: ReportSourceLike;
  state: 'ok' | 'unknown' | 'off';
  lastPostAt: string | null;
  reason: string | null;
}

/** Everything a report is built from. Times are ISO strings. */
export interface FeedInputs {
  readAt: string;
  dealRelay: RelayRead;
  askRelay: RelayRead;
  reports: ReportRead[];
  /** null when the heartbeat rows could not be read. */
  jobs: Partial<Record<JobId, string>> | null;
  /** null when the sync's state could not be read. */
  affinity: { configured: boolean; lastRunAt: string | null } | null;
  /** When a meeting note was last written; null when the notes could not be read. */
  notes: { configured: boolean; lastAt: string | null } | null;
  /** null when the questions could not be read. */
  ask: { configured: boolean; waitingSince: string | null } | null;
}

/* ------------------------------------------------------------ the report */

export interface FeedRow {
  id: FeedId;
  def: FeedDef;
  status: FeedStatus;
  lastSeen: string | null;
  /** A post newer than `lastSeen` that its card could not read. */
  unreadableAt: string | null;
  /** Items the post at `lastSeen` (all its run's parts) left out as unreadable. Absent when none. */
  skipped?: number;
  /** When the oldest unanswered request was made, for an on-demand feed. */
  waitingSince: string | null;
  /** Why it cannot be checked, or why it is off. Plain words, never a value. */
  reason: string | null;
}

export interface FeedReport {
  checkedAt: string;
  /** Worst first, then in registry order. */
  rows: FeedRow[];
}

function relayRow(def: FeedDef, read: RelayRead, now: Date, tz: string): FeedRow {
  const base = { id: def.id, def, waitingSince: null } as const;
  if (read.state !== 'ok') {
    return { ...base, status: read.state, lastSeen: null, unreadableAt: null, reason: read.reason };
  }
  const seen = read.seen[def.id as StaticFeedId];
  const lastSeen = seen?.at ?? null;
  return {
    ...base,
    status: cadenceStatus(def.cadence, lastSeen, now, tz),
    lastSeen,
    unreadableAt: seen?.unreadableAt ?? null,
    ...(lastSeen && seen?.skipped ? { skipped: seen.skipped } : {}),
    reason: null,
  };
}

function rowFor(def: FeedDef, inputs: FeedInputs, now: Date, tz: string): FeedRow {
  const plain = (status: FeedStatus, lastSeen: string | null, reason: string | null = null) => ({
    id: def.id,
    def,
    status,
    lastSeen,
    unreadableAt: null,
    waitingSince: null,
    reason,
  });

  switch (def.id) {
    case 'ask-answers': {
      if (inputs.ask && !inputs.ask.configured) {
        return plain(
          'off',
          null,
          'Answers come back through the relay channel, which is not set up here.',
        );
      }
      const row = relayRow(def, inputs.askRelay, now, tz);
      const waitingSince = inputs.ask?.waitingSince ?? null;
      if (!waitingSince) return row;
      // A waiting question is news even when the channel cannot be read.
      return {
        ...row,
        status: cadenceStatus(def.cadence, row.lastSeen, now, tz, waitingSince),
        waitingSince,
        reason: null,
      };
    }
    case 'daily-job':
    case 'push-sender': {
      if (!inputs.jobs) return plain('unknown', null, 'Its record could not be read just now.');
      const at = inputs.jobs[def.id] ?? null;
      return plain(cadenceStatus(def.cadence, at, now, tz), at);
    }
    case 'affinity-sync': {
      if (!inputs.affinity) return plain('unknown', null, 'Its saved state could not be read.');
      if (!inputs.affinity.configured) {
        return plain('off', inputs.affinity.lastRunAt, 'AFFINITY_API_KEY is not set.');
      }
      const at = inputs.affinity.lastRunAt;
      return plain(cadenceStatus(def.cadence, at, now, tz), at);
    }
    case 'meeting-notes': {
      if (!inputs.notes) return plain('unknown', null, 'The notes could not be read just now.');
      const at = inputs.notes.lastAt;
      if (!inputs.notes.configured && !at) {
        return plain('off', null, 'No meeting-notes delivery is set up (see Setup).');
      }
      return plain(cadenceStatus(def.cadence, at, now, tz), at);
    }
    default:
      return relayRow(
        def,
        def.source === 'ask-relay' ? inputs.askRelay : inputs.dealRelay,
        now,
        tz,
      );
  }
}

/** The report for these inputs at `now`. Pure. */
export function buildFeedReport(inputs: FeedInputs, now: Date, timeZone: string): FeedReport {
  const rows: FeedRow[] = FEEDS.map((def) => rowFor(def, inputs, now, timeZone));
  for (const report of inputs.reports) {
    const def = reportFeed(report.source);
    rows.push({
      id: def.id,
      def,
      status:
        report.state === 'ok'
          ? cadenceStatus(def.cadence, report.lastPostAt, now, timeZone)
          : report.state,
      lastSeen: report.lastPostAt,
      unreadableAt: null,
      waitingSince: null,
      reason: report.reason,
    });
  }
  const rank = (row: FeedRow) => STATUS_ORDER.indexOf(row.status);
  // Array.prototype.sort is stable: equal statuses keep the registry order.
  rows.sort((a, b) => rank(a) - rank(b));
  return { checkedAt: inputs.readAt, rows };
}

/* ------------------------------------------------------- relay sightings */

/** What one post is, as its consumer reads it. */
export interface RelayOutcome {
  /** Which feeds the post is for. */
  feeds: readonly StaticFeedId[];
  /** Whether its consumer could read it. */
  valid: boolean;
  /** Items in a readable post that were left out because they could not be read. */
  skipped?: number;
  /** The run the post belongs to (its run_at, as one spelling), when it says. */
  run?: string;
  /** Its part number within that run; 1 when it does not say. */
  part?: number;
}

/** How one marker's posts are read: as its consumer reads them. */
export interface RelayRule {
  read: (text: string) => RelayOutcome;
  /** Only these posters count; anyone when empty. */
  posters: readonly string[];
  /** Skip messages with a subtype (edits, joins, bot notices), as the consumer does. */
  skipSubtypes: boolean;
}

const MARKER_RE = /^[A-Z][A-Z0-9_]*_V\d+/;

/**
 * Slack messages (any order) -> per feed, the newest post its consumer can
 * read and any newer one it cannot, with the items that readable post left
 * out: summed over every part of its run, each part counted once. Pure.
 */
export function collectSightings(
  messages: readonly SlackMessage[],
  rules: ReadonlyMap<string, RelayRule>,
): Partial<Record<StaticFeedId, RelaySighting>> {
  const seen: Partial<Record<StaticFeedId, RelaySighting>> = {};
  // The run each feed's newest readable post belongs to, and its parts counted so far.
  const runs = new Map<StaticFeedId, { run: string; parts: Set<number> }>();
  const ordered = messages
    .map((m) => ({ m, iso: slackTsToIso(m.ts) }))
    .filter((x): x is { m: SlackMessage; iso: string } => x.iso !== null)
    .sort((a, b) => b.iso.localeCompare(a.iso));
  for (const { m, iso } of ordered) {
    if (typeof m.text !== 'string') continue;
    const marker = MARKER_RE.exec(unwrapSlackText(m.text, { preferLabel: true }).trim())?.[0];
    const rule = marker ? rules.get(marker) : undefined;
    if (!rule) continue;
    if (rule.skipSubtypes && m.subtype !== undefined && m.subtype !== null) continue;
    if (rule.posters.length > 0 && !(typeof m.user === 'string' && rule.posters.includes(m.user))) {
      continue;
    }
    let outcome: RelayOutcome;
    try {
      outcome = rule.read(m.text);
    } catch {
      continue;
    }
    const part = outcome.part ?? 1;
    const skipped = outcome.valid ? Math.max(0, outcome.skipped ?? 0) : 0;
    for (const feed of outcome.feeds) {
      const entry = (seen[feed] ??= { at: null, unreadableAt: null });
      if (entry.at) {
        // An older part of the same run: what it left out counts too, once.
        const run = runs.get(feed);
        if (outcome.valid && run && outcome.run === run.run && !run.parts.has(part)) {
          run.parts.add(part);
          if (skipped) entry.skipped = (entry.skipped ?? 0) + skipped;
        }
        continue;
      }
      if (outcome.valid) {
        entry.at = iso;
        if (skipped) entry.skipped = skipped;
        if (outcome.run) runs.set(feed, { run: outcome.run, parts: new Set([part]) });
      } else {
        entry.unreadableAt ??= iso;
      }
    }
  }
  return seen;
}

/** A run_at as one spelling, so the parts of one run group however each wrote it. */
function runKey(runAt: unknown): string | undefined {
  if (typeof runAt !== 'string') return undefined;
  const ms = Date.parse(runAt);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Each #deal-relay feed's marker. */
const DEAL_RELAY_FEEDS: Record<string, StaticFeedId> = {
  [PRIORITIES_MARKER]: 'priorities',
  [FOLLOWUPS_MARKER]: 'follow-ups',
  [RELATIONSHIPS_MARKER]: 'relationships',
  [LP_PIPELINE_MARKER]: 'lp-pipeline',
  [PORTFOLIO_HEALTH_MARKER]: 'portfolio-health',
  [INTROS_MARKER]: 'intros',
  [WEEK_AHEAD_MARKER]: 'week-ahead',
  [EMAIL_QUEUE_MARKER]: 'email-queue',
  [MEETING_FOLLOWUP_MARKER]: 'meeting-recaps',
  [SCHEDULING_MARKER]: 'scheduling',
  [LP_UPDATE_DRAFT_MARKER]: 'lp-update',
};

/** The rules for #deal-relay, with this deployment's poster allow-lists. */
export function dealRelayRules(e: Pick<AppEnv, 'dealRelayPosterIds' | 'taskRelayPosterIds'>) {
  const rules = new Map<string, RelayRule>();
  for (const [marker, feed] of Object.entries(DEAL_RELAY_FEEDS)) {
    rules.set(marker, {
      read: (text) => {
        const parsed = parseFollowUpMessage(text);
        if (!parsed) return { feeds: [feed], valid: false };
        const envelope = parsed.value as { run_at?: unknown; part?: unknown };
        return {
          feeds: [feed],
          valid: true,
          skipped: parsed.skipped,
          run: runKey(envelope.run_at),
          part: typeof envelope.part === 'number' ? envelope.part : 1,
        };
      },
      posters: e.dealRelayPosterIds,
      skipSubtypes: true,
    });
  }
  rules.set(DEAL_HEARTBEAT_MARKER, {
    read: (text) => ({
      feeds: ['deal-sorter'],
      valid: parseDealRelayMessage(text)?.kind === 'heartbeat',
    }),
    posters: e.dealRelayPosterIds,
    skipSubtypes: true,
  });
  // The weekly jobs scan may come in numbered parts: any part the Jobs tab
  // can read is the run seen.
  rules.set(JOBS_MARKER, {
    read: (text) => {
      const parsed = parseJobsMessage(text);
      if (!parsed) return { feeds: ['portfolio-jobs'], valid: false };
      return {
        feeds: ['portfolio-jobs'],
        valid: true,
        skipped: parsed.dropped,
        run: runKey(parsed.post.run_at),
        part: parsed.post.part ?? 1,
      };
    },
    posters: e.dealRelayPosterIds,
    skipSubtypes: true,
  });
  // The twice-weekly students scan, numbered parts and all, the same way.
  rules.set(STUDENTS_MARKER, {
    read: (text) => {
      const parsed = parseStudentsMessage(text);
      if (!parsed) return { feeds: ['students'], valid: false };
      return {
        feeds: ['students'],
        valid: true,
        skipped: parsed.dropped,
        run: runKey(parsed.post.run_at),
        part: parsed.post.part ?? 1,
      };
    },
    posters: e.dealRelayPosterIds,
    skipSubtypes: true,
  });
  rules.set(TASK_CLOSER_RUN_MARKER, {
    read: (text) => ({
      feeds: ['task-closer'],
      valid: parseTaskCloseMessage(text)?.kind === 'run',
    }),
    posters: e.taskRelayPosterIds,
    skipSubtypes: true,
  });
  return rules;
}

/** The rules for the briefing and Ask relay channel. */
export function askRelayRules(e: Pick<AppEnv, 'taskRelayPosterIds'>) {
  const rules = new Map<string, RelayRule>();
  rules.set('BRIEFING_PAYLOAD_V1', {
    read: (text) => {
      const payload = parseBriefingRelayMessage(text);
      if (payload) {
        return { feeds: [payload.kind === 'afternoon' ? 'recap' : 'overview'], valid: true };
      }
      // An unreadable briefing is the routine its kind names, when that much
      // can be made out; otherwise it could be either's.
      const kind = /"kind"\s*:\s*"(morning|afternoon|dossier)"/.exec(text)?.[1];
      if (!kind) return { feeds: ['overview', 'recap'], valid: false };
      return { feeds: [kind === 'afternoon' ? 'recap' : 'overview'], valid: false };
    },
    posters: [],
    skipSubtypes: false,
  });
  rules.set('TASK_ADD_V1', {
    read: (text) => ({ feeds: ['task-suggest'], valid: parseTaskRelayMessage(text) !== null }),
    posters: e.taskRelayPosterIds,
    skipSubtypes: true,
  });
  rules.set('PORTFOLIO_ADD_V1', {
    read: (text) => ({
      feeds: ['portfolio-adds'],
      valid: parsePortfolioRelayMessage(text) !== null,
    }),
    posters: [],
    skipSubtypes: false,
  });
  rules.set('ASK_ANSWER_V1', {
    read: (text) => ({ feeds: ['ask-answers'], valid: parseAnswerMessage(text) !== null }),
    posters: [],
    skipSubtypes: false,
  });
  return rules;
}

const RELAY_REASON: Record<Exclude<RelayReadState, 'ok'>, string> = {
  bot_not_in_channel: 'The Copilot Slack app is not a member of the relay channel.',
  missing_scope: 'The Copilot Slack app is missing a Slack scope.',
  bad_token: 'Slack refused the read token.',
  rate_limited: 'Slack is rate-limiting reads; it is checked again shortly.',
  error: 'Slack could not be read just now.',
};

async function readRelay(
  channelId: string,
  rules: ReadonlyMap<string, RelayRule>,
  e: AppEnv,
  now: Date,
  fetchImpl: typeof fetch,
): Promise<RelayRead> {
  if (!e.askRelaySlackToken) {
    return { state: 'off', reason: 'No Slack read token (ASK_RELAY_SLACK_TOKEN).' };
  }
  const window = await readRelayWindow({
    token: e.askRelaySlackToken,
    channelId,
    windowDays: RELAY_WINDOW_DAYS,
    maxPages: RELAY_MAX_PAGES,
    pageSize: RELAY_PAGE_SIZE,
    now,
    fetchImpl,
  });
  if (window.state !== 'ok') {
    if (window.fault !== undefined) log.warn('Feed watchdog could not read a relay channel');
    return { state: 'unknown', reason: RELAY_REASON[window.state] };
  }
  return { state: 'ok', seen: collectSightings(window.messages, rules) };
}

/* ---------------------------------------------------------- other inputs */

async function readReports(now: Date): Promise<ReportRead[]> {
  const feed = getUpdatesFeed(now);
  if (!feed) {
    return UPDATE_SOURCES.map((source) => ({
      source,
      state: 'off',
      lastPostAt: null,
      reason: 'Closed until sign-in is limited to your own domain (AUTH_ALLOWED_EMAIL_DOMAINS).',
    }));
  }
  try {
    const snapshot = await readUpdates(feed, { now });
    return snapshot.sources.map((view) => {
      const readable = view.access.state === 'ok' || view.stale !== null;
      return {
        source: view.source,
        state: readable ? 'ok' : view.access.state === 'no_token' ? 'off' : 'unknown',
        lastPostAt: view.lastPostAt,
        reason: readable
          ? null
          : view.access.state === 'no_token'
            ? 'No Slack read token (ASK_RELAY_SLACK_TOKEN).'
            : 'The channel could not be read just now; Reports says why.',
      };
    });
  } catch {
    return feed.sources.map((source) => ({
      source,
      state: 'unknown',
      lastPostAt: null,
      reason: 'The channel could not be read just now.',
    }));
  }
}

/** When each job last reached the app, from its heartbeat row. */
export async function readJobHeartbeats(
  store: DataStore,
  organizationId: string,
): Promise<Partial<Record<JobId, string>>> {
  const rows = (await store.list(
    'audit_events',
    organizationId,
    { eq: { action: HEARTBEAT_ACTION } },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 10 },
  )) as AuditEvent[];
  const out: Partial<Record<JobId, string>> = {};
  for (const row of rows) {
    const job = row.entity_id;
    if ((job === 'daily-job' || job === 'push-sender') && !out[job]) out[job] = row.created_at;
  }
  return out;
}

/**
 * When a meeting note last reached the app: the newest write, a new note or a
 * redelivered one, by the webhook or its catch-up. Null when none has.
 */
export async function readNotesArrival(
  store: DataStore,
  organizationId: string,
): Promise<string | null> {
  // Granola's deliveries only: a Copilot Notes write (D-076) is not this feed.
  const rows = (await store.list(
    'meeting_notes',
    organizationId,
    { eq: { provider: 'granola' } },
    { orderBy: [{ field: 'updated_at', direction: 'desc' }], limit: 1 },
  )) as MeetingNote[];
  return rows[0]?.updated_at ?? null;
}

/**
 * When the oldest Ask question still waiting for the bridge was asked: the
 * oldest pending answer from the last day that is newer than the newest
 * answered one. A question left behind by one that was answered after it is
 * a one-off, not a stopped answerer. Null when nothing waits.
 */
export async function readAskWaiting(
  store: DataStore,
  organizationId: string,
  now: Date,
): Promise<{ waitingSince: string | null }> {
  const since = new Date(now.getTime() - ASK_WAIT_LOOKBACK_MS).toISOString();
  const [pending, answered] = await Promise.all([
    store.list(
      'chat_messages',
      organizationId,
      { eq: { role: 'assistant', status: 'pending' }, gte: { created_at: since } },
      { orderBy: [{ field: 'created_at', direction: 'asc' }], limit: 20 },
    ) as Promise<ChatMessage[]>,
    store.list(
      'chat_messages',
      organizationId,
      { eq: { role: 'assistant', status: 'answered', model: ASK_BRIDGE_MODEL } },
      { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
    ) as Promise<ChatMessage[]>,
  ]);
  const after = answered[0] ? Date.parse(answered[0].created_at) : Number.NEGATIVE_INFINITY;
  const waiting = pending.find((m) => Date.parse(m.created_at) > after);
  return { waitingSince: waiting?.created_at ?? null };
}

async function settled<T>(read: () => Promise<T>, what: string): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    log.warn('Feed watchdog read failed', {
      what,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Read every input, each on its own: one that fails is "can't check". In demo
 * mode the inputs are the demo's own, fictional and relative to `now`.
 */
export async function readFeedInputs(
  store: DataStore,
  organizationId: string,
  options: { now?: Date; fetchImpl?: typeof fetch; e?: AppEnv } = {},
): Promise<FeedInputs> {
  const { now = new Date(), fetchImpl = fetch, e = env() } = options;
  if (e.demoMode) return demoFeedInputs(now);
  const unknown = (reason: string): RelayRead => ({ state: 'unknown', reason });
  const [dealRelay, askRelay, reports, jobs, affinity, notesAt, waiting] = await Promise.all([
    settled(async () => {
      if (e.askRelaySlackToken && !(await isRelayOrganization(store, organizationId))) {
        return {
          state: 'off',
          reason: 'Read only on a deployment with one workspace.',
        } satisfies RelayRead;
      }
      return readRelay(e.dealRelayChannelId, dealRelayRules(e), e, now, fetchImpl);
    }, 'deal relay'),
    settled(() => readRelay(e.askRelayChannelId, askRelayRules(e), e, now, fetchImpl), 'ask relay'),
    settled(() => readReports(now), 'reports'),
    settled(() => readJobHeartbeats(store, organizationId), 'heartbeats'),
    settled(async () => {
      const status = await getAffinitySyncStatus(store, organizationId, now);
      return { configured: status.configured, lastRunAt: status.lastRun?.finishedAt ?? null };
    }, 'affinity sync'),
    // Wrapped so a read that worked but found nothing is not the null of a failed one.
    settled(async () => ({ at: await readNotesArrival(store, organizationId) }), 'meeting notes'),
    settled(() => readAskWaiting(store, organizationId, now), 'ask questions'),
  ]);
  return {
    readAt: now.toISOString(),
    dealRelay: dealRelay ?? unknown('The relay channel could not be read just now.'),
    askRelay: askRelay ?? unknown('The relay channel could not be read just now.'),
    reports: reports ?? [],
    jobs,
    affinity,
    notes: notesAt
      ? {
          configured:
            Boolean(e.granolaSigningSecret && e.granolaApiKey) || Boolean(e.granolaWebhookSecret),
          lastAt: notesAt.at,
        }
      : null,
    ask: waiting
      ? { configured: Boolean(e.askRelaySlackToken), waitingSince: waiting.waitingSince }
      : null,
  };
}

/* --------------------------------------------------------------- caching */

const state = processWide('feed-health', () => ({
  inputs: new Map<string, { at: number; inputs: FeedInputs }>(),
  inFlight: new Map<string, Promise<FeedInputs>>(),
  watchers: new Map<string, { at: number; users: Set<string> }>(),
  heartbeats: new Map<string, number>(),
}));

/** Test hook. */
export function resetFeedHealthState(): void {
  state.inputs.clear();
  state.inFlight.clear();
  state.watchers.clear();
  state.heartbeats.clear();
}

/**
 * The feeds' report for this organization, from a read no older than
 * `maxAgeMs` (shared with concurrent callers). Never throws.
 */
export async function readFeedHealth(
  store: DataStore,
  organizationId: string,
  options: { now?: Date; timeZone: string; maxAgeMs?: number; fetchImpl?: typeof fetch },
): Promise<FeedReport> {
  const { now = new Date(), timeZone, maxAgeMs = PAGE_MAX_AGE_MS, fetchImpl } = options;
  const cached = state.inputs.get(organizationId);
  let inputs: FeedInputs;
  if (cached && Math.abs(now.getTime() - cached.at) <= maxAgeMs) {
    inputs = cached.inputs;
  } else {
    let pending = state.inFlight.get(organizationId);
    if (!pending) {
      pending = readFeedInputs(store, organizationId, { now, fetchImpl }).finally(() => {
        state.inFlight.delete(organizationId);
      });
      state.inFlight.set(organizationId, pending);
    }
    inputs = await pending;
    state.inputs.set(organizationId, { at: now.getTime(), inputs });
  }
  return buildFeedReport(inputs, now, timeZone);
}

/* ------------------------------------------------------------ heartbeats */

/**
 * Note that a job reached the app: one `feeds.heartbeat` row per job,
 * replaced each time. Throttled per process (`JOB_HEARTBEAT_EVERY_MS`), so a
 * job that calls every minute costs a write every ten. Never throws: a job
 * must not fail because its heartbeat could not be written.
 */
export async function recordJobHeartbeat(
  store: DataStore,
  organizationId: string,
  job: JobId,
  now: Date = new Date(),
): Promise<void> {
  const key = `${organizationId}:${job}`;
  const last = state.heartbeats.get(key);
  if (last !== undefined && now.getTime() - last < JOB_HEARTBEAT_EVERY_MS[job]) return;
  state.heartbeats.set(key, now.getTime());
  try {
    await store.removeWhere('audit_events', organizationId, {
      eq: { action: HEARTBEAT_ACTION, entity_id: job },
    });
    // Written directly, like the alert ledgers: it is state, not an audit entry.
    const row: AuditEvent = {
      id: newId(),
      organization_id: organizationId,
      user_id: null,
      action: HEARTBEAT_ACTION,
      entity_type: 'feeds',
      entity_id: job,
      metadata: {},
      ip_hash: null,
      created_at: now.toISOString(),
    };
    await store.insert('audit_events', row);
  } catch (error) {
    state.heartbeats.delete(key);
    log.warn('Feed heartbeat could not be written', {
      job,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The same for every organization, for a job that serves them all at once. */
export async function recordJobHeartbeatForAll(
  store: DataStore,
  job: JobId,
  now: Date = new Date(),
): Promise<void> {
  const key = `*:${job}`;
  const last = state.heartbeats.get(key);
  if (last !== undefined && now.getTime() - last < JOB_HEARTBEAT_EVERY_MS[job]) return;
  state.heartbeats.set(key, now.getTime());
  try {
    const organizations = (await store.list('organizations', '', {})) as Organization[];
    for (const org of organizations) await recordJobHeartbeat(store, org.id, job, now);
  } catch (error) {
    state.heartbeats.delete(key);
    log.warn('Feed heartbeats could not be written', {
      job,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/* ---------------------------------------------------------- feed notices */

/** Whether this person has feed notices on; null when it cannot be read. */
export async function feedNoticesOn(
  store: DataStore,
  organizationId: string,
  userId: string,
): Promise<boolean | null> {
  try {
    const count = await store.count('audit_events', organizationId, {
      eq: { action: NOTICE_ACTION, user_id: userId },
    });
    return count > 0;
  } catch {
    return null;
  }
}

/**
 * Turn feed notices on or off for the signed-in person, for themselves only:
 * nobody can turn them on for someone else. On is one `feeds.notify` row
 * (entity_id = the person); off removes it. Audited either way.
 */
export async function setFeedNotices(
  store: DataStore,
  auth: Pick<AuthContext, 'organizationId' | 'userId'>,
  on: boolean,
  now: Date = new Date(),
): Promise<void> {
  const { organizationId, userId } = auth;
  await store.removeWhere('audit_events', organizationId, {
    eq: { action: NOTICE_ACTION, user_id: userId },
  });
  if (on) {
    const row: AuditEvent = {
      id: newId(),
      organization_id: organizationId,
      user_id: userId,
      action: NOTICE_ACTION,
      entity_type: 'feeds',
      entity_id: userId,
      metadata: {},
      ip_hash: null,
      created_at: now.toISOString(),
    };
    await store.insert('audit_events', row);
  }
  state.watchers.delete(organizationId);
  await recordAudit(store, {
    organizationId,
    userId,
    action: on ? 'feeds.notices_on' : 'feeds.notices_off',
    entityType: 'feeds',
    entityId: userId,
  });
}

/** Who in this organization has feed notices on (cached for five minutes). */
export async function feedNoticeWatchers(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<Set<string>> {
  const hit = state.watchers.get(organizationId);
  if (hit && Math.abs(now.getTime() - hit.at) < WATCHERS_TTL_MS) return hit.users;
  const rows = (await store.list(
    'audit_events',
    organizationId,
    { eq: { action: NOTICE_ACTION } },
    { limit: 50 },
  )) as AuditEvent[];
  const users = new Set(rows.map((r) => r.user_id).filter((u): u is string => Boolean(u)));
  state.watchers.set(organizationId, { at: now.getTime(), users });
  return users;
}

/** A feed's notice key for the local day: one notice per feed per day per computer. */
export function feedNoticeKey(id: FeedId, now: Date, timeZone: string): string {
  return `${NOTICE_KEY_PREFIX}${id}:${localClock(now, timeZone).dateKey}`;
}

/** Whether feed notices may go out at `now` (8am to 8pm local). */
export function inNoticeHours(now: Date, timeZone: string): boolean {
  const { hour } = localClock(now, timeZone);
  return hour >= NOTICE_FROM_HOUR && hour < NOTICE_UNTIL_HOUR;
}

function clip(text: string): string {
  return text.length <= NOTICE_BODY_MAX ? text : `${text.slice(0, NOTICE_BODY_MAX - 1).trimEnd()}…`;
}

function ago(iso: string, now: Date): string {
  const hours = Math.max(0, (now.getTime() - Date.parse(iso)) / 3_600_000);
  if (hours < 48) return `${Math.max(1, Math.round(hours))} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * One notification for the feeds that look stopped and have not been noticed
 * on this computer today: "A feed looks stopped" (or "3 feeds look stopped"),
 * each with when it was last seen, and a click to Diagnostics > Feeds. Null
 * when there is none, or outside 8am to 8pm. Pure.
 */
export function feedNotice(
  report: FeedReport,
  sent: ReadonlySet<string>,
  now: Date,
  timeZone: string,
): { keys: string[]; title: string; body: string; url: string } | null {
  if (!inNoticeHours(now, timeZone)) return null;
  const due = report.rows
    .filter((row) => row.status === 'stopped')
    .map((row) => ({ row, key: feedNoticeKey(row.id, now, timeZone) }))
    .filter(({ key }) => !sent.has(key));
  if (!due.length) return null;
  const line = ({ row }: (typeof due)[number]) =>
    row.waitingSince
      ? `${row.def.name}: a question has waited since ${ago(row.waitingSince, now)}`
      : row.lastSeen
        ? `${row.def.name}: last seen ${ago(row.lastSeen, now)}`
        : row.def.name;
  const [first, ...rest] = due;
  return {
    keys: due.map((d) => d.key),
    title: due.length === 1 ? 'A feed looks stopped' : `${due.length} feeds look stopped`,
    body: clip(rest.length ? `${line(first!)} (+${rest.length} more)` : line(first!)),
    url: '/diagnostics?tab=feeds',
  };
}

/**
 * The feed notice for one computer, if its owner has feed notices on and a
 * feed looks stopped that this computer has not shown today. Never throws.
 */
export async function feedNoticeFor(
  store: DataStore,
  caller: { organizationId: string; userId: string },
  sent: ReadonlySet<string>,
  now: Date,
  timeZone: string,
): Promise<{ keys: string[]; title: string; body: string; url: string } | null> {
  if (!inNoticeHours(now, timeZone)) return null;
  try {
    const watchers = await feedNoticeWatchers(store, caller.organizationId, now);
    if (!watchers.has(caller.userId)) return null;
    const report = await readFeedHealth(store, caller.organizationId, {
      now,
      timeZone,
      maxAgeMs: NOTICE_MAX_AGE_MS,
    });
    return feedNotice(report, sent, now, timeZone);
  } catch (error) {
    log.warn('Feed notice could not be worked out', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
