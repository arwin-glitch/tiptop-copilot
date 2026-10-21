import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import { listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { taskPeople, type TaskPerson } from '@/lib/tasks/task-people';
import {
  isAsleep,
  isAwake,
  isOpenNow,
  sortSnoozed,
  type TaskRestore,
} from '@/lib/tasks/tasks-view';
import type { OrganizationMember, Task, TaskStatus } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { DEFAULT_TIMEZONE } from '@/lib/util/time';
import { isMoneyLegalTask } from './money-legal-records';
import { recordProofExpectation } from './task-proof';

/** Follow-ups and tasks. Deliberately small: a task is a title, a due date and a link. */

export { isAwake, type TaskRestore };

export interface CreateTaskInput {
  title: string;
  detail?: string | null;
  dueAt?: string | null;
  dealId?: string | null;
  portfolioCompanyId?: string | null;
  emailMessageId?: string | null;
  source?: 'human' | 'suggested';
}

export async function createTask(auth: AuthContext, input: CreateTaskInput): Promise<Result<Task>> {
  if (!input.title.trim()) return err('invalid_input', 'A task needs a title.');
  const store = getStore();
  const now = new Date().toISOString();
  const task: Task = {
    id: newId(),
    organization_id: auth.organizationId,
    title: input.title.trim(),
    detail: input.detail?.trim() || null,
    status: 'open',
    due_at: input.dueAt ?? null,
    snoozed_until: null,
    deal_id: input.dealId ?? null,
    portfolio_company_id: input.portfolioCompanyId ?? null,
    email_message_id: input.emailMessageId ?? null,
    assigned_to: auth.userId,
    created_by: auth.userId,
    source: input.source ?? 'human',
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
  await store.insert('tasks', task);
  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'task.created',
    entityType: 'task',
    entityId: task.id,
    metadata: { source: task.source, has_due_date: Boolean(task.due_at) },
  });
  return ok(task);
}

/** The message a money or legal task gives when someone tries to close it without proof. */
export const PROOF_REQUIRED_MESSAGE =
  'This is a money or legal task. Add proof to close it: a link, or who confirmed it.';

/**
 * Changes a task's status. Completing a money or legal task needs proof
 * (`completeTaskWithProof`), so a plain "Mark complete" on one is refused
 * with `proof_required`, which the buttons answer by asking for it. A
 * `cancelled` task is a deleted one: it leaves every list, and stays in the
 * table so a suggestion with its title is never added again.
 */
export async function updateTaskStatus(
  auth: AuthContext,
  taskId: string,
  status: TaskStatus,
): Promise<Result<Task>> {
  const store = getStore();
  const task = (await store.get('tasks', auth.organizationId, taskId)) as Task | null;
  if (!task) return err('not_found', 'That task does not exist.');
  if (
    status === 'complete' &&
    task.status !== 'complete' &&
    (await isMoneyLegalTask(store, auth.organizationId, task))
  ) {
    return err('proof_required', PROOF_REQUIRED_MESSAGE);
  }
  return ok(await writeTaskStatus(store, auth, task, status));
}

/**
 * The status write itself, audited as the person's; the money and legal
 * proof gate is the caller's. A person's completion of a deliverable (a
 * reply, a send, feedback, an intro…) also notes what should have gone out,
 * for the proof check (task-proof.ts), unless the completion already carried
 * its proof (`with_proof`, a money or legal close).
 */
export async function writeTaskStatus(
  store: DataStore,
  auth: AuthContext,
  task: Task,
  status: TaskStatus,
  metadata: Record<string, unknown> = {},
): Promise<Task> {
  const updated = (await store.update('tasks', auth.organizationId, task.id, {
    status,
    completed_at: status === 'complete' ? new Date().toISOString() : null,
    snoozed_until: status === 'snoozed' ? task.snoozed_until : null,
  })) as Task;

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'task.updated',
    entityType: 'task',
    entityId: task.id,
    metadata: { from: task.status, to: status, ...metadata },
  });
  if (status === 'complete' && metadata.with_proof !== true) {
    await recordProofExpectation(
      store,
      {
        organizationId: auth.organizationId,
        userId: auth.userId,
        timeZone: auth.profile.timezone || DEFAULT_TIMEZONE,
      },
      { ...task, ...updated, status: 'complete' },
    );
  }
  return updated;
}

export interface EditTaskInput {
  title: string;
  detail: string | null;
  dueAt: string | null;
}

const TITLE_MAX = 300;
const DETAIL_MAX = 2000;

/**
 * A person's edit of a task's title, detail or due date. Audited as
 * `task.edited`, a person's touch like any other, so evidence older than the
 * edit never closes the task. A changed title keeps the old one in the audit
 * row, so the task-suggest routine does not add the old wording back.
 */
export async function editTask(
  auth: AuthContext,
  taskId: string,
  input: EditTaskInput,
): Promise<Result<Task>> {
  const title = input.title.replace(/\s+/g, ' ').trim();
  if (!title) return err('invalid_input', 'A task needs a title.');
  if (title.length > TITLE_MAX) {
    return err('invalid_input', `Keep the title under ${TITLE_MAX} characters.`);
  }
  const detail = input.detail?.trim() || null;
  if (detail && detail.length > DETAIL_MAX) {
    return err('invalid_input', `Keep the detail under ${DETAIL_MAX} characters.`);
  }
  let dueAt: string | null = null;
  if (input.dueAt) {
    const ms = Date.parse(input.dueAt);
    if (Number.isNaN(ms)) return err('invalid_input', 'That due date is not a date.');
    dueAt = new Date(ms).toISOString();
  }

  const store = getStore();
  const task = (await store.get('tasks', auth.organizationId, taskId)) as Task | null;
  if (!task || task.status === 'cancelled') return err('not_found', 'That task does not exist.');

  const sameDue =
    (task.due_at ? Date.parse(task.due_at) : null) === (dueAt ? Date.parse(dueAt) : null);
  const patch: Partial<Task> = {};
  if (title !== task.title) patch.title = title;
  if (detail !== (task.detail?.trim() || null)) patch.detail = detail;
  if (!sameDue) patch.due_at = dueAt;
  const fields = Object.keys(patch);
  if (fields.length === 0) return ok(task);

  const updated = (await store.update('tasks', auth.organizationId, taskId, patch)) as Task;
  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'task.edited',
    entityType: 'task',
    entityId: taskId,
    metadata: { fields, ...(patch.title ? { previous_title: task.title } : {}) },
  });
  return ok(updated);
}

/**
 * Who a task is for: one of the organization's members, or no one. Not a
 * touch for the task-closer, the same as moving a task between Today's cards:
 * handing a task over says nothing about whether it is done.
 */
export async function assignTask(
  auth: AuthContext,
  taskId: string,
  userId: string | null,
): Promise<Result<Task>> {
  const store = getStore();
  const task = (await store.get('tasks', auth.organizationId, taskId)) as Task | null;
  if (!task || task.status === 'cancelled') return err('not_found', 'That task does not exist.');
  if (userId !== null) {
    const people = await listTaskPeople(auth.organizationId, store);
    if (!people.some((p) => p.id === userId)) {
      return err('invalid_input', 'Tasks can only go to someone on the team.');
    }
  }
  if (task.assigned_to === userId) return ok(task);
  const updated = (await store.update('tasks', auth.organizationId, taskId, {
    assigned_to: userId,
  })) as Task;
  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'task.assigned',
    entityType: 'task',
    entityId: taskId,
    metadata: { from: task.assigned_to, to: userId },
  });
  return ok(updated);
}

/** The organization's members, as a task can name them. */
export async function listTaskPeople(
  organizationId: string,
  store: DataStore = getStore(),
): Promise<TaskPerson[]> {
  const members = (await store.list('organization_members', organizationId, {
    eq: { organization_id: organizationId },
  })) as OrganizationMember[];
  const rows = await Promise.all(
    members.map(async (member) => {
      const profile = await store.userProfileById(member.user_id);
      return {
        id: member.user_id,
        fullName: profile?.full_name ?? null,
        email: profile?.email ?? null,
        owner: member.role === 'owner',
      };
    }),
  );
  return taskPeople(rows);
}

export async function snoozeTask(
  auth: AuthContext,
  taskId: string,
  until: string,
): Promise<Result<Task>> {
  const store = getStore();
  const task = (await store.get('tasks', auth.organizationId, taskId)) as Task | null;
  if (!task) return err('not_found', 'That task does not exist.');
  if (Number.isNaN(Date.parse(until))) {
    return err('invalid_input', 'Snooze needs a valid date.');
  }
  const updated = (await store.update('tasks', auth.organizationId, taskId, {
    status: 'snoozed',
    snoozed_until: until,
  })) as Task;
  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'task.updated',
    entityType: 'task',
    entityId: taskId,
    metadata: { snoozed_until: until },
  });
  return ok(updated);
}

/**
 * The Undo in the "Marked complete", "Snoozed" and "Back on To do" toasts.
 * A snooze whose time has passed meanwhile comes back open. It is an ordinary
 * person's change, audited with their id, so evidence older than it can never
 * close the task again.
 */
export async function restoreTask(
  auth: AuthContext,
  taskId: string,
  prev: TaskRestore,
  now: Date = new Date(),
): Promise<Result<Task>> {
  if (prev.status === 'snoozed') {
    if (prev.snoozedUntil === null) return updateTaskStatus(auth, taskId, 'snoozed');
    const until = Date.parse(prev.snoozedUntil);
    if (!Number.isNaN(until) && until > now.getTime()) {
      return snoozeTask(auth, taskId, new Date(until).toISOString());
    }
  }
  return updateTaskStatus(auth, taskId, 'open');
}

/**
 * Every completed task, newest completed first. Paged, because completed
 * tasks only accumulate and a plain list stops at the API's 1,000 rows.
 */
export async function listCompletedTasks(organizationId: string): Promise<Task[]> {
  return (await listAllPages(getStore(), 'tasks', organizationId, { eq: { status: 'complete' } }, [
    { field: 'completed_at', direction: 'desc' },
  ])) as Task[];
}

/**
 * Open tasks, and snoozed ones whose wake time has passed. Paged: open and
 * snoozed rows are read together, so a long list cannot hide a woken task.
 */
export async function listOpenTasks(
  organizationId: string,
  now: Date = new Date(),
  store: DataStore = getStore(),
): Promise<Task[]> {
  const rows = (await listAllPages(
    store,
    'tasks',
    organizationId,
    { in: { status: ['open', 'snoozed'] } },
    [{ field: 'due_at', direction: 'asc' }],
  )) as Task[];
  return rows.filter((task) => isOpenNow(task, now));
}

/** Snoozed tasks still asleep, soonest to wake first; no wake date last. */
export async function listSnoozedTasks(
  organizationId: string,
  now: Date = new Date(),
): Promise<Task[]> {
  const rows = (await listAllPages(getStore(), 'tasks', organizationId, {
    eq: { status: 'snoozed' },
  })) as Task[];
  return sortSnoozed(rows.filter((task) => isAsleep(task, now)));
}

/** Open tasks that are due now or overdue, most overdue first. */
export async function dueAndOverdue(
  organizationId: string,
  now: Date = new Date(),
): Promise<{ overdue: Task[]; dueToday: Task[]; upcoming: Task[] }> {
  const tasks = await listOpenTasks(organizationId, now);
  const nowMs = now.getTime();
  const endOfDay = nowMs + 86_400_000;

  const overdue: Task[] = [];
  const dueToday: Task[] = [];
  const upcoming: Task[] = [];

  for (const task of tasks) {
    if (!task.due_at) {
      upcoming.push(task);
      continue;
    }
    const due = Date.parse(task.due_at);
    if (due < nowMs) overdue.push(task);
    else if (due <= endOfDay) dueToday.push(task);
    else upcoming.push(task);
  }

  overdue.sort((a, b) => Date.parse(a.due_at ?? '') - Date.parse(b.due_at ?? ''));
  return { overdue, dueToday, upcoming };
}
