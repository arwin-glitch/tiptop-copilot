import { z } from 'zod';
import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import { slackTsToIso, type SlackMessage } from '@/lib/slack/relay-history';
import type { AuditEvent, Integration, Task } from '@/lib/types/domain';
import { unwrapSlackText } from '@/lib/util/slack-text';
import { formatMonthDay, formatTime, localClock, localDateKey } from '@/lib/util/time';
import { normalizeTitle } from './task-ingest';

/**
 * Closing tasks that are already done, from evidence.
 *
 * The task-closer cloud routine checks Nick's mailbox and calendar at 4pm
 * Central and posts what it found done to the private #deal-relay channel,
 * because its sandbox cannot reach this app. This module reads those posts
 * (`TASK_CLOSE_V1`, one `TASK_CLOSER_RUN_V1` per run), matches each close to a
 * task, and applies it only when no person has touched the task since the
 * evidence: a Reopen, an Undo, a snooze or creating the task by hand all
 * outrank older evidence. Every close is a `task.auto_completed` audit row
 * with no user, so there is no migration, and the Completed tab shows where
 * each one came from.
 */

export const TASK_CLOSE_MARKER = 'TASK_CLOSE_V1';
export const TASK_CLOSER_RUN_MARKER = 'TASK_CLOSER_RUN_V1';
/** What the routine posts in PREVIEW mode. A person checks these; the app never applies them. */
export const TASK_CLOSE_PREVIEW_MARKER = 'TASK_CLOSE_PREVIEW_V1';
export const TASK_CLOSER_PREVIEW_RUN_MARKER = 'TASK_CLOSER_PREVIEW_RUN_V1';

/** The routine's clock, and the reply check's. */
export const CENTRAL_TIMEZONE = 'America/Chicago';

/** Gmail's own address for the default mailbox, when no Google integration names one. */
export const DEFAULT_MAILBOX = 'nick@tiptop.vc';

export const CLOSE_KINDS = [
  'reply',
  'intro',
  'send_doc',
  'meeting',
  'decision',
  'payment',
  'followup',
] as const;
export const EVIDENCE_TYPES = ['gmail_sent', 'calendar_event'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Slack's own ceiling on a message; anything longer was not the routine's. */
const MAX_MESSAGE_CHARS = 40_000;
/** How far before a suggested task's post its evidence may be (the suggester looks back 5 days). */
const SUGGESTED_LOOKBACK_MS = 7 * 86_400_000;

export const TASK_CLOSE_SCHEMA = z.object({
  task_id: z.string().trim().regex(UUID_RE, 'must be a task id').optional(),
  title: z.string().trim().min(1).max(300),
  kind: z.enum(CLOSE_KINDS),
  evidence_at: z.string().datetime({ offset: true }),
  evidence: z.object({
    type: z.enum(EVIDENCE_TYPES),
    id: z.string().trim().min(1).max(200),
    thread_id: z.string().trim().min(1).max(200).optional(),
    to: z.array(z.string().trim().max(320)).max(20).optional(),
  }),
  reason: z.string().trim().min(1).max(300),
});

export type TaskClose = z.infer<typeof TASK_CLOSE_SCHEMA>;

const TASK_CLOSE_ENVELOPE = z.object({
  v: z.literal(1),
  source: z.literal('task-closer'),
  batch: z.string().max(40).optional(),
  part: z.number().int().min(1).max(100).optional(),
  parts: z.number().int().min(1).max(100).optional(),
  closes: z.array(z.unknown()).min(1).max(20),
});

/** The run record. Lenient: it only feeds a status line, so an odd field falls back. */
const TASK_CLOSER_RUN_SCHEMA = z.object({
  v: z.number().optional().catch(undefined),
  run_at: z.string().max(40).optional().catch(undefined),
  local_date: z.string().regex(LOCAL_DATE_RE).optional().catch(undefined),
  list: z.enum(['snapshot', 'suggested']).optional().catch(undefined),
  snapshot_batch: z.string().max(40).nullish().catch(null),
  checked: z.number().int().min(0).catch(0),
  closed: z.number().int().min(0).catch(0),
  near_misses: z.number().int().min(0).catch(0),
  excluded: z.number().int().min(0).catch(0),
  unchecked: z.number().int().min(0).catch(0),
});

export type TaskCloserRun = z.infer<typeof TASK_CLOSER_RUN_SCHEMA>;

export type ParsedTaskCloseMessage =
  | { kind: 'close'; batch: string | null; closes: TaskClose[]; rejected: number }
  | { kind: 'run'; run: TaskCloserRun };

/** Null and empty-string fields are "absent", as the routine may spell either. */
function dropBlank(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (inner === null || inner === undefined) continue;
    if (typeof inner === 'string' && inner.trim() === '') continue;
    out[key] = key === 'evidence' ? dropBlank(inner) : inner;
  }
  return out;
}

function markerOf(clean: string): string {
  return (clean.split('\n', 1)[0] ?? '').trim();
}

/**
 * One #deal-relay message -> its closes or its run record, or null. The first
 * line must be exactly the marker (so the preview markers never match), and
 * the JSON is the first backtick-quoted span. A close that fails its schema is
 * counted and dropped; the rest of its message is kept.
 */
export function parseTaskCloseMessage(text: unknown): ParsedTaskCloseMessage | null {
  if (typeof text !== 'string' || text.length > MAX_MESSAGE_CHARS) return null;
  const clean = unwrapSlackText(text).trim();
  const marker = markerOf(clean);
  if (marker !== TASK_CLOSE_MARKER && marker !== TASK_CLOSER_RUN_MARKER) return null;
  const match = /`([^`]+)`/.exec(clean);
  if (!match?.[1]) return null;
  let json: unknown;
  try {
    json = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;

  if (marker === TASK_CLOSER_RUN_MARKER) {
    const source = (json as { source?: unknown }).source;
    if (source !== 'task-closer') return null;
    return { kind: 'run', run: TASK_CLOSER_RUN_SCHEMA.parse(json) };
  }

  const envelope = TASK_CLOSE_ENVELOPE.safeParse(json);
  if (!envelope.success) return null;
  const closes: TaskClose[] = [];
  let rejected = 0;
  for (const raw of envelope.data.closes) {
    const parsed = TASK_CLOSE_SCHEMA.safeParse(dropBlank(raw));
    if (parsed.success) closes.push(parsed.data);
    else rejected++;
  }
  return { kind: 'close', batch: envelope.data.batch ?? null, closes, rejected };
}

/* -------------------------------------------------------------- collecting */

export interface RelayClose {
  close: TaskClose;
  /** When Slack says it was posted. Evidence can never be later than this. */
  postedAt: string;
  slackTs: string;
}

export interface CollectedTaskCloses {
  /** Oldest post first. */
  closes: RelayClose[];
  /** The newest run record in the window, with its Slack time. */
  lastRun: { run: TaskCloserRun; ts: string } | null;
  /** Messages with a close or run marker that could not be read, and single closes dropped. */
  rejected: { messages: number; closes: number };
}

/**
 * Slack's pages (newest first) -> closes, oldest first. Only posts from
 * `posterIds` count: anything else, and anything with a subtype (edits,
 * joins, bot notices), is skipped.
 */
export function collectTaskCloses(
  messages: readonly SlackMessage[],
  posterIds: readonly string[],
): CollectedTaskCloses {
  const usable = messages
    .filter((m) => m.subtype === undefined || m.subtype === null)
    .filter((m) => typeof m.user === 'string' && posterIds.includes(m.user))
    .map((m) => ({ m, at: typeof m.ts === 'string' ? Number(m.ts) : Number.NaN }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((a, b) => a.at - b.at);

  const out: CollectedTaskCloses = {
    closes: [],
    lastRun: null,
    rejected: { messages: 0, closes: 0 },
  };
  for (const { m } of usable) {
    const postedAt = slackTsToIso(m.ts);
    if (!postedAt || typeof m.ts !== 'string') continue;
    let parsed: ParsedTaskCloseMessage | null;
    try {
      parsed = parseTaskCloseMessage(m.text);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      const text = typeof m.text === 'string' ? markerOf(unwrapSlackText(m.text).trim()) : '';
      if (text === TASK_CLOSE_MARKER || text === TASK_CLOSER_RUN_MARKER) out.rejected.messages++;
      continue;
    }
    if (parsed.kind === 'run') {
      out.lastRun = { run: parsed.run, ts: postedAt };
      continue;
    }
    out.rejected.closes += parsed.rejected;
    for (const close of parsed.closes) out.closes.push({ close, postedAt, slackTs: m.ts });
  }
  return out;
}

/* --------------------------------------------------------- the person wins */

const HUMAN_TOUCH_ACTIONS = ['task.created', 'task.updated'];

/**
 * The last time a person changed this task: the newest `task.created` or
 * `task.updated` audit row with a user. For a task a person created with no
 * such row, its `created_at`. Null for a suggested task nobody has touched.
 */
export async function latestHumanTaskTouch(
  store: DataStore,
  organizationId: string,
  task: Pick<Task, 'id' | 'source' | 'created_at'>,
): Promise<string | null> {
  const rows = (await store.list(
    'audit_events',
    organizationId,
    {
      eq: { entity_type: 'task', entity_id: task.id },
      in: { action: HUMAN_TOUCH_ACTIONS },
      notNull: ['user_id'],
    },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
  )) as AuditEvent[];
  if (rows[0]) return rows[0].created_at;
  return task.source === 'human' ? task.created_at : null;
}

/** `latestHumanTaskTouch` for many tasks, a hundred per query. */
export async function latestHumanTaskTouches(
  store: DataStore,
  organizationId: string,
  tasks: readonly Pick<Task, 'id' | 'source' | 'created_at'>[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const ids of chunk(tasks.map((t) => t.id))) {
    const rows = (await listAllPages(store, 'audit_events', organizationId, {
      eq: { entity_type: 'task' },
      in: { action: HUMAN_TOUCH_ACTIONS, entity_id: ids },
      notNull: ['user_id'],
    })) as AuditEvent[];
    for (const row of rows) {
      if (!row.entity_id) continue;
      const seen = out.get(row.entity_id);
      if (!seen || Date.parse(row.created_at) > Date.parse(seen)) {
        out.set(row.entity_id, row.created_at);
      }
    }
  }
  for (const task of tasks) {
    if (!out.has(task.id) && task.source === 'human') out.set(task.id, task.created_at);
  }
  return out;
}

export type TaskCloseSkip =
  | 'id_title_mismatch'
  | 'no_open_match'
  | 'ambiguous'
  | 'not_open'
  | 'person_newer'
  | 'evidence_too_old'
  | 'already_applied';

/** The time a close counts from: its evidence, but never later than the post that carried it. */
export function evidenceTime(evidenceAt: string, postedAt: string | null): number {
  const evidence = Date.parse(evidenceAt);
  const posted = postedAt ? Date.parse(postedAt) : Number.NaN;
  if (Number.isNaN(posted)) return evidence;
  return Math.min(evidence, posted);
}

function isOpenOrSnoozed(task: Pick<Task, 'status'>): boolean {
  return task.status === 'open' || task.status === 'snoozed';
}

/**
 * Whether evidence at `evidenceMs` may close `task`. A snoozed task counts as
 * open (a snooze is a person's touch, so only evidence after it counts).
 */
export function closeAllowed(
  task: Pick<Task, 'status' | 'source' | 'created_at'>,
  evidenceMs: number,
  humanTouch: string | null,
): TaskCloseSkip | null {
  if (!isOpenOrSnoozed(task)) return 'not_open';
  if (Number.isNaN(evidenceMs)) return 'evidence_too_old';
  if (humanTouch !== null) {
    const touched = Date.parse(humanTouch);
    // An unreadable touch time is treated as "just now": the person wins.
    return Number.isNaN(touched) || !(evidenceMs > touched) ? 'person_newer' : null;
  }
  // A suggested task nobody has touched: the suggester runs behind its
  // evidence, so a little before the post is fine, a week is not.
  const created = Date.parse(task.created_at);
  if (!Number.isNaN(created) && evidenceMs < created - SUGGESTED_LOOKBACK_MS) {
    return 'evidence_too_old';
  }
  return null;
}

/** Whether this task already carries an auto-close for this piece of evidence. */
async function alreadyApplied(
  store: DataStore,
  organizationId: string,
  taskId: string,
  evidenceId: string,
): Promise<boolean> {
  const rows = (await store.list('audit_events', organizationId, {
    eq: { action: 'task.auto_completed', entity_type: 'task', entity_id: taskId },
  })) as AuditEvent[];
  return rows.some((row) => row.metadata?.evidence_id === evidenceId);
}

export interface AutoCloseMetadata {
  source: 'task-closer' | 'app-reply-check';
  match: 'id' | 'title' | 'thread';
  kind: (typeof CLOSE_KINDS)[number];
  evidence_type: (typeof EVIDENCE_TYPES)[number];
  evidence_id: string;
  thread_id: string | null;
  evidence_at: string;
  reason: string;
  slack_ts: string | null;
}

/**
 * Re-reads the task and, if it is still open or snoozed and this evidence has
 * never closed it before, completes it with a user-less audit row. The second
 * guard holds even if a Reopen's audit row was lost. There is no conditional
 * update in the store; the window between the read and the write is
 * milliseconds.
 */
export async function writeAutoClose(
  store: DataStore,
  organizationId: string,
  taskId: string,
  metadata: AutoCloseMetadata,
  now: Date,
): Promise<'closed' | 'not_open' | 'already_applied'> {
  const fresh = (await store.get('tasks', organizationId, taskId)) as Task | null;
  if (!fresh || !isOpenOrSnoozed(fresh)) return 'not_open';
  if (await alreadyApplied(store, organizationId, taskId, metadata.evidence_id)) {
    return 'already_applied';
  }
  await store.update('tasks', organizationId, taskId, {
    status: 'complete',
    completed_at: now.toISOString(),
    snoozed_until: null,
  });
  await recordAudit(store, {
    organizationId,
    userId: null,
    action: 'task.auto_completed',
    entityType: 'task',
    entityId: taskId,
    metadata: { ...metadata },
  });
  return 'closed';
}

/* ---------------------------------------------------------------- applying */

export interface TaskCloseCounts {
  closed: number;
  skipped: Partial<Record<TaskCloseSkip, number>>;
  rejected: number;
}

export function zeroCloseCounts(): TaskCloseCounts {
  return { closed: 0, skipped: {}, rejected: 0 };
}

const SNAPSHOT_TITLE_MAX = 200;

/** A title as the open-task snapshot shows it: one line, at most 200 characters, no backticks. */
export function snapshotTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim().replaceAll('`', "'");
  return clean.length > SNAPSHOT_TITLE_MAX ? `${clean.slice(0, SNAPSHOT_TITLE_MAX - 1)}…` : clean;
}

/**
 * Titles as compared: case and spacing aside, and without the scheme Slack
 * adds when it auto-links a bare domain or address in a post.
 */
function titleKey(title: string): string {
  return normalizeTitle(title.replace(/\b(?:https?:\/\/|mailto:)/gi, ''));
}

/**
 * Matches each close to one task and applies it. By `task_id` when the task
 * exists and its title agrees, as stored or as the snapshot showed it (titles
 * never change here); otherwise by title, among open or snoozed *suggested*
 * tasks only, and only when exactly one matches. A task a person created
 * closes by id or not at all.
 */
export async function applyTaskCloses(
  store: DataStore,
  organizationId: string,
  closes: readonly RelayClose[],
  opts: { now?: Date; rejected?: number } = {},
): Promise<TaskCloseCounts> {
  const now = opts.now ?? new Date();
  const counts = zeroCloseCounts();
  counts.rejected = opts.rejected ?? 0;
  if (closes.length === 0) return counts;
  const skip = (reason: TaskCloseSkip) => {
    counts.skipped[reason] = (counts.skipped[reason] ?? 0) + 1;
  };

  const suggested = (await listAllPages(store, 'tasks', organizationId, {
    in: { status: ['open', 'snoozed'] },
    eq: { source: 'suggested' },
  })) as Task[];
  const byTitle = new Map<string, Task[]>();
  for (const task of suggested) {
    const key = titleKey(task.title);
    byTitle.set(key, [...(byTitle.get(key) ?? []), task]);
  }
  const closedHere = new Set<string>();

  for (const { close, postedAt, slackTs } of closes) {
    const title = titleKey(close.title);
    let task: Task | null = null;
    let match: 'id' | 'title' = 'title';

    if (close.task_id) {
      const byId = (await store.get('tasks', organizationId, close.task_id)) as Task | null;
      if (byId) {
        if (titleKey(byId.title) !== title && titleKey(snapshotTitle(byId.title)) !== title) {
          skip('id_title_mismatch');
          continue;
        }
        task = closedHere.has(byId.id) ? { ...byId, status: 'complete' } : byId;
        match = 'id';
      }
    }
    if (!task) {
      const candidates = (byTitle.get(title) ?? []).filter((t) => !closedHere.has(t.id));
      if (candidates.length === 0) {
        skip('no_open_match');
        continue;
      }
      if (candidates.length > 1) {
        skip('ambiguous');
        continue;
      }
      task = candidates[0]!;
    }

    if (!isOpenOrSnoozed(task)) {
      skip('not_open');
      continue;
    }
    const evidenceMs = evidenceTime(close.evidence_at, postedAt);
    const touched = await latestHumanTaskTouch(store, organizationId, task);
    const blocked = closeAllowed(task, evidenceMs, touched);
    if (blocked) {
      skip(blocked);
      continue;
    }
    const written = await writeAutoClose(
      store,
      organizationId,
      task.id,
      {
        source: 'task-closer',
        match,
        kind: close.kind,
        evidence_type: close.evidence.type,
        evidence_id: close.evidence.id,
        thread_id: close.evidence.thread_id ?? null,
        evidence_at: new Date(evidenceMs).toISOString(),
        reason: close.reason,
        slack_ts: slackTs,
      },
      now,
    );
    if (written === 'closed') {
      counts.closed++;
      closedHere.add(task.id);
    } else {
      skip(written);
    }
  }

  if (counts.closed > 0 || counts.rejected > 0) {
    log.info('Task closes applied', {
      closed: counts.closed,
      rejected: counts.rejected,
      ...counts.skipped,
    });
  }
  return counts;
}

/* ------------------------------------------------- showing it on Completed */

export interface AutoCloseRecord {
  auditId: string;
  at: string;
  source: string;
  kind: string | null;
  evidenceType: string | null;
  evidenceId: string | null;
  evidenceAt: string | null;
  reason: string | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The newest auto-close of each completed task that is still the reason it is
 * complete: a task a person reopened and later completed themselves (a human
 * `task.updated` newer than the auto-close) is theirs again.
 */
export async function autoCloseInfo(
  store: DataStore,
  organizationId: string,
  completedIds: readonly string[],
): Promise<Map<string, AutoCloseRecord>> {
  const wanted = new Set(completedIds);
  const out = new Map<string, AutoCloseRecord>();
  if (wanted.size === 0) return out;

  const rows = (await listAllPages(
    store,
    'audit_events',
    organizationId,
    { eq: { action: 'task.auto_completed' } },
    [{ field: 'created_at', direction: 'desc' }],
  )) as AuditEvent[];
  for (const row of rows) {
    if (!row.entity_id || !wanted.has(row.entity_id) || out.has(row.entity_id)) continue;
    const m = row.metadata ?? {};
    out.set(row.entity_id, {
      auditId: row.id,
      at: row.created_at,
      source: str(m.source) ?? 'task-closer',
      kind: str(m.kind),
      evidenceType: str(m.evidence_type),
      evidenceId: str(m.evidence_id),
      evidenceAt: str(m.evidence_at),
      reason: str(m.reason),
    });
  }

  for (const ids of chunk([...out.keys()])) {
    const human = (await listAllPages(store, 'audit_events', organizationId, {
      eq: { entity_type: 'task', action: 'task.updated' },
      in: { entity_id: ids },
      notNull: ['user_id'],
    })) as AuditEvent[];
    for (const row of human) {
      const auto = row.entity_id ? out.get(row.entity_id) : undefined;
      if (auto && Date.parse(row.created_at) > Date.parse(auto.at)) out.delete(row.entity_id!);
    }
  }
  return out;
}

/** The mailbox a Gmail link opens: the Google integration's account, else the default. */
export async function linkMailbox(store: DataStore, organizationId: string): Promise<string> {
  const rows = (await store.list(
    'integrations',
    organizationId,
    { eq: { provider: 'google' } },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
  )) as Integration[];
  return rows[0]?.account_email?.trim().toLowerCase() || DEFAULT_MAILBOX;
}

/**
 * A sent message in Gmail. `authuser=<address>` picks the account; `/u/<address>/`
 * answers 404 and `u/0` can open whichever account is signed in first.
 */
export function gmailMessageHref(mailbox: string, messageId: string | null): string | null {
  if (!messageId || !/^[0-9a-f]{8,32}$/i.test(messageId)) return null;
  const account = encodeURIComponent(mailbox).replace(/%40/g, '@');
  return `https://mail.google.com/mail/?authuser=${account}#all/${messageId}`;
}

/** The Completed row's "Closed automatically · email sent Sep 22" line. */
export function autoCloseView(
  record: AutoCloseRecord,
  timeZone: string,
  mailbox: string,
): { label: string; href: string | null; reason: string | null } {
  const when = record.evidenceAt ?? record.at;
  const date = Number.isNaN(Date.parse(when)) ? null : formatMonthDay(when, timeZone);
  const what = record.evidenceType === 'calendar_event' ? 'meeting booked' : 'email sent';
  return {
    label: `Closed automatically · ${what}${date ? ` ${date}` : ''}`,
    href:
      record.evidenceType === 'gmail_sent' ? gmailMessageHref(mailbox, record.evidenceId) : null,
    reason: record.reason ? record.reason.replace(/\s+/g, ' ').trim() : null,
  };
}

/* ------------------------------------------------------------- status line */

const LATE_MINUTES = 17 * 60 + 30;

/**
 * The muted line at the top of To do, from the newest run record: when it
 * ran and what it closed, or, after 5:30pm Central with no run today, that it
 * has not reported. Null before any run record exists.
 */
export function autoCheckStatusLine(
  lastRun: { run: TaskCloserRun; ts: string } | null,
  now: Date,
  timeZone: string,
): string | null {
  if (!lastRun) return null;
  const { run } = lastRun;
  const at = run.run_at && !Number.isNaN(Date.parse(run.run_at)) ? run.run_at : lastRun.ts;
  const ranOn = run.local_date ?? localDateKey(new Date(at), CENTRAL_TIMEZONE);
  const central = localClock(now, CENTRAL_TIMEZONE);
  const scope = run.list === 'snapshot' ? '' : " · only suggested and 'Reply to' tasks are checked";

  if (ranOn === central.dateKey) {
    return `Auto-check ran today at ${formatTime(at, timeZone)} · closed ${run.closed}${scope}`;
  }
  if (central.hour * 60 + central.minute >= LATE_MINUTES) {
    return `Today's 4 PM Central auto-check hasn't reported yet${scope}`;
  }
  return `Auto-check last ran ${formatMonthDay(at, timeZone)} at ${formatTime(at, timeZone)} · closed ${run.closed}${scope}`;
}
