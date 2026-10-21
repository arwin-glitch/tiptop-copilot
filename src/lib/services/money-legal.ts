import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import {
  moneyLegalWhy,
  PROOF_SCHEMA,
  proofExplains,
  staleDays,
  staleLabel,
  type MoneyLegalState,
} from '@/lib/tasks/money-legal';
import { personShort, type TaskPerson } from '@/lib/tasks/task-people';
import type { Task } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';
import { formatMonthDay } from '@/lib/util/time';
import {
  MONEY_LEGAL_ACTION,
  PROOF_ACTION,
  readMoneyLegalStates,
  readNeedsProofClaims,
  readProofRecords,
  type NeedsProofClaim,
  type ProofRecord,
} from './money-legal-records';
import { latestHumanTaskTouches } from './task-close';
import { listTaskPeople, writeTaskStatus } from './tasks';

/**
 * Money and legal tasks, written and read for the Tasks page.
 *
 * A money or legal task (a wire, a signature, a filing, an invoice: see the
 * rules in lib/tasks/money-legal.ts, or a person's toggle) stays on the Money
 * & legal tab until it is really closed: by a person, with proof, or by the
 * task-closer on a close that states its own. A close without proof becomes
 * a "needs proof" claim on the tab instead. No mailbox is read here.
 */

function isOpenOrSnoozed(task: Pick<Task, 'status'>): boolean {
  return task.status === 'open' || task.status === 'snoozed';
}

/** A person's toggle: on puts the task on the Money & legal tab, off takes it off. */
export async function setMoneyLegal(
  auth: AuthContext,
  taskId: string,
  on: boolean,
): Promise<Result<{ on: boolean }>> {
  const store = getStore();
  const task = (await store.get('tasks', auth.organizationId, taskId)) as Task | null;
  if (!task || task.status === 'cancelled') return err('not_found', 'That task does not exist.');
  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: MONEY_LEGAL_ACTION,
    entityType: 'task',
    entityId: taskId,
    metadata: { on },
  });
  return ok({ on });
}

/**
 * Closes a task on proof: a web link, or a member of the team who confirmed
 * it, with an optional note. The proof is a `task.proof_recorded` row written
 * just before the completion it explains. Works for any open or snoozed
 * task; for a money or legal one it is the only way a person closes it.
 */
export async function completeTaskWithProof(
  auth: AuthContext,
  taskId: string,
  input: unknown,
): Promise<Result<Task>> {
  const parsed = PROOF_SCHEMA.safeParse(input);
  if (!parsed.success) {
    return err('invalid_input', parsed.error.issues[0]?.message ?? 'That proof is not valid.');
  }
  const proof = parsed.data;
  const store = getStore();
  const task = (await store.get('tasks', auth.organizationId, taskId)) as Task | null;
  if (!task || task.status === 'cancelled') return err('not_found', 'That task does not exist.');
  if (!isOpenOrSnoozed(task)) return err('conflict', 'That task is already closed.');
  if (proof.kind === 'confirmed') {
    const people = await listTaskPeople(auth.organizationId, store);
    if (!people.some((p) => p.id === proof.confirmedBy)) {
      return err('invalid_input', 'Choose someone on the team.');
    }
  }

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: PROOF_ACTION,
    entityType: 'task',
    entityId: taskId,
    metadata: {
      v: 1,
      kind: proof.kind,
      ...(proof.kind === 'link' ? { url: proof.url } : { confirmed_by: proof.confirmedBy }),
      ...(proof.note ? { note: proof.note } : {}),
    },
  });
  return ok(await writeTaskStatus(store, auth, task, 'complete', { with_proof: true }));
}

/**
 * "Not done": the task-closer said a money or legal task was done but gave
 * no proof, and a person says it is not. An ordinary person's touch, so the
 * same evidence can never close or claim the task again.
 */
export async function dismissNeedsProof(auth: AuthContext, taskId: string): Promise<Result<Task>> {
  const store = getStore();
  const task = (await store.get('tasks', auth.organizationId, taskId)) as Task | null;
  if (!task || !isOpenOrSnoozed(task)) return err('not_found', 'That task is not open.');
  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'task.updated',
    entityType: 'task',
    entityId: taskId,
    metadata: { from: task.status, to: task.status, needs_proof: 'dismissed' },
  });
  return ok(task);
}

/* ----------------------------------------------------------------- reading */

export interface MoneyLegalRead {
  states: Map<string, MoneyLegalState>;
  /** Outstanding needs-proof claims: newer than any person's touch, on an open or snoozed task. */
  claims: Map<string, NeedsProofClaim>;
  /** Proofs that explain a completed task's current completion. */
  proofs: Map<string, ProofRecord>;
}

const EMPTY_READ = (): MoneyLegalRead => ({
  states: new Map(),
  claims: new Map(),
  proofs: new Map(),
});

/**
 * Everything the Tasks page needs to show money and legal tasks, for the
 * tasks it already listed. Never throws: a store fault reads as no money or
 * legal tasks, so the page still lists every task (the Sep 15 lesson).
 */
export async function readMoneyLegal(
  store: DataStore,
  organizationId: string,
  tasks: readonly Task[],
): Promise<MoneyLegalRead> {
  try {
    const states = await readMoneyLegalStates(store, organizationId, tasks);
    const on = tasks.filter((t) => states.get(t.id)?.on);
    const open = on.filter(isOpenOrSnoozed);
    const done = on.filter((t) => t.status === 'complete');
    const [rawClaims, touches, rawProofs] = await Promise.all([
      readNeedsProofClaims(
        store,
        organizationId,
        open.map((t) => t.id),
      ),
      latestHumanTaskTouches(store, organizationId, open),
      readProofRecords(
        store,
        organizationId,
        done.map((t) => t.id),
      ),
    ]);
    const claims = new Map<string, NeedsProofClaim>();
    for (const [taskId, claim] of rawClaims) {
      const touched = touches.get(taskId);
      if (!touched || Date.parse(claim.at) > Date.parse(touched)) claims.set(taskId, claim);
    }
    const proofs = new Map<string, ProofRecord>();
    for (const task of done) {
      const proof = rawProofs.get(task.id);
      if (proof && proofExplains(proof.at, task.completed_at)) proofs.set(task.id, proof);
    }
    return { states, claims, proofs };
  } catch {
    return EMPTY_READ();
  }
}

/** The people a task can name, or none when they cannot be read. */
export async function readTaskPeople(
  organizationId: string,
  store: DataStore = getStore(),
): Promise<TaskPerson[]> {
  try {
    return await listTaskPeople(organizationId, store);
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------- the labels */

export interface ProofView {
  /** "Closed with proof · mail.example.com", or "Closed · Sam confirmed". */
  label: string;
  href: string | null;
  note: string | null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

export function proofView(proof: ProofRecord, people: readonly TaskPerson[]): ProofView {
  if (proof.kind === 'link') {
    const host = proof.url ? hostOf(proof.url) : null;
    return {
      label: host ? `Closed with proof · ${host}` : 'Closed with proof',
      href: proof.url,
      note: proof.note,
    };
  }
  const who = personShort(people, proof.confirmedBy);
  return {
    label: who ? `Closed · ${who} confirmed` : 'Closed · confirmed by the team',
    href: null,
    note: proof.note,
  };
}

export interface NeedsProofView {
  /** "The auto-check marked it done · meeting booked Oct 14". */
  label: string;
  reason: string | null;
}

export function needsProofView(claim: NeedsProofClaim, timeZone: string): NeedsProofView {
  const when = claim.evidenceAt ?? claim.at;
  const date = Number.isNaN(Date.parse(when)) ? null : formatMonthDay(when, timeZone);
  const what =
    claim.evidenceType === 'calendar_event'
      ? 'meeting booked'
      : claim.evidenceType === 'gmail_sent'
        ? 'email sent'
        : 'no evidence';
  return {
    label: `The auto-check marked it done · ${what}${date ? ` ${date}` : ''}`,
    reason: claim.reason ? claim.reason.replace(/\s+/g, ' ').trim() : null,
  };
}

/** The badge line for a money or legal row: why it is here, and whether it is going stale. */
export function moneyLegalBadges(
  task: Pick<Task, 'status' | 'snoozed_until' | 'updated_at' | 'created_at'>,
  state: MoneyLegalState | undefined,
  now: Date,
  asleep: boolean,
): { why: string; stale: string | null } | null {
  const why = state ? moneyLegalWhy(state) : null;
  if (!why) return null;
  // A task someone snoozed on purpose is not going stale until it wakes.
  const days =
    asleep || !isOpenOrSnoozed(task) ? null : staleDays(task.updated_at || task.created_at, now);
  return { why, stale: days === null ? null : staleLabel(days) };
}
