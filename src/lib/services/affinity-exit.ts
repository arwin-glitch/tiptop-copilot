import 'server-only';
import {
  affinityDailySyncState,
  affinityExitCountdown,
  affinityExitTodayLine,
  applyAffinityExitChange,
  emptyAffinityExitSettings,
  parseAffinityExitSettings,
  type AffinityDailySyncState,
  type AffinityExitChange,
  type AffinityExitCountdown,
  type AffinityExitSettings,
} from '@/lib/crm/affinity-exit';
import type { DataStore, Filter } from '@/lib/db/store';
import { log, redact } from '@/lib/security/redact';
import { getAffinitySyncStatus, type AffinitySyncStatus } from '@/lib/services/affinity-sync';
import {
  readAffinityExitImports,
  type AffinityExitImportKind,
  type AffinityExitImportSummary,
} from '@/lib/services/affinity-exit-import';
import { getCrmSetup } from '@/lib/services/crm';
import { INTRODUCTION_ACTION } from '@/lib/services/introductions';
import type { AuditEvent } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * The Affinity exit checklist's data: the settings the workspace typed in
 * (notice date, cancelled, outside tools) and the status rows worked out from
 * what Copilot already holds.
 *
 * Where the settings live: like the daily sync's progress, the newest
 * `audit_events` row with `action = 'crm.affinity_exit'` holds them whole in
 * `metadata.settings`, and each change appends a row. No migration (the table
 * is in every deployment, so nothing can run ahead of a hand-applied
 * migration), and the history of who moved the date or ticked a tool comes
 * for free. A read that fails reads as "nothing set yet", never an error.
 */

export const AFFINITY_EXIT_ACTION = 'crm.affinity_exit' as const;
export const AFFINITY_EXIT_ENTITY = 'affinity_exit' as const;

interface StoredSettings {
  settings: AffinityExitSettings;
  at: number;
}

async function readStored(
  store: DataStore,
  organizationId: string,
): Promise<StoredSettings | null> {
  const [row] = await store.list(
    'audit_events',
    organizationId,
    { eq: { action: AFFINITY_EXIT_ACTION, entity_type: AFFINITY_EXIT_ENTITY } },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
  );
  if (!row) return null;
  return {
    settings: parseAffinityExitSettings(row.metadata?.settings),
    at: Date.parse(row.created_at),
  };
}

/** The checklist's settings; empty until someone sets something. Never throws. */
export async function readAffinityExitSettings(
  store: DataStore,
  organizationId: string,
): Promise<AffinityExitSettings> {
  try {
    return (await readStored(store, organizationId))?.settings ?? emptyAffinityExitSettings();
  } catch (error) {
    log.warn('Affinity exit settings could not be read', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return emptyAffinityExitSettings();
  }
}

/**
 * Apply one change to the newest settings and save the result as a new row,
 * strictly after the last one so "newest wins" holds within a millisecond.
 */
export async function changeAffinityExitSettings(
  store: DataStore,
  organizationId: string,
  change: AffinityExitChange,
  actor: { userId: string | null },
  now: Date = new Date(),
): Promise<Result<AffinityExitSettings>> {
  let stored: StoredSettings | null;
  try {
    stored = await readStored(store, organizationId);
  } catch (error) {
    log.error('Affinity exit settings could not be read', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'The checklist could not be read just now. Try again.', {
      retryable: true,
    });
  }
  const applied = applyAffinityExitChange(stored?.settings ?? emptyAffinityExitSettings(), change, {
    now,
    id: newId,
  });
  if (!applied.ok) return err('invalid_input', applied.message);

  const lastAt = stored?.at ?? NaN;
  const at = Number.isNaN(lastAt) ? now.getTime() : Math.max(now.getTime(), lastAt + 1);
  const row: AuditEvent = {
    id: newId(),
    organization_id: organizationId,
    user_id: actor.userId,
    action: AFFINITY_EXIT_ACTION,
    entity_type: AFFINITY_EXIT_ENTITY,
    entity_id: null,
    // Redacted like any audit row: a key pasted into a tool's name is not kept.
    metadata: redact({ change: change.op, settings: applied.settings }) as Record<string, unknown>,
    ip_hash: null,
    created_at: new Date(at).toISOString(),
  };
  try {
    await store.insert('audit_events', row);
  } catch (error) {
    log.error('Affinity exit settings could not be saved', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'The change could not be saved. Try again.', { retryable: true });
  }
  return ok(parseAffinityExitSettings((row.metadata as { settings?: unknown }).settings));
}

/** Today's one line, or null. Never throws (a fault only hides the line). */
export async function readAffinityExitTodayLine(
  store: DataStore,
  organizationId: string,
  now: Date,
  timeZone: string,
): Promise<AffinityExitCountdown | null> {
  return affinityExitTodayLine(
    await readAffinityExitSettings(store, organizationId),
    now,
    timeZone,
  );
}

/* ---------------------------------------------------------------- status */

/** Introduction rows read at most, to count them: a few thousand introductions. */
const INTRO_ROWS_MAX = 5_000;
const INTRO_PAGE = 1_000;

/** Everything the checklist shows. A number that could not be read is null ("unknown"). */
export interface AffinityExitStatus {
  settings: AffinityExitSettings;
  countdown: AffinityExitCountdown | null;
  /** The CRM tables exist; without them every CRM count is unknown. */
  crmReady: boolean;
  lists: number | null;
  companies: number | null;
  people: number | null;
  notes: number | null;
  introductions: {
    /** Distinct introductions imported from Affinity's export. */
    count: number | null;
    /** More rows than were read: the count is at least this. */
    atLeast: boolean;
    lastImportAt: string | null;
  };
  sync: {
    state: AffinityDailySyncState;
    demo: boolean;
    lastRunAt: string | null;
    stoppedAt: string | null;
  };
  imports: Record<AffinityExitImportKind, AffinityExitImportSummary>;
}

async function countOrNull(
  store: DataStore,
  table: 'crm_lists' | 'crm_records' | 'crm_notes',
  organizationId: string,
  filter: Filter,
): Promise<number | null> {
  try {
    return await store.count(table, organizationId, filter);
  } catch {
    return null;
  }
}

async function introductionCounts(
  store: DataStore,
  organizationId: string,
): Promise<AffinityExitStatus['introductions']> {
  try {
    const intros = new Set<string>();
    let rows = 0;
    for (let offset = 0; offset < INTRO_ROWS_MAX; offset += INTRO_PAGE) {
      const page = await store.list(
        'audit_events',
        organizationId,
        { eq: { action: INTRODUCTION_ACTION } },
        { orderBy: [{ field: 'id', direction: 'asc' }], limit: INTRO_PAGE, offset },
      );
      rows += page.length;
      for (const row of page) {
        const intro = row.metadata?.intro;
        if (typeof intro === 'string') intros.add(intro);
      }
      if (page.length < INTRO_PAGE) break;
    }
    const [last] = await store.list(
      'audit_events',
      organizationId,
      { eq: { action: 'crm.imported', entity_type: 'crm_introduction' } },
      { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
    );
    return {
      count: intros.size,
      atLeast: rows >= INTRO_ROWS_MAX,
      lastImportAt: last?.created_at ?? null,
    };
  } catch (error) {
    log.warn('Affinity exit could not count introductions', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return { count: null, atLeast: false, lastImportAt: null };
  }
}

/**
 * The checklist's status, from what Copilot already holds. Never throws and
 * never fails: each number that cannot be read is shown as unknown, alone.
 */
export async function getAffinityExitStatus(
  store: DataStore,
  organizationId: string,
  options: { now?: Date; timeZone: string },
): Promise<AffinityExitStatus> {
  const now = options.now ?? new Date();
  const [settings, setup, sync, intros, imports] = await Promise.all([
    readAffinityExitSettings(store, organizationId),
    getCrmSetup(store, organizationId).catch(() => ({ ready: false, missing: [] })),
    getAffinitySyncStatus(store, organizationId, now).catch((): AffinitySyncStatus => ({
      configured: false,
      demo: false,
      running: false,
      phase: null,
      listsDone: 0,
      listsTotal: 0,
      lastRun: null,
      lastError: null,
      stopped: null,
    })),
    introductionCounts(store, organizationId),
    readAffinityExitImports(store, organizationId, now),
  ]);
  const affinity = { source: 'affinity' };
  const [lists, companies, people, notes] = setup.ready
    ? await Promise.all([
        countOrNull(store, 'crm_lists', organizationId, { eq: affinity }),
        countOrNull(store, 'crm_records', organizationId, { eq: { ...affinity, kind: 'company' } }),
        countOrNull(store, 'crm_records', organizationId, { eq: { ...affinity, kind: 'person' } }),
        countOrNull(store, 'crm_notes', organizationId, { eq: affinity }),
      ])
    : [null, null, null, null];
  return {
    settings,
    countdown: affinityExitCountdown(settings, now, options.timeZone),
    crmReady: setup.ready,
    lists,
    companies,
    people,
    notes,
    introductions: intros,
    sync: {
      state: affinityDailySyncState(sync),
      demo: sync.demo,
      lastRunAt: sync.lastRun?.finishedAt ?? null,
      stoppedAt: sync.stopped?.at ?? null,
    },
    imports,
  };
}
