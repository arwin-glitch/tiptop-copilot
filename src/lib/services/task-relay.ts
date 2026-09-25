import { env, type TaskCloserRuntime } from '@/lib/config/env';
import { listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { log } from '@/lib/security/redact';
import { readRelayWindow, type RelayReadState } from '@/lib/slack/relay-history';
import { isAwake } from '@/lib/tasks/tasks-view';
import type { AuditEvent, Task } from '@/lib/types/domain';
import { sha256 } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { formatDateTime } from '@/lib/util/time';
import { scrubErrorMessage } from './deal-ingest';
import { isRelayOrganization } from './deal-relay';
import {
  applyTaskCloses,
  collectTaskCloses,
  type TaskCloseCounts,
  type TaskCloserRun,
} from './task-close';
import { ingestTasksFromSlack } from './task-ingest';
import { REPLY_CHECK_MAILBOX, runReplyCheck, type ReplyCheckOutcome } from './task-reply-check';
import { maybePostSnapshot, type SnapshotStatus } from './task-snapshot';

/**
 * Everything the Tasks page pulls, in order: new suggested tasks from the
 * relay channel, closes from #deal-relay, the app's own 4pm "Reply to" check,
 * and the open-task snapshot. Runs on viewing /tasks, from an open tab's
 * version watcher, after /today renders, and from the daily job. Concurrent
 * callers share one run; each step runs at most once a minute (the daily job
 * forces them). Never throws.
 */

export type TaskRelayReadState = 'pending' | 'not_configured' | 'other_workspace' | RelayReadState;

export interface TaskRelayStatus {
  /** When this status was produced; null until the first pull finishes. */
  pulledAt: string | null;
  /** How the last read of #deal-relay for closes went. */
  relay: TaskRelayReadState;
  /** The scope Slack says is missing, for `missing_scope`. */
  needed: string | null;
  /** Tasks added by this pull, or null when that step did not run or could not read. */
  added: number | null;
  /** This pull's closes, or null when that step did not run or could not read. */
  closes: TaskCloseCounts | null;
  /** The newest run record in the window, carried across pulls that could not read. */
  lastRun: { run: TaskCloserRun; ts: string } | null;
  /** This pull's reply check, or null when that step did not run. */
  reply: ReplyCheckOutcome | null;
  /** The last reply check that did something or could not (not "not yet" or "done today"). */
  lastReplyCheck: ReplyCheckOutcome | null;
  snapshot: SnapshotStatus;
}

const STEP_INTERVAL_MS = 60_000;
/** The suggester posts at most twice a day and the closer once; two weeks is ample. */
const CLOSE_WINDOW_DAYS = 14;
const CLOSE_MAX_PAGES = 5;
const CLOSE_PAGE_SIZE = 200;

type Step = 'adds' | 'closes' | 'reply' | 'snapshot';

const { statuses, nextStepAt, inFlight } = processWide('task-relay', () => ({
  statuses: new Map<string, TaskRelayStatus>(),
  nextStepAt: new Map<string, number>(),
  inFlight: new Map<string, Promise<TaskRelayStatus>>(),
}));

function emptyStatus(): TaskRelayStatus {
  return {
    pulledAt: null,
    relay: 'pending',
    needed: null,
    added: null,
    closes: null,
    lastRun: null,
    reply: null,
    lastReplyCheck: null,
    snapshot: { state: 'idle', lastPostedAt: null, retryAt: null },
  };
}

/** The last pull's outcome for this organization. */
export function getTaskRelayStatus(organizationId: string): TaskRelayStatus {
  return statuses.get(organizationId) ?? emptyStatus();
}

export async function pullTaskRelays(
  store: DataStore,
  organizationId: string,
  opts: { fetchImpl?: typeof fetch; now?: Date; force?: boolean } = {},
): Promise<TaskRelayStatus> {
  const running = inFlight.get(organizationId);
  if (running) return running;
  const key = (step: Step) => `${organizationId}:${step}`;
  const due = (step: Step) => opts.force || Date.now() >= (nextStepAt.get(key(step)) ?? 0);
  const steps: Step[] = ['adds', 'closes', 'reply', 'snapshot'];
  if (!steps.some(due)) return getTaskRelayStatus(organizationId);

  const pull = (async (): Promise<TaskRelayStatus> => {
    // Registered as in flight before any work, however quickly it finishes.
    await Promise.resolve();
    const e = env();
    const now = opts.now ?? new Date();
    const fetchImpl = opts.fetchImpl ?? fetch;
    const previous = getTaskRelayStatus(organizationId);
    const status: TaskRelayStatus = { ...previous, added: null, closes: null, reply: null };
    const waitFor = (step: Step, ms: number) => nextStepAt.set(key(step), Date.now() + ms);
    let relayOrg: boolean | null = null;
    const isRelayOrg = async () => (relayOrg ??= await isRelayOrganization(store, organizationId));

    try {
      if (due('adds')) {
        waitFor('adds', STEP_INTERVAL_MS);
        try {
          const added = await ingestTasksFromSlack(store, organizationId, fetchImpl);
          status.added = added ? added.created.length : null;
        } catch (error) {
          log.warn('Task additions pull failed', { reason: scrubErrorMessage(error) });
        }
      }

      if (due('closes')) {
        if (!e.askRelaySlackToken) {
          waitFor('closes', STEP_INTERVAL_MS);
          status.relay = 'not_configured';
        } else if (!(await isRelayOrg())) {
          waitFor('closes', STEP_INTERVAL_MS);
          status.relay = 'other_workspace';
        } else {
          const window = await readRelayWindow({
            token: e.askRelaySlackToken,
            channelId: e.dealRelayChannelId,
            windowDays: CLOSE_WINDOW_DAYS,
            maxPages: CLOSE_MAX_PAGES,
            pageSize: CLOSE_PAGE_SIZE,
            now,
            fetchImpl,
          });
          if (window.fault !== undefined) {
            log.warn('Reading #deal-relay for task closes failed', {
              reason: scrubErrorMessage(window.fault),
            });
          }
          waitFor('closes', window.retryIn);
          status.relay = window.state;
          status.needed = window.needed;
          if (window.state === 'ok') {
            const collected = collectTaskCloses(window.messages, e.taskRelayPosterIds);
            status.lastRun = collected.lastRun;
            try {
              status.closes = await applyTaskCloses(store, organizationId, collected.closes, {
                now,
                rejected: collected.rejected.messages + collected.rejected.closes,
              });
            } catch (error) {
              // Read fine, could not save: try again in seconds, not a minute.
              waitFor('closes', 10_000);
              log.warn('Applying task closes failed', { reason: scrubErrorMessage(error) });
            }
          }
        }
      }

      if (due('reply')) {
        waitFor('reply', STEP_INTERVAL_MS);
        try {
          status.reply = await runReplyCheck(store, organizationId, {
            now,
            enabled: e.taskReplyAutoclose,
          });
          if (status.reply.state !== 'not_yet' && status.reply.state !== 'done_today') {
            status.lastReplyCheck = status.reply;
          }
        } catch (error) {
          log.warn('Reply check failed', { reason: scrubErrorMessage(error) });
        }
      }

      if (due('snapshot')) {
        waitFor('snapshot', STEP_INTERVAL_MS);
        const token = e.askRelaySlackToken;
        if (e.taskSnapshotFeed === 'off') {
          status.snapshot = { state: 'off', lastPostedAt: null, retryAt: null };
        } else if (!token) {
          status.snapshot = { state: 'not_configured', lastPostedAt: null, retryAt: null };
        } else if (!(await isRelayOrg())) {
          status.snapshot = { state: 'other_workspace', lastPostedAt: null, retryAt: null };
        } else {
          status.snapshot = await maybePostSnapshot(store, organizationId, {
            token,
            channelId: e.dealRelayChannelId,
            fetchImpl,
            now,
          });
        }
      }
    } catch (error) {
      log.warn('Task relay pull failed', { reason: scrubErrorMessage(error) });
    } finally {
      status.pulledAt = new Date().toISOString();
      statuses.set(organizationId, status);
      inFlight.delete(organizationId);
    }
    return status;
  })();
  inFlight.set(organizationId, pull);
  return pull;
}

/** Counts only: the daily job's response is printed into the public Actions log. */
export function formatTaskCronStatus(status: TaskRelayStatus): string {
  const replied = status.reply?.state === 'ran' ? status.reply.closed : 0;
  if (status.added === null && status.relay !== 'ok') {
    return `skipped: ${status.relay}${replied > 0 ? `; ${replied} closed by the reply check` : ''}`;
  }
  const closed = (status.closes?.closed ?? 0) + replied;
  const rejected = status.closes?.rejected ?? 0;
  return `ok: ${status.added ?? 0} added, ${closed} closed, ${rejected} rejected`;
}

function iso(value: string | undefined): string {
  if (!value) return '';
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/**
 * A fingerprint of what /tasks shows, for the open-tab watcher: task count,
 * the newest change, the newest auto-close, how many snoozes have woken and
 * the newest run record. Hashed, so it carries no task content.
 */
export async function readTasksVersion(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<string> {
  const [count, newest, autos, snoozed] = await Promise.all([
    store.count('tasks', organizationId),
    store.list(
      'tasks',
      organizationId,
      {},
      { orderBy: [{ field: 'updated_at', direction: 'desc' }], limit: 1 },
    ) as Promise<Task[]>,
    store.list(
      'audit_events',
      organizationId,
      { eq: { action: 'task.auto_completed' } },
      { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
    ) as Promise<AuditEvent[]>,
    listAllPages(store, 'tasks', organizationId, { eq: { status: 'snoozed' } }) as Promise<Task[]>,
  ]);
  const awake = snoozed.filter((task) => isAwake(task, now)).length;
  return sha256(
    [
      count,
      iso(newest[0]?.updated_at),
      autos[0]?.id ?? '',
      awake,
      getTaskRelayStatus(organizationId).lastRun?.ts ?? '',
    ].join('|'),
  ).slice(0, 32);
}

const RELAY_TEXT: Record<TaskRelayReadState, string> = {
  pending: 'not read yet on this instance',
  not_configured: 'no Slack token',
  other_workspace: 'not read: this deployment has more than one organization',
  ok: 'readable',
  bot_not_in_channel: 'the Slack app is not a member of #deal-relay',
  missing_scope: 'the Slack app is missing a scope',
  bad_token: 'Slack refuses the token',
  rate_limited: 'rate limited by Slack; retrying',
  error: 'could not be read; retrying',
};

const SNAPSHOT_TEXT: Record<SnapshotStatus['state'], string> = {
  off: 'off (TASK_SNAPSHOT_FEED=off)',
  not_configured: 'off: no Slack token',
  other_workspace: 'off: more than one organization',
  idle: 'waiting for its first post',
  posted: 'posting',
  needs_chat_write: 'needs chat:write (tried again every 6 hours)',
  bot_not_in_channel: 'bot not in channel',
  bad_token: 'Slack refuses the token',
  rate_limited: 'rate limited by Slack; retrying',
  error: 'failed; retrying in 15 minutes',
};

/** What Diagnostics says about the task-closer: plain text, no task content. */
export function taskCloserRuntime(organizationId: string, timeZone: string): TaskCloserRuntime {
  const status = getTaskRelayStatus(organizationId);
  const e = env();
  const run = status.lastRun;
  const runAt = run
    ? run.run.run_at && !Number.isNaN(Date.parse(run.run.run_at))
      ? run.run.run_at
      : run.ts
    : null;
  const lastPosted = status.snapshot.lastPostedAt;

  let reply: string;
  const check = status.lastReplyCheck;
  if (!e.taskReplyAutoclose) reply = 'off (TASK_REPLY_AUTOCLOSE=off)';
  else if (check?.state === 'wrong_mailbox') {
    reply = `skipped: the connected Google account is not ${REPLY_CHECK_MAILBOX}`;
  } else if (check?.state === 'no_mailbox') reply = 'skipped: no Google account is connected';
  else if (check?.state === 'ran') {
    reply = `ran for ${check.localDate}: ${check.checked} checked, ${check.closed} closed`;
  } else reply = 'on; runs once a day after 4 PM Central';

  return {
    relay:
      status.relay === 'missing_scope' && status.needed
        ? `the Slack app is missing ${status.needed}`
        : RELAY_TEXT[status.relay],
    lastRun: run
      ? `${formatDateTime(runAt!, timeZone)}${run.run.local_date ? ` (Central ${run.run.local_date})` : ''}: ${run.run.checked} checked, ${run.run.closed} closed, from the ${run.run.list ?? 'suggested'} list`
      : null,
    snapshot:
      status.snapshot.state === 'posted' && lastPosted
        ? `posting (last ${formatDateTime(lastPosted, timeZone)})`
        : SNAPSHOT_TEXT[status.snapshot.state],
    reply,
  };
}

/** Test seam: forget throttles, in-flight pulls and statuses. */
export function resetTaskRelayState(): void {
  statuses.clear();
  nextStepAt.clear();
  inFlight.clear();
}
