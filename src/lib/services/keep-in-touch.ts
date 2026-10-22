import 'server-only';
import {
  cadenceDays,
  cadenceLabel,
  cadenceStatus,
  choiceForDays,
  compareCadenceStatus,
  lastCheckInAt,
  planCheckIns,
  type Cadence,
  type CadenceChoice,
  type CadenceStatus,
  type CheckInCandidate,
} from '@/lib/crm/cadence';
import {
  loadContactEvidence,
  type ContactEvidence,
  type ContactEvidenceIndex,
} from '@/lib/crm/contact-evidence';
import { isMissingTableError } from '@/lib/db/missing-table';
import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import { readTeam } from '@/lib/tasks/principal';
import type { AuditEvent, CrmRecord, Task } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { DEFAULT_TIMEZONE, formatDate } from '@/lib/util/time';

/**
 * Keep-in-touch reminders: a cadence on a company or person, and a Copilot
 * task ("Check in with …") whenever one comes due.
 *
 * A cadence is an `audit_events` row (action `crm.cadence_set`, entity the
 * record) — newest per record wins, and turning one off is a row with no
 * days — so it needs no migration and its history is the audit trail of who
 * set what, when. When it is due is computed on every read from the mail and
 * calendar evidence (lib/crm/contact-evidence.ts, which reads the same
 * relationship index as the profile's Relationship panel, so the two never
 * disagree on a last contact) and from check-in tasks already finished, never
 * stored, so it cannot drift from the records.
 *
 * Tasks are added by `sweepKeepInTouch` — from the daily job, and for one
 * record straight after its cadence is set — under the planning rules in
 * lib/crm/cadence.ts: add-only, and nothing finished is ever brought back.
 */

export const CADENCE_ACTION = 'crm.cadence_set';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_SET_UP =
  'Keep in touch needs the CRM tables, which do not exist yet. Run the CRM migration in the Supabase SQL editor, then reload.';

export type CadenceRecord = Pick<CrmRecord, 'id' | 'kind' | 'name' | 'domain' | 'emails'>;

/** A stored row -> its cadence; null for "turned off"; undefined for a row that is not one. */
function cadenceOf(row: AuditEvent): Cadence | null | undefined {
  const m = row.metadata as Record<string, unknown>;
  if (m.days === null) return null;
  if (typeof m.days !== 'number' || !Number.isInteger(m.days) || m.days < 1) return undefined;
  return {
    days: m.days,
    choice: choiceForDays(m.days),
    setAt: row.created_at,
    setBy: typeof m.by === 'string' ? m.by : null,
    setById: row.user_id,
  };
}

/** The newest cadence per record (null where the newest says "off"). Never throws. */
export async function readCadences(
  store: DataStore,
  organizationId: string,
  recordIds?: readonly string[],
): Promise<Map<string, Cadence | null>> {
  const order = [{ field: 'created_at', direction: 'desc' as const }];
  const rows: AuditEvent[] = [];
  try {
    if (recordIds) {
      for (const group of chunk([...new Set(recordIds)], 100)) {
        rows.push(
          ...((await listAllPages(
            store,
            'audit_events',
            organizationId,
            { eq: { action: CADENCE_ACTION }, in: { entity_id: group } },
            order,
          )) as AuditEvent[]),
        );
      }
    } else {
      rows.push(
        ...((await listAllPages(
          store,
          'audit_events',
          organizationId,
          { eq: { action: CADENCE_ACTION } },
          order,
        )) as AuditEvent[]),
      );
    }
  } catch (error) {
    log.warn('Keep-in-touch cadences could not be read', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  const out = new Map<string, Cadence | null>();
  for (const row of rows) {
    if (!row.entity_id || out.has(row.entity_id)) continue;
    const cadence = cadenceOf(row);
    if (cadence !== undefined) out.set(row.entity_id, cadence);
  }
  return out;
}

const KIND_WORDS: Record<NonNullable<ContactEvidence['lastContactKind']>, string> = {
  inbound: 'an email from them',
  outbound: 'an email to them',
  meeting: 'a meeting',
};

/** "Last contact: an email from them on Sep 2, 2026." */
export function lastContactSentence(evidence: ContactEvidence, timezone = DEFAULT_TIMEZONE) {
  if (!evidence.lastContactAt || !evidence.lastContactKind) return null;
  return `Last contact: ${KIND_WORDS[evidence.lastContactKind]} on ${formatDate(evidence.lastContactAt, timezone)}.`;
}

/** One record with a cadence, where it stands, and the evidence behind it. */
export interface KeepInTouchRow {
  record: CadenceRecord;
  cadence: Cadence;
  status: CadenceStatus;
  evidence: ContactEvidence;
  /** When a check-in task for them was last finished or dismissed. */
  lastCheckInAt: string | null;
}

interface Loaded {
  rows: KeepInTouchRow[];
  tasks: Task[];
}

/** Mail and calendar evidence, or a thrown error: a due date is never worked out without it. */
async function evidenceIndex(
  store: DataStore,
  organizationId: string,
  now: Date,
): Promise<ContactEvidenceIndex> {
  const loaded = await loadContactEvidence(store, organizationId, { now });
  if (!loaded.ok) throw new EvidenceUnavailable(loaded.error.message);
  return loaded.value;
}

class EvidenceUnavailable extends Error {}

/** Records with a live cadence, each with its status, plus every task (for the sweep). */
async function load(
  store: DataStore,
  organizationId: string,
  now: Date,
  recordIds?: readonly string[],
): Promise<Loaded> {
  const cadences = await readCadences(store, organizationId, recordIds);
  const live = [...cadences].filter((e): e is [string, Cadence] => e[1] !== null);
  if (!live.length) return { rows: [], tasks: [] };

  const ids = live.map(([id]) => id).filter((id) => UUID_RE.test(id));
  const records: CrmRecord[] = [];
  for (const group of chunk(ids, 100)) {
    records.push(
      ...((await listAllPages(store, 'crm_records', organizationId, {
        in: { id: group },
      })) as CrmRecord[]),
    );
  }
  const byId = new Map(records.map((r) => [r.id, r]));
  const [evidence, tasks] = await Promise.all([
    evidenceIndex(store, organizationId, now),
    listAllPages(store, 'tasks', organizationId) as Promise<Task[]>,
  ]);

  const rows: KeepInTouchRow[] = [];
  for (const [id, cadence] of live) {
    const record = byId.get(id);
    if (!record) continue;
    const found = evidence.evidenceFor(record);
    const checkIn = lastCheckInAt(tasks, record.id, record.name);
    rows.push({
      record: {
        id: record.id,
        kind: record.kind,
        name: record.name,
        domain: record.domain,
        emails: record.emails,
      },
      cadence,
      status: cadenceStatus({
        cadence,
        lastContactAt: found.lastContactAt,
        lastCheckInAt: checkIn,
        now,
      }),
      evidence: found,
      lastCheckInAt: checkIn,
    });
  }
  rows.sort((a, b) => compareCadenceStatus(a.status, b.status));
  return { rows, tasks };
}

/** Every record with a cadence, overdue first. "Not set up" when the CRM tables are missing. */
export async function listKeepInTouch(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<Result<KeepInTouchRow[]>> {
  try {
    return ok((await load(store, organizationId, now)).rows);
  } catch (error) {
    if (isMissingTableError(error)) return err('not_configured', NOT_SET_UP);
    if (error instanceof EvidenceUnavailable) {
      return err('provider_unavailable', error.message, { retryable: true });
    }
    log.error('Keep-in-touch list failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'The keep-in-touch list could not be read just now.', {
      retryable: true,
    });
  }
}

/** One record's cadence and where it stands, for its profile. */
export interface KeepInTouchProfile {
  cadence: Cadence | null;
  status: CadenceStatus | null;
  evidence: ContactEvidence;
  lastCheckInAt: string | null;
}

export async function keepInTouchFor(
  store: DataStore,
  organizationId: string,
  record: CadenceRecord,
  now: Date = new Date(),
): Promise<Result<KeepInTouchProfile>> {
  try {
    const { rows } = await load(store, organizationId, now, [record.id]);
    const row = rows[0];
    if (row) {
      return ok({
        cadence: row.cadence,
        status: row.status,
        evidence: row.evidence,
        lastCheckInAt: row.lastCheckInAt,
      });
    }
    // No cadence: the last contact is still worth showing beside the picker.
    const index = await evidenceIndex(store, organizationId, now);
    return ok({
      cadence: null,
      status: null,
      evidence: index.evidenceFor(record),
      lastCheckInAt: null,
    });
  } catch (error) {
    if (error instanceof EvidenceUnavailable) {
      return err('provider_unavailable', error.message, { retryable: true });
    }
    log.error('Keep-in-touch profile read failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'Keep in touch could not be read just now.', { retryable: true });
  }
}

export interface SetCadenceInput {
  choice: CadenceChoice | 'off';
  customDays?: number | null;
}

export interface SetCadenceResult {
  cadence: Cadence | null;
  /** Check-in tasks added because the record was already due. */
  created: string[];
}

/**
 * Set or turn off a record's cadence: a new sidecar row, never an edit of an
 * old one. A record already due gets its check-in task straight away.
 */
export async function setCadence(
  store: DataStore,
  organizationId: string,
  recordId: string,
  input: SetCadenceInput,
  actor: { userId: string | null; name: string | null },
  now: Date = new Date(),
): Promise<Result<SetCadenceResult>> {
  if (!UUID_RE.test(recordId)) return err('not_found', 'That record does not exist.');
  const days = input.choice === 'off' ? null : cadenceDays(input.choice, input.customDays);
  if (input.choice !== 'off' && days === null) {
    return err('invalid_input', 'A custom cadence is a whole number of days from 1 to 365.');
  }
  try {
    const record = await store.get('crm_records', organizationId, recordId);
    if (!record) return err('not_found', 'That record does not exist.');
    const row: AuditEvent = {
      id: newId(),
      organization_id: organizationId,
      user_id: actor.userId,
      action: CADENCE_ACTION,
      entity_type: 'crm_record',
      entity_id: record.id,
      // Written directly, not through recordAudit: this row is the setting
      // itself, read back as data, and the action is not an audit verb.
      metadata: { days, by: actor.name },
      ip_hash: null,
      created_at: now.toISOString(),
    };
    await store.insert('audit_events', row);
    const cadence = cadenceOf(row) ?? null;
    const swept = cadence
      ? await sweepKeepInTouch(store, organizationId, { now, recordIds: [record.id], actor })
      : { created: [], existing: [] };
    return ok({ cadence, created: swept.created });
  } catch (error) {
    if (isMissingTableError(error)) {
      return err('not_configured', 'Nothing was saved: the CRM tables do not exist yet.', {
        stillUsable: 'Everything outside the CRM works as before.',
      });
    }
    log.error('Setting a keep-in-touch cadence failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'The cadence could not be saved.', { retryable: true });
  }
}

export interface SweepResult {
  created: string[];
  existing: string[];
}

/**
 * Who a record's check-in tasks are for, and who made them. They are for the
 * organization's principal (lib/tasks/principal.ts): the cadence is on a
 * relationship of the person whose mail and calendar the app reads, and
 * whoever set it (an assistant, often) set it for them. They are made by
 * whoever set the cadence, while still a member; else by the acting user;
 * else by the organization's owner. The same answer from the daily job and
 * from the sweep straight after a cadence is set.
 */
async function checkInPeople(
  store: DataStore,
  organizationId: string,
  actorId: string | null,
): Promise<{ assignee: string | null; creator: (cadence: Cadence) => string | null }> {
  const { members, principal } = await readTeam(store, organizationId);
  const ids = new Set(members.map((m) => m.userId));
  const owner = (members.find((m) => m.role === 'owner') ?? members[0])?.userId ?? null;
  const fallback = actorId && ids.has(actorId) ? actorId : owner;
  return {
    assignee: principal?.userId ?? null,
    creator: (cadence) =>
      cadence.setById && ids.has(cadence.setById) ? cadence.setById : fallback,
  };
}

/**
 * Add a "Check in with …" task for every record whose cadence has come due
 * (see planCheckIns for what is never added twice), for the organization's
 * principal (see checkInPeople). Never throws; a missing table is no tasks,
 * and so is mail and calendar that cannot be read, since a due date cannot
 * be known without them.
 */
export async function sweepKeepInTouch(
  store: DataStore,
  organizationId: string,
  options: {
    now?: Date;
    recordIds?: readonly string[];
    actor?: { userId: string | null };
  } = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  try {
    const { rows, tasks } = await load(store, organizationId, now, options.recordIds);
    if (!rows.length) return { created: [], existing: [] };
    const candidates: CheckInCandidate[] = rows.map((row) => ({
      recordId: row.record.id,
      name: row.record.name,
      status: row.status,
      cadenceLabel: cadenceLabel(row.cadence.days),
      lastContact: lastContactSentence(row.evidence),
    }));
    const plan = planCheckIns(candidates, tasks, now);
    if (!plan.create.length) return { created: [], existing: plan.existing };

    const people = await checkInPeople(store, organizationId, options.actor?.userId ?? null);
    const cadenceOfRecord = new Map(rows.map((row) => [row.record.id, row.cadence]));
    const created: string[] = [];
    const skipped: string[] = [];
    for (const planned of plan.create) {
      const cadence = cadenceOfRecord.get(planned.recordId);
      const assignee = cadence ? people.assignee : null;
      const creator = cadence ? people.creator(cadence) : null;
      if (!assignee || !creator) {
        log.warn('Keep-in-touch task skipped: no organization member to attribute it to', {
          organizationId,
        });
        skipped.push(planned.title);
        continue;
      }
      // The sweep's own clock, so a task always belongs to the round it was made for.
      const at = now.toISOString();
      const task: Task = {
        id: newId(),
        organization_id: organizationId,
        title: planned.title,
        detail: planned.detail,
        status: 'open',
        due_at: planned.dueAt,
        snoozed_until: null,
        deal_id: null,
        portfolio_company_id: null,
        email_message_id: null,
        assigned_to: assignee,
        created_by: creator,
        source: 'suggested',
        completed_at: null,
        created_at: at,
        updated_at: at,
      };
      await store.insert('tasks', task);
      await recordAudit(store, {
        organizationId,
        userId: null,
        action: 'task.created',
        entityType: 'task',
        entityId: task.id,
        metadata: { source: 'keep-in-touch', title: task.title },
      });
      created.push(planned.title);
    }
    return { created, existing: [...plan.existing, ...skipped] };
  } catch (error) {
    if (error instanceof EvidenceUnavailable) {
      log.warn('Keep-in-touch sweep skipped: mail and calendar could not be read', {
        organizationId,
      });
    } else if (!isMissingTableError(error)) {
      log.error('Keep-in-touch sweep failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return { created: [], existing: [] };
  }
}
