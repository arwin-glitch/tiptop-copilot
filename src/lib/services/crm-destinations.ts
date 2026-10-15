import 'server-only';
import {
  isCrmDestination,
  resolveCrmListDestination,
  type CrmDestination,
  type CrmListDestination,
} from '@/lib/crm/destinations';
import { statusFieldOf } from '@/lib/crm/fields';
import { listAllPages } from '@/lib/db/paging';
import type { DataStore, Filter, QueryOptions } from '@/lib/db/store';
import { redact, log } from '@/lib/security/redact';
import {
  CRM_ENTRY_PAGE_MAX,
  crmGuard,
  listCrmLists,
  recordSummaries,
  type CrmActor,
  type CrmListSummary,
  type CrmRecordSummary,
} from '@/lib/services/crm';
import type { AuditEvent, CrmField, CrmList, CrmListEntry } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * The CRM read by destination: which lists feed a page, and their entries.
 *
 * The pages that take over from Affinity's lists (Deals, Fund II, Portfolio,
 * Network) ask for a destination, never a list by name: `listsFor` gives the
 * lists whose data belongs there and `entriesFor` one page of their entries.
 * Where a list goes is decided by `lib/crm/destinations.ts` from its name and
 * entity type, unless someone chose otherwise on Knowledge → Affinity lists.
 *
 * Where that choice is kept, and why there: an `audit_events` row per change,
 * `action = 'crm.list_destination'`, `entity_type = 'crm_list'`, `entity_id`
 * the list id, `metadata = { destination, previous, list_name }`, where a
 * `destination` of null means "back to automatic". The latest row per list
 * wins. No migration: `crm_lists` has no settings column, `crm_lists.fields`
 * is the list's columns (a value there would show up as a column and be
 * rewritten by every re-import), and the audit table is already per
 * organization, append-only, read with the service role and indexed on
 * `(organization_id, action, created_at)`. So the history of every choice
 * comes for free, and an import can never undo one. Overrides are a
 * refinement: if they cannot be read, every list falls back to its rules
 * rather than the page failing.
 *
 * Everything returns a Result and survives missing CRM tables the way
 * `lib/services/crm.ts` does (`isCrmNotSetUp` on the result).
 */

export const CRM_DESTINATION_ACTION = 'crm.list_destination' as const;
export const CRM_DESTINATION_ENTITY = 'crm_list' as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------------------------------------------------------------- overrides */

const NEWEST_FIRST: NonNullable<QueryOptions['orderBy']> = [
  { field: 'created_at', direction: 'desc' },
];

/**
 * The destination someone chose for each list, by list id. A list left on
 * automatic (never set, or set back) is absent. Never fails: a read error is
 * logged and every list falls back to its rules.
 */
export async function readDestinationOverrides(
  store: DataStore,
  organizationId: string,
): Promise<Record<string, CrmDestination>> {
  try {
    const rows = await listAllPages(
      store,
      'audit_events',
      organizationId,
      { eq: { action: CRM_DESTINATION_ACTION, entity_type: CRM_DESTINATION_ENTITY } },
      NEWEST_FIRST,
    );
    const seen = new Set<string>();
    const out: Record<string, CrmDestination> = {};
    for (const row of rows) {
      if (!row.entity_id || seen.has(row.entity_id)) continue;
      seen.add(row.entity_id);
      const chosen = row.metadata?.destination;
      if (isCrmDestination(chosen)) out[row.entity_id] = chosen;
    }
    return out;
  } catch (error) {
    log.warn('CRM list destinations could not be read; using the rules', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/** One list's destination: its override if someone chose one, else its rules. Never fails. */
export async function destinationForList(
  store: DataStore,
  organizationId: string,
  list: Pick<CrmList, 'id' | 'name' | 'entity_type'>,
): Promise<CrmListDestination> {
  const overrides = await readDestinationOverrides(store, organizationId);
  return resolveCrmListDestination(list, overrides[list.id]);
}

/* -------------------------------------------------------------------- lists */

/** A list with its entry count and where its data goes. */
export interface CrmDestinationList extends CrmListSummary {
  destination: CrmListDestination;
}

/** Every list with its destination, in display order. Archived lists only when asked. */
export async function listsWithDestinations(
  store: DataStore,
  organizationId: string,
  options: { includeArchived?: boolean } = {},
): Promise<Result<CrmDestinationList[]>> {
  const [lists, overrides] = await Promise.all([
    listCrmLists(store, organizationId, { includeArchived: options.includeArchived }),
    readDestinationOverrides(store, organizationId),
  ]);
  if (!lists.ok) return lists;
  return ok(
    lists.value.map((list) => ({
      ...list,
      destination: resolveCrmListDestination(list, overrides[list.id]),
    })),
  );
}

/**
 * The lists whose data belongs to one destination (or any of several), in
 * display order. Archived lists are left out unless asked for: archiving is
 * how a list is put away.
 */
export async function listsFor(
  store: DataStore,
  organizationId: string,
  destination: CrmDestination | readonly CrmDestination[],
  options: { includeArchived?: boolean } = {},
): Promise<Result<CrmDestinationList[]>> {
  const wanted = new Set<CrmDestination>(
    typeof destination === 'string' ? [destination] : destination,
  );
  const all = await listsWithDestinations(store, organizationId, options);
  if (!all.ok) return all;
  return ok(all.value.filter((l) => wanted.has(l.destination.destination)));
}

/* ------------------------------------------------------------------ entries */

export interface CrmDestinationEntryQuery {
  /** Case-insensitive substring of the entry title. */
  query?: string | null;
  /** Only these lists (ids), of the destination's lists. Others are ignored. */
  listIds?: readonly string[] | null;
  /**
   * Keep entries whose status is one of these labels (exact match), each
   * list on its own status field (`statusFieldOf`). Lists without a status
   * field then contribute nothing.
   */
  statusIn?: readonly string[] | null;
  /** 'recent' (last changed first, the default) or 'title' (A to Z). */
  sort?: 'recent' | 'title' | null;
  offset?: number | null;
  /** Default 50, at most CRM_ENTRY_PAGE_MAX. */
  limit?: number | null;
  includeArchived?: boolean;
}

/** One entry of a destination, with what a row needs to show it. */
export interface CrmDestinationEntry {
  entry: CrmListEntry;
  list: Pick<CrmList, 'id' | 'name' | 'entity_type'>;
  /** The company or person it is about, when linked. */
  record: CrmRecordSummary | null;
  /** The entry's value for its list's status field (the stage), if any. */
  status: string | null;
}

export interface CrmDestinationEntries {
  destinations: CrmDestination[];
  /** Every list of the destination, before `listIds` narrows it (a page's list filter). */
  available: CrmDestinationList[];
  /** The destination's lists the page was read from (after `listIds`). */
  lists: CrmDestinationList[];
  entries: CrmDestinationEntry[];
  /** Entries matching the query and status filter, across all pages. */
  total: number;
  offset: number;
  limit: number;
  /** Each list's status field (its pipeline), by list id; null when it has none. */
  statusFields: Record<string, CrmField | null>;
}

function clampInt(value: number | null | undefined, min: number, max: number, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function orderFor(sort: CrmDestinationEntryQuery['sort']): NonNullable<QueryOptions['orderBy']> {
  return sort === 'title'
    ? [
        { field: 'title', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ]
    : [
        { field: 'updated_at', direction: 'desc' },
        { field: 'id', direction: 'asc' },
      ];
}

/** The same order as `orderFor`, in memory, for merging groups read apart. */
function compareFor(sort: CrmDestinationEntryQuery['sort']) {
  return (a: CrmListEntry, b: CrmListEntry): number => {
    if (sort === 'title') {
      const t = a.title.localeCompare(b.title);
      if (t !== 0) return t;
    } else if (a.updated_at !== b.updated_at) {
      return a.updated_at < b.updated_at ? 1 : -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/**
 * One page of the entries of every list in a destination (or several),
 * filtered, sorted and paged in the database.
 *
 * With a status filter, lists are read in groups that share a status field
 * key (an LP list's stage field need not be called what the deal list's is),
 * and the groups merged; otherwise it is one query across all the lists.
 */
export async function entriesFor(
  store: DataStore,
  organizationId: string,
  destination: CrmDestination | readonly CrmDestination[],
  query: CrmDestinationEntryQuery = {},
): Promise<Result<CrmDestinationEntries>> {
  const destinations: CrmDestination[] =
    typeof destination === 'string' ? [destination] : [...destination];
  const found = await listsFor(store, organizationId, destinations, {
    includeArchived: query.includeArchived,
  });
  if (!found.ok) return found;

  return crmGuard('read', 'list CRM entries by destination', async () => {
    const limit = clampInt(query.limit, 1, CRM_ENTRY_PAGE_MAX, 50);
    const offset = clampInt(query.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const only = query.listIds?.length ? new Set(query.listIds) : null;
    const lists = only ? found.value.filter((l) => only.has(l.id)) : found.value;
    const statusFields: Record<string, CrmField | null> = {};
    for (const list of lists) statusFields[list.id] = statusFieldOf(list);
    const empty: CrmDestinationEntries = {
      destinations,
      available: found.value,
      lists,
      entries: [],
      total: 0,
      offset,
      limit,
      statusFields,
    };
    if (lists.length === 0) return ok(empty);

    // Which lists are read together, and the filter each group adds.
    const statuses = (query.statusIn ?? []).filter((s) => typeof s === 'string' && s);
    const groups = new Map<string, { ids: string[]; extra: Filter['in'] }>();
    for (const list of lists) {
      let key = '';
      let extra: Filter['in'] = {};
      if (statuses.length) {
        const field = statusFields[list.id];
        if (!field) continue;
        key = field.key;
        extra = { [`values->>${field.key}`]: statuses };
      }
      const group = groups.get(key);
      if (group) group.ids.push(list.id);
      else groups.set(key, { ids: [list.id], extra });
    }
    if (groups.size === 0) return ok(empty);

    const text = query.query?.trim().slice(0, 200);
    const orderBy = orderFor(query.sort);
    const filterOf = (g: { ids: string[]; extra: Filter['in'] }): Filter => ({
      in: { list_id: g.ids, ...g.extra },
      ...(text ? { textSearch: { columns: ['title'], query: text } } : {}),
    });

    let entries: CrmListEntry[];
    let total: number;
    const parts = [...groups.values()];
    if (parts.length === 1) {
      const filter = filterOf(parts[0] as (typeof parts)[number]);
      [entries, total] = await Promise.all([
        store.list('crm_list_entries', organizationId, filter, { orderBy, limit, offset }),
        store.count('crm_list_entries', organizationId, filter),
      ]);
    } else {
      // Each group's first offset+limit rows hold every row of the merged page.
      const read = await Promise.all(
        parts.map(async (g) => {
          const filter = filterOf(g);
          const [rows, count] = await Promise.all([
            store.list('crm_list_entries', organizationId, filter, {
              orderBy,
              limit: offset + limit,
            }),
            store.count('crm_list_entries', organizationId, filter),
          ]);
          return { rows, count };
        }),
      );
      entries = read
        .flatMap((r) => r.rows)
        .sort(compareFor(query.sort))
        .slice(offset, offset + limit);
      total = read.reduce((sum, r) => sum + r.count, 0);
    }

    const records = await recordSummaries(store, organizationId, entries);
    const listById = new Map(lists.map((l) => [l.id, l]));
    return ok({
      ...empty,
      total,
      entries: entries.map((entry) => {
        const list = listById.get(entry.list_id) as CrmDestinationList;
        const field = statusFields[list.id];
        const raw = field ? entry.values[field.key] : undefined;
        return {
          entry,
          list: { id: list.id, name: list.name, entity_type: list.entity_type },
          record: entry.record_id ? (records[entry.record_id] ?? null) : null,
          status: typeof raw === 'string' && raw ? raw : null,
        };
      }),
    });
  });
}

/* -------------------------------------------------------------------- write */

/**
 * Choose where a list's data goes, or (`null`) put it back on its rules.
 * Kept as an audit row (see the top of this file), so it survives every
 * re-import and its history stays readable.
 */
export async function setListDestination(
  store: DataStore,
  organizationId: string,
  listId: string,
  destination: CrmDestination | null,
  actor?: CrmActor,
): Promise<Result<CrmListDestination>> {
  return crmGuard('write', 'set a CRM list destination', async () => {
    if (destination !== null && !isCrmDestination(destination)) {
      return err('invalid_input', 'That is not one of the places a list can go.');
    }
    if (!UUID_RE.test(listId)) return err('not_found', 'That list does not exist.');
    const list = await store.get('crm_lists', organizationId, listId);
    if (!list) return err('not_found', 'That list does not exist.');

    const [last] = await store.list(
      'audit_events',
      organizationId,
      {
        eq: {
          action: CRM_DESTINATION_ACTION,
          entity_type: CRM_DESTINATION_ENTITY,
          entity_id: list.id,
        },
      },
      { orderBy: NEWEST_FIRST, limit: 1 },
    );
    const before = last?.metadata?.destination;
    const previous = isCrmDestination(before) ? before : null;
    // Strictly after the last choice, so "latest wins" holds for two changes
    // made in the same millisecond.
    const lastAt = last ? Date.parse(last.created_at) : NaN;
    const at = Number.isNaN(lastAt) ? Date.now() : Math.max(Date.now(), lastAt + 1);

    const row: AuditEvent = {
      id: newId(),
      organization_id: organizationId,
      user_id: actor?.userId ?? null,
      action: CRM_DESTINATION_ACTION,
      entity_type: CRM_DESTINATION_ENTITY,
      entity_id: list.id,
      metadata: redact({ destination, previous, list_name: list.name }) as Record<string, unknown>,
      ip_hash: null,
      created_at: new Date(at).toISOString(),
    };
    // Inserted directly, not through recordAudit, which swallows a failed
    // write: here the row is the setting, so a failure must say so.
    await store.insert('audit_events', row);
    return ok(resolveCrmListDestination(list, destination));
  });
}
