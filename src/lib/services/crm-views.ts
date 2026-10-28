import 'server-only';
import JSZip from 'jszip';
import { statusFieldOf } from '@/lib/crm/fields';
import {
  CRM_ALL_VIEW_ID,
  CRM_TIME_IN_STATUS_KEY,
  CRM_TIME_IN_STATUS_LABEL,
  CRM_VIEWS_MAX,
  addToTotals,
  cleanViewName,
  daysSince,
  emptyTotals,
  exportCellValue,
  importedDurationMs,
  importedTimeInStatusField,
  normalizeViewState,
  parseSavedViews,
  roundTotals,
  summableFields,
  toCsv,
  viewStateOf,
  visibleColumnKeys,
  type CrmSavedView,
  type CrmTimeInStatus,
  type CrmTotals,
} from '@/lib/crm/saved-views';
import { isMissingColumnError } from '@/lib/db/missing-table';
import { chunk, listAllPages, PAGE_SIZE } from '@/lib/db/paging';
import type { DataStore, Filter, QueryOptions } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import {
  entryOrder,
  entryQueryFilter,
  guard,
  isUuid,
  type CrmActor,
  type CrmEntryQuery,
} from '@/lib/services/crm';
import type { AuditEvent, CrmList, CrmListEntry, CrmNote, CrmRecord } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { sanitizeFilename } from '@/lib/util/text';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Affinity-grade views on CRM lists: saved views, column totals, time in
 * current status, and exports.
 *
 * Kept beside crm.ts rather than in it, on the same rules: everything takes
 * the store and organization first, returns a Result, and runs inside crm.ts's
 * `guard`, so a missing table is "not set up yet" and never a crashed page.
 *
 * Saved views live in a `views` jsonb column on crm_lists rather than a table
 * of their own: a list has a handful of views, they are always read with the
 * list, and the list row already scopes them to an organization under its
 * row-level security. The column arrives by 20261016010000_crm_views.sql;
 * until it has run, reads find no views (the column is simply absent from
 * the row) and saving one says which file to run. Two people saving a view
 * on the same list at the same instant can lose one of the two saves — the
 * array is read and written whole — which for a handful of views edited by
 * a small team is the trade for no new table.
 *
 * Nothing here logs a value from a list, record or note.
 */

export const CRM_VIEWS_MIGRATION_FILE = 'supabase/migrations/20261016010000_crm_views.sql';

const VIEWS_NOT_SET_UP = `Nothing was saved: saved views need a database column that does not exist yet. Run ${CRM_VIEWS_MIGRATION_FILE} in the Supabase SQL editor, then try again.`;

async function audit(
  store: DataStore,
  organizationId: string,
  actor: CrmActor | undefined,
  action: 'crm.view_saved' | 'crm.view_deleted' | 'crm.exported',
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await recordAudit(store, {
    organizationId,
    userId: actor?.userId ?? null,
    action,
    entityType,
    entityId,
    metadata,
  });
}

/* ------------------------------------------------------------ saved views */

/** A list's saved views, cleaned against its current fields. Empty until the views migration has run. */
export async function listSavedViews(
  store: DataStore,
  organizationId: string,
  listId: string,
): Promise<Result<CrmSavedView[]>> {
  return guard('read', 'read saved CRM views', async () => {
    if (!isUuid(listId)) return err('not_found', 'That list does not exist.');
    const list = await store.get('crm_lists', organizationId, listId);
    if (!list) return err('not_found', 'That list does not exist.');
    return ok(parseSavedViews(list.views, list.fields));
  });
}

export interface SaveCrmViewInput {
  /** The view to change; omitted to create one. */
  id?: string | null;
  /** Required for a new view; omitted to keep an existing view's name. */
  name?: string | null;
  /** The view state (CrmViewState); omitted to keep an existing view's. Normalized against the list. */
  state?: unknown;
}

/** Write a list's views, telling a missing `views` column apart from every other failure. */
async function writeViews(
  store: DataStore,
  organizationId: string,
  listId: string,
  views: CrmSavedView[],
): Promise<Result<true>> {
  try {
    await store.update('crm_lists', organizationId, listId, { views });
    return ok(true);
  } catch (error) {
    if (isMissingColumnError(error)) {
      return err('not_configured', VIEWS_NOT_SET_UP, {
        stillUsable: 'The list works as before; changes to it just cannot be saved as a view yet.',
      });
    }
    throw error;
  }
}

/**
 * Create a view, or rename or re-save one. Names are unique per list (any
 * case) and "All" is the built-in view's, which can be neither saved over,
 * renamed nor deleted. A list holds at most CRM_VIEWS_MAX views.
 */
export async function saveView(
  store: DataStore,
  organizationId: string,
  listId: string,
  input: SaveCrmViewInput,
  actor?: CrmActor,
): Promise<Result<{ view: CrmSavedView; views: CrmSavedView[] }>> {
  return guard('write', 'save a CRM view', async () => {
    if (!isUuid(listId)) return err('not_found', 'That list does not exist.');
    const list = await store.get('crm_lists', organizationId, listId);
    if (!list) return err('not_found', 'That list does not exist.');
    if (input.id === CRM_ALL_VIEW_ID) {
      return err('invalid_input', 'The All view cannot be changed. Save it as a new view instead.');
    }
    const views = parseSavedViews(list.views, list.fields);
    const existing = input.id ? views.find((v) => v.id === input.id) : undefined;
    if (input.id && !existing) {
      return err('not_found', 'That view no longer exists. Reload the list and try again.');
    }

    let name = existing?.name ?? null;
    if (input.name !== undefined && input.name !== null) {
      name = cleanViewName(input.name);
      if (!name) return err('invalid_input', 'A view needs a name of at most 80 characters.');
    }
    if (!name) return err('invalid_input', 'A view needs a name.');
    if (name.toLowerCase() === CRM_ALL_VIEW_ID) {
      return err('invalid_input', '“All” is the name of the built-in view. Choose another name.');
    }
    if (views.some((v) => v.id !== existing?.id && v.name.toLowerCase() === name.toLowerCase())) {
      return err('conflict', `${list.name} already has a view called “${name}”.`);
    }
    if (!existing && views.length >= CRM_VIEWS_MAX) {
      return err('too_large', `A list can have at most ${CRM_VIEWS_MAX} saved views.`);
    }

    const state =
      input.state !== undefined
        ? normalizeViewState(input.state, list.fields)
        : existing
          ? viewStateOf(existing)
          : normalizeViewState({}, list.fields);
    const now = new Date().toISOString();
    const view: CrmSavedView = {
      id: existing?.id ?? newId().replace(/-/g, '').slice(0, 16),
      name,
      ...state,
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    const next = existing ? views.map((v) => (v.id === view.id ? view : v)) : [...views, view];
    const written = await writeViews(store, organizationId, list.id, next);
    if (!written.ok) return written;
    await audit(store, organizationId, actor, 'crm.view_saved', 'crm_list', list.id, {
      view_id: view.id,
      created: !existing,
      layout: view.view,
      conditions: view.conditions.length,
    });
    return ok({ view, views: next });
  });
}

export async function deleteView(
  store: DataStore,
  organizationId: string,
  listId: string,
  viewId: string,
  actor?: CrmActor,
): Promise<Result<{ views: CrmSavedView[] }>> {
  return guard('write', 'delete a CRM view', async () => {
    if (!isUuid(listId)) return err('not_found', 'That list does not exist.');
    if (viewId === CRM_ALL_VIEW_ID) {
      return err('invalid_input', 'The All view is built in and cannot be deleted.');
    }
    const list = await store.get('crm_lists', organizationId, listId);
    if (!list) return err('not_found', 'That list does not exist.');
    const views = parseSavedViews(list.views, list.fields);
    if (!views.some((v) => v.id === viewId)) {
      return err('not_found', 'That view no longer exists.');
    }
    const next = views.filter((v) => v.id !== viewId);
    const written = await writeViews(store, organizationId, list.id, next);
    if (!written.ok) return written;
    await audit(store, organizationId, actor, 'crm.view_deleted', 'crm_list', list.id, {
      view_id: viewId,
    });
    return ok({ views: next });
  });
}

/* ------------------------------------------------------------------ totals */

/** Past this many entries the totals stop and say they are partial. */
export const CRM_TOTALS_ROW_CAP = 50_000;

/** Every entry matching `filter`, a page at a time, in a stable order; stops past `cap`. */
async function* entryPages(
  store: DataStore,
  organizationId: string,
  filter: Filter,
  orderBy: NonNullable<QueryOptions['orderBy']>,
  cap: number,
): AsyncGenerator<CrmListEntry[], void, void> {
  for (let offset = 0; offset < cap; offset += PAGE_SIZE) {
    const rows = await store.list('crm_list_entries', organizationId, filter, {
      orderBy,
      limit: Math.min(PAGE_SIZE, cap - offset),
      offset,
    });
    if (rows.length) yield rows;
    if (rows.length < PAGE_SIZE) return;
  }
}

/**
 * Sums of every number and money field (but an LP list's amounts, which are
 * never summed: summableFields) across all the entries a view holds — not
 * just the page on screen — with the count of entries behind each sum,
 * and the same per board column when `groupKey` names the grouping field.
 * There is no aggregate query through PostgREST, so this reads the matching
 * entries a thousand at a time; the page streams it in after the rows, and it
 * stops at CRM_TOTALS_ROW_CAP and says so. A list with nothing to sum costs
 * one count.
 */
export async function summarizeEntries(
  store: DataStore,
  organizationId: string,
  listId: string,
  query: Pick<CrmEntryQuery, 'query' | 'statusIn' | 'statusKey' | 'conditions'> & {
    groupKey?: string | null;
  } = {},
): Promise<Result<CrmTotals>> {
  return guard('read', 'total CRM entries', async () => {
    if (!isUuid(listId)) return err('not_found', 'That list does not exist.');
    const list = await store.get('crm_lists', organizationId, listId);
    if (!list) return err('not_found', 'That list does not exist.');
    const { filter } = entryQueryFilter(list, query);
    const sumKeys = summableFields(list, list.fields).map((f) => f.key);
    const group = query.groupKey
      ? (list.fields.find((f) => f.key === query.groupKey && f.type === 'status') ?? null)
      : null;
    if (!sumKeys.length) {
      return ok({
        ...emptyTotals(),
        count: await store.count('crm_list_entries', organizationId, filter),
      });
    }
    const totals = emptyTotals();
    for await (const rows of entryPages(
      store,
      organizationId,
      filter,
      [{ field: 'id', direction: 'asc' }],
      CRM_TOTALS_ROW_CAP + 1,
    )) {
      addToTotals(totals, rows, sumKeys, group?.key ?? null);
    }
    if (totals.count > CRM_TOTALS_ROW_CAP) totals.complete = false;
    return ok(roundTotals(totals));
  });
}

/* ---------------------------------------------------------- time in status */

/** Above this many entries the audit trail is read for the whole list at once rather than by id. */
const BY_LIST_THRESHOLD = 300;

/** Whether an audited change touched `key`: its `changed` keys, else (older rows) the keys it set. */
function changedKey(event: AuditEvent, key: string): boolean {
  const meta = event.metadata ?? {};
  const keys = Array.isArray(meta.changed) ? meta.changed : meta.fields;
  return Array.isArray(keys) && keys.includes(key);
}

/**
 * How long each entry has been in its current status.
 *
 * The latest audited change to the status field (crm.entry_updated) says
 * when an entry entered it. Without one — the entry is as the import left it
 * — Affinity's own "Time in Current Status" column is used when the import
 * kept one, counted on from the list's latest import (crm.imported, or when
 * the entry arrived if that is later) so it does not freeze at the import:
 * "12d" imported on Sep 21 reads about 36 days on Oct 15. That is an
 * estimate, and says so (timeInStatusText). An entry made in Kraken counts
 * from when it was added. Anything else is unknown. Best-effort: a failure to
 * read the audit trail leaves the column blank, or uncounted, rather than
 * failing the page.
 */
export async function timeInStatus(
  store: DataStore,
  organizationId: string,
  list: Pick<CrmList, 'id' | 'fields'>,
  entries: readonly CrmListEntry[],
): Promise<Record<string, CrmTimeInStatus>> {
  const status = statusFieldOf(list);
  if (!status || entries.length === 0) return {};
  const imported = importedTimeInStatusField(list.fields);
  const latest = new Map<string, string>();
  try {
    const base: Filter = { eq: { action: 'crm.entry_updated', entity_type: 'crm_list_entry' } };
    const order: NonNullable<QueryOptions['orderBy']> = [
      { field: 'created_at', direction: 'desc' },
    ];
    const events: AuditEvent[] = [];
    if (entries.length > BY_LIST_THRESHOLD) {
      events.push(
        ...(await listAllPages(
          store,
          'audit_events',
          organizationId,
          { eq: { ...base.eq, 'metadata->>list_id': list.id } },
          order,
        )),
      );
    } else {
      for (const ids of chunk(
        entries.map((e) => e.id),
        100,
      )) {
        events.push(
          ...(await store.list(
            'audit_events',
            organizationId,
            { ...base, in: { entity_id: ids } },
            { orderBy: order, limit: 1000 },
          )),
        );
      }
    }
    for (const event of events) {
      if (!event.entity_id || !changedKey(event, status.key)) continue;
      const seen = latest.get(event.entity_id);
      if (!seen || event.created_at > seen) latest.set(event.entity_id, event.created_at);
    }
  } catch (error) {
    log.warn('CRM time-in-status lookup failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  // When Affinity's figures were taken: the list's latest import.
  let lastImport: string | null = null;
  if (imported && entries.some((e) => !latest.has(e.id))) {
    try {
      const [event] = await store.list(
        'audit_events',
        organizationId,
        { eq: { action: 'crm.imported', entity_type: 'crm_list', entity_id: list.id } },
        { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
      );
      lastImport = event?.created_at ?? null;
    } catch (error) {
      log.warn('CRM last-import lookup failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const out: Record<string, CrmTimeInStatus> = {};
  for (const entry of entries) {
    const changed = latest.get(entry.id);
    const importedValue = imported ? entry.values?.[imported.key] : undefined;
    const importedText =
      typeof importedValue === 'number'
        ? String(importedValue)
        : typeof importedValue === 'string'
          ? importedValue.trim() || null
          : null;
    const hasStatus = entry.values?.[status.key] !== undefined;
    if (changed) out[entry.id] = { since: changed, imported: null, source: 'copilot' };
    else if (importedText) {
      // Taken at the latest import, or when this entry arrived if later.
      const asOf =
        lastImport && Date.parse(lastImport) > Date.parse(entry.created_at)
          ? lastImport
          : entry.created_at;
      const ms = importedDurationMs(importedText);
      const at = Date.parse(asOf);
      out[entry.id] = {
        since: ms === null || Number.isNaN(at) ? null : new Date(at - ms).toISOString(),
        imported: importedText,
        source: 'affinity',
        importedAt: asOf,
      };
    } else if (entry.external_id === null && hasStatus) {
      out[entry.id] = { since: entry.created_at, imported: null, source: 'added' };
    } else out[entry.id] = { since: null, imported: null, source: 'unknown' };
  }
  return out;
}

/* ------------------------------------------------------------------ export */

/** The most rows one CSV export reads. */
export const CRM_EXPORT_ROW_CAP = 100_000;

export interface CrmCsvExport {
  filename: string;
  csv: string;
  rows: number;
  /** False when the export stopped at CRM_EXPORT_ROW_CAP. */
  complete: boolean;
}

/**
 * The view on screen as a CSV: its visible columns in its order, every entry
 * its filters match across all pages, in its sort. Numbers stay numbers and
 * list values are joined with "; " (what the import splits on), so an export
 * opens cleanly in a spreadsheet and can be imported again.
 */
export async function exportViewCsv(
  store: DataStore,
  organizationId: string,
  listId: string,
  query: Pick<
    CrmEntryQuery,
    'query' | 'statusIn' | 'statusKey' | 'conditions' | 'sortKey' | 'sortDir'
  > & { columns?: readonly string[] | null; viewName?: string | null },
  actor?: CrmActor,
): Promise<Result<CrmCsvExport>> {
  return guard('read', 'export a CRM view', async () => {
    if (!isUuid(listId)) return err('not_found', 'That list does not exist.');
    const list = await store.get('crm_lists', organizationId, listId);
    if (!list) return err('not_found', 'That list does not exist.');
    const { filter } = entryQueryFilter(list, query);
    const { orderBy } = entryOrder(list, query.sortKey, query.sortDir);
    const keys = visibleColumnKeys(list.fields, query.columns ? [...query.columns] : null);
    const byKey = new Map(list.fields.map((f) => [f.key, f]));
    const header = [
      'Name',
      ...keys.map((k) =>
        k === CRM_TIME_IN_STATUS_KEY
          ? `${CRM_TIME_IN_STATUS_LABEL} (days)`
          : (byKey.get(k)?.name ?? k),
      ),
    ];

    const entries: CrmListEntry[] = [];
    for await (const rows of entryPages(
      store,
      organizationId,
      filter,
      orderBy,
      CRM_EXPORT_ROW_CAP + 1,
    )) {
      entries.push(...rows);
    }
    const complete = entries.length <= CRM_EXPORT_ROW_CAP;
    if (!complete) entries.length = CRM_EXPORT_ROW_CAP;
    const timers = keys.includes(CRM_TIME_IN_STATUS_KEY)
      ? await timeInStatus(store, organizationId, list, entries)
      : {};

    const now = Date.now();
    const rows = entries.map((entry) => [
      entry.title,
      ...keys.map((k) => {
        if (k === CRM_TIME_IN_STATUS_KEY) {
          const t = timers[entry.id];
          return t?.since ? daysSince(t.since, now) : (t?.imported ?? null);
        }
        return exportCellValue(entry.values?.[k]);
      }),
    ]);
    const name = query.viewName?.trim();
    await audit(store, organizationId, actor, 'crm.exported', 'crm_list', list.id, {
      scope: 'view',
      rows: rows.length,
      columns: header.length,
      complete,
    });
    return ok({
      filename: sanitizeFilename(`${list.name}${name ? ` - ${name}` : ''}.csv`),
      csv: toCsv([header, ...rows]),
      rows: rows.length,
      complete,
    });
  });
}

function noteOrder(a: CrmNote, b: CrmNote): number {
  const at = a.occurred_at ?? '';
  const bt = b.occurred_at ?? '';
  if (at !== bt) return at < bt ? 1 : -1;
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
}

const NOTE_HEADER = ['Date', 'Title', 'Author', 'Content', 'Attached to', 'Source', 'Flagged'];

function noteRow(note: CrmNote): (string | boolean | null)[] {
  return [
    note.occurred_at,
    note.title,
    note.author,
    note.content,
    note.entity_names.join('; '),
    note.source,
    note.injection_flagged,
  ];
}

/** Every note on a company or person — on the record itself or on any of its list entries — newest first. */
export async function exportRecordNotesCsv(
  store: DataStore,
  organizationId: string,
  recordId: string,
  actor?: CrmActor,
): Promise<Result<CrmCsvExport>> {
  return guard('read', 'export CRM notes', async () => {
    if (!isUuid(recordId)) return err('not_found', 'That record does not exist.');
    const record = await store.get('crm_records', organizationId, recordId);
    if (!record) return err('not_found', 'That record does not exist.');
    const entries = await listAllPages(store, 'crm_list_entries', organizationId, {
      eq: { record_id: record.id },
    });
    const groups = await Promise.all([
      listAllPages(store, 'crm_notes', organizationId, {
        arrayContains: { record_ids: record.id },
      }),
      ...chunk(
        entries.map((e) => e.id),
        100,
      ).map((ids) =>
        listAllPages(store, 'crm_notes', organizationId, { arrayOverlaps: { entry_ids: ids } }),
      ),
    ]);
    const byId = new Map<string, CrmNote>();
    for (const note of groups.flat()) byId.set(note.id, note);
    const notes = [...byId.values()].sort(noteOrder);
    await audit(store, organizationId, actor, 'crm.exported', 'crm_record', record.id, {
      scope: 'notes',
      rows: notes.length,
    });
    return ok({
      filename: sanitizeFilename(`${record.name} notes.csv`),
      csv: toCsv([NOTE_HEADER, ...notes.map(noteRow)]),
      rows: notes.length,
      complete: true,
    });
  });
}

export interface CrmEverythingExport {
  filename: string;
  data: Uint8Array;
  counts: { lists: number; records: number; entries: number; notes: number };
}

function listFileName(list: CrmList, index: number, taken: Set<string>): string {
  const base = sanitizeFilename(`${String(index + 1).padStart(2, '0')} ${list.name}.csv`);
  let name = `lists/${base}`;
  for (let n = 2; taken.has(name); n++) name = `lists/${base.replace(/\.csv$/, '')}-${n}.csv`;
  taken.add(name);
  return name;
}

/**
 * The whole CRM as a ZIP of CSVs: every list (archived ones too) with its
 * entries, every company and person, every note — what leaving would need,
 * and what an owner keeps as a backup. Built in memory; for a CRM of tens of
 * thousands of records and notes that is tens of megabytes, which a server
 * holds comfortably. Owner-only at the route.
 */
export async function exportEverything(
  store: DataStore,
  organizationId: string,
  actor?: CrmActor,
): Promise<Result<CrmEverythingExport>> {
  return guard('read', 'export the CRM', async () => {
    const [lists, records, notes] = await Promise.all([
      listAllPages(store, 'crm_lists', organizationId, {}, [
        { field: 'position', direction: 'asc' },
      ]),
      listAllPages(store, 'crm_records', organizationId, {}, [{ field: 'name', direction: 'asc' }]),
      listAllPages(store, 'crm_notes', organizationId, {}, [
        { field: 'occurred_at', direction: 'desc' },
      ]),
    ]);
    const recordById = new Map<string, CrmRecord>(records.map((r) => [r.id, r]));
    const zip = new JSZip();
    const taken = new Set<string>();
    let entryCount = 0;
    const listRows: (string | number | boolean | null)[][] = [];

    for (const [index, list] of lists.entries()) {
      const entries = await listAllPages(
        store,
        'crm_list_entries',
        organizationId,
        { eq: { list_id: list.id } },
        [{ field: 'position', direction: 'asc' }],
      );
      entryCount += entries.length;
      const header = [
        'Entry ID',
        'Name',
        'Record ID',
        'Record',
        ...list.fields.map((f) => f.name),
        'Added',
        'Updated',
      ];
      const rows = entries.map((e) => [
        e.id,
        e.title,
        e.record_id,
        e.record_id ? (recordById.get(e.record_id)?.name ?? null) : null,
        ...list.fields.map((f) => exportCellValue(e.values?.[f.key])),
        e.created_at,
        e.updated_at,
      ]);
      zip.file(listFileName(list, index, taken), toCsv([header, ...rows]));
      listRows.push([
        list.id,
        list.name,
        list.entity_type,
        list.source,
        list.archived,
        entries.length,
        list.fields.map((f) => f.name).join('; '),
        parseSavedViews(list.views, list.fields).length,
        list.created_at,
        list.updated_at,
      ]);
    }
    zip.file(
      'lists.csv',
      toCsv([
        [
          'List ID',
          'Name',
          'Type',
          'Source',
          'Archived',
          'Entries',
          'Fields',
          'Saved views',
          'Created',
          'Updated',
        ],
        ...listRows,
      ]),
    );

    // Records carry free-form columns from their exports; each label becomes
    // a column, in alphabetical order.
    const extra = [...new Set(records.flatMap((r) => Object.keys(r.fields ?? {})))].sort((a, b) =>
      a.localeCompare(b),
    );
    zip.file(
      'records.csv',
      toCsv([
        [
          'Record ID',
          'Kind',
          'Name',
          'Domain',
          'Primary email',
          'Emails',
          'Source',
          'Source ID',
          'Created',
          'Updated',
          ...extra,
        ],
        ...records.map((r) => [
          r.id,
          r.kind,
          r.name,
          r.domain,
          r.primary_email,
          r.emails.join('; '),
          r.source,
          r.external_id,
          r.created_at,
          r.updated_at,
          ...extra.map((k) => exportCellValue(r.fields?.[k])),
        ]),
      ]),
    );

    zip.file(
      'notes.csv',
      toCsv([
        ['Note ID', ...NOTE_HEADER, 'Record IDs', 'Entry IDs', 'Created'],
        ...[...notes]
          .sort(noteOrder)
          .map((n) => [
            n.id,
            ...noteRow(n),
            n.record_ids.join('; '),
            n.entry_ids.join('; '),
            n.created_at,
          ]),
      ]),
    );

    const counts = {
      lists: lists.length,
      records: records.length,
      entries: entryCount,
      notes: notes.length,
    };
    zip.file(
      'README.txt',
      [
        'Kraken CRM export',
        `Exported ${new Date().toISOString()}`,
        '',
        `lists.csv     ${counts.lists} lists (archived ones included)`,
        `lists/*.csv   ${counts.entries} list entries, one file per list, a column per field`,
        `records.csv   ${counts.records} companies and people`,
        `notes.csv     ${counts.notes} notes, newest first`,
        '',
        'List values that hold several names are joined with "; ".',
        'Text that a spreadsheet would run as a formula starts with an apostrophe.',
        '',
      ].join('\r\n'),
    );
    const data = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    await audit(store, organizationId, actor, 'crm.exported', 'organization', organizationId, {
      scope: 'everything',
      ...counts,
      bytes: data.byteLength,
    });
    const day = new Date().toISOString().slice(0, 10);
    return ok({ filename: `copilot-crm-export-${day}.zip`, data, counts });
  });
}
