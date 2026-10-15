import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import {
  crmNameKey,
  displayCrmValue,
  mergeCrmFields,
  normalizeCrmFields,
  normalizeCrmValue,
  statusFieldOf,
  validateCrmValue,
  type CrmFieldInput,
} from '@/lib/crm/fields';
import { compileEntryFilter, type CrmViewCondition } from '@/lib/crm/saved-views';
import { sortStatusOptions } from '@/lib/crm/view';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore, Filter, QueryOptions, Row, TableName } from '@/lib/db/store';
import { recordAudit, type AuditAction } from '@/lib/security/audit';
import { scanForInjection } from '@/lib/security/injection';
import { log } from '@/lib/security/redact';
import type {
  CrmEntityType,
  CrmField,
  CrmList,
  CrmListEntry,
  CrmNote,
  CrmRecord,
  CrmRecordKind,
  CrmSource,
  CrmValue,
} from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';
import { corporateEmailDomain, normalizeCompanyName, normalizeDomain } from '@/lib/util/text';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * The CRM: Affinity's model, held in Copilot.
 *
 * Lists of one entity type with their own fields, companies and people as
 * records, list entries carrying a list's values, and notes. Three groups of
 * functions, all taking the store and the organization first and all returning
 * a Result — nothing here throws to its caller:
 *
 *   - reads for the pages: lists, a page of entries, a record's profile, search
 *   - writes for the pages: create a list, set values, add an entry, add a note
 *   - import upserts for the CSV import route, idempotent on natural keys
 *
 * Every table here arrives by a hand-applied migration, and code has reached
 * production before its table before (the Sep 15 outage). So every function
 * runs inside `guard`: a missing table becomes `not_configured` — "not set up
 * yet" for a read, "nothing was saved" for a write — and any other failure an
 * `internal` error, never an exception through a page.
 */

/* ------------------------------------------------------------- setup state */

export const CRM_TABLES = ['crm_lists', 'crm_records', 'crm_list_entries', 'crm_notes'] as const;
export type CrmTable = (typeof CRM_TABLES)[number];

export const CRM_MIGRATION_FILE = 'supabase/migrations/20261015000000_crm.sql';

const NOT_SET_UP_READ = `The CRM is not set up yet: its tables do not exist. Run ${CRM_MIGRATION_FILE} in the Supabase SQL editor, then reload.`;
const NOT_SET_UP_WRITE = `Nothing was saved: the CRM tables do not exist yet. Run ${CRM_MIGRATION_FILE} in the Supabase SQL editor, then try again.`;
const OUT_OF_DATE_READ = `The CRM is not fully set up: its tables are from an earlier copy of the migration. Run ${CRM_MIGRATION_FILE} again in the Supabase SQL editor (it is safe to re-run), then reload.`;
const OUT_OF_DATE_WRITE = `Nothing was saved: the CRM tables are from an earlier copy of the migration. Run ${CRM_MIGRATION_FILE} again in the Supabase SQL editor (it is safe to re-run), then try again.`;

/** True for the "tables not created yet" failure, which a page shows as a set-up state, not an error. */
export function isCrmNotSetUp(result: Result<unknown>): boolean {
  return !result.ok && result.error.code === 'not_configured';
}

/** Which CRM tables exist. Never throws; an unrelated failure is logged and not reported as missing. */
export async function getCrmSetup(
  store: DataStore,
  organizationId: string,
): Promise<{ ready: boolean; missing: CrmTable[] }> {
  const missing = new Set<CrmTable>();
  await Promise.all(
    CRM_TABLES.map(async (table) => {
      try {
        // A read, not `count`: a count is a HEAD request, and postgrest-js
        // reads a HEAD 404 (no body, so no PGRST205) as an empty success, so
        // a missing table would count as zero rows instead of failing.
        await store.list(table, organizationId, {}, { limit: 1 });
      } catch (error) {
        if (isMissingTableError(error)) missing.add(table);
        else log.warn('CRM setup probe failed', { table, reason: (error as Error)?.message });
      }
    }),
  );
  const list = CRM_TABLES.filter((t) => missing.has(t));
  return { ready: list.length === 0, missing: list };
}

export async function guard<T>(
  mode: 'read' | 'write',
  operation: string,
  run: () => Promise<Result<T>>,
): Promise<Result<T>> {
  try {
    return await run();
  } catch (error) {
    if (isMissingTableError(error)) {
      return err('not_configured', mode === 'read' ? NOT_SET_UP_READ : NOT_SET_UP_WRITE, {
        stillUsable: 'Everything outside the CRM works as before.',
        details: { operation },
      });
    }
    // A table from an earlier copy of the migration (a column added since):
    // the same "set up" state, with the fix it needs.
    if (isMissingColumnError(error)) {
      return err('not_configured', mode === 'read' ? OUT_OF_DATE_READ : OUT_OF_DATE_WRITE, {
        stillUsable: 'Everything outside the CRM works as before.',
        details: { operation },
      });
    }
    log.error('CRM operation failed', {
      operation,
      reason: error instanceof Error ? error.message : String(error),
    });
    return err(
      'internal',
      mode === 'read' ? 'The CRM could not be read just now.' : 'The change could not be saved.',
      { retryable: true, details: { operation } },
    );
  }
}

/* ----------------------------------------------------------------- helpers */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id from a URL that cannot be a row id is "not found", not a Postgres cast error. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function clampInt(value: number | null | undefined, min: number, max: number, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Run `fn` over `items`, at most `limit` at a time. */
async function inBatches<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (const group of chunk(items, limit)) out.push(...(await Promise.all(group.map(fn))));
  return out;
}

/** Every row whose `column` is one of `values`, across as many requests and pages as it takes. */
async function listWhereIn<T extends TableName>(
  store: DataStore,
  table: T,
  organizationId: string,
  base: Filter,
  column: string,
  values: readonly string[],
): Promise<Row<T>[]> {
  const unique = [...new Set(values)];
  const out: Row<T>[] = [];
  for (const group of chunk(unique, 100)) {
    out.push(
      ...(await listAllPages(store, table, organizationId, {
        ...base,
        in: { ...base.in, [column]: group },
      })),
    );
  }
  return out;
}

/** Deep equality for stored values, ignoring object key order (jsonb does not keep it). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return (a ?? null) === (b ?? null);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => same(v, b[i]));
  }
  const ak = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const bk = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ak.length !== bk.length) return false;
  return ak.every((k) =>
    same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Two timestamps naming the same instant, however each is written; two nulls are the same. */
function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const ta = Date.parse(a);
  return !Number.isNaN(ta) && ta === Date.parse(b);
}

function union(a: readonly string[], b: readonly string[]): string[] {
  const out = [...a];
  for (const v of b) if (!out.includes(v)) out.push(v);
  return out;
}

async function nextPosition(
  store: DataStore,
  organizationId: string,
  table: 'crm_lists' | 'crm_list_entries',
  filter: Filter,
): Promise<number> {
  const [last] = await store.list(table, organizationId, filter, {
    orderBy: [{ field: 'position', direction: 'desc' }],
    limit: 1,
  });
  return last ? last.position + 1 : 0;
}

/* ------------------------------------------------------------------- reads */

/** A list with how many entries it holds. */
export interface CrmListSummary extends CrmList {
  entry_count: number;
}

/** The parts of a record a table row or a search result needs. */
export type CrmRecordSummary = Pick<CrmRecord, 'id' | 'kind' | 'name' | 'domain' | 'primary_email'>;

function summarize(record: CrmRecord): CrmRecordSummary {
  const { id, kind, name, domain, primary_email } = record;
  return { id, kind, name, domain, primary_email };
}

const LIST_ORDER: NonNullable<QueryOptions['orderBy']> = [
  { field: 'position', direction: 'asc' },
  { field: 'name', direction: 'asc' },
];

async function withCounts(
  store: DataStore,
  organizationId: string,
  lists: CrmList[],
): Promise<CrmListSummary[]> {
  // One head-only count per list, a few at a time: 36 lists is 36 tiny
  // requests, against reading every entry of every list to count them.
  return inBatches(lists, 6, async (list) => ({
    ...list,
    entry_count: await store.count('crm_list_entries', organizationId, {
      eq: { list_id: list.id },
    }),
  }));
}

/** Every list, in display order, with entry counts. Archived lists only when asked. */
export async function listCrmLists(
  store: DataStore,
  organizationId: string,
  options: { includeArchived?: boolean } = {},
): Promise<Result<CrmListSummary[]>> {
  return guard('read', 'list CRM lists', async () => {
    const filter: Filter = options.includeArchived ? {} : { eq: { archived: false } };
    const lists = await listAllPages(store, 'crm_lists', organizationId, filter, LIST_ORDER);
    return ok(await withCounts(store, organizationId, lists));
  });
}

export async function getCrmList(
  store: DataStore,
  organizationId: string,
  listId: string,
): Promise<Result<CrmListSummary>> {
  return guard('read', 'read a CRM list', async () => {
    if (!isUuid(listId)) return err('not_found', 'That list does not exist.');
    const list = await store.get('crm_lists', organizationId, listId);
    if (!list) return err('not_found', 'That list does not exist.');
    const [summary] = await withCounts(store, organizationId, [list]);
    return ok(summary as CrmListSummary);
  });
}

/** Entry columns that can be sorted on directly; any field key of the list can be too. */
export const CRM_ENTRY_SORT_COLUMNS = ['title', 'position', 'created_at', 'updated_at'] as const;

export const CRM_ENTRY_PAGE_MAX = 500;

export interface CrmEntryQuery {
  /** Case-insensitive substring of the entry title. */
  query?: string | null;
  /** One of CRM_ENTRY_SORT_COLUMNS, or a field key of the list. Unknown keys fall back to position. */
  sortKey?: string | null;
  sortDir?: 'asc' | 'desc' | null;
  /** Keep entries whose status is one of these labels (exact match). */
  statusIn?: readonly string[] | null;
  /** Which field `statusIn` applies to; defaults to the list's status field (statusFieldOf). */
  statusKey?: string | null;
  /** A saved view's filter conditions, all of which must hold (compileEntryFilter). */
  conditions?: readonly CrmViewCondition[] | null;
  offset?: number | null;
  /** Default 50, at most CRM_ENTRY_PAGE_MAX. */
  limit?: number | null;
}

export interface CrmEntryPage {
  list: CrmList;
  entries: CrmListEntry[];
  /** Entries matching the query and status filter, across all pages. */
  total: number;
  offset: number;
  limit: number;
  /** The sort actually applied. */
  sort: { key: string; dir: 'asc' | 'desc' };
  /** The field `statusIn` filtered on (the pipeline field), or null when the list has none. */
  statusField: CrmField | null;
  /** The records the page's entries point at, by id. */
  records: Record<string, CrmRecordSummary>;
}

/**
 * One page of a list's entries, filtered, sorted and paged in the database.
 *
 * A field sort orders by the jsonb value (`values->key`), so money and number
 * fields sort numerically and dates (stored as ISO strings) chronologically.
 * Ties break on position, then id, so pages never overlap. Entries with no
 * value for the sort field sort last in Postgres (the demo store puts them
 * first when ascending).
 */
export async function listEntries(
  store: DataStore,
  organizationId: string,
  listId: string,
  query: CrmEntryQuery = {},
): Promise<Result<CrmEntryPage>> {
  return guard('read', 'list CRM entries', async () => {
    if (!isUuid(listId)) return err('not_found', 'That list does not exist.');
    const list = await store.get('crm_lists', organizationId, listId);
    if (!list) return err('not_found', 'That list does not exist.');

    const limit = clampInt(query.limit, 1, CRM_ENTRY_PAGE_MAX, 50);
    const offset = clampInt(query.offset, 0, Number.MAX_SAFE_INTEGER, 0);

    const { filter, statusField } = entryQueryFilter(list, query);
    const { sort, orderBy } = entryOrder(list, query.sortKey, query.sortDir);

    const [entries, total] = await Promise.all([
      store.list('crm_list_entries', organizationId, filter, { orderBy, limit, offset }),
      store.count('crm_list_entries', organizationId, filter),
    ]);

    const records = await recordSummaries(store, organizationId, entries);
    return ok({ list, entries, total, offset, limit, sort, statusField, records });
  });
}

/**
 * The filter for a list's entries under a query: the title search, the
 * status chips (on `statusKey`, else the pipeline field) and a view's
 * conditions. Shared by the page of entries, the totals and the CSV export,
 * so all three always agree on which entries a view holds.
 */
export function entryQueryFilter(
  list: CrmList,
  query: Pick<CrmEntryQuery, 'query' | 'statusIn' | 'statusKey' | 'conditions'>,
): { filter: Filter; statusField: CrmField | null } {
  const statusField = query.statusKey
    ? (list.fields.find((f) => f.key === query.statusKey) ?? null)
    : statusFieldOf(list);
  const filter = compileEntryFilter(entriesFilter(list, query.query), list.fields, {
    statusKey: statusField?.key ?? null,
    statuses: query.statusIn,
    conditions: query.conditions,
  });
  return { filter, statusField };
}

/**
 * `filter` narrowed to entries whose `path` is one of `labels`: intersected
 * with any list of labels the filter already holds for that path, never
 * replacing the filter's other `in` lists.
 */
function narrowIn(filter: Filter, path: string, labels: readonly string[]): Filter {
  const before = filter.in?.[path];
  const values = before ? before.filter((v) => labels.includes(v as string)) : [...labels];
  return { ...filter, in: { ...filter.in, [path]: values } };
}

/** `filter` narrowed to entries with no value at `path`. */
function narrowNull(filter: Filter, path: string): Filter {
  return { ...filter, isNull: [...(filter.isNull ?? []).filter((p) => p !== path), path] };
}

/**
 * The order for a page of entries: a known column or a field key of the list
 * (by its jsonb value), else list position. Ties break on position, then id,
 * so pages never overlap.
 */
export function entryOrder(
  list: CrmList,
  sortKey: string | null | undefined,
  sortDir: 'asc' | 'desc' | null | undefined,
): { sort: { key: string; dir: 'asc' | 'desc' }; orderBy: NonNullable<QueryOptions['orderBy']> } {
  const dir = sortDir === 'desc' ? 'desc' : 'asc';
  const wanted = sortKey ?? '';
  let sort: { key: string; dir: 'asc' | 'desc' } = { key: 'position', dir: 'asc' };
  let orderField = 'position';
  if ((CRM_ENTRY_SORT_COLUMNS as readonly string[]).includes(wanted)) {
    sort = { key: wanted, dir };
    orderField = wanted;
  } else if (list.fields.some((f) => f.key === wanted)) {
    sort = { key: wanted, dir };
    orderField = `values->${wanted}`;
  }
  const orderBy: NonNullable<QueryOptions['orderBy']> = [
    { field: orderField, direction: sort.dir },
  ];
  if (orderField !== 'position') orderBy.push({ field: 'position', direction: 'asc' });
  orderBy.push({ field: 'id', direction: 'asc' });
  return { sort, orderBy };
}

/** The records some entries point at, by id. */
async function recordSummaries(
  store: DataStore,
  organizationId: string,
  entries: readonly CrmListEntry[],
): Promise<Record<string, CrmRecordSummary>> {
  const recordIds = entries.map((e) => e.record_id).filter((id): id is string => Boolean(id));
  const records: Record<string, CrmRecordSummary> = {};
  if (recordIds.length) {
    for (const r of await listWhereIn(store, 'crm_records', organizationId, {}, 'id', recordIds)) {
      records[r.id] = summarize(r);
    }
  }
  return records;
}

/** A list a record sits on, through one entry. */
export interface CrmMembership {
  entry: CrmListEntry;
  list: Pick<CrmList, 'id' | 'name' | 'entity_type' | 'fields' | 'archived'>;
}

export interface CrmRecordProfile {
  record: CrmRecord;
  /** Every entry that points at the record, with its list, in list display order. */
  memberships: CrmMembership[];
  /** Notes on the record or on any of its entries, newest first. */
  notes: CrmNote[];
  /**
   * For a company, the people whose primary email is at its domain; for a
   * person, the companies at their work email domains. A lookup against
   * records that exist, never a guess.
   */
  related: CrmRecordSummary[];
}

function byOccurredDesc(a: CrmNote, b: CrmNote): number {
  const at = a.occurred_at ?? '';
  const bt = b.occurred_at ?? '';
  if (at !== bt) return at < bt ? 1 : -1;
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
}

/** A company's or person's profile: the record, its list memberships, notes and related records. */
export async function getRecord(
  store: DataStore,
  organizationId: string,
  recordId: string,
  options: { noteLimit?: number } = {},
): Promise<Result<CrmRecordProfile>> {
  return guard('read', 'read a CRM record', async () => {
    if (!isUuid(recordId)) return err('not_found', 'That record does not exist.');
    const record = await store.get('crm_records', organizationId, recordId);
    if (!record) return err('not_found', 'That record does not exist.');
    const noteLimit = clampInt(options.noteLimit, 1, 500, 100);

    const entries = await listAllPages(store, 'crm_list_entries', organizationId, {
      eq: { record_id: record.id },
    });
    const lists = entries.length
      ? await listWhereIn(
          store,
          'crm_lists',
          organizationId,
          {},
          'id',
          entries.map((e) => e.list_id),
        )
      : [];
    const listById = new Map(lists.map((l) => [l.id, l]));
    const memberships: CrmMembership[] = entries
      .map((entry) => {
        const list = listById.get(entry.list_id);
        if (!list) return null;
        const { id, name, entity_type, fields, archived } = list;
        return { entry, list: { id, name, entity_type, fields, archived } };
      })
      .filter((m): m is CrmMembership => m !== null)
      .sort((a, b) => {
        const la = listById.get(a.list.id) as CrmList;
        const lb = listById.get(b.list.id) as CrmList;
        return (
          la.position - lb.position ||
          la.name.localeCompare(lb.name) ||
          a.entry.position - b.entry.position
        );
      });

    const noteOrder: QueryOptions = {
      orderBy: [
        { field: 'occurred_at', direction: 'desc' },
        { field: 'created_at', direction: 'desc' },
      ],
      limit: noteLimit,
    };
    const noteGroups = await Promise.all([
      store.list(
        'crm_notes',
        organizationId,
        { arrayContains: { record_ids: record.id } },
        noteOrder,
      ),
      ...chunk(
        entries.map((e) => e.id),
        100,
      ).map((ids) =>
        store.list('crm_notes', organizationId, { arrayOverlaps: { entry_ids: ids } }, noteOrder),
      ),
    ]);
    const notesById = new Map<string, CrmNote>();
    for (const note of noteGroups.flat()) notesById.set(note.id, note);
    const notes = [...notesById.values()].sort(byOccurredDesc).slice(0, noteLimit);

    let related: CrmRecordSummary[] = [];
    if (record.kind === 'company' && record.domain) {
      const suffix = `@${record.domain}`;
      const people = await store.list(
        'crm_records',
        organizationId,
        { eq: { kind: 'person' }, textSearch: { columns: ['primary_email'], query: suffix } },
        { orderBy: [{ field: 'name', direction: 'asc' }], limit: 50 },
      );
      related = people.filter((p) => p.primary_email?.endsWith(suffix)).map(summarize);
    } else if (record.kind === 'person') {
      const domains = [
        ...new Set(
          record.emails.map((e) => corporateEmailDomain(e)).filter((d): d is string => !!d),
        ),
      ];
      if (domains.length) {
        const companies = await store.list(
          'crm_records',
          organizationId,
          { eq: { kind: 'company' }, in: { domain: domains.slice(0, 20) } },
          { orderBy: [{ field: 'name', direction: 'asc' }], limit: 20 },
        );
        related = companies.map(summarize);
      }
    }

    return ok({ record, memberships, notes, related });
  });
}

/**
 * Companies and people by name, domain or email, best match first: an exact
 * name/domain/email, then a name prefix, then a domain prefix, then anything
 * containing the text.
 *
 * Each tier is its own small query. A single "contains" query capped and
 * ranked afterwards misses the best matches in a CRM of twenty thousand
 * records: "Kin" is inside hundreds of names, the cap keeps the first few
 * alphabetically, and the company called Kin is never fetched to be ranked.
 */
export async function searchRecords(
  store: DataStore,
  organizationId: string,
  q: string,
  limit = 20,
  kind?: CrmRecordKind,
): Promise<Result<CrmRecord[]>> {
  return guard('read', 'search CRM records', async () => {
    const term = (q ?? '').trim().slice(0, 200);
    if (!term) return ok([]);
    const cap = clampInt(limit, 1, 50, 20);
    const base: Filter = kind ? { eq: { kind } } : {};
    const key = crmNameKey(term);
    const byName: QueryOptions = { orderBy: [{ field: 'name', direction: 'asc' }], limit: cap };

    const searches = [
      store.list(
        'crm_records',
        organizationId,
        { ...base, eq: { ...base.eq, name_key: key } },
        { limit: cap },
      ),
      store.list(
        'crm_records',
        organizationId,
        { ...base, textSearch: { columns: ['name'], query: term, mode: 'prefix' } },
        byName,
      ),
      store.list(
        'crm_records',
        organizationId,
        { ...base, textSearch: { columns: ['domain'], query: term, mode: 'prefix' } },
        { orderBy: [{ field: 'domain', direction: 'asc' }], limit: cap },
      ),
      store.list(
        'crm_records',
        organizationId,
        { ...base, textSearch: { columns: ['name', 'domain', 'primary_email'], query: term } },
        { ...byName, limit: Math.min(cap * 3, 100) },
      ),
    ];
    if (/^[^\s@]+@[^\s@]+$/.test(term)) {
      searches.push(
        store.list(
          'crm_records',
          organizationId,
          { ...base, arrayContains: { emails: term.toLowerCase() } },
          { limit: cap },
        ),
      );
    }
    const byId = new Map<string, CrmRecord>();
    for (const r of (await Promise.all(searches)).flat()) byId.set(r.id, r);

    const rank = (r: CrmRecord): number => {
      if (r.name_key === key || r.domain === key || r.emails.includes(key)) return 0;
      if (r.name_key.startsWith(key)) return 1;
      if (r.domain?.startsWith(key)) return 2;
      return 3;
    };
    const ranked = [...byId.values()].sort(
      (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
    );
    return ok(ranked.slice(0, cap));
  });
}

/**
 * Record ids by name, case-insensitively, for linking an import's name-only
 * columns (a note's entity names, an opportunity's Organizations) to records.
 * Keyed by crmNameKey(name); ids oldest first. Names with no record are absent.
 */
export async function matchRecordsByName(
  store: DataStore,
  organizationId: string,
  names: readonly string[],
  kind?: CrmRecordKind,
): Promise<Result<Record<string, string[]>>> {
  return guard('read', 'match CRM records by name', async () => {
    const keys = names.map((n) => crmNameKey(n)).filter(Boolean);
    const rows = await listWhereIn(
      store,
      'crm_records',
      organizationId,
      kind ? { eq: { kind } } : {},
      'name_key',
      keys,
    );
    rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    const out: Record<string, string[]> = {};
    for (const r of rows) (out[r.name_key] ??= []).push(r.id);
    return ok(out);
  });
}

/* ------------------------------------------------------- list page reads */
//
// What the Lists pages need beyond a page of entries: when each list last
// changed, how many entries sit in each status (the filter chips), the list as
// status columns (the board), one entry with its notes (the side panel), and
// where a company already exists elsewhere in Copilot (a profile's links).
// A list can hold thousands of entries, so all of it is counted and capped in
// the database; nothing here reads a whole list.

/**
 * When each list last changed, by list id: its own row or its newest entry,
 * whichever is later. One single-row read per list, a few at a time.
 */
export async function listActivity(
  store: DataStore,
  organizationId: string,
  lists: readonly Pick<CrmList, 'id' | 'updated_at'>[],
): Promise<Result<Record<string, string>>> {
  return guard('read', 'read CRM list activity', async () => {
    const out: Record<string, string> = {};
    await inBatches(lists, 6, async (list) => {
      const [newest] = await store.list(
        'crm_list_entries',
        organizationId,
        { eq: { list_id: list.id } },
        { orderBy: [{ field: 'updated_at', direction: 'desc' }], limit: 1 },
      );
      out[list.id] =
        newest && newest.updated_at > list.updated_at ? newest.updated_at : list.updated_at;
    });
    return ok(out);
  });
}

/** The status field `key` names, else the list's pipeline field. */
function statusFieldFor(list: CrmList, key: string | null | undefined): CrmField | null {
  if (!key) return statusFieldOf(list);
  return list.fields.find((f) => f.key === key && f.type === 'status') ?? null;
}

/** The entries of a list, optionally narrowed to titles containing `query`. */
function entriesFilter(list: CrmList, query: string | null | undefined): Filter {
  const filter: Filter = { eq: { list_id: list.id } };
  const text = query?.trim();
  if (text) filter.textSearch = { columns: ['title'], query: text.slice(0, 200) };
  return filter;
}

export interface CrmStatusCounts {
  /** The field counted; null when the list has no status field. */
  field: CrmField | null;
  /** Entries per option, for every option of the field. */
  counts: Record<string, number>;
  /** Entries with no status. */
  none: number;
  /** Entries whose status is not one of the options, which an import can leave. */
  other: number;
  total: number;
}

/**
 * How many entries hold each status, for the filter chips: one count per
 * option (a list's pipeline has a dozen or so), plus the entries with none.
 * Narrowed by the same title search as the page, so the chips agree with it.
 */
export async function countEntriesByStatus(
  store: DataStore,
  organizationId: string,
  listId: string,
  options: {
    query?: string | null;
    statusKey?: string | null;
    /** A view's conditions, so the chips count what the view shows. */
    conditions?: readonly CrmViewCondition[] | null;
  } = {},
): Promise<Result<CrmStatusCounts>> {
  return guard<CrmStatusCounts>('read', 'count CRM entries by status', async () => {
    if (!isUuid(listId)) return err('not_found', 'That list does not exist.');
    const list = await store.get('crm_lists', organizationId, listId);
    if (!list) return err('not_found', 'That list does not exist.');
    const base = compileEntryFilter(entriesFilter(list, options.query), list.fields, {
      conditions: options.conditions,
    });
    const field = statusFieldFor(list, options.statusKey);
    if (!field) {
      const total = await store.count('crm_list_entries', organizationId, base);
      return ok({ field: null, counts: {}, none: 0, other: 0, total });
    }
    const path = `values->>${field.key}`;
    const labels = field.options ?? [];
    const [total, none, perOption] = await Promise.all([
      store.count('crm_list_entries', organizationId, base),
      store.count('crm_list_entries', organizationId, narrowNull(base, path)),
      inBatches(labels, 6, (label) =>
        store.count('crm_list_entries', organizationId, narrowIn(base, path, [label])),
      ),
    ]);
    const counts: Record<string, number> = {};
    labels.forEach((label, i) => (counts[label] = perOption[i] ?? 0));
    const placed = none + perOption.reduce((sum, n) => sum + n, 0);
    return ok({ field, counts, none, other: Math.max(0, total - placed), total });
  });
}

export const CRM_BOARD_COLUMN_MAX = 100;

export interface CrmBoardColumn {
  /** The status label, or null for the entries with no status. */
  status: string | null;
  /** The first cards of the column, in the board's sort. */
  entries: CrmListEntry[];
  /** Entries in the column across the whole list; `entries` is capped. */
  total: number;
}

export interface CrmBoard {
  list: CrmList;
  statusField: CrmField;
  /**
   * One column per status option in pipeline order (sortStatusOptions), then
   * "no status" when any entry has none.
   */
  columns: CrmBoardColumn[];
  /** Entries whose status is not one of the options: on no column, still in the table. */
  unplaced: number;
  sort: { key: string; dir: 'asc' | 'desc' };
  perColumn: number;
  records: Record<string, CrmRecordSummary>;
}

/**
 * A list as status columns. Each column is its own capped query and count, so
 * a 5,000-entry pipeline is a couple of dozen small reads, not 5,000 rows.
 * `statusIn` keeps only those columns (the page's status chips).
 */
export async function listBoard(
  store: DataStore,
  organizationId: string,
  listId: string,
  query: Pick<
    CrmEntryQuery,
    'query' | 'sortKey' | 'sortDir' | 'statusIn' | 'statusKey' | 'conditions'
  > & {
    perColumn?: number | null;
    /**
     * The status field to make columns of, when not the one `statusIn`
     * filters (a view grouped by another field). `statusIn` then narrows
     * the entries rather than choosing columns.
     */
    groupKey?: string | null;
  } = {},
): Promise<Result<CrmBoard>> {
  return guard('read', 'read a CRM board', async () => {
    if (!isUuid(listId)) return err('not_found', 'That list does not exist.');
    const list = await store.get('crm_lists', organizationId, listId);
    if (!list) return err('not_found', 'That list does not exist.');
    const pipeline = statusFieldFor(list, query.statusKey);
    const grouped = query.groupKey ? statusFieldFor(list, query.groupKey) : null;
    const field = grouped ?? pipeline;
    if (!field) {
      return err('invalid_input', `${list.name} has no status field to lay out as a board.`);
    }
    const perColumn = clampInt(query.perColumn, 1, CRM_BOARD_COLUMN_MAX, 25);
    const wanted = (query.statusIn ?? []).filter((s) => typeof s === 'string' && s);
    // Chips on the field the columns are made of pick columns; chips on
    // another field narrow every column.
    const chipsPickColumns = field.key === pipeline?.key;
    const base = compileEntryFilter(entriesFilter(list, query.query), list.fields, {
      statusKey: chipsPickColumns ? null : (pipeline?.key ?? null),
      statuses: chipsPickColumns ? null : wanted,
      conditions: query.conditions,
    });
    const { sort, orderBy } = entryOrder(list, query.sortKey, query.sortDir);
    const path = `values->>${field.key}`;

    const ordered = sortStatusOptions(field.options ?? []);
    const statuses: (string | null)[] =
      chipsPickColumns && wanted.length
        ? ordered.filter((s) => wanted.includes(s))
        : [...ordered, null];

    const [total, loaded] = await Promise.all([
      store.count('crm_list_entries', organizationId, base),
      inBatches(statuses, 4, async (status): Promise<CrmBoardColumn> => {
        const filter: Filter =
          status === null ? narrowNull(base, path) : narrowIn(base, path, [status]);
        const [entries, count] = await Promise.all([
          store.list('crm_list_entries', organizationId, filter, { orderBy, limit: perColumn }),
          store.count('crm_list_entries', organizationId, filter),
        ]);
        return { status, entries, total: count };
      }),
    ]);
    const columns = loaded.filter((c) => c.status !== null || c.total > 0);
    const placed = loaded.reduce((sum, c) => sum + c.total, 0);
    const records = await recordSummaries(
      store,
      organizationId,
      columns.flatMap((c) => c.entries),
    );
    return ok({
      list,
      statusField: field,
      columns,
      unplaced: chipsPickColumns && wanted.length ? 0 : Math.max(0, total - placed),
      sort,
      perColumn,
      records,
    });
  });
}

export interface CrmEntryDetail {
  entry: CrmListEntry;
  list: Pick<CrmList, 'id' | 'name' | 'entity_type' | 'fields'>;
  record: CrmRecordSummary | null;
  /** Notes on the entry or on the record it points at, newest first. */
  notes: CrmNote[];
}

/** One entry for the list page's side panel: its list, its record and their notes. */
export async function getEntry(
  store: DataStore,
  organizationId: string,
  entryId: string,
  options: { noteLimit?: number } = {},
): Promise<Result<CrmEntryDetail>> {
  return guard('read', 'read a CRM entry', async () => {
    if (!isUuid(entryId)) return err('not_found', 'That entry does not exist.');
    const entry = await store.get('crm_list_entries', organizationId, entryId);
    if (!entry) return err('not_found', 'That entry does not exist.');
    const noteLimit = clampInt(options.noteLimit, 1, 500, 100);
    const noteOrder: QueryOptions = {
      orderBy: [
        { field: 'occurred_at', direction: 'desc' },
        { field: 'created_at', direction: 'desc' },
      ],
      limit: noteLimit,
    };
    const [list, record, onEntry, onRecord] = await Promise.all([
      store.get('crm_lists', organizationId, entry.list_id),
      entry.record_id
        ? store.get('crm_records', organizationId, entry.record_id)
        : Promise.resolve(null),
      store.list(
        'crm_notes',
        organizationId,
        { arrayContains: { entry_ids: entry.id } },
        noteOrder,
      ),
      entry.record_id
        ? store.list(
            'crm_notes',
            organizationId,
            { arrayContains: { record_ids: entry.record_id } },
            noteOrder,
          )
        : Promise.resolve([] as CrmNote[]),
    ]);
    if (!list) return err('not_found', 'That entry’s list does not exist.');
    const notesById = new Map<string, CrmNote>();
    for (const note of [...onEntry, ...onRecord]) notesById.set(note.id, note);
    const { id, name, entity_type, fields } = list;
    return ok({
      entry,
      list: { id, name, entity_type, fields },
      record: record ? summarize(record) : null,
      notes: [...notesById.values()].sort(byOccurredDesc).slice(0, noteLimit),
    });
  });
}

/** A company as it already exists in Copilot's own Deals or Portfolio. */
export interface CrmCopilotLink {
  kind: 'deal' | 'portfolio';
  id: string;
  name: string;
  /** A deal's stage key, or a portfolio company's current stage. */
  stage: string | null;
  archived: boolean;
  matchedBy: 'domain' | 'name';
}

/**
 * Where a CRM company also lives in Copilot: deals and portfolio companies
 * with the same domain, or — for a table where no row shares the domain — the
 * same normalized name. Read-only; the two are never merged. A person has no
 * such links. These tables predate the CRM, so a failure is an ordinary
 * internal error the page can drop, never "not set up".
 */
export async function findCopilotLinks(
  store: DataStore,
  organizationId: string,
  record: Pick<CrmRecord, 'kind' | 'name' | 'domain'>,
): Promise<Result<CrmCopilotLink[]>> {
  if (record.kind !== 'company') return ok([]);
  const domain = record.domain ? normalizeDomain(record.domain) : null;
  const name = normalizeCompanyName(record.name);
  try {
    const lookup = async <T extends 'deals' | 'portfolio_companies'>(table: T) => {
      if (domain) {
        const byDomain = await store.list(table, organizationId, { eq: { domain } }, { limit: 10 });
        if (byDomain.length) return { rows: byDomain, matchedBy: 'domain' as const };
      }
      if (!name) return { rows: [] as Row<T>[], matchedBy: 'name' as const };
      const byName = await store.list(
        table,
        organizationId,
        { eq: { normalized_name: name } },
        { limit: 10 },
      );
      return { rows: byName, matchedBy: 'name' as const };
    };
    const [deals, portfolio] = await Promise.all([lookup('deals'), lookup('portfolio_companies')]);
    return ok([
      ...portfolio.rows.map((p): CrmCopilotLink => ({
        kind: 'portfolio',
        id: p.id,
        name: p.name,
        stage: p.current_stage,
        archived: p.is_archived,
        matchedBy: portfolio.matchedBy,
      })),
      ...deals.rows.map((d): CrmCopilotLink => ({
        kind: 'deal',
        id: d.id,
        name: d.company_name,
        stage: d.stage,
        archived: d.is_archived,
        matchedBy: deals.matchedBy,
      })),
    ]);
  } catch (error) {
    log.warn('CRM cross-link lookup failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'Copilot’s deals and portfolio could not be checked just now.', {
      retryable: true,
    });
  }
}

/* ----------------------------------------------------------- page writes */

/** Who made a change: audited by user id, and the display name a note is signed with. */
export interface CrmActor {
  userId: string | null;
  name: string | null;
}

/** The signed-in user as a CRM actor; the name is their display name, else their email. */
export function crmActor(auth: Pick<AuthContext, 'userId' | 'profile'>): CrmActor {
  return {
    userId: auth.userId,
    name: auth.profile.full_name?.trim() || auth.profile.email || null,
  };
}

async function audit(
  store: DataStore,
  organizationId: string,
  actor: CrmActor | undefined,
  action: AuditAction,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown> = {},
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

const ENTITY_TYPES: readonly CrmEntityType[] = ['company', 'person', 'deal'];
const ENTITY_NOUN: Record<CrmEntityType, string> = {
  company: 'companies',
  person: 'people',
  deal: 'deals',
};

export interface CreateCrmListInput {
  name: string;
  entityType: CrmEntityType;
  fields?: readonly CrmFieldInput[];
}

/** A new Copilot list, placed after the existing ones. */
export async function createList(
  store: DataStore,
  organizationId: string,
  input: CreateCrmListInput,
  actor?: CrmActor,
): Promise<Result<CrmList>> {
  return guard('write', 'create a CRM list', async () => {
    const name = input.name?.trim();
    if (!name) return err('invalid_input', 'A list needs a name.');
    if (name.length > 300) return err('invalid_input', 'That list name is too long.');
    if (!ENTITY_TYPES.includes(input.entityType)) {
      return err('invalid_input', 'A list holds companies, people or deals.');
    }
    const now = new Date().toISOString();
    const list: CrmList = {
      id: newId(),
      organization_id: organizationId,
      source: 'copilot',
      external_id: null,
      name,
      entity_type: input.entityType,
      fields: normalizeCrmFields(input.fields ?? []),
      position: await nextPosition(store, organizationId, 'crm_lists', {}),
      archived: false,
      created_at: now,
      updated_at: now,
    };
    const saved = await store.insert('crm_lists', list);
    await audit(store, organizationId, actor, 'crm.list_created', 'crm_list', list.id, {
      entity_type: list.entity_type,
      fields: list.fields.length,
    });
    return ok(saved);
  });
}

export interface UpdateCrmListInput {
  name?: string;
  /** Replaces the field list. Keep a field's `key` to keep its stored values addressable. */
  fields?: readonly CrmFieldInput[];
  archived?: boolean;
  position?: number;
}

/** Rename, re-field, archive or move a list. */
export async function updateList(
  store: DataStore,
  organizationId: string,
  listId: string,
  patch: UpdateCrmListInput,
  actor?: CrmActor,
): Promise<Result<CrmList>> {
  return guard('write', 'update a CRM list', async () => {
    if (!isUuid(listId)) return err('not_found', 'That list does not exist.');
    const list = await store.get('crm_lists', organizationId, listId);
    if (!list) return err('not_found', 'That list does not exist.');
    const next: Partial<CrmList> = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name || name.length > 300) return err('invalid_input', 'A list needs a name.');
      next.name = name;
    }
    if (patch.fields !== undefined) next.fields = normalizeCrmFields(patch.fields);
    if (patch.archived !== undefined) next.archived = Boolean(patch.archived);
    if (patch.position !== undefined) next.position = clampInt(patch.position, 0, 1e6, 0);
    if (Object.keys(next).length === 0) return ok(list);
    next.updated_at = new Date().toISOString();
    const updated = await store.update('crm_lists', organizationId, list.id, next);
    await audit(store, organizationId, actor, 'crm.list_updated', 'crm_list', list.id, {
      changed: Object.keys(next).filter((k) => k !== 'updated_at'),
    });
    return ok(updated);
  });
}

/** The most stages a status field carries; the import's own cap on options. */
export const CRM_STATUS_OPTIONS_MAX = 500;

/**
 * Set a status field's stages, in order: add stages no row used on the day
 * the list was exported, put them in pipeline order, drop ones nothing uses.
 * Stages are matched by label, so this never renames one — entries would be
 * left holding the old label — and a stage some entries still hold is only
 * removed once they have moved on. The order matters for stages without a
 * number; numbered ones ("3. First Meeting") always sort by their number
 * (sortStatusOptions).
 */
export async function updateStatusOptions(
  store: DataStore,
  organizationId: string,
  listId: string,
  fieldKey: string,
  options: readonly string[],
  actor?: CrmActor,
): Promise<Result<CrmList>> {
  return guard('write', 'update CRM stages', async () => {
    if (!isUuid(listId)) return err('not_found', 'That list does not exist.');
    const list = await store.get('crm_lists', organizationId, listId);
    if (!list) return err('not_found', 'That list does not exist.');
    const field = list.fields.find((f) => f.key === fieldKey);
    if (!field || field.type !== 'status') {
      return err('invalid_input', `That is not a status field of ${list.name}.`);
    }
    const next: string[] = [];
    const seen = new Set<string>();
    for (const raw of options ?? []) {
      const label = typeof raw === 'string' ? raw.trim() : '';
      if (!label) continue;
      if (label.length > 200)
        return err('invalid_input', 'A stage name can be at most 200 characters.');
      if (seen.has(label.toLowerCase())) return err('invalid_input', `“${label}” is listed twice.`);
      seen.add(label.toLowerCase());
      next.push(label);
    }
    if (!next.length) return err('invalid_input', `${field.name} needs at least one stage.`);
    if (next.length > CRM_STATUS_OPTIONS_MAX) {
      return err('too_large', `${field.name} can have at most ${CRM_STATUS_OPTIONS_MAX} stages.`);
    }
    const before = field.options ?? [];
    const removed = before.filter((o) => !next.includes(o));
    for (const label of removed) {
      const held = await store.count('crm_list_entries', organizationId, {
        eq: { list_id: list.id },
        in: { [`values->>${field.key}`]: [label] },
      });
      if (held > 0) {
        return err(
          'conflict',
          `${held.toLocaleString('en-US')} ${held === 1 ? 'entry is' : 'entries are'} in “${label}”. Move ${held === 1 ? 'it' : 'them'} to another stage before removing it.`,
        );
      }
    }
    if (same(next, before)) return ok(list);
    const updated = await store.update('crm_lists', organizationId, list.id, {
      fields: list.fields.map((f) => (f.key === field.key ? { ...f, options: next } : f)),
      updated_at: new Date().toISOString(),
    });
    await audit(store, organizationId, actor, 'crm.list_updated', 'crm_list', list.id, {
      changed: ['stages'],
      field: field.key,
      added: next.filter((o) => !before.includes(o)).length,
      removed: removed.length,
    });
    return ok(updated);
  });
}

/** Check a `{ key: value }` patch against the list's fields, strictly. */
function validateValues(
  list: CrmList,
  patch: Record<string, unknown>,
): { ok: true; values: Record<string, CrmValue> } | { ok: false; message: string } {
  const values: Record<string, CrmValue> = {};
  for (const [key, raw] of Object.entries(patch)) {
    const field = list.fields.find((f) => f.key === key);
    if (!field) return { ok: false, message: `"${key}" is not a field of ${list.name}.` };
    const checked = validateCrmValue(field, raw);
    if (!checked.ok) return { ok: false, message: checked.message };
    values[key] = checked.value;
  }
  return { ok: true, values };
}

/** `base` with `patch` applied; a null in the patch removes the key. */
function applyValues(
  base: Record<string, CrmValue>,
  patch: Record<string, CrmValue>,
): Record<string, CrmValue> {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || (Array.isArray(value) && value.length === 0)) delete out[key];
    else out[key] = value;
  }
  return out;
}

/**
 * Set some of an entry's values — a status change is `{ status: '5. Diligence' }`.
 * Keys must be fields of the entry's list; values are checked against the
 * field (a status must be one of its options); null clears a value. Keys not
 * in the patch are untouched. An unchanged patch writes nothing.
 */
export async function updateEntryValues(
  store: DataStore,
  organizationId: string,
  entryId: string,
  patch: Record<string, unknown>,
  actor?: CrmActor,
): Promise<Result<CrmListEntry>> {
  return guard('write', 'update a CRM entry', async () => {
    if (!isUuid(entryId)) return err('not_found', 'That entry does not exist.');
    const entry = await store.get('crm_list_entries', organizationId, entryId);
    if (!entry) return err('not_found', 'That entry does not exist.');
    const list = await store.get('crm_lists', organizationId, entry.list_id);
    if (!list) return err('not_found', 'That entry’s list does not exist.');
    const checked = validateValues(list, patch ?? {});
    if (!checked.ok) return err('invalid_input', checked.message);

    const values = applyValues(entry.values ?? {}, checked.values);
    if (same(values, entry.values ?? {})) return ok(entry);
    const updated = await store.update('crm_list_entries', organizationId, entry.id, {
      values,
      updated_at: new Date().toISOString(),
    });
    const before = entry.values ?? {};
    await audit(store, organizationId, actor, 'crm.entry_updated', 'crm_list_entry', entry.id, {
      list_id: list.id,
      fields: Object.keys(checked.values),
      // The keys whose value actually changed (keys, never values): what the
      // time-in-status column reads a status change from.
      changed: Object.keys(checked.values).filter(
        (k) => !same(before[k] ?? null, values[k] ?? null),
      ),
    });
    return ok(updated);
  });
}

export interface AddCrmEntryInput {
  /** The company or person to add. For a company or person list, required unless `title` is given. */
  recordId?: string | null;
  /** The row's name; defaults to the record's name. Required for a deal without a record. */
  title?: string | null;
  values?: Record<string, unknown>;
}

/**
 * Add a row to a list, at the end. A company list takes company records and a
 * person list people; a deal list takes a title and optionally the company it
 * is with. A record already on a company or person list is a conflict.
 */
export async function addEntry(
  store: DataStore,
  organizationId: string,
  listId: string,
  input: AddCrmEntryInput,
  actor?: CrmActor,
): Promise<Result<CrmListEntry>> {
  return guard('write', 'add a CRM entry', async () => {
    if (!isUuid(listId)) return err('not_found', 'That list does not exist.');
    const list = await store.get('crm_lists', organizationId, listId);
    if (!list) return err('not_found', 'That list does not exist.');

    let record: CrmRecord | null = null;
    if (input.recordId) {
      record = isUuid(input.recordId)
        ? await store.get('crm_records', organizationId, input.recordId)
        : null;
      if (!record) return err('not_found', 'That company or person does not exist.');
      const expected: CrmRecordKind = list.entity_type === 'person' ? 'person' : 'company';
      if (record.kind !== expected) {
        return err(
          'invalid_input',
          list.entity_type === 'person'
            ? `${list.name} holds people, not companies.`
            : `${list.name} holds companies, not people.`,
        );
      }
      if (list.entity_type !== 'deal') {
        const existing = await store.findOne('crm_list_entries', organizationId, {
          eq: { list_id: list.id, record_id: record.id },
        });
        if (existing) return err('conflict', `${record.name} is already on ${list.name}.`);
      }
    }
    const title = (input.title?.trim() || record?.name || '').slice(0, 500);
    if (!title) return err('invalid_input', 'An entry needs a name or a company/person.');

    const checked = validateValues(list, input.values ?? {});
    if (!checked.ok) return err('invalid_input', checked.message);

    const now = new Date().toISOString();
    const entry: CrmListEntry = {
      id: newId(),
      organization_id: organizationId,
      list_id: list.id,
      record_id: record?.id ?? null,
      title,
      external_id: null,
      values: applyValues({}, checked.values),
      imported_values: null,
      position: await nextPosition(store, organizationId, 'crm_list_entries', {
        eq: { list_id: list.id },
      }),
      created_at: now,
      updated_at: now,
    };
    const saved = await store.insert('crm_list_entries', entry);
    await audit(store, organizationId, actor, 'crm.entry_added', 'crm_list_entry', entry.id, {
      list_id: list.id,
      has_record: Boolean(record),
    });
    return ok(saved);
  });
}

/** Take a row off its list. The record and its notes are untouched. */
export async function removeEntry(
  store: DataStore,
  organizationId: string,
  entryId: string,
  actor?: CrmActor,
): Promise<Result<{ id: string }>> {
  return guard('write', 'remove a CRM entry', async () => {
    if (!isUuid(entryId)) return err('not_found', 'That entry does not exist.');
    const entry = await store.get('crm_list_entries', organizationId, entryId);
    if (!entry) return err('not_found', 'That entry does not exist.');
    await store.remove('crm_list_entries', organizationId, entry.id);
    await audit(store, organizationId, actor, 'crm.entry_removed', 'crm_list_entry', entry.id, {
      list_id: entry.list_id,
    });
    return ok({ id: entry.id });
  });
}

export const CRM_NOTE_MAX_CHARS = 500_000;

export interface AddCrmNoteInput {
  content: string;
  recordIds?: readonly string[];
  entryIds?: readonly string[];
  title?: string | null;
  /** When it happened; defaults to now. */
  occurredAt?: string | null;
}

/**
 * A note written in Copilot, signed with the actor's display name. It must be
 * attached to at least one record or entry, all of which must exist; the
 * names they carry are kept on the note as `entity_names`.
 */
export async function addNote(
  store: DataStore,
  organizationId: string,
  input: AddCrmNoteInput,
  actor: CrmActor,
): Promise<Result<CrmNote>> {
  return guard('write', 'add a CRM note', async () => {
    const content = (input.content ?? '').trim();
    if (!content) return err('invalid_input', 'A note needs some text.');
    if (content.length > CRM_NOTE_MAX_CHARS) return err('too_large', 'That note is too long.');
    const recordIds = [...new Set(input.recordIds ?? [])];
    const entryIds = [...new Set(input.entryIds ?? [])];
    if (!recordIds.length && !entryIds.length) {
      return err('invalid_input', 'Attach the note to a company, person or list entry.');
    }
    if (![...recordIds, ...entryIds].every(isUuid)) {
      return err('not_found', 'Something this note is attached to does not exist.');
    }
    const [records, entries] = await Promise.all([
      recordIds.length
        ? listWhereIn(store, 'crm_records', organizationId, {}, 'id', recordIds)
        : Promise.resolve([] as CrmRecord[]),
      entryIds.length
        ? listWhereIn(store, 'crm_list_entries', organizationId, {}, 'id', entryIds)
        : Promise.resolve([] as CrmListEntry[]),
    ]);
    if (records.length !== recordIds.length || entries.length !== entryIds.length) {
      return err('not_found', 'Something this note is attached to does not exist.');
    }
    let occurredAt = new Date().toISOString();
    if (input.occurredAt) {
      const t = Date.parse(input.occurredAt);
      if (Number.isNaN(t)) return err('invalid_input', 'That date is not valid.');
      occurredAt = new Date(t).toISOString();
    }
    const title = input.title?.trim().slice(0, 500) || null;
    const now = new Date().toISOString();
    const id = newId();
    const note: CrmNote = {
      id,
      organization_id: organizationId,
      source: 'copilot',
      external_id: id,
      title,
      content,
      author: actor.name?.trim() || null,
      occurred_at: occurredAt,
      record_ids: recordIds,
      entry_ids: entryIds,
      entity_names: union(
        records.map((r) => r.name),
        entries.map((e) => e.title),
      ),
      // Typed by a colleague, but pasted text travels: same scan as imports.
      injection_flagged: scanForInjection(`${title ?? ''}\n${content}`).flagged,
      created_at: now,
      updated_at: now,
    };
    const saved = await store.insert('crm_notes', note);
    await audit(store, organizationId, actor, 'crm.note_added', 'crm_note', id, {
      records: recordIds.length,
      entries: entryIds.length,
    });
    return ok(saved);
  });
}

/* --------------------------------------------------------- import upserts */
//
// Each takes at most CRM_UPSERT_BATCH_MAX rows, so one import request stays
// well inside the host's time limit; the import route sends a large file as
// a sequence of calls. Existing rows are fetched in a few `in` queries per
// batch, rows are matched in memory, and only rows that actually change are
// written — new ones in bulk inserts, changed ones one update each. Importing
// the same rows again therefore writes nothing at all.
//
// Counts are per input row: `inserted` created a row, `updated` changed one
// (including one created earlier in the same batch), `unchanged` matched a row
// it would not change, `skipped` had nothing usable (see `problems`), and
// `errors` failed to write.

export const CRM_UPSERT_BATCH_MAX = 500;

export interface CrmUpsertSummary {
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: number;
  /** The id each input row resolved to, in input order; null when skipped or failed. */
  ids: (string | null)[];
  /** Why rows were skipped or values dropped or kept (row is the input index). At most 50. */
  problems: { row: number; message: string }[];
  /** List entries only: values changed in Copilot that the import kept rather than overwrote. */
  keptEdits: number;
}

type Outcome = 'inserted' | 'updated' | 'unchanged' | 'skipped' | 'error';

/** Bookkeeping shared by the three upserts. */
class Batch<T extends { id: string }> {
  readonly outcomes: Outcome[];
  readonly ids: (string | null)[];
  readonly problems: { row: number; message: string }[] = [];
  keptEdits = 0;
  /** Rows to create, by id. */
  readonly inserts = new Map<string, T>();
  /** Existing rows to change, by id: the row as stored, and as it will be. */
  readonly updates = new Map<string, { before: T; after: T }>();
  /** Which input rows each written row carries, so a failed write fails them all. */
  private readonly rowsFor = new Map<string, number[]>();

  constructor(size: number) {
    this.outcomes = new Array<Outcome>(size).fill('skipped');
    this.ids = new Array<string | null>(size).fill(null);
  }

  problem(row: number, message: string): void {
    if (this.problems.length < 50) this.problems.push({ row, message });
  }

  skip(row: number, message: string): void {
    this.outcomes[row] = 'skipped';
    this.problem(row, message);
  }

  keptEdit(row: number, message: string): void {
    this.keptEdits++;
    this.problem(row, message);
  }

  private carry(id: string, row: number): void {
    this.ids[row] = id;
    const rows = this.rowsFor.get(id) ?? [];
    rows.push(row);
    this.rowsFor.set(id, rows);
  }

  insert(row: number, value: T): void {
    this.inserts.set(value.id, value);
    this.outcomes[row] = 'inserted';
    this.carry(value.id, row);
  }

  /** Record `row`'s effect on `current` (a stored row, or one being created in this batch). */
  change(row: number, current: T, next: T, stored: T | undefined): void {
    if (same(current, next)) {
      this.outcomes[row] = 'unchanged';
    } else if (this.inserts.has(current.id)) {
      this.inserts.set(current.id, next);
      this.outcomes[row] = 'updated';
    } else {
      this.updates.set(current.id, { before: stored ?? current, after: next });
      this.outcomes[row] = 'updated';
    }
    this.carry(current.id, row);
  }

  fail(id: string, message: string): void {
    for (const row of this.rowsFor.get(id) ?? []) {
      this.outcomes[row] = 'error';
      this.ids[row] = null;
      this.problem(row, message);
    }
  }

  summary(): CrmUpsertSummary {
    const count = (o: Outcome) => this.outcomes.filter((x) => x === o).length;
    return {
      inserted: count('inserted'),
      updated: count('updated'),
      unchanged: count('unchanged'),
      skipped: count('skipped'),
      errors: count('error'),
      ids: this.ids,
      problems: this.problems,
      keptEdits: this.keptEdits,
    };
  }
}

const MUTABLE: Record<'crm_records' | 'crm_list_entries' | 'crm_notes', readonly string[]> = {
  crm_records: [
    'source',
    'external_id',
    'name',
    'name_key',
    'domain',
    'emails',
    'primary_email',
    'fields',
  ],
  crm_list_entries: ['record_id', 'title', 'external_id', 'values', 'imported_values', 'position'],
  crm_notes: [
    'title',
    'content',
    'author',
    'occurred_at',
    'record_ids',
    'entry_ids',
    'entity_names',
    'injection_flagged',
  ],
};

/** Write a batch: bulk inserts (row by row if a bulk insert fails), then the changed rows. */
async function flush<T extends 'crm_records' | 'crm_list_entries' | 'crm_notes'>(
  store: DataStore,
  organizationId: string,
  table: T,
  batch: Batch<Row<T>>,
): Promise<void> {
  const failed = (id: string, error: unknown) => {
    // A missing table or column fails every row the same way; let the guard
    // say so once.
    if (isMissingTableError(error) || isMissingColumnError(error)) throw error;
    batch.fail(id, 'This row could not be saved.');
    log.warn('CRM import row failed', { table, reason: (error as Error)?.message });
  };

  for (const group of chunk([...batch.inserts.values()], 100)) {
    try {
      await store.insertMany(table, group);
    } catch (error) {
      if (isMissingTableError(error) || isMissingColumnError(error)) throw error;
      // One bad row (or a concurrent import that got there first) must not
      // sink its neighbours: retry them one at a time.
      for (const row of group) {
        try {
          await store.insert(table, row);
        } catch (rowError) {
          failed(row.id, rowError);
        }
      }
    }
  }

  const now = new Date().toISOString();
  await inBatches([...batch.updates.values()], 8, async ({ before, after }) => {
    const patch: Record<string, unknown> = { updated_at: now };
    for (const column of MUTABLE[table]) {
      const a = (after as unknown as Record<string, unknown>)[column];
      if (!same((before as unknown as Record<string, unknown>)[column], a)) patch[column] = a;
    }
    try {
      await store.update(table, organizationId, after.id, patch as Partial<Row<T>>);
    } catch (error) {
      failed(after.id, error);
    }
  });
}

function tooMany(rows: readonly unknown[]): Result<never> | null {
  if (rows.length <= CRM_UPSERT_BATCH_MAX) return null;
  return err(
    'too_large',
    `At most ${CRM_UPSERT_BATCH_MAX} rows per call; send the import in batches.`,
  );
}

function externalKey(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, 300) : null;
}

/** Index of rows by several keys, kept current as a batch inserts and changes rows. */
class Index<T extends { id: string; created_at: string }> {
  private readonly maps = new Map<string, Map<string, T[]>>();
  private readonly byId = new Map<string, T>();

  /**
   * `order` ranks rows sharing a key, the first being the one a lookup finds.
   * Oldest first by default, so an ambiguous match is resolved the same way
   * every time.
   */
  constructor(
    private readonly keysOf: (row: T) => Record<string, readonly string[]>,
    private readonly order: (a: T, b: T) => number = (a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1,
  ) {}

  add(row: T): void {
    const previous = this.byId.get(row.id);
    if (previous) this.drop(previous);
    this.byId.set(row.id, row);
    for (const [name, keys] of Object.entries(this.keysOf(row))) {
      let map = this.maps.get(name);
      if (!map) this.maps.set(name, (map = new Map()));
      for (const key of keys) {
        const rows = map.get(key) ?? [];
        rows.push(row);
        rows.sort(this.order);
        map.set(key, rows);
      }
    }
  }

  private drop(row: T): void {
    for (const [name, keys] of Object.entries(this.keysOf(row))) {
      const map = this.maps.get(name);
      for (const key of keys) {
        const rows = map?.get(key)?.filter((r) => r.id !== row.id);
        if (map && rows) map.set(key, rows);
      }
    }
  }

  find(name: string, key: string | null | undefined, accept?: (row: T) => boolean): T | null {
    return this.all(name, key, accept)[0] ?? null;
  }

  /** Every row under `key`, oldest first. */
  all(name: string, key: string | null | undefined, accept?: (row: T) => boolean): T[] {
    if (!key) return [];
    const rows = this.maps.get(name)?.get(key) ?? [];
    return accept ? rows.filter(accept) : rows;
  }
}

/* ---- records */

/** A company or person row from an export, after the import route's column mapping. */
export interface CrmRecordRow {
  /** Affinity's Organization ID / Person ID. */
  externalId?: string | number | null;
  name?: string | null;
  /** A domain or a website URL; normalized to the bare domain. Companies. */
  domain?: string | null;
  /** Addresses, or one cell of them separated by `;` or `,`. People. */
  emails?: readonly string[] | string | null;
  primaryEmail?: string | null;
  /** Other columns, by display label. Empty values are dropped. */
  fields?: Record<string, unknown> | null;
}

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

function cleanEmails(value: readonly string[] | string | null | undefined): string[] {
  const parts = typeof value === 'string' ? value.split(/[;,\s]+/) : (value ?? []);
  const out: string[] = [];
  for (const raw of parts) {
    const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (EMAIL_RE.test(email) && !out.includes(email)) out.push(email);
  }
  return out;
}

function cleanRecordFields(fields: Record<string, unknown> | null | undefined) {
  const out: Record<string, CrmValue> = {};
  for (const [rawLabel, raw] of Object.entries(fields ?? {})) {
    const label = rawLabel.trim().slice(0, 100);
    if (!label || Object.keys(out).length >= 100) continue;
    const value = normalizeCrmValue(Array.isArray(raw) ? 'multi' : 'text', raw);
    if (value !== null) out[label] = typeof raw === 'number' ? raw : value;
  }
  return out;
}

interface CleanRecordRow {
  externalId: string | null;
  name: string;
  nameKey: string;
  domain: string | null;
  emails: string[];
  primaryEmail: string | null;
  fields: Record<string, CrmValue>;
}

function cleanRecordRow(kind: CrmRecordKind, row: CrmRecordRow): CleanRecordRow | null {
  const emails = kind === 'person' ? cleanEmails(row.emails) : [];
  const primary = kind === 'person' ? (cleanEmails(row.primaryEmail ?? '')[0] ?? null) : null;
  if (primary && !emails.includes(primary)) emails.unshift(primary);
  const domain = kind === 'company' ? normalizeDomain(row.domain) : null;
  const name = (row.name?.trim() || (kind === 'person' ? emails[0] : domain) || '').slice(0, 500);
  if (!name) return null;
  return {
    externalId: externalKey(row.externalId),
    name,
    nameKey: crmNameKey(name),
    domain,
    emails,
    primaryEmail: primary ?? emails[0] ?? null,
    fields: cleanRecordFields(row.fields),
  };
}

/**
 * Upsert companies or people from an export.
 *
 * A row with an external id is the same record as the one stored under that
 * id; failing that, it adopts a matching record that has no external id yet (a
 * company first made from a name in some other list) rather than duplicating
 * it. A row without one matches companies by domain, then name; people by
 * primary email, then any email, then name — names case-insensitively. A name
 * match needs one candidate and no contradiction (a different domain, or no
 * address in common); a name-only row that several records share is skipped
 * and reported rather than linked to a guess. An id match takes the row's
 * name, domain and primary email; a fuzzy match only fills what the record
 * lacks. Emails and fields are merged either way.
 */
export async function upsertRecords(
  store: DataStore,
  organizationId: string,
  kind: CrmRecordKind,
  rows: readonly CrmRecordRow[],
  options: { source?: CrmSource } = {},
): Promise<Result<CrmUpsertSummary>> {
  return guard('write', 'import CRM records', async () => {
    const tooLarge = tooMany(rows);
    if (tooLarge) return tooLarge;
    if (kind !== 'company' && kind !== 'person') {
      return err('invalid_input', 'Records are companies or people.');
    }
    const source = options.source ?? 'affinity';
    const batch = new Batch<CrmRecord>(rows.length);
    const clean = rows.map((row) => cleanRecordRow(kind, row));

    const index = new Index<CrmRecord>((r) => ({
      external: r.external_id ? [`${r.source}\u0000${r.external_id}`] : [],
      domain: r.domain ? [r.domain] : [],
      name: [r.name_key],
      primary: r.primary_email ? [r.primary_email] : [],
      email: r.emails,
    }));
    const stored = new Map<string, CrmRecord>();
    const prefetch = async (column: string, values: string[], base: Filter = {}) => {
      if (!values.length) return;
      const found = await listWhereIn(
        store,
        'crm_records',
        organizationId,
        { ...base, eq: { ...base.eq, kind } },
        column,
        values,
      );
      for (const r of found) {
        if (stored.has(r.id)) continue;
        stored.set(r.id, r);
        index.add(r);
      }
    };
    const present = clean.filter((r): r is CleanRecordRow => r !== null);
    await prefetch(
      'external_id',
      present.map((r) => r.externalId).filter((v): v is string => !!v),
      { eq: { source } },
    );
    await prefetch(
      'name_key',
      present.map((r) => r.nameKey),
    );
    if (kind === 'company') {
      await prefetch(
        'domain',
        present.map((r) => r.domain).filter((v): v is string => !!v),
      );
    } else {
      const emails = [...new Set(present.flatMap((r) => r.emails))];
      await prefetch('primary_email', emails);
      for (const group of chunk(emails, 100)) {
        for (const r of await listAllPages(store, 'crm_records', organizationId, {
          eq: { kind },
          arrayOverlaps: { emails: group },
        })) {
          if (stored.has(r.id)) continue;
          stored.set(r.id, r);
          index.add(r);
        }
      }
    }

    const now = new Date().toISOString();
    clean.forEach((row, i) => {
      if (!row) return batch.skip(i, 'No name, so there was nothing to store.');

      // A domain or an address tells records apart, so it matches exactly.
      const byIdentifier = (accept?: (r: CrmRecord) => boolean): CrmRecord | null =>
        kind === 'company'
          ? index.find('domain', row.domain, accept)
          : (index.find('primary', row.primaryEmail, accept) ??
            row.emails.map((e) => index.find('email', e, accept)).find(Boolean) ??
            null);
      // A name only where nothing contradicts it: a company at another domain,
      // or a person none of whose addresses are the row's, is someone else
      // with the same name ("Nova" at nova.ai and at nova.io; two Chris Lees).
      const byName = (accept?: (r: CrmRecord) => boolean): CrmRecord[] =>
        index.all(
          'name',
          row.nameKey,
          (r) =>
            (kind === 'company'
              ? !row.domain || !r.domain || r.domain === row.domain
              : !row.emails.length ||
                !r.emails.length ||
                row.emails.some((e) => r.emails.includes(e))) &&
            (!accept || accept(r)),
        );
      const onlyOne = (rows: CrmRecord[]) => (rows.length === 1 ? (rows[0] as CrmRecord) : null);

      let match: CrmRecord | null = null;
      let mode: 'id' | 'adopt' | 'fill' = 'fill';
      let sameName = 0;
      if (row.externalId) {
        match = index.find('external', `${source}\u0000${row.externalId}`);
        mode = 'id';
        if (!match) {
          const idless = (r: CrmRecord) => r.external_id === null;
          match = byIdentifier(idless) ?? onlyOne(byName(idless));
          mode = 'adopt';
        }
      } else {
        const named = byName();
        match = byIdentifier() ?? onlyOne(named);
        sameName = match ? 0 : named.length;
      }

      // Nothing but a name, and several records have it (a deal's
      // Organizations cell, say): picking one is a guess, and a new record
      // would duplicate one of them on every import. Left unlinked instead,
      // as the notes import leaves an ambiguous name. A row with an id, a
      // domain or an address is a record of its own and is created below.
      const identified = kind === 'company' ? Boolean(row.domain) : row.emails.length > 0;
      if (!match && sameName > 1 && !identified) {
        return batch.skip(
          i,
          `${sameName} ${kind === 'company' ? 'companies are' : 'people are'} named “${row.name}”, so this row was not linked to one.`,
        );
      }

      if (!match) {
        const record: CrmRecord = {
          id: newId(),
          organization_id: organizationId,
          kind,
          source,
          external_id: row.externalId,
          name: row.name,
          name_key: row.nameKey,
          domain: row.domain,
          emails: row.emails,
          primary_email: row.primaryEmail,
          fields: row.fields,
          created_at: now,
          updated_at: now,
        };
        batch.insert(i, record);
        index.add(record);
        return;
      }

      const authoritative = mode !== 'fill';
      const primary = authoritative
        ? (row.primaryEmail ?? match.primary_email)
        : (match.primary_email ?? row.primaryEmail);
      const emails = union(match.emails, row.emails);
      if (primary && !emails.includes(primary)) emails.unshift(primary);
      const next: CrmRecord = {
        ...match,
        source: mode === 'adopt' ? source : match.source,
        external_id: mode === 'adopt' ? row.externalId : match.external_id,
        name: authoritative ? row.name : match.name,
        name_key: authoritative ? row.nameKey : match.name_key,
        domain: authoritative ? (row.domain ?? match.domain) : (match.domain ?? row.domain),
        emails,
        primary_email: primary,
        fields: authoritative
          ? { ...match.fields, ...row.fields }
          : { ...row.fields, ...match.fields },
      };
      batch.change(i, match, next, stored.get(match.id));
      index.add(next);
    });

    await flush(store, organizationId, 'crm_records', batch);
    return ok(batch.summary());
  });
}

/* ---- lists */

export interface CrmListMeta {
  /**
   * The Copilot list to import into, when the person chose one. It keeps its
   * name; its entity type must be `entityType`.
   */
  id?: string | null;
  /** The list's id in the source, if known. Without one, a list matches by name and entity type. */
  externalId?: string | number | null;
  name: string;
  entityType: CrmEntityType;
  /** The columns being imported. Merged into an existing list's fields (see mergeCrmFields). */
  fields?: readonly CrmFieldInput[];
  source?: CrmSource;
}

export interface CrmListUpsert {
  list: CrmList;
  created: boolean;
  /** An existing list's name or fields changed. */
  updated: boolean;
}

/**
 * Create or update an imported list. Key entry values by the fields of the
 * list this returns: a re-imported column keeps the key it was first given.
 */
export async function upsertList(
  store: DataStore,
  organizationId: string,
  meta: CrmListMeta,
): Promise<Result<CrmListUpsert>> {
  return guard<CrmListUpsert>('write', 'import a CRM list', async () => {
    const name = meta.name?.trim();
    if (!name || name.length > 300) return err('invalid_input', 'A list needs a name.');
    if (!ENTITY_TYPES.includes(meta.entityType)) {
      return err('invalid_input', 'A list holds companies, people or deals.');
    }
    const source = meta.source ?? 'affinity';
    const externalId = externalKey(meta.externalId);
    const incoming = normalizeCrmFields(meta.fields ?? []);

    let existing: CrmList | null = null;
    if (meta.id) {
      existing = isUuid(meta.id) ? await store.get('crm_lists', organizationId, meta.id) : null;
      if (!existing) {
        return err(
          'not_found',
          'The list chosen to import into no longer exists. Reload the page and choose again.',
        );
      }
      if (existing.entity_type !== meta.entityType) {
        return err(
          'invalid_input',
          `${existing.name} holds ${ENTITY_NOUN[existing.entity_type]}, not ${ENTITY_NOUN[meta.entityType]}.`,
        );
      }
    }
    if (!existing && externalId) {
      existing = await store.findOne('crm_lists', organizationId, {
        eq: { source, external_id: externalId },
      });
    }
    if (!existing) {
      const candidates = await listAllPages(store, 'crm_lists', organizationId, {
        eq: { source, entity_type: meta.entityType },
      });
      existing =
        candidates.find(
          (l) => crmNameKey(l.name) === crmNameKey(name) && (!externalId || l.external_id === null),
        ) ?? null;
    }

    if (!existing) {
      const now = new Date().toISOString();
      const list: CrmList = {
        id: newId(),
        organization_id: organizationId,
        source,
        external_id: externalId,
        name,
        entity_type: meta.entityType,
        fields: incoming,
        position: await nextPosition(store, organizationId, 'crm_lists', {}),
        archived: false,
        created_at: now,
        updated_at: now,
      };
      return ok({ list: await store.insert('crm_lists', list), created: true, updated: false });
    }

    const fields = mergeCrmFields(existing.fields, incoming);
    const patch: Partial<CrmList> = {};
    if (!same(fields, existing.fields)) patch.fields = fields;
    // A list chosen by id keeps its name; one found by name takes the casing sent.
    if (!meta.id && existing.name !== name) patch.name = name;
    if (externalId && existing.external_id !== externalId) patch.external_id = externalId;
    if (Object.keys(patch).length === 0)
      return ok({ list: existing, created: false, updated: false });
    patch.updated_at = new Date().toISOString();
    const list = await store.update('crm_lists', organizationId, existing.id, patch);
    return ok({ list, created: false, updated: true });
  });
}

/* ---- entries */

/** One row of a list export, after column mapping. */
export interface CrmEntryRow {
  /**
   * What makes the row the same row next time, of one of three kinds:
   * Affinity's row id ("Affinity Row ID") as it is, `entity:<id>` for the
   * organization, person or opportunity id of a view without row ids, or
   * `name:<name>` for a deal list exported with neither.
   */
  externalId?: string | number | null;
  /** The entity or opportunity name; defaults to the record's name. */
  title?: string | null;
  /** The record the row is about, from upsertRecords' `ids`. */
  recordId?: string | null;
  /**
   * Values by the list's field keys: raw CSV strings (coerced by the field's
   * type) or already-typed values. A key present with an empty value clears
   * it; keys absent are left as they are. Keys that are not fields of the
   * list are dropped and reported.
   */
  values?: Record<string, unknown> | null;
  position?: number | null;
}

type EntryKeyKind = 'row' | 'entity' | 'name';

/** The kind of an entry's external id; a key with no prefix is a row id. */
function entryKeyKind(key: string): EntryKeyKind {
  if (key.startsWith('entity:')) return 'entity';
  if (key.startsWith('name:')) return 'name';
  return 'row';
}

/** Which key an entry keeps when an import names it by another kind: the more specific. */
const KEY_STRENGTH: Record<EntryKeyKind, number> = { name: 1, entity: 2, row: 3 };

/**
 * An import's values laid over an entry. A value someone changed in Copilot
 * since the last import — it differs from what that import left, in
 * `imported_values` — is kept rather than overwritten, and so is a value on a
 * row no import has written yet (one made in Copilot) that the file
 * disagrees with. Every other key the file carries takes the file's value, an
 * empty cell clearing it. The snapshot always takes the file's values, so a
 * kept edit stays kept when the same file is imported again, and a later
 * change in Affinity to a value nobody touched in Copilot still comes through.
 */
function mergeImport(
  entry: Pick<CrmListEntry, 'values' | 'imported_values'>,
  incoming: Record<string, CrmValue>,
): { values: Record<string, CrmValue>; imported: Record<string, CrmValue>; kept: string[] } {
  const current = entry.values ?? {};
  const base = entry.imported_values ?? null;
  const apply: Record<string, CrmValue> = {};
  const kept: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    const now = current[key] ?? null;
    const editedInCopilot = base ? !same(now, base[key] ?? null) : now !== null;
    if (editedInCopilot && !same(now, value)) kept.push(key);
    else apply[key] = value;
  }
  return {
    values: applyValues(current, apply),
    imported: applyValues(base ?? {}, incoming),
    kept,
  };
}

/** What the import summary says about a value it kept: the Copilot value, and the file's. */
function keptMessage(
  field: CrmField | undefined,
  key: string,
  copilot: CrmValue | undefined,
  file: CrmValue | undefined,
): string {
  const quote = (value: CrmValue | undefined) => {
    const text = field ? displayCrmValue(field, value) : String(value ?? '');
    return text ? `“${text.length > 60 ? `${text.slice(0, 60)}…` : text}”` : '';
  };
  const name = field?.name ?? key;
  const now = quote(copilot);
  const theirs = quote(file);
  if (!now) return `Kept ${name} cleared, as it was in Copilot, rather than the file’s ${theirs}.`;
  if (!theirs)
    return `Kept ${name} as set in Copilot (${now}) rather than clearing it as the file does.`;
  return `Kept ${name} as set in Copilot (${now}) rather than the file’s ${theirs}.`;
}

/**
 * Upsert a list's rows.
 *
 * A row with an external id matches the entry stored under it. Failing that,
 * it adopts an entry that has no external id, or one keyed by a different
 * kind of id — the same list exported once from a view without row ids and
 * once from a view with them names its rows by entity id or name the first
 * time and by row id the second, and must not import every row again. The
 * adopted entry keeps the more specific of the two keys. Candidates are found
 * by record, then title; on a deal list by title alone, since a company's
 * deals share its record. A row without an external id matches the same
 * way. An entry another row of the batch already matched or created is not
 * taken again by record or title, so two rows never fold into one.
 *
 * Values follow mergeImport: an import never overwrites what someone changed
 * in Copilot since the last one, and says so in `problems`.
 */
export async function upsertEntries(
  store: DataStore,
  organizationId: string,
  listId: string,
  rows: readonly CrmEntryRow[],
): Promise<Result<CrmUpsertSummary>> {
  return guard('write', 'import CRM entries', async () => {
    const tooLarge = tooMany(rows);
    if (tooLarge) return tooLarge;
    if (!isUuid(listId)) return err('not_found', 'That list does not exist.');
    const list = await store.get('crm_lists', organizationId, listId);
    if (!list) return err('not_found', 'That list does not exist.');
    const fields = new Map(list.fields.map((f) => [f.key, f]));
    const batch = new Batch<CrmListEntry>(rows.length);

    // Records the rows point at must exist: a dangling id would fail the
    // foreign key and take the whole bulk insert with it.
    const wantedRecords = rows
      .map((r) => r.recordId)
      .filter((id): id is string => typeof id === 'string' && isUuid(id));
    const records = new Map(
      (wantedRecords.length
        ? await listWhereIn(store, 'crm_records', organizationId, {}, 'id', wantedRecords)
        : []
      ).map((r) => [r.id, r]),
    );

    const dropped = new Set<string>();
    const clean = rows.map((row, i) => {
      let recordId: string | null = null;
      if (row.recordId) {
        if (records.has(row.recordId)) recordId = row.recordId;
        else batch.problem(i, 'The linked company or person does not exist; stored without it.');
      }
      const title = (row.title?.trim() || records.get(recordId ?? '')?.name || '').slice(0, 500);
      const values: Record<string, CrmValue> = {};
      for (const [key, raw] of Object.entries(row.values ?? {})) {
        const field = fields.get(key);
        if (!field) {
          if (!dropped.has(key)) {
            dropped.add(key);
            batch.problem(
              i,
              `"${key}" is not a field of ${list.name}; its values were not stored.`,
            );
          }
          continue;
        }
        values[key] = normalizeCrmValue(field.type, raw);
      }
      const position = typeof row.position === 'number' ? clampInt(row.position, 0, 1e9, 0) : null;
      return { externalId: externalKey(row.externalId), title, recordId, values, position };
    });

    // In list order: rows created by one import share a timestamp, and the
    // file's row order is what pairs its rows with them again next time.
    const index = new Index<CrmListEntry>(
      (e) => ({
        external: e.external_id ? [e.external_id] : [],
        record: e.record_id ? [e.record_id] : [],
        title: [e.title],
      }),
      (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const stored = new Map<string, CrmListEntry>();
    const prefetch = async (column: string, values: string[]) => {
      if (!values.length) return;
      for (const e of await listWhereIn(
        store,
        'crm_list_entries',
        organizationId,
        { eq: { list_id: list.id } },
        column,
        values,
      )) {
        if (stored.has(e.id)) continue;
        stored.set(e.id, e);
        index.add(e);
      }
    };
    await prefetch(
      'external_id',
      clean.map((r) => r.externalId).filter((v): v is string => !!v),
    );
    await prefetch(
      'record_id',
      clean.map((r) => r.recordId).filter((v): v is string => !!v),
    );
    await prefetch('title', clean.map((r) => r.title).filter(Boolean));

    let position = await nextPosition(store, organizationId, 'crm_list_entries', {
      eq: { list_id: list.id },
    });
    const now = new Date().toISOString();
    // Entries a row of this batch has already matched or created, which no
    // other row may then take by record or title.
    const claimed = new Set<string>();
    clean.forEach((row, i) => {
      if (!row.title) return batch.skip(i, 'No name and no linked record, so nothing to store.');

      const candidate = (accept: (e: CrmListEntry) => boolean): CrmListEntry | null => {
        const open = (e: CrmListEntry) => !claimed.has(e.id) && accept(e);
        if (list.entity_type === 'deal') return index.find('title', row.title, open);
        return index.find('record', row.recordId, open) ?? index.find('title', row.title, open);
      };

      let match: CrmListEntry | null = null;
      let externalId = row.externalId;
      if (row.externalId) {
        const kind = entryKeyKind(row.externalId);
        match = index.find('external', row.externalId);
        if (!match) {
          match = candidate((e) => e.external_id === null || entryKeyKind(e.external_id) !== kind);
          const had = match?.external_id ?? null;
          if (had !== null && KEY_STRENGTH[entryKeyKind(had)] > KEY_STRENGTH[kind]) {
            externalId = had;
          }
        }
      } else {
        match = candidate(() => true);
        externalId = match?.external_id ?? null;
      }

      if (!match) {
        const values = applyValues({}, row.values);
        const entry: CrmListEntry = {
          id: newId(),
          organization_id: organizationId,
          list_id: list.id,
          record_id: row.recordId,
          title: row.title,
          external_id: row.externalId,
          values,
          imported_values: { ...values },
          position: row.position ?? position++,
          created_at: now,
          updated_at: now,
        };
        batch.insert(i, entry);
        index.add(entry);
        claimed.add(entry.id);
        return;
      }
      claimed.add(match.id);

      const merged = mergeImport(match, row.values);
      for (const key of merged.kept) {
        batch.keptEdit(i, keptMessage(fields.get(key), key, match.values?.[key], row.values[key]));
      }
      const next: CrmListEntry = {
        ...match,
        record_id: row.recordId ?? match.record_id,
        title: row.title,
        external_id: externalId,
        values: merged.values,
        imported_values: merged.imported,
        position: row.position ?? match.position,
      };
      batch.change(i, match, next, stored.get(match.id));
      index.add(next);
    });

    await flush(store, organizationId, 'crm_list_entries', batch);
    return ok(batch.summary());
  });
}

/* ---- notes */

/** One note from a notes export, after column mapping. */
export interface CrmNoteRow {
  /** The note's id in the source, if the export has one. Otherwise a content hash is used. */
  externalId?: string | number | null;
  title?: string | null;
  /** Verbatim. */
  content: string;
  author?: string | null;
  /** Any date Date.parse understands; unparseable dates are stored as null. */
  occurredAt?: string | null;
  recordIds?: readonly string[] | null;
  entryIds?: readonly string[] | null;
  /** The names the export attaches the note to. */
  entityNames?: readonly string[] | null;
}

function cleanNames(names: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of names ?? []) {
    const name = typeof raw === 'string' ? raw.trim().slice(0, 500) : '';
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The identity of a note that has no id: its date, author and content — not
 * the names it is attached to, which differ between the exports of the lists
 * one note sits on (see affinityNoteId, the page's equivalent). Rows with the
 * same identity are one note, whose names and links the upsert unions. With
 * neither a date nor an author the names count too, so one short line on
 * fifty companies stays fifty notes.
 */
export function crmNoteExternalId(
  occurredAt: string | null,
  author: string | null,
  content: string,
  entityNames: readonly string[] = [],
): string {
  const t = occurredAt ? Date.parse(occurredAt) : NaN;
  const when = Number.isNaN(t) ? '' : new Date(t).toISOString();
  const who = crmNameKey(author ?? '');
  const parts: unknown[] = [when, who, content.replace(/\r\n?/g, '\n').trim()];
  if (!when && !who) parts.push([...new Set(entityNames.map((n) => crmNameKey(n)))].sort());
  return `csv:${sha256(JSON.stringify(parts))}`;
}

/**
 * Upsert notes. A note matches the one stored under the same source and
 * external id (or content hash); a match takes the row's content, title,
 * author and date, and keeps any links added since, so re-importing never
 * detaches a note from what someone linked it to in Copilot.
 */
export async function upsertNotes(
  store: DataStore,
  organizationId: string,
  rows: readonly CrmNoteRow[],
  options: { source?: CrmSource } = {},
): Promise<Result<CrmUpsertSummary>> {
  return guard('write', 'import CRM notes', async () => {
    const tooLarge = tooMany(rows);
    if (tooLarge) return tooLarge;
    const source = options.source ?? 'affinity';
    const batch = new Batch<CrmNote>(rows.length);

    // Links must point at rows that exist; arrays carry no foreign key, so a
    // stale id would otherwise linger silently.
    const wantedRecords = rows.flatMap((r) => r.recordIds ?? []).filter(isUuid);
    const wantedEntries = rows.flatMap((r) => r.entryIds ?? []).filter(isUuid);
    const [knownRecords, knownEntries] = await Promise.all([
      wantedRecords.length
        ? listWhereIn(store, 'crm_records', organizationId, {}, 'id', wantedRecords)
        : Promise.resolve([] as CrmRecord[]),
      wantedEntries.length
        ? listWhereIn(store, 'crm_list_entries', organizationId, {}, 'id', wantedEntries)
        : Promise.resolve([] as CrmListEntry[]),
    ]);
    const recordIds = new Set(knownRecords.map((r) => r.id));
    const entryIds = new Set(knownEntries.map((e) => e.id));

    const clean = rows.map((row, i) => {
      const content = typeof row.content === 'string' ? row.content : '';
      if (!content.trim()) {
        batch.skip(i, 'The note has no text.');
        return null;
      }
      if (content.length > CRM_NOTE_MAX_CHARS) {
        batch.skip(i, 'The note is too long to store.');
        return null;
      }
      const t = row.occurredAt ? Date.parse(row.occurredAt) : NaN;
      const occurredAt = Number.isNaN(t) ? null : new Date(t).toISOString();
      const entityNames = cleanNames(row.entityNames);
      const links = {
        records: [...new Set(row.recordIds ?? [])].filter((id) => recordIds.has(id)),
        entries: [...new Set(row.entryIds ?? [])].filter((id) => entryIds.has(id)),
      };
      if (
        links.records.length !== new Set(row.recordIds ?? []).size ||
        links.entries.length !== new Set(row.entryIds ?? []).size
      ) {
        batch.problem(
          i,
          'Some linked records or entries do not exist; the note was kept without them.',
        );
      }
      const title = row.title?.trim().slice(0, 500) || null;
      const author = row.author?.trim().slice(0, 300) || null;
      return {
        externalId:
          externalKey(row.externalId) ??
          crmNoteExternalId(occurredAt, author, content, entityNames),
        title,
        content,
        author,
        occurredAt,
        entityNames,
        links,
        flagged: scanForInjection(`${title ?? ''}\n${content}`).flagged,
      };
    });

    const index = new Index<CrmNote>((n) => ({ external: [n.external_id] }));
    const stored = new Map<string, CrmNote>();
    const present = clean.filter((c): c is NonNullable<typeof c> => c !== null);
    for (const n of await listWhereIn(
      store,
      'crm_notes',
      organizationId,
      { eq: { source } },
      'external_id',
      present.map((c) => c.externalId),
    )) {
      stored.set(n.id, n);
      index.add(n);
    }

    const now = new Date().toISOString();
    clean.forEach((row, i) => {
      if (!row) return;
      const match = index.find('external', row.externalId);
      if (!match) {
        const note: CrmNote = {
          id: newId(),
          organization_id: organizationId,
          source,
          external_id: row.externalId,
          title: row.title,
          content: row.content,
          author: row.author,
          occurred_at: row.occurredAt,
          record_ids: row.links.records,
          entry_ids: row.links.entries,
          entity_names: row.entityNames,
          injection_flagged: row.flagged,
          created_at: now,
          updated_at: now,
        };
        batch.insert(i, note);
        index.add(note);
        return;
      }
      const next: CrmNote = {
        ...match,
        title: row.title,
        content: row.content,
        author: row.author,
        // Compared as instants: PostgREST returns a timestamptz as
        // `…T12:00:00+00:00` and the import sends `…T12:00:00.000Z`; as text
        // the two would make every dated note "updated" on every re-import.
        occurred_at: sameInstant(match.occurred_at, row.occurredAt)
          ? match.occurred_at
          : row.occurredAt,
        record_ids: union(match.record_ids, row.links.records),
        entry_ids: union(match.entry_ids, row.links.entries),
        entity_names: union(match.entity_names, row.entityNames),
        injection_flagged: row.flagged,
      };
      batch.change(i, match, next, stored.get(match.id));
      index.add(next);
    });

    await flush(store, organizationId, 'crm_notes', batch);
    return ok(batch.summary());
  });
}
