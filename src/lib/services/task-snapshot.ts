import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import { mentionsNickOnly } from '@/lib/tasks/nick-only';
import { isAwake } from '@/lib/tasks/tasks-view';
import type { AuditEvent, EmailMessage, EmailThread, Task } from '@/lib/types/domain';
import { sha256 } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { localClock } from '@/lib/util/time';
import { CENTRAL_TIMEZONE, latestHumanTaskTouches, snapshotTitle } from './task-close';

/**
 * The open-task snapshot (`TASK_OPEN_V1`) the app posts to #deal-relay so the
 * task-closer can check tasks a person created, by id. It needs the Slack
 * app's `chat:write` scope, which it does not have yet: until then every
 * attempt answers `missing_scope`, the app waits six hours before trying
 * again, and Diagnostics says "needs chat:write". Adding the scope switches
 * it on with no other change. `TASK_SNAPSHOT_FEED=off` stops it entirely.
 * Tasks involving a Nick-only counterparty are left out.
 */

export const TASK_OPEN_MARKER = 'TASK_OPEN_V1';

const PART_MAX_CHARS = 3_500;
const MAX_PARTS = 10;
const SUBJECT_MAX = 120;
/**
 * The routine reads the list once, at 4pm Central, and every post is several
 * messages in a channel read by message count, so a changed list is posted
 * only in the two hours before the check, at most every 30 minutes.
 */
const CHANGE_WINDOW_START_HOUR = 14;
const CHANGE_WINDOW_END_HOUR = 16;
const MIN_GAP_MS = 30 * 60_000;
/** Any list is re-posted this often, so the routine always has one under 36 hours old. */
const MAX_AGE_MS = 20 * 3_600_000;
/** After a refusal that needs a person (scope, invite, token). */
const REFUSAL_RETRY_MS = 6 * 3_600_000;
const FAULT_RETRY_MS = 15 * 60_000;

export type SnapshotState =
  | 'off'
  | 'not_configured'
  | 'other_workspace'
  | 'idle'
  | 'posted'
  | 'needs_chat_write'
  | 'bot_not_in_channel'
  | 'bad_token'
  | 'rate_limited'
  | 'error';

export interface SnapshotStatus {
  state: SnapshotState;
  /** The newest snapshot posted, from its audit row. */
  lastPostedAt: string | null;
  /** When the next attempt may happen after a failure. */
  retryAt: string | null;
}

export interface SnapshotTask {
  id: string;
  title: string;
  status: 'open' | 'snoozed';
  src: 'human' | 'suggested';
  created_at: string;
  touched_at?: string;
  due_at?: string;
  thread_id?: string;
  from?: string;
  subject?: string;
}

/** Slack's three entities, plus no backtick, which would end the code span early. */
export function escapeForSlack(text: string): string {
  return text
    .replaceAll('`', "'")
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** A fingerprint of what the routine would need to re-read: ids, states, wake times, touches. */
export function snapshotHash(
  tasks: readonly Pick<Task, 'id' | 'status' | 'snoozed_until'>[],
  touches: ReadonlyMap<string, string>,
): string {
  const lines = tasks
    .map((t) => `${t.id}|${t.status}|${t.snoozed_until ?? ''}|${touches.get(t.id) ?? ''}`)
    .sort();
  return sha256(lines.join('\n'));
}

function partText(envelope: Record<string, unknown>): string {
  return `${TASK_OPEN_MARKER}\n\`${escapeForSlack(JSON.stringify(envelope))}\``;
}

/**
 * Newest-created first, cut into messages of at most 3,500 characters as
 * Slack stores them, and at most ten; anything left over is dropped and
 * every part says `truncated`.
 */
export function snapshotParts(
  tasks: readonly SnapshotTask[],
  meta: { batch: string; asOf: string },
): { texts: string[]; truncated: boolean } {
  const ordered = [...tasks].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id),
  );
  const envelope = (part: number, parts: number, list: SnapshotTask[], truncated: boolean) => ({
    v: 1,
    source: 'tiptop-copilot',
    batch: meta.batch,
    part,
    parts,
    as_of: meta.asOf,
    ...(truncated ? { truncated: true } : {}),
    tasks: list,
  });
  // Measured with two-digit part numbers and the flag, so the final numbers never overflow.
  const fits = (list: SnapshotTask[]) =>
    partText(envelope(MAX_PARTS, MAX_PARTS, list, true)).length <= PART_MAX_CHARS;

  const groups: SnapshotTask[][] = [[]];
  let truncated = false;
  for (const task of ordered) {
    const current = groups[groups.length - 1]!;
    if (fits([...current, task])) {
      current.push(task);
      continue;
    }
    if (groups.length === MAX_PARTS) {
      truncated = true;
      break;
    }
    groups.push([task]);
  }
  const parts = groups.length;
  return {
    texts: groups.map((list, i) => partText(envelope(i + 1, parts, list, truncated))),
    truncated,
  };
}

/** Open and snoozed tasks (sleeping ones too), with what the routine needs to find them. */
async function buildSnapshot(
  store: DataStore,
  organizationId: string,
): Promise<{ tasks: Task[]; touches: Map<string, string>; hash: string }> {
  const tasks = (await listAllPages(store, 'tasks', organizationId, {
    in: { status: ['open', 'snoozed'] },
  })) as Task[];
  const touches = await latestHumanTaskTouches(store, organizationId, tasks);
  return { tasks, touches, hash: snapshotHash(tasks, touches) };
}

/** What the snapshot says about each task, leaving out any that involve a Nick-only counterparty. */
async function describe(
  store: DataStore,
  organizationId: string,
  tasks: readonly Task[],
  touches: ReadonlyMap<string, string>,
  now: Date,
): Promise<SnapshotTask[]> {
  const messageIds = tasks.map((t) => t.email_message_id).filter((id): id is string => !!id);
  const messages = new Map<string, EmailMessage>();
  for (const ids of chunk(messageIds)) {
    for (const row of (await store.list('email_messages', organizationId, {
      in: { id: ids },
    })) as EmailMessage[]) {
      messages.set(row.id, row);
    }
  }
  const threads = new Map<string, EmailThread>();
  for (const ids of chunk([...new Set([...messages.values()].map((m) => m.thread_id))])) {
    for (const row of (await store.list('email_threads', organizationId, {
      in: { id: ids },
    })) as EmailThread[]) {
      threads.set(row.id, row);
    }
  }

  const described: SnapshotTask[] = [];
  for (const task of tasks) {
    const message = task.email_message_id ? messages.get(task.email_message_id) : undefined;
    const thread = message ? threads.get(message.thread_id) : undefined;
    const nickOnly = mentionsNickOnly(
      task.title,
      task.detail,
      message?.from_address,
      message?.subject,
      ...(message?.to_addresses ?? []),
      ...(message?.cc_addresses ?? []),
    );
    if (nickOnly) continue;
    const touched = touches.get(task.id);
    described.push({
      id: task.id,
      title: snapshotTitle(task.title),
      status: task.status === 'snoozed' && !isAwake(task, now) ? 'snoozed' : 'open',
      src: task.source,
      created_at: task.created_at,
      ...(touched ? { touched_at: touched } : {}),
      ...(task.due_at ? { due_at: task.due_at } : {}),
      ...(thread?.provider_thread_id ? { thread_id: thread.provider_thread_id } : {}),
      ...(message?.from_address ? { from: message.from_address } : {}),
      ...(message?.subject ? { subject: clip(message.subject, SUBJECT_MAX) } : {}),
    });
  }
  return described;
}

const SLACK_REFUSALS: Record<string, SnapshotState> = {
  missing_scope: 'needs_chat_write',
  not_in_channel: 'bot_not_in_channel',
  channel_not_found: 'bot_not_in_channel',
  invalid_auth: 'bad_token',
  not_authed: 'bad_token',
  token_revoked: 'bad_token',
  account_inactive: 'bad_token',
  ratelimited: 'rate_limited',
};

async function postMessage(
  fetchImpl: typeof fetch,
  token: string,
  channel: string,
  text: string,
): Promise<{ ok: true } | { ok: false; state: SnapshotState; retryMs: number }> {
  try {
    const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    const seconds = Number(response.headers.get('retry-after'));
    if (response.status === 429) {
      return { ok: false, state: 'rate_limited', retryMs: Math.max(60_000, seconds * 1000 || 0) };
    }
    if (response.status >= 500) return { ok: false, state: 'error', retryMs: FAULT_RETRY_MS };
    const body = (await response.json()) as { ok?: boolean; error?: string };
    if (body.ok) return { ok: true };
    const state = SLACK_REFUSALS[body.error ?? ''] ?? 'error';
    const retryMs =
      state === 'rate_limited'
        ? Math.max(60_000, seconds * 1000 || 0)
        : state === 'error'
          ? FAULT_RETRY_MS
          : REFUSAL_RETRY_MS;
    return { ok: false, state, retryMs };
  } catch {
    return { ok: false, state: 'error', retryMs: FAULT_RETRY_MS };
  }
}

const { retryAt, posted } = processWide('task-snapshot', () => ({
  retryAt: new Map<string, { at: number; state: SnapshotState }>(),
  /** The last post from here, which outranks its audit row if that write was lost. */
  posted: new Map<string, { at: string; hash: string | null }>(),
}));

async function lastPost(
  store: DataStore,
  organizationId: string,
): Promise<{ at: string; hash: string | null } | null> {
  const rows = (await store.list(
    'audit_events',
    organizationId,
    { eq: { action: 'task.snapshot_posted', entity_id: organizationId } },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
  )) as AuditEvent[];
  const row = rows[0];
  if (!row) return null;
  return {
    at: row.created_at,
    hash: typeof row.metadata?.hash === 'string' ? row.metadata.hash : null,
  };
}

/**
 * Posts a snapshot when there is none, when the last is 20 hours old, or when
 * the list changed, it is between 2pm and 4pm Central and the last post is at
 * least 30 minutes old. Never throws.
 */
export async function maybePostSnapshot(
  store: DataStore,
  organizationId: string,
  opts: { token: string; channelId: string; fetchImpl?: typeof fetch; now?: Date },
): Promise<SnapshotStatus> {
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const waiting = retryAt.get(organizationId);
  try {
    const stored = await lastPost(store, organizationId);
    const local = posted.get(organizationId);
    const last =
      local && (!stored || Date.parse(local.at) > Date.parse(stored.at)) ? local : stored;
    const lastPostedAt = last?.at ?? null;
    if (waiting && now.getTime() < waiting.at) {
      return {
        state: waiting.state,
        lastPostedAt,
        retryAt: new Date(waiting.at).toISOString(),
      };
    }

    const { tasks, touches, hash } = await buildSnapshot(store, organizationId);
    const age = last ? now.getTime() - Date.parse(last.at) : Infinity;
    const { hour } = localClock(now, CENTRAL_TIMEZONE);
    const beforeCheck = hour >= CHANGE_WINDOW_START_HOUR && hour < CHANGE_WINDOW_END_HOUR;
    const due =
      !last || age >= MAX_AGE_MS || (hash !== last.hash && beforeCheck && age >= MIN_GAP_MS);
    if (!due) return { state: last ? 'posted' : 'idle', lastPostedAt, retryAt: null };

    const batch = now.toISOString();
    const described = await describe(store, organizationId, tasks, touches, now);
    const { texts, truncated } = snapshotParts(described, { batch, asOf: batch });
    for (const text of texts) {
      const posted = await postMessage(fetchImpl, opts.token, opts.channelId, text);
      if (!posted.ok) {
        const at = now.getTime() + posted.retryMs;
        retryAt.set(organizationId, { at, state: posted.state });
        if (posted.state !== 'needs_chat_write') {
          log.warn('Task snapshot could not be posted', { state: posted.state });
        }
        return { state: posted.state, lastPostedAt, retryAt: new Date(at).toISOString() };
      }
    }
    retryAt.delete(organizationId);
    posted.set(organizationId, { at: now.toISOString(), hash });
    await recordAudit(store, {
      organizationId,
      userId: null,
      action: 'task.snapshot_posted',
      entityType: 'organization',
      entityId: organizationId,
      metadata: { hash, batch, parts: texts.length, truncated, tasks: described.length },
    });
    return { state: 'posted', lastPostedAt: now.toISOString(), retryAt: null };
  } catch (error) {
    const at = now.getTime() + FAULT_RETRY_MS;
    retryAt.set(organizationId, { at, state: 'error' });
    log.warn('Task snapshot failed', {
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return { state: 'error', lastPostedAt: null, retryAt: new Date(at).toISOString() };
  }
}

/** Test seam: forget back-offs and posts. */
export function resetSnapshotState(): void {
  retryAt.clear();
  posted.clear();
}
