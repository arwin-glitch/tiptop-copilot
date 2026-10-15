import { z } from 'zod';
import { env } from '@/lib/config/env';
import { listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type { OrganizationMember, Task } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { unwrapSlackText } from '@/lib/util/slack-text';
import { DEFAULT_TIMEZONE, wallTimeToUtc } from '@/lib/util/time';
import { DUE_PRECISIONS, GLANCE_BUCKETS, GLANCE_SHORT_SCHEMA } from '@/lib/tasks/glance';
import { recordRoutineGlance } from './task-glance';

const DATE_ONLY_RE = /^(\d{4}-\d{2}-\d{2})$/;
const NO_OFFSET_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
/** A routine's date with no time is a working morning: 09:00, as the prompt's week-level dates are. */
const DATE_ONLY_HOUR = 9;

/**
 * `due_at` as a routine actually writes it. The prompt asks for ISO with "Z",
 * and any offset is taken as is. A bare date ("2026-10-26") is 09:00 Central
 * that day, and a time with no offset ("2026-10-26T09:00") is Central wall
 * time: Nick's clock, which the prompts already use. Anything else is left
 * for the schema to reject.
 */
export function normalizeDueAt(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  const dateOnly = DATE_ONLY_RE.exec(text);
  if (dateOnly) {
    return wallTimeToUtc(dateOnly[1]!, DATE_ONLY_HOUR, 0, DEFAULT_TIMEZONE)?.toISOString() ?? text;
  }
  const noOffset = NO_OFFSET_RE.exec(text);
  if (noOffset) {
    const at = wallTimeToUtc(
      noOffset[1]!,
      Number(noOffset[2]),
      Number(noOffset[3]),
      DEFAULT_TIMEZONE,
      Number(noOffset[4] ?? 0),
    );
    return at?.toISOString() ?? text;
  }
  return text;
}

/** One task in a payload. The relay also checks tasks one by one. */
const TASK_ITEM_SCHEMA = z.object({
  title: z.string().trim().min(1).max(300),
  detail: z.string().trim().max(2000).nullish(),
  // Any offset, a bare date or a Central wall time; stored as UTC.
  due_at: z.preprocess(normalizeDueAt, z.string().datetime({ offset: true }).nullish()),
  urgent: z.boolean().nullish(),
  // Today's "At a glance" hints. Each falls back to null on its own, so a
  // bad label never costs the task.
  short: GLANCE_SHORT_SCHEMA.nullish().catch(null),
  bucket: z.enum(GLANCE_BUCKETS).nullish().catch(null),
  due_precision: z.enum(DUE_PRECISIONS).nullish().catch(null),
});

/**
 * Payload for the task webhook: things a watcher noticed that need a human
 * follow-up — an unanswered ask with a deadline, a promise made in a
 * meeting, a commitment surfaced in Slack. Deliberately narrow, matching
 * `CreateTaskInput`: a title, an optional detail (should say where it came
 * from), an optional due date, and whether it is urgent enough to want
 * attention today. Optionally, for Today's "At a glance" cards, a short
 * label, the card it belongs on and whether its date is a day or a week.
 */
export const TASK_INGEST_SCHEMA = z.object({
  source: z.string().trim().min(1).max(100),
  tasks: z.array(TASK_ITEM_SCHEMA).min(1).max(20),
});

export type TaskIngestPayload = z.infer<typeof TASK_INGEST_SCHEMA>;

export interface TaskIngestResult {
  created: string[];
  existing: string[];
}

/** Case- and whitespace-insensitive: how one task title is matched against another. */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The organization's owner, to attribute a machine-suggested task to (the
 * `tasks` table requires a real `created_by`). Falls back to the first
 * member if no member is explicitly the owner — same fallback the daily cron
 * job already uses for the same reason.
 */
async function resolveOwnerId(store: DataStore, organizationId: string): Promise<string | null> {
  const members = (await store.list('organization_members', organizationId, {})) as
    OrganizationMember[] | [];
  const owner = members.find((m) => m.role === 'owner') ?? members[0];
  return owner?.user_id ?? null;
}

/**
 * Add-only, like the portfolio webhook, and the same "never resurrect"
 * rule: a title that (case/whitespace-insensitively) matches ANY existing
 * task for the organization — open, snoozed, or already completed — is
 * skipped. Checking only open tasks would let a watcher that re-scans the
 * same thread every run bring a task back the moment a person finishes it.
 * Nothing here can complete, snooze, or delete a task a person is already
 * working, or has already finished.
 *
 * Only the title decides. A short label never does, even for an intro: labels
 * are first names by design ("Chris → Sam"), so two different intros, or the
 * same pair introduced twice months apart, share one. Not reposting a pair
 * under new wording is the routine prompt's rule; a duplicate that slips
 * through is one tick, a dropped intro is a promise nobody sees.
 */
export async function ingestTasks(
  store: DataStore,
  organizationId: string,
  payload: TaskIngestPayload,
): Promise<TaskIngestResult> {
  const ownerId = await resolveOwnerId(store, organizationId);
  if (!ownerId) {
    log.warn('Task ingest skipped: no organization member to attribute the task to', {
      organizationId,
    });
    return { created: [], existing: payload.tasks.map((t) => t.title) };
  }

  // Every page: a title past the API's 1,000th row must still count as known.
  const known = (await listAllPages(store, 'tasks', organizationId)) as Task[];
  const seen = new Set(known.map((t) => normalizeTitle(t.title)));
  const result: TaskIngestResult = { created: [], existing: [] };

  for (const input of payload.tasks) {
    const normalized = normalizeTitle(input.title);
    if (seen.has(normalized)) {
      result.existing.push(input.title);
      continue;
    }
    seen.add(normalized);

    const now = new Date().toISOString();
    const task: Task = {
      id: newId(),
      organization_id: organizationId,
      title: input.title.trim(),
      detail: input.detail ?? null,
      status: 'open',
      due_at: input.due_at ? new Date(input.due_at).toISOString() : input.urgent ? now : null,
      snoozed_until: null,
      deal_id: null,
      portfolio_company_id: null,
      email_message_id: null,
      assigned_to: ownerId,
      created_by: ownerId,
      source: 'suggested',
      completed_at: null,
      created_at: now,
      updated_at: now,
    };
    await store.insert('tasks', task);

    await recordAudit(store, {
      organizationId,
      userId: null,
      action: 'task.created',
      entityType: 'task',
      entityId: task.id,
      metadata: { source: payload.source, title: task.title },
    });
    if (input.short || input.bucket || input.due_precision) {
      await recordRoutineGlance(store, organizationId, task.id, {
        source: payload.source,
        short: input.short,
        bucket: input.bucket,
        due_precision: input.due_precision,
      });
    }
    result.created.push(input.title);
  }

  return result;
}

/* ---------------------------------------------------------- Slack relay */

const TASK_MARKER = 'TASK_ADD_V1';
/** Fields a task can lose and still be the task it was. */
const OPTIONAL_TASK_FIELDS: ReadonlySet<string> = new Set(['detail', 'due_at', 'urgent']);

/**
 * The JSON in a relay post. From the first "{" to the last "}", so a backtick
 * inside a value, or a ```json fence around it, is no obstacle; the first
 * backtick pair, the original shape, is the fallback.
 */
function relayJson(clean: string): unknown {
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  const candidates = [
    start >= 0 && end > start ? clean.slice(start, end + 1) : null,
    /`([^`]+)`/.exec(clean)?.[1] ?? null,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next shape.
    }
  }
  return undefined;
}

/**
 * A payload that does not validate as a whole, task by task: a task that
 * fails only on optional fields (an odd `due_at`, say) is kept without them,
 * and only a task with no usable title is left out. Nobody reads the relay's
 * errors, and the same message is read again every run, so one bad field must
 * not cost every task in it.
 */
function salvageTasks(json: unknown): TaskIngestPayload | null {
  if (!json || typeof json !== 'object') return null;
  const { source, tasks } = json as { source?: unknown; tasks?: unknown };
  const parsedSource = TASK_INGEST_SCHEMA.shape.source.safeParse(source);
  if (!parsedSource.success || !Array.isArray(tasks)) return null;
  const kept: TaskIngestPayload['tasks'] = [];
  for (const raw of tasks.slice(0, 20)) {
    const whole = TASK_ITEM_SCHEMA.safeParse(raw);
    if (whole.success) {
      kept.push(whole.data);
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const fields = new Set(whole.error.issues.map((issue) => String(issue.path[0] ?? '')));
    if (![...fields].every((field) => OPTIONAL_TASK_FIELDS.has(field))) continue;
    const trimmed: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    for (const field of fields) delete trimmed[field];
    const retry = TASK_ITEM_SCHEMA.safeParse(trimmed);
    if (retry.success) kept.push(retry.data);
  }
  return kept.length > 0 ? { source: parsedSource.data, tasks: kept } : null;
}

/** One relay-channel message -> a validated task payload, or null. */
export function parseTaskRelayMessage(text: unknown): TaskIngestPayload | null {
  if (typeof text !== 'string') return null;
  const clean = unwrapSlackText(text).trim();
  if (!clean.startsWith(TASK_MARKER)) return null;
  const json = relayJson(clean);
  if (json === undefined) {
    log.warn('Task relay message has no readable JSON', { marker: TASK_MARKER });
    return null;
  }
  const parsed = TASK_INGEST_SCHEMA.safeParse(json);
  if (parsed.success) return parsed.data;
  const salvaged = salvageTasks(json);
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.')}: ${issue.code}`);
  if (salvaged) {
    log.warn('Task relay message partly invalid; kept what validated', {
      kept: salvaged.tasks.length,
      issues,
    });
    return salvaged;
  }
  log.warn('Task relay message failed validation', { issues });
  return null;
}

/**
 * The cloud routine that notices new tasks cannot reach this app directly,
 * so it posts a TASK_ADD_V1 message to the relay channel instead, and the
 * daily job reads it here — same shape as `ingestPortfolioFromSlack`.
 */
export async function ingestTasksFromSlack(
  store: DataStore,
  organizationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TaskIngestResult | null> {
  const e = env();
  if (!e.askRelaySlackToken) return null;
  try {
    const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(
      e.askRelayChannelId,
    )}&limit=100`;
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${e.askRelaySlackToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as {
      ok?: boolean;
      error?: string;
      messages?: Array<{ text?: unknown; user?: unknown; subtype?: unknown }>;
    };
    if (!body.ok) {
      log.warn('Slack relay channel could not be read for task additions', {
        error: body.error ?? 'unknown',
      });
      return null;
    }
    const total: TaskIngestResult = { created: [], existing: [] };
    // Oldest first, so a task posted twice keeps its first source. The relay
    // channel is public, so only the routines' own account is read.
    for (const message of [...(body.messages ?? [])].reverse()) {
      if (message.subtype !== undefined && message.subtype !== null) continue;
      if (typeof message.user !== 'string' || !e.taskRelayPosterIds.includes(message.user)) {
        continue;
      }
      const payload = parseTaskRelayMessage(message.text);
      if (!payload) continue;
      const result = await ingestTasks(store, organizationId, {
        ...payload,
        source: `slack-relay:${payload.source}`,
      });
      total.created.push(...result.created);
      total.existing.push(...result.existing);
    }
    return total;
  } catch (error) {
    log.warn('Task relay ingest failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}
