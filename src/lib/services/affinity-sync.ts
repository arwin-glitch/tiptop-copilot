import 'server-only';
import { NO_COUNTS, addCounts, affinityDomain, type AffinityCounts } from '@/lib/crm/affinity-csv';
import {
  affinityEntityType,
  affinityPersonName,
  mapAffinityEntries,
  mapAffinityNote,
  noteFingerprint,
  planAffinityColumns,
  withSeenOptions,
  type AffinityApiFieldMeta,
  type AffinityApiList,
  type AffinityApiListEntry,
  type AffinityApiNote,
  type AffinityApiPage,
  type AffinityListType,
  type AffinityNoteRow,
} from '@/lib/crm/affinity-api';
import { crmNameKey } from '@/lib/crm/fields';
import { env } from '@/lib/config/env';
import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { log, redact } from '@/lib/security/redact';
import {
  createAffinityHttp,
  affinityUrl,
  type AffinityHttp,
  type AffinityHttpOptions,
} from '@/lib/services/affinity-client';
import {
  CRM_MIGRATION_FILE,
  crmGuard,
  getCrmSetup,
  upsertEntries,
  upsertList,
  upsertNotes,
  upsertRecords,
  type CrmNoteRow,
  type CrmUpsertSummary,
} from '@/lib/services/crm';
import type {
  AuditEvent,
  CrmEntityType,
  CrmField,
  CrmList,
  CrmNote,
  Organization,
} from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type AppError, type Result } from '@/lib/util/result';

/**
 * The daily Affinity sync: everything in Affinity, pulled into the CRM tables
 * every morning until the subscription is cancelled, with no exports.
 *
 * What it reads (Affinity API v2, `lib/services/affinity-client.ts`):
 *   - every list (`/v2/lists`), its fields, and its entries with all four
 *     kinds of field data — the entry's company, person or opportunity comes
 *     with its global, enriched and relationship fields, so no separate pass
 *     over `/v2/companies` or `/v2/persons` is needed, and that pass would
 *     drag in every contact Affinity ever auto-created from the mailbox;
 *   - the notes (`/v2/notes`), with the companies, people and deals each is
 *     attached to (`includes=…Preview`), which v1's note associations used to
 *     be needed for. After the first run, only notes created or changed since.
 *
 * What it writes: the CRM service's import upserts, with the keys the CSV
 * import used (see `lib/crm/affinity-api.ts`), so a list imported by hand is
 * updated rather than duplicated, and running it twice changes nothing. A
 * value someone changed in Copilot since the last import is kept, as for a
 * CSV re-import. Nothing is ever deleted: a row removed from an Affinity list
 * stays in Copilot.
 *
 * How it runs: in bounded steps. Render (and a GitHub Actions curl) cannot
 * hold one request for a full first pull, so each call does what fits in its
 * time budget, saves where it got to and answers `done: false`; the caller
 * calls again. A step that dies mid-way is safe to repeat — every write is an
 * idempotent upsert — so progress is saved once per step, not per page.
 *
 * Where the progress lives: the newest `audit_events` row with
 * `action = 'crm.affinity_sync'`, `entity_type = 'affinity_sync'`, whose
 * `metadata.state` is the whole state (the run in progress, the last finished
 * run, the notes watermark, a lease). No migration, append-only, and the
 * history of every run comes for free — the same pattern as the list
 * destination overrides in `crm-destinations.ts`. Every step writes two rows:
 * one taking the lease (so a "Sync now" and the daily job never work the same
 * page at once) and one with the progress.
 */

export const AFFINITY_SYNC_ACTION = 'crm.affinity_sync' as const;
export const AFFINITY_SYNC_ENTITY = 'affinity_sync' as const;

const STATE_VERSION = 1;
const DEFAULT_BUDGET_MS = 45_000;
const DEFAULT_MAX_PAGES = 40;
/** A lease outlives its step by this much, in case the step's last write is slow. */
const LEASE_GRACE_MS = 30_000;
/** Notes changed this long before a run started are read again by the next one. */
const NOTES_OVERLAP_MS = 60 * 60_000;
/** How far apart an export's date and the API's can be for the same note (time zones). */
const NOTE_MATCH_WINDOW_MS = 36 * 60 * 60_000;
const ENTRY_FIELD_TYPES = ['list', 'global', 'enriched', 'relationship-intelligence'] as const;
const NOTE_INCLUDES = ['companiesPreview', 'personsPreview', 'opportunitiesPreview'] as const;

export type AffinitySyncTrigger = 'cron' | 'manual';

export interface AffinitySyncCounts {
  /** Lists finished this run. */
  listsDone: number;
  /** Lists that were new to Copilot. */
  listsCreated: number;
  records: AffinityCounts;
  entries: AffinityCounts;
  notes: AffinityCounts;
  /** Notes attached to at least one company, person or deal. */
  notesLinked: number;
  /** Notes a CSV import had stored without an id, now keyed by their Affinity id. */
  notesAdopted: number;
  /** Values changed in Copilot that the sync kept rather than overwrote. */
  keptEdits: number;
  /**
   * Pages skipped: ones that failed to save three times running, and notes
   * Affinity would not send at all. The next run reads them again.
   */
  pagesSkipped: number;
  /**
   * Pages Affinity kept refusing (an expired cursor, a rejected filter) that
   * the sync moved past: restarting the list or the notes from their first
   * page, reading every note instead of the changed ones, or, last, skipping.
   */
  refused: number;
  /** Affinity API requests, retries included. */
  requests: number;
}

interface RunList {
  id: number;
  name: string;
  type: AffinityListType | string;
}

export interface AffinitySyncRun {
  id: string;
  startedAt: string;
  trigger: AffinitySyncTrigger;
  phase: 'lists' | 'notes';
  lists: RunList[];
  listIndex: number;
  /** The next page of the current list's entries; null for its first page. */
  entriesUrl: string | null;
  /** The next page of notes; null for the first. */
  notesUrl: string | null;
  /** Notes created or changed since this instant; null reads every note. */
  notesSince: string | null;
  /** The page that last failed to save, and how many times running. */
  failedAt: string | null;
  failures: number;
  /** The page Affinity last failed to send (a 5xx, the network), and how many times running. */
  fetchFailedAt: string | null;
  fetchFailures: number;
  /** How often the current list, or the notes, has been moved past a refused page. */
  recoveries: number;
  /**
   * A notes page was skipped or the notes were given up: the run has not seen
   * every changed note, so finishing it must not move the watermark past them.
   */
  notesIncomplete: boolean;
  counts: AffinitySyncCounts;
}

export interface AffinitySyncLastRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  trigger: AffinitySyncTrigger;
  counts: AffinitySyncCounts;
}

export interface AffinitySyncState {
  version: typeof STATE_VERSION;
  run: AffinitySyncRun | null;
  last: AffinitySyncLastRun | null;
  notesWatermark: string | null;
  leaseUntil: string | null;
  lastError: { at: string; code: string; message: string } | null;
}

/** What one step did, and how far the run has got. Counts only, never data. */
export interface AffinitySyncStep {
  done: boolean;
  /** Another step holds the lease; nothing was done. Call again shortly. */
  busy: boolean;
  /** Affinity's rate limit ended the step early; call again. */
  rateLimited: boolean;
  phase: 'lists' | 'notes' | 'done';
  listsDone: number;
  listsTotal: number;
  /** The run so far (the finished run's totals when `done`). */
  counts: AffinitySyncCounts;
  /** Pages handled by this call. */
  pages: number;
}

export function emptyAffinitySyncCounts(): AffinitySyncCounts {
  return {
    listsDone: 0,
    listsCreated: 0,
    records: { ...NO_COUNTS },
    entries: { ...NO_COUNTS },
    notes: { ...NO_COUNTS },
    notesLinked: 0,
    notesAdopted: 0,
    keptEdits: 0,
    pagesSkipped: 0,
    refused: 0,
    requests: 0,
  };
}

function emptyState(): AffinitySyncState {
  return {
    version: STATE_VERSION,
    run: null,
    last: null,
    notesWatermark: null,
    leaseUntil: null,
    lastError: null,
  };
}

/* ------------------------------------------------------------------ state */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function parseCounts(raw: unknown): AffinitySyncCounts {
  const out = emptyAffinitySyncCounts();
  if (!isObject(raw)) return out;
  const counts = (v: unknown): AffinityCounts =>
    isObject(v)
      ? {
          inserted: num(v.inserted),
          updated: num(v.updated),
          unchanged: num(v.unchanged),
          skipped: num(v.skipped),
          errors: num(v.errors),
        }
      : { ...NO_COUNTS };
  return {
    listsDone: num(raw.listsDone),
    listsCreated: num(raw.listsCreated),
    records: counts(raw.records),
    entries: counts(raw.entries),
    notes: counts(raw.notes),
    notesLinked: num(raw.notesLinked),
    notesAdopted: num(raw.notesAdopted),
    keptEdits: num(raw.keptEdits),
    pagesSkipped: num(raw.pagesSkipped),
    refused: num(raw.refused),
    requests: num(raw.requests),
  };
}

const trigger = (v: unknown): AffinitySyncTrigger => (v === 'manual' ? 'manual' : 'cron');

/** A stored state, read defensively: anything malformed is dropped, never thrown. */
export function parseAffinitySyncState(raw: unknown): AffinitySyncState | null {
  if (!isObject(raw) || raw.version !== STATE_VERSION) return null;
  const state = emptyState();
  const run = raw.run;
  if (isObject(run) && str(run.id) && str(run.startedAt) && Array.isArray(run.lists)) {
    state.run = {
      id: str(run.id) as string,
      startedAt: str(run.startedAt) as string,
      trigger: trigger(run.trigger),
      phase: run.phase === 'notes' ? 'notes' : 'lists',
      lists: run.lists
        .filter((l): l is Record<string, unknown> => isObject(l) && typeof l.id === 'number')
        .map((l) => ({ id: l.id as number, name: str(l.name) ?? '', type: str(l.type) ?? '' })),
      listIndex: num(run.listIndex),
      entriesUrl: str(run.entriesUrl),
      notesUrl: str(run.notesUrl),
      notesSince: str(run.notesSince),
      failedAt: str(run.failedAt),
      failures: num(run.failures),
      fetchFailedAt: str(run.fetchFailedAt),
      fetchFailures: num(run.fetchFailures),
      recoveries: num(run.recoveries),
      notesIncomplete: run.notesIncomplete === true,
      counts: parseCounts(run.counts),
    };
  }
  const last = raw.last;
  if (isObject(last) && str(last.finishedAt) && str(last.startedAt)) {
    state.last = {
      id: str(last.id) ?? '',
      startedAt: str(last.startedAt) as string,
      finishedAt: str(last.finishedAt) as string,
      trigger: trigger(last.trigger),
      counts: parseCounts(last.counts),
    };
  }
  state.notesWatermark = str(raw.notesWatermark);
  state.leaseUntil = str(raw.leaseUntil);
  const e = raw.lastError;
  state.lastError =
    isObject(e) && str(e.at) && str(e.message)
      ? {
          at: str(e.at) as string,
          code: str(e.code) ?? 'internal',
          message: str(e.message) as string,
        }
      : null;
  return state;
}

interface StoredState {
  state: AffinitySyncState;
  /** When the newest state row was written (ms), so the next is strictly later. */
  at: number;
}

async function readStoredState(
  store: DataStore,
  organizationId: string,
): Promise<StoredState | null> {
  const [row] = await store.list(
    'audit_events',
    organizationId,
    { eq: { action: AFFINITY_SYNC_ACTION, entity_type: AFFINITY_SYNC_ENTITY } },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
  );
  if (!row) return null;
  return {
    state: parseAffinitySyncState(row.metadata?.state) ?? emptyState(),
    at: Date.parse(row.created_at),
  };
}

/** The sync's saved state, or null if it has never run. Never throws. */
export async function readAffinitySyncState(
  store: DataStore,
  organizationId: string,
): Promise<AffinitySyncState | null> {
  try {
    return (await readStoredState(store, organizationId))?.state ?? null;
  } catch (error) {
    log.warn('Affinity sync state could not be read', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Save the state as a new row, strictly after the last one so "newest wins"
 * holds for two writes in the same millisecond. Inserted directly rather than
 * through recordAudit, which swallows a failed write: here the row is the
 * progress, so a failure must be reported.
 */
async function writeState(
  store: DataStore,
  organizationId: string,
  state: AffinitySyncState,
  lastAt: number,
  now: number,
  userId: string | null,
): Promise<number> {
  const at = Number.isNaN(lastAt) ? now : Math.max(now, lastAt + 1);
  const row: AuditEvent = {
    id: newId(),
    organization_id: organizationId,
    user_id: userId,
    action: AFFINITY_SYNC_ACTION,
    entity_type: AFFINITY_SYNC_ENTITY,
    entity_id: null,
    metadata: redact({ state }) as Record<string, unknown>,
    ip_hash: null,
    created_at: new Date(at).toISOString(),
  };
  await store.insert('audit_events', row);
  return at;
}

/* ---------------------------------------------------------- organization */

/**
 * The organization the sync writes into. AFFINITY_API_KEY is one key for the
 * whole deployment, so it may only ever fill one workspace: with any other
 * number of organizations the sync refuses rather than guess (the same rule
 * as the Granola backfill).
 */
export async function affinitySyncOrganization(store: DataStore): Promise<Result<string>> {
  try {
    const organizations = (await store.list('organizations', '', {})) as Organization[];
    if (organizations.length !== 1) {
      return err(
        'conflict',
        'The Affinity sync needs exactly one workspace on this deployment, so it did not run.',
      );
    }
    return ok((organizations[0] as Organization).id);
  } catch (error) {
    log.error('Affinity sync could not read organizations', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'The Affinity sync could not start just now.', { retryable: true });
  }
}

/* ------------------------------------------------------------------- step */

export interface AffinitySyncOptions extends Pick<
  AffinityHttpOptions,
  'fetch' | 'sleep' | 'maxRetries'
> {
  apiKey: string;
  now?: () => number;
  /** How long this step may work before saving and answering. */
  budgetMs?: number;
  /** Pages of entries or notes this step may handle at most. */
  maxPages?: number;
  trigger?: AffinitySyncTrigger;
  /** Who pressed "Sync now"; null for the daily job. */
  userId?: string | null;
}

/** Per-step caches: one list's fields and Copilot list, read once a step. */
interface StepContext {
  store: DataStore;
  organizationId: string;
  http: AffinityHttp;
  fields: Map<number, AffinityApiFieldMeta[]>;
  /** Affinity list id → Copilot list, for linking notes to deal rows. */
  dealLists: Map<string, string> | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** An instant as Affinity's filter syntax takes it: whole seconds, `Z`. */
function filterInstant(value: string): string {
  return new Date(Date.parse(value)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function addSummary(into: AffinityCounts, summary: CrmUpsertSummary): AffinityCounts {
  const { inserted, updated, unchanged, skipped, errors } = summary;
  return addCounts(into, { inserted, updated, unchanged, skipped, errors });
}

function stepOf(state: AffinitySyncState, pages: number, extra: Partial<AffinitySyncStep> = {}) {
  const run = state.run;
  const step: AffinitySyncStep = run
    ? {
        done: false,
        busy: false,
        rateLimited: false,
        phase: run.phase,
        listsDone: Math.min(run.listIndex, run.lists.length),
        listsTotal: run.lists.length,
        counts: run.counts,
        pages,
      }
    : {
        done: true,
        busy: false,
        rateLimited: false,
        phase: 'done',
        listsDone: state.last?.counts.listsDone ?? 0,
        listsTotal: state.last?.counts.listsDone ?? 0,
        counts: state.last?.counts ?? emptyAffinitySyncCounts(),
        pages,
      };
  return { ...step, ...extra };
}

/** Every page of a small collection (lists, a list's fields). */
async function fetchAll<T>(http: AffinityHttp, path: string): Promise<Result<T[]>> {
  const out: T[] = [];
  let url: string | null = affinityUrl(path, { limit: 100 });
  for (let pages = 0; url && pages < 100; pages++) {
    const page: Result<AffinityApiPage<T>> = await http.get<AffinityApiPage<T>>(url);
    if (!page.ok) return page;
    out.push(...(page.value.data ?? []));
    const next: string | null = page.value.pagination?.nextUrl ?? null;
    url = next && next !== url ? next : null;
  }
  return ok(out);
}

/**
 * One step of the sync: start a run if none is in progress, then work through
 * list entries and notes until the budget is spent, and save where it got to.
 */
export async function runAffinitySyncStep(
  store: DataStore,
  organizationId: string,
  options: AffinitySyncOptions,
): Promise<Result<AffinitySyncStep>> {
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const userId = options.userId ?? null;

  const setup = await getCrmSetup(store, organizationId);
  if (!setup.ready) {
    return err(
      'not_configured',
      `Nothing was synced: the CRM tables do not exist yet. Run ${CRM_MIGRATION_FILE} in the Supabase SQL editor first.`,
      { stillUsable: 'Everything outside the CRM works as before.' },
    );
  }

  let stored: StoredState | null;
  try {
    stored = await readStoredState(store, organizationId);
  } catch (error) {
    log.error('Affinity sync state could not be read', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'The Affinity sync could not read its progress just now.', {
      retryable: true,
    });
  }
  const state = stored?.state ?? emptyState();
  let lastAt = stored?.at ?? NaN;
  if (state.leaseUntil && Date.parse(state.leaseUntil) > started) {
    return ok(stepOf(state, 0, { busy: true, done: false }));
  }

  const http = createAffinityHttp({
    apiKey: options.apiKey,
    fetch: options.fetch,
    sleep: options.sleep,
    maxRetries: options.maxRetries,
    now,
    deadline,
  });
  const ctx: StepContext = {
    store,
    organizationId,
    http,
    fields: new Map(),
    dealLists: null,
  };

  const save = async (next: AffinitySyncState) => {
    lastAt = await writeState(store, organizationId, next, lastAt, now(), userId);
  };
  /** Add this step's requests to the run (or, once finished, to its totals). */
  const countRequests = () => {
    const counts = state.run?.counts ?? state.last?.counts;
    if (counts) counts.requests += http.requests;
  };
  const failed = async (error: AppError): Promise<Result<never>> => {
    countRequests();
    state.leaseUntil = null;
    state.lastError = { at: iso(now()), code: error.code, message: error.message };
    try {
      await save(state);
    } catch {
      // The error being reported matters more than this row.
    }
    return { ok: false, error };
  };

  try {
    if (!state.run) {
      const lists = await fetchAll<AffinityApiList>(http, '/v2/lists');
      if (!lists.ok && lists.error.code === 'rate_limited') {
        // Nothing has started yet; the next call starts the run.
        return ok(stepOf(state, 0, { done: false, phase: 'lists', rateLimited: true }));
      }
      if (!lists.ok) return await failed(lists.error);
      state.run = {
        id: newId(),
        startedAt: iso(started),
        trigger: options.trigger ?? 'cron',
        phase: 'lists',
        lists: lists.value
          .filter((l) => l && typeof l.id === 'number' && typeof l.name === 'string')
          .map((l) => ({ id: l.id, name: l.name.trim().slice(0, 300), type: l.type })),
        listIndex: 0,
        entriesUrl: null,
        notesUrl: null,
        notesSince: state.notesWatermark,
        failedAt: null,
        failures: 0,
        fetchFailedAt: null,
        fetchFailures: 0,
        recoveries: 0,
        notesIncomplete: false,
        counts: emptyAffinitySyncCounts(),
      };
    }

    state.leaseUntil = iso(deadline + LEASE_GRACE_MS);
    await save(state);

    let pages = 0;
    let rateLimited = false;
    while (state.run && pages < maxPages && now() < deadline) {
      const run: AffinitySyncRun = state.run;
      const handled = run.phase === 'lists' ? await listsStep(ctx, run) : await notesStep(ctx, run);
      if (!handled.ok) {
        if (handled.error.code === 'rate_limited') {
          rateLimited = true;
          break;
        }
        return await failed(handled.error);
      }
      pages += handled.value.pages;
      if (handled.value.finished) finish(state, run, now());
    }

    countRequests();
    state.leaseUntil = null;
    if (!rateLimited) state.lastError = null;
    await save(state);
    return ok(stepOf(state, pages, { rateLimited }));
  } catch (error) {
    log.error('Affinity sync step failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return await failed({
      code: 'internal',
      message: 'The Affinity sync stopped unexpectedly; the next run picks up where it stopped.',
      retryable: true,
    });
  }
}

/**
 * Close the run: keep its totals as the last run and move the notes
 * watermark, unless a notes page was skipped or the notes were given up.
 * Then the watermark stays where it was, so the next run reads those notes
 * again rather than only the ones changed after today: every run re-reads
 * every list in full, but not every note.
 */
function finish(state: AffinitySyncState, run: AffinitySyncRun, at: number) {
  state.last = {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: iso(at),
    trigger: run.trigger,
    counts: run.counts,
  };
  if (!run.notesIncomplete) {
    state.notesWatermark = iso(Date.parse(run.startedAt) - NOTES_OVERLAP_MS);
  }
  state.run = null;
}

/* ------------------------------------------------------------------ lists */

/** Advance to the next list. */
function nextList(run: AffinitySyncRun) {
  run.listIndex++;
  run.entriesUrl = null;
  run.recoveries = 0;
  run.counts.listsDone++;
}

/** What one unit of work did: pages read, and whether that finished the run. */
interface Progress {
  pages: number;
  finished?: boolean;
}

const NOTHING: Progress = { pages: 0 };

/** Failures that are about the page's data, not about Affinity or the database being away. */
const DATA_FAILURES = new Set(['internal', 'invalid_input', 'too_large', 'conflict']);

/**
 * Whether a page that failed to save should now be skipped: the third failure
 * running at the same page. A page the CRM cannot take must not stop every
 * later list and note from syncing, day after day; a failure that is about
 * Affinity or the database (rate limits, outages, missing tables) never skips.
 */
function giveUpOn(run: AffinitySyncRun, page: string, error: AppError): boolean {
  if (!DATA_FAILURES.has(error.code)) return false;
  run.failures = run.failedAt === page ? run.failures + 1 : 1;
  run.failedAt = page;
  if (run.failures < 3) return false;
  log.warn('Affinity sync skipped a page it could not save three times', {
    phase: run.phase,
    code: error.code,
  });
  run.counts.pagesSkipped++;
  // The skipped notes are read again by the next run (see `finish`).
  if (run.phase === 'notes') run.notesIncomplete = true;
  run.failedAt = null;
  run.failures = 0;
  return true;
}

/** Calls in a row Affinity may fail to send one page (a 5xx, the network) before the sync moves past it. */
const FETCH_ATTEMPTS = 3;

/** What to do about a page Affinity did not send. */
type FetchRecovery =
  /** Report the error; the next call tries the same page again. */
  | 'retry'
  /** The run's place was moved (see `recoverFetch`); carry on from there. */
  | 'moved'
  /** Nothing left to fall back to: give the notes up for this run. */
  | 'give-up';

/**
 * A page Affinity would not send. A rate limit or a refused key is never
 * worked around: the first waits, the second needs a person. A refusal (a
 * 4xx: an expired or invalid cursor, a filter Affinity no longer takes) is the
 * same every time, so it is acted on at once; an outage (a 5xx, the network)
 * only on the third call running at the same page, so a passing blip costs
 * nothing. Acting on it means the next fallback, in order:
 *   - lists: restart the list from its first page (once), else skip the list;
 *   - notes: restart from the first page (once), else read every note rather
 *     than only the changed ones, else give the notes up for this run, which
 *     then keeps the old watermark (`finish`).
 * Each fallback is used at most once per list or per run's notes, so a page
 * that is always refused cannot loop, and no run can be stuck on one.
 */
function recoverFetch(run: AffinitySyncRun, page: string, error: AppError): FetchRecovery {
  if (error.code === 'rate_limited' || error.code === 'provider_unauthorized') return 'retry';
  if (error.retryable) {
    run.fetchFailures = run.fetchFailedAt === page ? run.fetchFailures + 1 : 1;
    run.fetchFailedAt = page;
    if (run.fetchFailures < FETCH_ATTEMPTS) return 'retry';
  }
  run.fetchFailedAt = null;
  run.fetchFailures = 0;
  run.counts.refused++;
  const first = run.recoveries === 0;
  run.recoveries++;
  log.warn('Affinity sync moved past a page Affinity would not send', {
    phase: run.phase,
    code: error.code,
  });
  if (run.phase === 'lists') {
    if (first && run.entriesUrl) run.entriesUrl = null;
    else nextList(run);
    return 'moved';
  }
  if (first && run.notesUrl) {
    run.notesUrl = null;
    return 'moved';
  }
  if (run.notesSince) {
    run.notesSince = null;
    run.notesUrl = null;
    return 'moved';
  }
  run.notesUrl = null;
  run.notesIncomplete = true;
  run.counts.pagesSkipped++;
  return 'give-up';
}

/** A page arrived: an earlier outage at it no longer counts. */
function pageArrived(run: AffinitySyncRun) {
  run.fetchFailedAt = null;
  run.fetchFailures = 0;
}

/** A failed fetch as a step's result: moved on, or the error to report. */
function afterFetchFailure(run: AffinitySyncRun, page: string, error: AppError): Result<Progress> {
  const recovery = recoverFetch(run, page, error);
  if (recovery === 'retry') return { ok: false, error };
  return ok(recovery === 'give-up' ? { pages: 0, finished: true } : NOTHING);
}

/** One page of the current list's entries, or the move on to notes. */
async function listsStep(ctx: StepContext, run: AffinitySyncRun): Promise<Result<Progress>> {
  const list = run.lists[run.listIndex];
  if (!list) {
    run.phase = 'notes';
    run.entriesUrl = null;
    run.recoveries = 0;
    return ok(NOTHING);
  }
  const entityType = affinityEntityType(list.type);
  if (!entityType || !list.name) {
    nextList(run);
    return ok(NOTHING);
  }

  let metas = ctx.fields.get(list.id);
  if (!metas) {
    const fetched = await fetchAll<AffinityApiFieldMeta>(ctx.http, `/v2/lists/${list.id}/fields`);
    if (!fetched.ok) {
      // A list deleted, or made private, since the run started.
      if (fetched.error.code === 'not_found' || fetched.error.code === 'forbidden') {
        nextList(run);
        return ok(NOTHING);
      }
      return afterFetchFailure(run, `fields:${list.id}`, fetched.error);
    }
    metas = fetched.value.filter((m) => m && typeof m.id === 'string');
    ctx.fields.set(list.id, metas);
  }

  const url =
    run.entriesUrl ??
    affinityUrl(`/v2/lists/${list.id}/list-entries`, { limit: 100, fieldTypes: ENTRY_FIELD_TYPES });
  const page = await ctx.http.get<AffinityApiPage<AffinityApiListEntry>>(url);
  if (!page.ok) {
    if (page.error.code === 'not_found' || page.error.code === 'forbidden') {
      nextList(run);
      return ok(NOTHING);
    }
    return afterFetchFailure(run, `lists:${list.id}:${url}`, page.error);
  }
  pageArrived(run);

  const applied = await applyEntries(ctx, run, list, entityType, metas, page.value.data ?? []);
  if (!applied.ok && !giveUpOn(run, `lists:${list.id}:${url}`, applied.error)) return applied;

  const next = page.value.pagination?.nextUrl ?? null;
  if (next && next !== url) run.entriesUrl = next;
  else nextList(run);
  return ok({ pages: 1 });
}

/**
 * The Copilot list an Affinity list goes into: the one already keyed by its
 * id, else one the CSV import made under its name (keyed by nothing), also
 * when the import kept a saved view's suffix ("Deal Pipeline - Active").
 */
async function targetList(
  ctx: StepContext,
  list: RunList,
  entityType: CrmEntityType,
): Promise<Result<CrmList | null>> {
  return crmGuard('write', 'find the list an Affinity list syncs into', async () => {
    const byId = await ctx.store.findOne('crm_lists', ctx.organizationId, {
      eq: { source: 'affinity', external_id: String(list.id) },
    });
    if (byId) return ok(byId);
    const wanted = crmNameKey(list.name);
    const candidates = (
      await listAllPages(ctx.store, 'crm_lists', ctx.organizationId, {
        eq: { source: 'affinity', entity_type: entityType },
      })
    )
      .filter((l) => l.external_id === null)
      .map((l) => ({ list: l, key: crmNameKey(l.name) }))
      .filter((c) => c.key === wanted || c.key.startsWith(`${wanted} - `))
      .sort(
        (a, b) =>
          Number(b.key === wanted) - Number(a.key === wanted) ||
          Number(a.list.archived) - Number(b.list.archived) ||
          a.list.position - b.list.position,
      );
    return ok(candidates[0]?.list ?? null);
  });
}

/** The stored key of a planned column: its own, else the field with its label. */
function storedKey(column: { key: string; name: string }, fields: readonly CrmField[]) {
  const label = crmNameKey(column.name);
  return (
    fields.find((f) => f.key === column.key)?.key ??
    fields.find((f) => crmNameKey(f.name) === label)?.key ??
    null
  );
}

async function applyEntries(
  ctx: StepContext,
  run: AffinitySyncRun,
  list: RunList,
  entityType: CrmEntityType,
  metas: readonly AffinityApiFieldMeta[],
  entries: readonly AffinityApiListEntry[],
): Promise<Result<void>> {
  const { store, organizationId } = ctx;
  const target = await targetList(ctx, list, entityType);
  if (!target.ok) return target;

  // First the list itself (adopting a CSV-imported one), so the plan can
  // match Affinity's fields to the columns it already has.
  const first = await upsertList(store, organizationId, {
    id: target.value?.id ?? null,
    externalId: String(list.id),
    name: list.name,
    entityType,
    fields: [],
  });
  if (!first.ok) return first;
  if (first.value.created) run.counts.listsCreated++;

  const plan = planAffinityColumns(metas, first.value.list.fields, entityType);
  const mapped = mapAffinityEntries(entityType, entries, plan);
  let stored = first.value.list;
  const fields = withSeenOptions(plan.fields, mapped.options);
  if (fields.length) {
    const second = await upsertList(store, organizationId, {
      id: stored.id,
      name: stored.name,
      entityType,
      fields,
    });
    if (!second.ok) return second;
    stored = second.value.list;
  }
  if (!mapped.entries.length) return ok(undefined);

  let recordIds: (string | null)[] = [];
  if (mapped.records.length) {
    const kind = entityType === 'person' ? 'person' : 'company';
    const records = await upsertRecords(store, organizationId, kind, mapped.records);
    if (!records.ok) return records;
    recordIds = records.value.ids;
    run.counts.records = addSummary(run.counts.records, records.value);
  }

  const keys = new Map(plan.columns.map((c) => [c.key, storedKey(c, stored.fields)]));
  const result = await upsertEntries(
    store,
    organizationId,
    stored.id,
    mapped.entries.map((entry) => {
      const values: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entry.values)) {
        const to = keys.get(key);
        if (to) values[to] = value;
      }
      return {
        externalId: entry.externalId,
        title: entry.title,
        recordId: entry.record === null ? null : (recordIds[entry.record] ?? null),
        values,
      };
    }),
  );
  if (!result.ok) return result;
  run.counts.entries = addSummary(run.counts.entries, result.value);
  run.counts.keptEdits += result.value.keptEdits;
  return ok(undefined);
}

/* ------------------------------------------------------------------ notes */

/** One page of notes; the last one finishes the run. */
async function notesStep(ctx: StepContext, run: AffinitySyncRun): Promise<Result<Progress>> {
  const url =
    run.notesUrl ??
    affinityUrl('/v2/notes', {
      limit: 100,
      includes: NOTE_INCLUDES,
      filter: run.notesSince
        ? `createdAt>=${filterInstant(run.notesSince)}|updatedAt>=${filterInstant(run.notesSince)}`
        : null,
    });
  const page = await ctx.http.get<AffinityApiPage<AffinityApiNote>>(url);
  if (!page.ok) return afterFetchFailure(run, `notes:${url}`, page.error);
  pageArrived(run);

  const applied = await applyNotes(ctx, run, page.value.data ?? []);
  if (!applied.ok && !giveUpOn(run, `notes:${url}`, applied.error)) return applied;

  const next = page.value.pagination?.nextUrl ?? null;
  if (next && next !== url) {
    run.notesUrl = next;
    return ok({ pages: 1 });
  }
  run.notesUrl = null;
  return ok({ pages: 1, finished: true });
}

/** Affinity list id → Copilot deal list id, read once a step. */
async function dealLists(ctx: StepContext): Promise<Map<string, string>> {
  if (ctx.dealLists) return ctx.dealLists;
  const lists = await listAllPages(ctx.store, 'crm_lists', ctx.organizationId, {
    eq: { source: 'affinity', entity_type: 'deal' },
  });
  ctx.dealLists = new Map(
    lists.filter((l) => l.external_id).map((l) => [l.external_id as string, l.id]),
  );
  return ctx.dealLists;
}

/**
 * The deal rows a page's notes are attached to, by Affinity opportunity id: on
 * the opportunity's list, the row keyed `entity:<id>` (a CSV import's key),
 * else the one row with the opportunity's name.
 */
async function dealRowsFor(
  ctx: StepContext,
  notes: readonly AffinityNoteRow[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const byList = new Map<string, { id: number; name: string }[]>();
  const lists = await dealLists(ctx);
  for (const note of notes) {
    for (const opp of note.opportunities) {
      const listId = opp.listId === null || opp.listId === undefined ? null : String(opp.listId);
      const copilot = listId ? lists.get(listId) : undefined;
      if (!copilot) continue;
      const group = byList.get(copilot) ?? [];
      group.push({ id: opp.id, name: (opp.name ?? '').trim() });
      byList.set(copilot, group);
    }
  }
  for (const [listId, opps] of byList) {
    for (const group of chunk(opps, 50)) {
      const rows = [
        ...(await listAllPages(ctx.store, 'crm_list_entries', ctx.organizationId, {
          eq: { list_id: listId },
          in: { external_id: group.map((o) => `entity:${o.id}`) },
        })),
        ...(await listAllPages(ctx.store, 'crm_list_entries', ctx.organizationId, {
          eq: { list_id: listId },
          in: { title: group.map((o) => o.name).filter(Boolean) },
        })),
      ];
      for (const opp of group) {
        const keyed = rows.find((r) => r.external_id === `entity:${opp.id}`);
        const named = [
          ...new Set(
            rows.filter((r) => crmNameKey(r.title) === crmNameKey(opp.name)).map((r) => r.id),
          ),
        ];
        const id = keyed?.id ?? (named.length === 1 ? named[0] : undefined);
        if (id) out.set(opp.id, id);
      }
    }
  }
  return out;
}

/**
 * Notes a CSV import stored without an id (keyed by a hash of date, author and
 * text) that are the same notes as these, by text and date: re-keyed by their
 * Affinity id, so the upsert updates them instead of adding a second copy.
 */
async function adoptCsvNotes(ctx: StepContext, notes: readonly AffinityNoteRow[]): Promise<number> {
  const { store, organizationId } = ctx;
  const ids = notes.map((n) => n.externalId);
  const known = new Set<string>();
  for (const group of chunk(ids, 100)) {
    for (const n of await listAllPages(store, 'crm_notes', organizationId, {
      eq: { source: 'affinity' },
      in: { external_id: group },
    })) {
      known.add(n.external_id);
    }
  }
  const fresh = notes.filter((n) => !known.has(n.externalId) && n.occurredAt);
  if (!fresh.length) return 0;

  const times = fresh.map((n) => Date.parse(n.occurredAt as string));
  const legacy = (
    await listAllPages(store, 'crm_notes', organizationId, {
      eq: { source: 'affinity' },
      gte: { occurred_at: iso(Math.min(...times) - NOTE_MATCH_WINDOW_MS) },
      lte: { occurred_at: iso(Math.max(...times) + NOTE_MATCH_WINDOW_MS) },
    })
  ).filter((n) => n.external_id && !/^\d+$/.test(n.external_id));
  if (!legacy.length) return 0;

  const prints = new Map<string, string>(legacy.map((n) => [n.id, noteFingerprint(n.content)]));
  const claimed = new Set<string>();
  let adopted = 0;
  for (const note of fresh) {
    const print = noteFingerprint(note.content);
    if (print.length < 8) continue;
    const at = Date.parse(note.occurredAt as string);
    const author = crmNameKey(note.author ?? '');
    const candidates = legacy
      .filter((n: CrmNote) => {
        if (claimed.has(n.id) || prints.get(n.id) !== print || !n.occurred_at) return false;
        if (Math.abs(Date.parse(n.occurred_at) - at) > NOTE_MATCH_WINDOW_MS) return false;
        const theirs = crmNameKey(n.author ?? '');
        return !author || !theirs || author === theirs;
      })
      .sort(
        (a, b) =>
          Math.abs(Date.parse(a.occurred_at as string) - at) -
          Math.abs(Date.parse(b.occurred_at as string) - at),
      );
    const match = candidates[0];
    if (!match) continue;
    try {
      await store.update('crm_notes', organizationId, match.id, {
        external_id: note.externalId,
        updated_at: new Date().toISOString(),
      });
      claimed.add(match.id);
      adopted++;
    } catch (error) {
      log.warn('Affinity sync could not re-key a CSV note', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return adopted;
}

async function applyNotes(
  ctx: StepContext,
  run: AffinitySyncRun,
  raw: readonly AffinityApiNote[],
): Promise<Result<void>> {
  const { store, organizationId } = ctx;
  const notes = raw.map(mapAffinityNote).filter((n): n is AffinityNoteRow => n !== null);
  if (!notes.length) return ok(undefined);

  return crmGuard('write', 'sync Affinity notes', async () => {
    // The companies and people the notes are about, as records: most already
    // are (from the lists); the rest are made, so the note has a profile to
    // sit on. Teammates are never made into contacts.
    const companies = new Map<number, AffinityNoteRow['companies'][number]>();
    const persons = new Map<number, AffinityNoteRow['persons'][number]>();
    for (const note of notes) {
      for (const c of note.companies) if ((c.name ?? '').trim()) companies.set(c.id, c);
      for (const p of note.persons) persons.set(p.id, p);
    }
    const recordFor = new Map<string, string>();
    if (companies.size) {
      const list = [...companies.values()];
      const result = await upsertRecords(
        store,
        organizationId,
        'company',
        list.map((c) => ({
          externalId: String(c.id),
          name: c.name,
          domain: affinityDomain(c.domain ?? null),
        })),
      );
      if (!result.ok) return result;
      run.counts.records = addSummary(run.counts.records, result.value);
      list.forEach((c, i) => {
        const id = result.value.ids[i];
        if (id) recordFor.set(`company:${c.id}`, id);
      });
    }
    if (persons.size) {
      const list = [...persons.values()];
      const result = await upsertRecords(
        store,
        organizationId,
        'person',
        list.map((p) => ({
          externalId: String(p.id),
          name: affinityPersonName(p) || null,
          primaryEmail: p.primaryEmailAddress ?? null,
          emails: p.primaryEmailAddress ? [p.primaryEmailAddress] : [],
        })),
      );
      if (!result.ok) return result;
      run.counts.records = addSummary(run.counts.records, result.value);
      list.forEach((p, i) => {
        const id = result.value.ids[i];
        if (id) recordFor.set(`person:${p.id}`, id);
      });
    }

    const deals = await dealRowsFor(ctx, notes);
    const links = new Map<string, { records: string[]; entries: string[]; names: string[] }>();
    for (const note of notes) {
      const records = [
        ...note.companies.map((c) => recordFor.get(`company:${c.id}`)),
        ...note.persons.map((p) => recordFor.get(`person:${p.id}`)),
      ].filter((id): id is string => Boolean(id));
      const entries = note.opportunities
        .map((o) => deals.get(o.id))
        .filter((id): id is string => Boolean(id));
      links.set(note.externalId, {
        records: [...new Set(records)],
        entries: [...new Set(entries)],
        names: note.entityNames,
      });
    }

    // A reply is attached to whatever its note is attached to.
    const missingParents = [
      ...new Set(
        notes.map((n) => n.parentId).filter((id): id is string => id !== null && !links.has(id)),
      ),
    ];
    const storedParents = new Map<string, CrmNote>();
    for (const group of chunk(missingParents, 100)) {
      for (const n of await listAllPages(store, 'crm_notes', organizationId, {
        eq: { source: 'affinity' },
        in: { external_id: group },
      })) {
        storedParents.set(n.external_id, n);
      }
    }
    for (const note of notes) {
      if (!note.parentId) continue;
      const own = links.get(note.externalId);
      const inPage = links.get(note.parentId);
      const parent = storedParents.get(note.parentId);
      const from =
        inPage ??
        (parent
          ? { records: parent.record_ids, entries: parent.entry_ids, names: parent.entity_names }
          : null);
      if (own && from) {
        own.records = [...new Set([...own.records, ...from.records])];
        own.entries = [...new Set([...own.entries, ...from.entries])];
        own.names = [...new Set([...own.names, ...from.names])];
      }
    }

    run.counts.notesAdopted += await adoptCsvNotes(ctx, notes);

    const rows: CrmNoteRow[] = notes.map((note) => {
      const link = links.get(note.externalId);
      return {
        externalId: note.externalId,
        content: note.content,
        title: note.title,
        author: note.author,
        occurredAt: note.occurredAt,
        entityNames: link?.names ?? note.entityNames,
        recordIds: link?.records ?? [],
        entryIds: link?.entries ?? [],
      };
    });
    const upserted = await upsertNotes(store, organizationId, rows);
    if (!upserted.ok) return upserted;
    run.counts.notes = addSummary(run.counts.notes, upserted.value);
    run.counts.notesLinked += rows.filter(
      (r, i) =>
        upserted.value.ids[i] && ((r.recordIds?.length ?? 0) > 0 || (r.entryIds?.length ?? 0) > 0),
    ).length;
    return ok(undefined);
  });
}

/**
 * A step as a public log may show it: booleans, a phase name and numbers, in
 * a fresh object so nothing else the step carries can ride along.
 */
export function publicAffinitySyncStep(step: AffinitySyncStep) {
  const c = step.counts;
  return {
    done: step.done,
    busy: step.busy,
    rateLimited: step.rateLimited,
    phase: step.phase,
    listsDone: step.listsDone,
    listsTotal: step.listsTotal,
    pages: step.pages,
    counts: {
      listsDone: c.listsDone,
      listsCreated: c.listsCreated,
      records: { ...c.records },
      entries: { ...c.entries },
      notes: { ...c.notes },
      notesLinked: c.notesLinked,
      notesAdopted: c.notesAdopted,
      keptEdits: c.keptEdits,
      pagesSkipped: c.pagesSkipped,
      refused: c.refused,
      requests: c.requests,
    },
  };
}

export type PublicAffinitySyncStep = ReturnType<typeof publicAffinitySyncStep>;

/* ----------------------------------------------------------------- status */

/** What Knowledge → Affinity import shows about the sync. Counts and times only. */
export interface AffinitySyncStatus {
  /** AFFINITY_API_KEY is set (never the key itself). */
  configured: boolean;
  demo: boolean;
  running: boolean;
  phase: 'lists' | 'notes' | null;
  listsDone: number;
  listsTotal: number;
  lastRun: {
    finishedAt: string;
    trigger: AffinitySyncTrigger;
    lists: number;
    rows: number;
    records: number;
    notes: number;
    /** Rows, records and notes added or changed by that run. */
    changed: number;
    /** Pages that run could not save and skipped; the next run reads them again. */
    skipped: number;
  } | null;
  lastError: { at: string; message: string } | null;
}

function changedIn(c: AffinitySyncCounts): number {
  return (
    c.entries.inserted +
    c.entries.updated +
    c.records.inserted +
    c.records.updated +
    c.notes.inserted +
    c.notes.updated
  );
}

const seen = (c: AffinityCounts) => c.inserted + c.updated + c.unchanged;

/**
 * The sync's status for the page. Never throws and never fails: an unreadable
 * state reads as "not run yet". In demo mode it is an invented example, like
 * the rest of the demo.
 */
export async function getAffinitySyncStatus(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<AffinitySyncStatus> {
  const e = env();
  if (e.demoMode) {
    return {
      configured: true,
      demo: true,
      running: false,
      phase: null,
      listsDone: 0,
      listsTotal: 0,
      lastRun: {
        finishedAt: new Date(now.getTime() - 3 * 60 * 60_000).toISOString(),
        trigger: 'cron',
        lists: 12,
        rows: 37,
        records: 41,
        notes: 18,
        changed: 4,
        skipped: 0,
      },
      lastError: null,
    };
  }
  const state = await readAffinitySyncState(store, organizationId);
  const run = state?.run ?? null;
  const last = state?.last ?? null;
  return {
    configured: Boolean(e.affinityApiKey),
    demo: false,
    running: run !== null,
    phase: run?.phase ?? null,
    listsDone: run ? Math.min(run.listIndex, run.lists.length) : 0,
    listsTotal: run?.lists.length ?? 0,
    lastRun: last
      ? {
          finishedAt: last.finishedAt,
          trigger: last.trigger,
          lists: last.counts.listsDone,
          rows: seen(last.counts.entries),
          records: seen(last.counts.records),
          notes: seen(last.counts.notes),
          changed: changedIn(last.counts),
          skipped: last.counts.pagesSkipped,
        }
      : null,
    lastError: state?.lastError
      ? { at: state.lastError.at, message: state.lastError.message }
      : null,
  };
}
