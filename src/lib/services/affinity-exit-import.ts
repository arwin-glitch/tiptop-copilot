import 'server-only';
import type {
  AffinityApiCompany,
  AffinityApiPage,
  AffinityApiPerson,
} from '@/lib/crm/affinity-api';
import {
  CRM_RECORDS_CEILING,
  REMINDERS_PER_RUN,
  UNLISTED_PER_RUN,
  isOpenReminder,
  reminderTask,
  unlistedCompanyRow,
  unlistedPersonRow,
  type AffinityApiReminder,
} from '@/lib/crm/affinity-exit-import';
import { isMissingTableError } from '@/lib/db/missing-table';
import { chunk } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { log, redact } from '@/lib/security/redact';
import {
  affinityUrl,
  createAffinityHttp,
  type AffinityHttpOptions,
} from '@/lib/services/affinity-client';
import { CRM_MIGRATION_FILE, getCrmSetup, upsertRecords } from '@/lib/services/crm';
import { readTeam } from '@/lib/tasks/principal';
import type { AuditEvent, CrmRecord, Task } from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';
import { err, ok, type AppError, type Result } from '@/lib/util/result';

/**
 * The opt-in copies on the Affinity exit checklist: what the daily sync
 * leaves in Affinity on purpose, brought over only when the owner presses
 * the button, with progress, in bounded steps the page calls in a loop —
 * the same shape as "Sync now" (lib/services/affinity-sync.ts).
 *
 *   - `contacts`: the companies and people on no list. The daily sync reads
 *     lists, not Affinity's whole directory, because the directory holds every
 *     contact Affinity ever made from the mailbox. This pages through
 *     `/v2/companies`, then `/v2/persons`, and adds the ones Kraken does not
 *     have, by Affinity id — so it is idempotent, and anything already in
 *     Kraken (from a list or a note) is left exactly as it is. Capped per
 *     press and by a workspace ceiling (lib/crm/affinity-exit-import.ts), so it
 *     cannot fill a free database.
 *   - `reminders`: open reminders (`/v2/reminders`), each a Kraken task. A
 *     task's id is derived from the reminder's, so copying twice adds nothing,
 *     and a task someone already finished is never brought back.
 *
 * Progress lives where the sync's does: the newest `audit_events` row with
 * `action = 'crm.affinity_exit_import'`, `entity_id` the kind. Counts and a
 * cursor only — never a name or the key. A step that dies half-way is safe to
 * repeat: every write is keyed.
 */

export const AFFINITY_EXIT_IMPORT_ACTION = 'crm.affinity_exit_import' as const;
export const AFFINITY_EXIT_IMPORT_ENTITY = 'affinity_exit_import' as const;

export const AFFINITY_EXIT_IMPORT_KINDS = ['contacts', 'reminders'] as const;
export type AffinityExitImportKind = (typeof AFFINITY_EXIT_IMPORT_KINDS)[number];

type Phase = 'companies' | 'persons' | 'reminders' | 'done';

const PAGE_LIMIT = 100;
const DEFAULT_BUDGET_MS = 20_000;
const DEFAULT_MAX_PAGES = 30;
const LEASE_GRACE_MS = 30_000;

export interface AffinityExitImportState {
  v: 1;
  phase: Phase;
  /** The next page of the current phase; null for its first page. */
  nextUrl: string | null;
  /** Read from Affinity since this pass started. */
  scanned: number;
  /** Of those, already in Kraken. */
  existing: number;
  /** Copied into Kraken, over every press. */
  copied: number;
  /** Left out on purpose: teammates and nameless contacts, finished reminders. */
  skipped: number;
  /** Rows that could not be saved; the next pass tries them again. */
  errors: number;
  /** Copied by the press under way, against its cap. */
  runCopied: number;
  /** Reminders only: how many are open in Affinity, when it said. */
  openTotal: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  leaseUntil: string | null;
  lastError: { at: string; message: string } | null;
}

/** What one step did. Counts only. */
export interface AffinityExitImportStep {
  kind: AffinityExitImportKind;
  done: boolean;
  /** Another step holds the lease; call again shortly. */
  busy: boolean;
  rateLimited: boolean;
  /** This press copied its most; the next press carries on from here. */
  capped: boolean;
  phase: Phase;
  scanned: number;
  existing: number;
  copied: number;
  runCopied: number;
  skipped: number;
  errors: number;
  openTotal: number | null;
}

function firstPhase(kind: AffinityExitImportKind): Phase {
  return kind === 'contacts' ? 'companies' : 'reminders';
}

function emptyState(kind: AffinityExitImportKind): AffinityExitImportState {
  return {
    v: 1,
    phase: firstPhase(kind),
    nextUrl: null,
    scanned: 0,
    existing: 0,
    copied: 0,
    skipped: 0,
    errors: 0,
    runCopied: 0,
    openTotal: null,
    startedAt: null,
    finishedAt: null,
    leaseUntil: null,
    lastError: null,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const PHASES: readonly Phase[] = ['companies', 'persons', 'reminders', 'done'];

/** A stored state, read defensively; anything malformed reads as never run. */
export function parseAffinityExitImportState(
  kind: AffinityExitImportKind,
  raw: unknown,
): AffinityExitImportState {
  const out = emptyState(kind);
  if (!isObject(raw) || raw.v !== 1) return out;
  const phase = PHASES.includes(raw.phase as Phase) ? (raw.phase as Phase) : out.phase;
  // A phase of the other kind (a hand-edited row) starts over rather than mixing.
  const belongs =
    phase === 'done' || (kind === 'contacts' ? phase !== 'reminders' : phase === 'reminders');
  out.phase = belongs ? phase : out.phase;
  out.nextUrl = str(raw.nextUrl);
  out.scanned = num(raw.scanned);
  out.existing = num(raw.existing);
  out.copied = num(raw.copied);
  out.skipped = num(raw.skipped);
  out.errors = num(raw.errors);
  out.runCopied = num(raw.runCopied);
  out.openTotal = typeof raw.openTotal === 'number' ? raw.openTotal : null;
  out.startedAt = str(raw.startedAt);
  out.finishedAt = str(raw.finishedAt);
  out.leaseUntil = str(raw.leaseUntil);
  const e = raw.lastError;
  out.lastError =
    isObject(e) && str(e.at) && str(e.message)
      ? { at: str(e.at) as string, message: str(e.message) as string }
      : null;
  return out;
}

interface Stored {
  state: AffinityExitImportState;
  at: number;
}

async function readStored(
  store: DataStore,
  organizationId: string,
  kind: AffinityExitImportKind,
): Promise<Stored | null> {
  const [row] = await store.list(
    'audit_events',
    organizationId,
    {
      eq: {
        action: AFFINITY_EXIT_IMPORT_ACTION,
        entity_type: AFFINITY_EXIT_IMPORT_ENTITY,
        entity_id: kind,
      },
    },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
  );
  if (!row) return null;
  return {
    state: parseAffinityExitImportState(kind, row.metadata?.state),
    at: Date.parse(row.created_at),
  };
}

async function writeState(
  store: DataStore,
  organizationId: string,
  kind: AffinityExitImportKind,
  state: AffinityExitImportState,
  lastAt: number,
  now: number,
  userId: string | null,
): Promise<number> {
  const at = Number.isNaN(lastAt) ? now : Math.max(now, lastAt + 1);
  const row: AuditEvent = {
    id: newId(),
    organization_id: organizationId,
    user_id: userId,
    action: AFFINITY_EXIT_IMPORT_ACTION,
    entity_type: AFFINITY_EXIT_IMPORT_ENTITY,
    entity_id: kind,
    metadata: redact({ state }) as Record<string, unknown>,
    ip_hash: null,
    created_at: new Date(at).toISOString(),
  };
  await store.insert('audit_events', row);
  return at;
}

/* --------------------------------------------------------------- summary */

/** What the checklist shows about one copy: counts and times, never data. */
export interface AffinityExitImportSummary {
  kind: AffinityExitImportKind;
  /** Never pressed, part-way (capped, stopped or still going), or a pass finished. */
  state: 'never' | 'partial' | 'done';
  /** A step holds the lease right now. */
  running: boolean;
  scanned: number;
  existing: number;
  copied: number;
  skipped: number;
  openTotal: number | null;
  finishedAt: string | null;
  lastError: { at: string; message: string } | null;
}

function summaryOf(
  kind: AffinityExitImportKind,
  stored: Stored | null,
  now: number,
): AffinityExitImportSummary {
  const s = stored?.state ?? emptyState(kind);
  return {
    kind,
    state: !stored ? 'never' : s.phase === 'done' ? 'done' : 'partial',
    running: Boolean(s.leaseUntil && Date.parse(s.leaseUntil) > now),
    scanned: s.scanned,
    existing: s.existing,
    copied: s.copied,
    skipped: s.skipped,
    openTotal: s.openTotal,
    finishedAt: s.finishedAt,
    lastError: s.lastError,
  };
}

/** Both copies' summaries. Never throws: an unreadable state reads as never run. */
export async function readAffinityExitImports(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<Record<AffinityExitImportKind, AffinityExitImportSummary>> {
  const read = async (kind: AffinityExitImportKind) => {
    try {
      return summaryOf(kind, await readStored(store, organizationId, kind), now.getTime());
    } catch (error) {
      log.warn('Affinity exit copy state could not be read', {
        kind,
        reason: error instanceof Error ? error.message : String(error),
      });
      return summaryOf(kind, null, now.getTime());
    }
  };
  const [contacts, reminders] = await Promise.all([read('contacts'), read('reminders')]);
  return { contacts, reminders };
}

/* ------------------------------------------------------------------ step */

export interface AffinityExitImportOptions extends Pick<
  AffinityHttpOptions,
  'fetch' | 'sleep' | 'maxRetries'
> {
  apiKey: string;
  /** Who pressed the button: the reminders' tasks are theirs. */
  userId: string | null;
  /** The first call of a press: its cap starts again, and a finished pass starts over. */
  fresh?: boolean;
  now?: () => number;
  budgetMs?: number;
  maxPages?: number;
  /** Rows one press copies at most; defaults to the kind's cap. */
  perRun?: number;
  /** Contacts only: the workspace's most companies and people. */
  ceiling?: number;
}

/** The task id an Affinity reminder becomes: fixed by the two ids, so it is made once. */
export function reminderTaskId(organizationId: string, reminderId: number): string {
  const h = sha256(`${organizationId}|affinity-reminder|${reminderId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A refusal as the person who pressed the button should read it. */
function friendly(kind: AffinityExitImportKind, error: AppError): AppError {
  if (error.code === 'provider_unauthorized') {
    return { ...error, message: 'Affinity refused the API key, so nothing more was copied.' };
  }
  if (error.code === 'forbidden') {
    return {
      ...error,
      message:
        kind === 'contacts'
          ? 'The Affinity key may not read the whole directory of companies and people (Affinity calls it the "Export All" permission), so nothing more was copied.'
          : 'The Affinity key may not read reminders, so nothing was copied.',
    };
  }
  return error;
}

function stepOf(
  kind: AffinityExitImportKind,
  state: AffinityExitImportState,
  extra: Partial<AffinityExitImportStep> = {},
): AffinityExitImportStep {
  return {
    kind,
    done: state.phase === 'done',
    busy: false,
    rateLimited: false,
    capped: false,
    phase: state.phase,
    scanned: state.scanned,
    existing: state.existing,
    copied: state.copied,
    runCopied: state.runCopied,
    skipped: state.skipped,
    errors: state.errors,
    openTotal: state.openTotal,
    ...extra,
  };
}

/**
 * Who the tasks a press copies are for, and who made them. They are for the
 * organization's principal (lib/tasks/principal.ts): the reminders are on the
 * relationships of the person whose mail the app reads, whoever presses the
 * button. They are made by whoever pressed, else by the workspace owner.
 */
async function reminderPeople(
  store: DataStore,
  organizationId: string,
  userId: string | null,
): Promise<{ assignee: string; creator: string } | null> {
  const { members, principal } = await readTeam(store, organizationId);
  const creator = userId ?? (members.find((m) => m.role === 'owner') ?? members[0])?.userId;
  if (!principal || !creator) return null;
  return { assignee: principal.userId, creator };
}

/**
 * One step of a copy: read pages until the budget, the page cap or the
 * press's cap, save where it got to, and answer.
 */
export async function runAffinityExitImportStep(
  store: DataStore,
  organizationId: string,
  kind: AffinityExitImportKind,
  options: AffinityExitImportOptions,
): Promise<Result<AffinityExitImportStep>> {
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const perRun = options.perRun ?? (kind === 'contacts' ? UNLISTED_PER_RUN : REMINDERS_PER_RUN);
  const ceiling = options.ceiling ?? CRM_RECORDS_CEILING;
  const userId = options.userId;

  if (kind === 'contacts') {
    const setup = await getCrmSetup(store, organizationId);
    if (!setup.ready) {
      return err(
        'not_configured',
        `Nothing was copied: the CRM tables do not exist yet. Run ${CRM_MIGRATION_FILE} in the Supabase SQL editor first.`,
      );
    }
  }

  let stored: Stored | null;
  try {
    stored = await readStored(store, organizationId, kind);
  } catch (error) {
    log.error('Affinity exit copy state could not be read', {
      kind,
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'The copy could not read its progress just now.', { retryable: true });
  }
  const state = stored?.state ?? emptyState(kind);
  let lastAt = stored?.at ?? NaN;
  if (state.leaseUntil && Date.parse(state.leaseUntil) > started) {
    return ok(stepOf(kind, state, { busy: true, done: false }));
  }

  if (options.fresh) {
    state.runCopied = 0;
    state.lastError = null;
    if (state.phase === 'done' || !state.startedAt) {
      // A new pass: the counts of the last one start again; what was copied stays counted.
      const copied = state.copied;
      Object.assign(state, emptyState(kind), {
        copied,
        startedAt: new Date(started).toISOString(),
      });
    }
  } else if (state.phase === 'done') {
    return ok(stepOf(kind, state));
  }

  const save = async () => {
    lastAt = await writeState(store, organizationId, kind, state, lastAt, now(), userId);
  };
  const failed = async (error: AppError): Promise<Result<never>> => {
    state.leaseUntil = null;
    state.lastError = { at: new Date(now()).toISOString(), message: error.message };
    try {
      await save();
    } catch {
      // The error being reported matters more than this row.
    }
    return { ok: false, error };
  };

  // The ceiling, before anything is read: a full workspace says so and stops.
  if (kind === 'contacts') {
    let held: number;
    try {
      held = await store.count('crm_records', organizationId);
    } catch (error) {
      log.warn('Affinity exit copy could not count records', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return err('internal', 'The copy could not check how much Kraken holds just now.', {
        retryable: true,
      });
    }
    if (held + PAGE_LIMIT > ceiling) {
      return await failed({
        code: 'too_large',
        message: `Kraken already holds ${held.toLocaleString('en-US')} companies and people, close to the ${ceiling.toLocaleString('en-US')} this copy stops at so the database stays well inside its plan. Nothing more was copied.`,
      });
    }
  }

  const http = createAffinityHttp({
    apiKey: options.apiKey,
    fetch: options.fetch,
    sleep: options.sleep,
    maxRetries: options.maxRetries,
    now,
    deadline,
  });

  try {
    state.leaseUntil = new Date(deadline + LEASE_GRACE_MS).toISOString();
    await save();

    // How many reminders are open, once a pass: best effort, for the page only.
    if (kind === 'reminders' && state.openTotal === null && state.nextUrl === null) {
      const counted = await http.get<{ pagination?: { totalCount?: number | null } | null }>(
        affinityUrl('/v2/reminders', {
          limit: 1,
          totalCount: 'true',
          filter: 'status=active|status=overdue',
        }),
      );
      if (counted.ok && typeof counted.value.pagination?.totalCount === 'number') {
        state.openTotal = counted.value.pagination.totalCount;
      } else if (!counted.ok && counted.error.code === 'provider_unauthorized') {
        return await failed(friendly(kind, counted.error));
      }
    }

    const people =
      kind === 'reminders' ? await reminderPeople(store, organizationId, userId) : null;
    if (kind === 'reminders' && !people) {
      return await failed({
        code: 'conflict',
        message: 'No one in this workspace to give the tasks to, so nothing was copied.',
      });
    }

    let pages = 0;
    let rateLimited = false;
    let capped = false;
    while (state.phase !== 'done' && pages < maxPages && now() < deadline) {
      // A page adds at most PAGE_LIMIT rows: stop before one could pass the cap.
      if (state.runCopied + PAGE_LIMIT > perRun) {
        capped = true;
        break;
      }
      const url = state.nextUrl ?? affinityUrl(`/v2/${state.phase}`, { limit: PAGE_LIMIT });
      const page = await http.get<AffinityApiPage<unknown>>(url);
      if (!page.ok) {
        if (page.error.code === 'rate_limited') {
          rateLimited = true;
          break;
        }
        return await failed(friendly(kind, page.error));
      }
      const data = page.value.data ?? [];
      const applied =
        kind === 'contacts'
          ? await applyContacts(store, organizationId, state, data)
          : await applyReminders(
              store,
              organizationId,
              state,
              data,
              people as { assignee: string; creator: string },
              now,
            );
      if (!applied.ok) return await failed(applied.error);
      pages++;

      const next = page.value.pagination?.nextUrl ?? null;
      if (next && next !== url) {
        state.nextUrl = next;
      } else {
        state.nextUrl = null;
        if (state.phase === 'companies') {
          state.phase = 'persons';
        } else {
          state.phase = 'done';
          state.finishedAt = new Date(now()).toISOString();
        }
      }
      // Stop at a ceiling reached mid-press, too.
      if (kind === 'contacts' && state.phase !== 'done') {
        const held = await store.count('crm_records', organizationId);
        if (held + PAGE_LIMIT > ceiling) {
          capped = true;
          break;
        }
      }
    }

    state.leaseUntil = null;
    if (!rateLimited) state.lastError = null;
    await save();
    return ok(stepOf(kind, state, { rateLimited, capped }));
  } catch (error) {
    log.error('Affinity exit copy step failed', {
      kind,
      reason: error instanceof Error ? error.message : String(error),
    });
    return await failed({
      code: isMissingTableError(error) ? 'not_configured' : 'internal',
      message: 'The copy stopped unexpectedly; pressing again carries on where it stopped.',
      retryable: true,
    });
  }
}

/* -------------------------------------------------------------- contacts */

async function applyContacts(
  store: DataStore,
  organizationId: string,
  state: AffinityExitImportState,
  data: readonly unknown[],
): Promise<Result<void>> {
  const kind = state.phase === 'companies' ? 'company' : 'person';
  const rows = data
    .map((item) =>
      kind === 'company'
        ? unlistedCompanyRow(item as AffinityApiCompany)
        : unlistedPersonRow(item as AffinityApiPerson),
    )
    .filter((r): r is NonNullable<typeof r> => r !== null);
  state.scanned += data.length;
  state.skipped += data.length - rows.length;
  if (!rows.length) return ok(undefined);

  // The ones Kraken already has, by Affinity id, are left exactly as they are.
  const known = new Set<string>();
  for (const group of chunk(
    rows.map((r) => String(r.externalId)),
    100,
  )) {
    for (const r of (await store.list('crm_records', organizationId, {
      eq: { kind, source: 'affinity' },
      in: { external_id: group },
    })) as CrmRecord[]) {
      if (r.external_id) known.add(r.external_id);
    }
  }
  const fresh = rows.filter((r) => !known.has(String(r.externalId)));
  state.existing += rows.length - fresh.length;
  if (!fresh.length) return ok(undefined);

  const result = await upsertRecords(store, organizationId, kind, fresh);
  if (!result.ok) return result;
  const added = result.value.inserted + result.value.updated;
  state.copied += added;
  state.runCopied += added;
  state.existing += result.value.unchanged;
  state.skipped += result.value.skipped;
  state.errors += result.value.errors;
  return ok(undefined);
}

/* ------------------------------------------------------------- reminders */

/** The names of the companies and people some reminders are on, by `company:<id>` / `person:<id>`. */
async function namesFor(
  store: DataStore,
  organizationId: string,
  reminders: readonly AffinityApiReminder[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted: Record<'company' | 'person', string[]> = { company: [], person: [] };
  for (const r of reminders) {
    if (r.company && typeof r.company.id === 'number') wanted.company.push(String(r.company.id));
    if (r.person && typeof r.person.id === 'number') wanted.person.push(String(r.person.id));
  }
  try {
    for (const kind of ['company', 'person'] as const) {
      for (const group of chunk([...new Set(wanted[kind])], 100)) {
        for (const r of (await store.list('crm_records', organizationId, {
          eq: { kind, source: 'affinity' },
          in: { external_id: group },
        })) as CrmRecord[]) {
          if (r.external_id) out.set(`${kind}:${r.external_id}`, r.name);
        }
      }
    }
  } catch (error) {
    // Without the CRM tables a task says what to do, just not about whom.
    if (!isMissingTableError(error)) throw error;
  }
  return out;
}

async function applyReminders(
  store: DataStore,
  organizationId: string,
  state: AffinityExitImportState,
  data: readonly unknown[],
  people: { assignee: string; creator: string },
  now: () => number,
): Promise<Result<void>> {
  const reminders = data as AffinityApiReminder[];
  const open = reminders.filter(isOpenReminder);
  state.scanned += reminders.length;
  state.skipped += reminders.length - open.length;
  if (!open.length) return ok(undefined);

  const ids = open.map((r) => reminderTaskId(organizationId, r.id));
  const known = new Set<string>();
  for (const group of chunk(ids, 100)) {
    for (const t of await store.list('tasks', organizationId, { in: { id: group } })) {
      known.add(t.id);
    }
  }
  const fresh = open.filter((_, i) => !known.has(ids[i] as string));
  state.existing += open.length - fresh.length;
  if (!fresh.length) return ok(undefined);

  const names = await namesFor(store, organizationId, fresh);
  const at = new Date(now()).toISOString();
  const tasks: Task[] = fresh.map((reminder) => {
    const about =
      (reminder.company ? names.get(`company:${reminder.company.id}`) : undefined) ??
      (reminder.person ? names.get(`person:${reminder.person.id}`) : undefined) ??
      null;
    const task = reminderTask(reminder, about);
    return {
      id: reminderTaskId(organizationId, reminder.id),
      organization_id: organizationId,
      title: task.title,
      detail: task.detail,
      status: 'open',
      due_at: task.dueAt,
      snoozed_until: null,
      deal_id: null,
      portfolio_company_id: null,
      email_message_id: null,
      assigned_to: people.assignee,
      created_by: people.creator,
      source: 'suggested',
      completed_at: null,
      created_at: at,
      updated_at: at,
    };
  });
  for (const group of chunk(tasks, 100)) {
    try {
      await store.insertMany('tasks', group);
      state.copied += group.length;
      state.runCopied += group.length;
    } catch {
      // One that a parallel press made first must not sink the rest.
      for (const task of group) {
        try {
          await store.insert('tasks', task);
          state.copied++;
          state.runCopied++;
        } catch {
          state.errors++;
        }
      }
    }
  }
  return ok(undefined);
}

/** A step as the page may show it: a fresh object of counts, nothing else. */
export function publicAffinityExitImportStep(step: AffinityExitImportStep) {
  return {
    kind: step.kind,
    done: step.done,
    busy: step.busy,
    rateLimited: step.rateLimited,
    capped: step.capped,
    phase: step.phase,
    scanned: step.scanned,
    existing: step.existing,
    copied: step.copied,
    runCopied: step.runCopied,
    skipped: step.skipped,
    errors: step.errors,
    openTotal: step.openTotal,
  };
}

export type PublicAffinityExitImportStep = ReturnType<typeof publicAffinityExitImportStep>;
