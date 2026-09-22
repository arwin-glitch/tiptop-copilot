import { z } from 'zod';
import { env } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type { OrganizationMember, Task } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { unwrapSlackText } from '@/lib/util/slack-text';

/**
 * Payload for the task webhook: things a watcher noticed that need a human
 * follow-up — an unanswered ask with a deadline, a promise made in a
 * meeting, a commitment surfaced in Slack. Deliberately narrow, matching
 * `CreateTaskInput`: a title, an optional detail (should say where it came
 * from), an optional due date, and whether it is urgent enough to want
 * attention today.
 */
export const TASK_INGEST_SCHEMA = z.object({
  source: z.string().trim().min(1).max(100),
  tasks: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        detail: z.string().trim().max(2000).nullish(),
        due_at: z.string().datetime().nullish(),
        urgent: z.boolean().nullish(),
      }),
    )
    .min(1)
    .max(20),
});

export type TaskIngestPayload = z.infer<typeof TASK_INGEST_SCHEMA>;

export interface TaskIngestResult {
  created: string[];
  existing: string[];
}

function normalizeTitle(title: string): string {
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

  const known = (await store.list('tasks', organizationId, {})) as Task[];
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
      due_at: input.due_at ?? (input.urgent ? now : null),
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
    result.created.push(input.title);
  }

  return result;
}

/* ---------------------------------------------------------- Slack relay */

const TASK_MARKER = 'TASK_ADD_V1';

/** One relay-channel message -> a validated task payload, or null. */
export function parseTaskRelayMessage(text: unknown): TaskIngestPayload | null {
  if (typeof text !== 'string') return null;
  const clean = unwrapSlackText(text).trim();
  if (!clean.startsWith(TASK_MARKER)) return null;
  const match = /`([^`]+)`/.exec(clean);
  if (!match?.[1]) return null;
  let json: unknown;
  try {
    json = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const parsed = TASK_INGEST_SCHEMA.safeParse(json);
  return parsed.success ? parsed.data : null;
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
      messages?: Array<{ text?: unknown }>;
    };
    if (!body.ok) {
      log.warn('Slack relay channel could not be read for task additions', {
        error: body.error ?? 'unknown',
      });
      return null;
    }
    const total: TaskIngestResult = { created: [], existing: [] };
    // Oldest first, so a task posted twice keeps its first source.
    for (const message of [...(body.messages ?? [])].reverse()) {
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

const TASK_PULL_INTERVAL_MS = 60_000;
let lastTaskPull = 0;

/** The Tasks page's on-view version, throttled like the portfolio one. */
export async function pullTasksFromSlack(
  store: DataStore,
  organizationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TaskIngestResult | null> {
  if (Date.now() - lastTaskPull < TASK_PULL_INTERVAL_MS) return null;
  lastTaskPull = Date.now();
  return ingestTasksFromSlack(store, organizationId, fetchImpl);
}

/** Test seam: forget the throttle so a second pull in the same process runs. */
export function resetTaskPullThrottle(): void {
  lastTaskPull = 0;
}
