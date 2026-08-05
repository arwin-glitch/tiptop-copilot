import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import type { Task, TaskStatus } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';

/** Follow-ups and tasks. Deliberately small: a task is a title, a due date and a link. */

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

export async function updateTaskStatus(
  auth: AuthContext,
  taskId: string,
  status: TaskStatus,
): Promise<Result<Task>> {
  const store = getStore();
  const task = (await store.get('tasks', auth.organizationId, taskId)) as Task | null;
  if (!task) return err('not_found', 'That task does not exist.');

  const updated = (await store.update('tasks', auth.organizationId, taskId, {
    status,
    completed_at: status === 'complete' ? new Date().toISOString() : null,
    snoozed_until: status === 'snoozed' ? task.snoozed_until : null,
  })) as Task;

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'task.updated',
    entityType: 'task',
    entityId: taskId,
    metadata: { from: task.status, to: status },
  });
  return ok(updated);
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

export interface TaskFilters {
  status?: TaskStatus;
  dealId?: string;
  portfolioCompanyId?: string;
  dueBefore?: string;
  includeSnoozed?: boolean;
}

export async function listTasks(
  organizationId: string,
  filters: TaskFilters = {},
): Promise<Task[]> {
  const store = getStore();
  const filter: Parameters<typeof store.list>[2] = { eq: {} };
  if (filters.status) filter.eq!.status = filters.status;
  if (filters.dealId) filter.eq!.deal_id = filters.dealId;
  if (filters.portfolioCompanyId) filter.eq!.portfolio_company_id = filters.portfolioCompanyId;
  if (filters.dueBefore) filter.lte = { due_at: filters.dueBefore };

  const rows = (await store.list('tasks', organizationId, filter, {
    orderBy: [{ field: 'due_at', direction: 'asc' }],
  })) as Task[];

  if (filters.includeSnoozed) return rows;
  const now = Date.now();
  // A snoozed task reappears once its snooze has elapsed.
  return rows.filter(
    (t) => t.status !== 'snoozed' || (t.snoozed_until ? Date.parse(t.snoozed_until) <= now : true),
  );
}

/** Open tasks that are due now or overdue, most overdue first. */
export async function dueAndOverdue(
  organizationId: string,
  now: Date = new Date(),
): Promise<{ overdue: Task[]; dueToday: Task[]; upcoming: Task[] }> {
  const tasks = await listTasks(organizationId, { status: 'open' });
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
