import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { moneyLegalState, type MoneyLegalState } from '@/lib/tasks/money-legal';
import type { AuditEvent, Task } from '@/lib/types/domain';

/**
 * The stored side of money and legal tasks, as audit rows beside each task
 * (`entity_type = 'task'`, `entity_id` the task), so there is no migration:
 *
 * - `task.money_legal_set`: a person's toggle, `{ on }`. The newest wins over
 *   the keyword rules.
 * - `task.proof_recorded`: what a person closed the task on, `{ kind: 'link',
 *   url }` or `{ kind: 'confirmed', confirmed_by }`, with an optional `note`.
 * - `task.needs_proof`: an automatic close of a money or legal task that
 *   stated no proof, kept as a claim instead of closing the task. No user;
 *   the metadata is the close's own.
 *
 * None of them is a "person touched it" action for the task-closer, so
 * marking a task or recording a claim never stops it closing itself. This
 * module imports nothing from the task-closer, which calls it.
 */

export const MONEY_LEGAL_ACTION = 'task.money_legal_set';
export const PROOF_ACTION = 'task.proof_recorded';
export const NEEDS_PROOF_ACTION = 'task.needs_proof';

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Newest row per task among `rows`. */
function newestByTask(rows: readonly AuditEvent[]): Map<string, AuditEvent> {
  const out = new Map<string, AuditEvent>();
  for (const row of rows) {
    if (!row.entity_id) continue;
    const seen = out.get(row.entity_id);
    if (!seen || Date.parse(row.created_at) > Date.parse(seen.created_at)) {
      out.set(row.entity_id, row);
    }
  }
  return out;
}

/** Every row of `action` for these tasks, a hundred ids per query. */
async function rowsFor(
  store: DataStore,
  organizationId: string,
  action: string,
  taskIds: readonly string[],
  personOnly: boolean,
): Promise<AuditEvent[]> {
  const out: AuditEvent[] = [];
  for (const ids of chunk([...new Set(taskIds)])) {
    const rows = (await listAllPages(store, 'audit_events', organizationId, {
      eq: { entity_type: 'task', action },
      in: { entity_id: ids },
      ...(personOnly ? { notNull: ['user_id'] } : {}),
    })) as AuditEvent[];
    out.push(...rows);
  }
  return out;
}

/** A person's newest toggle for each task that has one. */
export async function readMoneyLegalOverrides(
  store: DataStore,
  organizationId: string,
  taskIds: readonly string[],
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (taskIds.length === 0) return out;
  const rows = await rowsFor(store, organizationId, MONEY_LEGAL_ACTION, taskIds, true);
  for (const [taskId, row] of newestByTask(rows)) {
    if (typeof row.metadata?.on === 'boolean') out.set(taskId, row.metadata.on);
  }
  return out;
}

/** Each task's money and legal state: its toggle, else the rules. */
export async function readMoneyLegalStates(
  store: DataStore,
  organizationId: string,
  tasks: readonly Pick<Task, 'id' | 'title' | 'detail'>[],
): Promise<Map<string, MoneyLegalState>> {
  const overrides = await readMoneyLegalOverrides(
    store,
    organizationId,
    tasks.map((t) => t.id),
  );
  return new Map(tasks.map((t) => [t.id, moneyLegalState(t, overrides.get(t.id))]));
}

/** Whether one task is a money or legal task right now. */
export async function isMoneyLegalTask(
  store: DataStore,
  organizationId: string,
  task: Pick<Task, 'id' | 'title' | 'detail'>,
): Promise<boolean> {
  const rows = (await store.list(
    'audit_events',
    organizationId,
    {
      eq: { entity_type: 'task', entity_id: task.id, action: MONEY_LEGAL_ACTION },
      notNull: ['user_id'],
    },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
  )) as AuditEvent[];
  const manual = rows[0]?.metadata?.on;
  return moneyLegalState(task, typeof manual === 'boolean' ? manual : null).on;
}

/* ------------------------------------------------------------------- proof */

export interface ProofRecord {
  auditId: string;
  at: string;
  /** Who recorded it. */
  userId: string | null;
  kind: 'link' | 'confirmed';
  url: string | null;
  confirmedBy: string | null;
  note: string | null;
}

/** The newest proof recorded for each task that has one. */
export async function readProofRecords(
  store: DataStore,
  organizationId: string,
  taskIds: readonly string[],
): Promise<Map<string, ProofRecord>> {
  const out = new Map<string, ProofRecord>();
  if (taskIds.length === 0) return out;
  const rows = await rowsFor(store, organizationId, PROOF_ACTION, taskIds, true);
  for (const [taskId, row] of newestByTask(rows)) {
    const m = row.metadata ?? {};
    const kind = m.kind === 'link' || m.kind === 'confirmed' ? m.kind : null;
    if (!kind) continue;
    out.set(taskId, {
      auditId: row.id,
      at: row.created_at,
      userId: row.user_id,
      kind,
      url: kind === 'link' ? str(m.url) : null,
      confirmedBy: kind === 'confirmed' ? str(m.confirmed_by) : null,
      note: str(m.note),
    });
  }
  return out;
}

/* ------------------------------------------------------------- needs proof */

export interface NeedsProofClaim {
  auditId: string;
  at: string;
  source: string;
  kind: string | null;
  evidenceType: string | null;
  evidenceId: string | null;
  evidenceAt: string | null;
  reason: string | null;
}

/** The newest needs-proof claim for each task that has one, outstanding or not. */
export async function readNeedsProofClaims(
  store: DataStore,
  organizationId: string,
  taskIds: readonly string[],
): Promise<Map<string, NeedsProofClaim>> {
  const out = new Map<string, NeedsProofClaim>();
  if (taskIds.length === 0) return out;
  const rows = await rowsFor(store, organizationId, NEEDS_PROOF_ACTION, taskIds, false);
  for (const [taskId, row] of newestByTask(rows)) {
    const m = row.metadata ?? {};
    out.set(taskId, {
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
  return out;
}

/**
 * Keeps an automatic close as a claim on the task instead of closing it. The
 * same evidence is claimed once; a later run posting it again changes nothing.
 */
export async function recordNeedsProof(
  store: DataStore,
  organizationId: string,
  taskId: string,
  metadata: Record<string, unknown>,
): Promise<'needs_proof' | 'already_applied'> {
  const evidenceId = metadata.evidence_id;
  const rows = (await store.list('audit_events', organizationId, {
    eq: { action: NEEDS_PROOF_ACTION, entity_type: 'task', entity_id: taskId },
  })) as AuditEvent[];
  if (rows.some((row) => row.metadata?.evidence_id === evidenceId)) return 'already_applied';
  await recordAudit(store, {
    organizationId,
    userId: null,
    action: NEEDS_PROOF_ACTION,
    entityType: 'task',
    entityId: taskId,
    metadata: { ...metadata },
  });
  return 'needs_proof';
}
