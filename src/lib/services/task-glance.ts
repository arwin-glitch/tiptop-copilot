import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import {
  buildGlance,
  foldGlanceMeta,
  GLANCE_BUCKETS,
  GLANCE_SHORT_SCHEMA,
  type DuePrecision,
  type FoldedGlance,
  type Glance,
  type GlanceBucket,
  type GlanceRow,
} from '@/lib/tasks/glance';
import type { AuditEvent, Deal, PortfolioCompany, Task } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';
import { listOpenTasks } from './tasks';

/**
 * Today's "At a glance" cards, read and written.
 *
 * A task's short label and bucket are `task.glance_set` audit rows beside it:
 * no user for the routine's suggestion, the person's id for their choice. No
 * migration, and deliberately not one of the task-closer's "person touched it"
 * actions, so moving a line between cards never stops a task closing itself.
 */

export const GLANCE_ACTION = 'task.glance_set';

/** Every glance row for these tasks, folded per task. A hundred ids per query. */
export async function readGlanceMeta(
  store: DataStore,
  organizationId: string,
  taskIds: readonly string[],
): Promise<Map<string, FoldedGlance>> {
  const rowsByTask = new Map<string, GlanceRow[]>();
  for (const ids of chunk([...new Set(taskIds)])) {
    const rows = (await listAllPages(store, 'audit_events', organizationId, {
      eq: { entity_type: 'task', action: GLANCE_ACTION },
      in: { entity_id: ids },
    })) as AuditEvent[];
    for (const row of rows) {
      if (!row.entity_id) continue;
      const list = rowsByTask.get(row.entity_id) ?? [];
      list.push(row);
      rowsByTask.set(row.entity_id, list);
    }
  }
  const out = new Map<string, FoldedGlance>();
  for (const [taskId, rows] of rowsByTask) out.set(taskId, foldGlanceMeta(rows));
  return out;
}

export interface RoutineGlance {
  source: string;
  short?: string | null;
  bucket?: GlanceBucket | null;
  due_precision?: DuePrecision | null;
}

/** The routine's label, bucket and precision for a task it just added. No user. */
export async function recordRoutineGlance(
  store: DataStore,
  organizationId: string,
  taskId: string,
  glance: RoutineGlance,
): Promise<void> {
  const metadata: Record<string, unknown> = { v: 1, by: 'routine', source: glance.source };
  if (glance.short) metadata.short = glance.short;
  if (glance.bucket) metadata.bucket = glance.bucket;
  if (glance.due_precision) metadata.due_precision = glance.due_precision;
  await recordAudit(store, {
    organizationId,
    userId: null,
    action: GLANCE_ACTION,
    entityType: 'task',
    entityId: taskId,
    metadata,
  });
}

export interface GlancePatch {
  short?: string;
  bucket?: GlanceBucket;
}

/** A person's own label or card for a task. It outranks the routine's, field by field. */
export async function setTaskGlance(
  auth: AuthContext,
  taskId: string,
  patch: GlancePatch,
): Promise<Result<FoldedGlance>> {
  const metadata: Record<string, unknown> = { v: 1, by: 'person' };
  if (patch.short !== undefined) {
    const short = GLANCE_SHORT_SCHEMA.safeParse(patch.short);
    if (!short.success) {
      return err('invalid_input', 'A short label is one line of at most six words.');
    }
    metadata.short = short.data;
  }
  if (patch.bucket !== undefined) {
    if (!GLANCE_BUCKETS.includes(patch.bucket)) {
      return err('invalid_input', 'That card does not exist.');
    }
    metadata.bucket = patch.bucket;
  }
  if (metadata.short === undefined && metadata.bucket === undefined) {
    return err('invalid_input', 'Nothing to change.');
  }

  const store = getStore();
  const task = (await store.get('tasks', auth.organizationId, taskId)) as Task | null;
  if (!task) return err('not_found', 'That task does not exist.');
  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: GLANCE_ACTION,
    entityType: 'task',
    entityId: taskId,
    metadata,
  });
  const folded = await readGlanceMeta(store, auth.organizationId, [taskId]);
  return ok(folded.get(taskId) ?? {});
}

/**
 * The three cards for Today: open and awake tasks, their glance rows, and
 * the names of linked deals and portfolio companies for the labels.
 */
export async function readTodayGlance(
  store: DataStore,
  organizationId: string,
  { now, timeZone }: { now: Date; timeZone: string },
): Promise<Glance> {
  const tasks = await listOpenTasks(organizationId, now, store);
  const dealIds = [...new Set(tasks.map((t) => t.deal_id).filter((id): id is string => !!id))];
  const [meta, portfolio, deals] = await Promise.all([
    readGlanceMeta(
      store,
      organizationId,
      tasks.map((t) => t.id),
    ),
    store.list('portfolio_companies', organizationId) as Promise<PortfolioCompany[]>,
    Promise.all(
      chunk(dealIds).map(
        (ids) => store.list('deals', organizationId, { in: { id: ids } }) as Promise<Deal[]>,
      ),
    ).then((pages) => pages.flat()),
  ]);
  const companyNames = new Map<string, string>();
  for (const company of portfolio) companyNames.set(company.id, company.name);
  for (const deal of deals) companyNames.set(deal.id, deal.company_name);
  return buildGlance(tasks, meta, { now, timeZone, companyNames });
}
