import 'server-only';
import {
  compareFinderRows,
  contactedWithin,
  finderIsNarrowed,
  lastContactOf,
  LOCATION_PREFILTER_LABELS,
  placeMatches,
  placeSearchTerm,
  recordLocation,
  type CrmFinderContact,
  type CrmFinderCriteria,
} from '@/lib/crm/finder';
import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore, Filter } from '@/lib/db/store';
import { evidenceFor, type RelationshipIndex } from '@/lib/network/evidence';
import { crmGuard, isUuid, type CrmRecordSummary } from '@/lib/services/crm';
import {
  getRelationshipIndex,
  recordAddresses,
  type RelationshipScope,
} from '@/lib/services/relationships';
import type { CrmList, CrmListEntry, CrmRecord } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Knowledge → Find & save: companies and people across the CRM by name,
 * place and last contact, for saving as a list or adding to one.
 *
 * The database narrows first — by name, email or domain, by a place in the
 * record's Location, or to one list's members — reading at most
 * CRM_FINDER_SCAN_MAX records; the rest is matched in memory on what was
 * read, because a record's fields are keyed by whatever label the export used
 * and "in touch since" is the later of Affinity's dates and Copilot's own
 * mail and calendar, which the database does not hold.
 */

/** The most records one search reads before it says it stopped. */
export const CRM_FINDER_SCAN_MAX = 5000;
/** Rows a page shows; saving takes every match. */
export const CRM_FINDER_SHOW = 200;
/** Matches whose other lists' columns are read for Affinity's dates. */
const ENTRY_LOOKUP_MAX = 1000;

export interface CrmFinderRow extends CrmRecordSummary {
  location: string | null;
  lastContact: CrmFinderContact | null;
}

export interface CrmFinderResult {
  /** The first matches, newest contact first. */
  rows: CrmFinderRow[];
  /** Every match's id, in the same order (for saving). */
  ids: string[];
  total: number;
  /** Records read from the database. */
  scanned: number;
  /** The read stopped at CRM_FINDER_SCAN_MAX: narrow the search to see the rest. */
  truncated: boolean;
  /**
   * Copilot's mail and calendar: used, could not be read (Affinity's dates
   * only), or not asked for (no scope).
   */
  mail: 'used' | 'unavailable' | 'unused';
  /** The list searched within, when one was. */
  list: Pick<CrmList, 'id' | 'name' | 'entity_type'> | null;
  /** No name, place or list was given, so nothing was searched. */
  needsNarrowing: boolean;
}

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase();

/** Whether a record matches the typed text: its name, domain or any address. */
function textMatches(record: CrmRecord, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    lower(record.name).includes(needle) ||
    lower(record.domain).includes(needle) ||
    record.emails.some((e) => e.includes(needle))
  );
}

/** Records by id, a hundred to a request. */
async function recordsById(
  store: DataStore,
  organizationId: string,
  ids: readonly string[],
  base: Filter,
): Promise<CrmRecord[]> {
  const out: CrmRecord[] = [];
  for (const group of chunk([...new Set(ids)], 100)) {
    out.push(
      ...(await listAllPages(store, 'crm_records', organizationId, {
        ...base,
        in: { id: group },
      })),
    );
  }
  return out;
}

/** The records a search starts from, read in pages until the cap. */
async function candidates(
  store: DataStore,
  organizationId: string,
  criteria: CrmFinderCriteria,
): Promise<{ records: CrmRecord[]; truncated: boolean }> {
  const filter: Filter = { eq: { kind: criteria.kind } };
  if (criteria.q) {
    filter.textSearch = { columns: ['name', 'domain', 'primary_email'], query: criteria.q };
  } else if (criteria.place) {
    filter.textSearch = {
      columns: LOCATION_PREFILTER_LABELS.map((label) => `fields->>${label}`),
      query: placeSearchTerm(criteria.place),
    };
  }
  const records: CrmRecord[] = [];
  for (let offset = 0; records.length <= CRM_FINDER_SCAN_MAX; offset += 1000) {
    const page = await store.list('crm_records', organizationId, filter, {
      orderBy: [
        { field: 'name', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ],
      limit: 1000,
      offset,
    });
    records.push(...page);
    if (page.length < 1000) break;
  }
  const truncated = records.length > CRM_FINDER_SCAN_MAX;
  return { records: records.slice(0, CRM_FINDER_SCAN_MAX), truncated };
}

/**
 * Companies or people matching the criteria, newest contact first: at most
 * `limit` rows (CRM_FINDER_SHOW), and every match's id. With `scope`, last
 * contact also counts Copilot's own mail and calendar (the relationship
 * index, cached for minutes); without it, or when that cannot be read,
 * Affinity's dates alone, and the result says so.
 */
export async function findCrmRecords(
  store: DataStore,
  organizationId: string,
  criteria: CrmFinderCriteria,
  options: { scope?: RelationshipScope; limit?: number; now?: Date } = {},
): Promise<Result<CrmFinderResult>> {
  return crmGuard<CrmFinderResult>('read', 'find CRM records', async () => {
    const now = options.now ?? options.scope?.now ?? new Date();
    const limit = Math.max(1, Math.min(options.limit ?? CRM_FINDER_SHOW, CRM_FINDER_SCAN_MAX));
    const empty: CrmFinderResult = {
      rows: [],
      ids: [],
      total: 0,
      scanned: 0,
      truncated: false,
      mail: 'unused',
      list: null,
      needsNarrowing: false,
    };
    if (!finderIsNarrowed(criteria)) return ok({ ...empty, needsNarrowing: true });

    // Where to start: one list's members, or a narrowed read of every record.
    let list: CrmList | null = null;
    let listEntries: CrmListEntry[] = [];
    let records: CrmRecord[];
    let truncated = false;
    if (criteria.listId) {
      list = isUuid(criteria.listId)
        ? await store.get('crm_lists', organizationId, criteria.listId)
        : null;
      if (!list) return err('not_found', 'That list does not exist.');
      listEntries = await listAllPages(store, 'crm_list_entries', organizationId, {
        eq: { list_id: list.id },
      });
      const ids = listEntries.map((e) => e.record_id).filter((id): id is string => !!id);
      records = await recordsById(store, organizationId, ids.slice(0, CRM_FINDER_SCAN_MAX), {
        eq: { kind: criteria.kind },
      });
      truncated = new Set(ids).size > CRM_FINDER_SCAN_MAX;
    } else {
      ({ records, truncated } = await candidates(store, organizationId, criteria));
    }
    const scanned = records.length;

    const matched = records.filter(
      (r) =>
        textMatches(r, criteria.q) &&
        (!criteria.place || placeMatches(recordLocation(r.fields), criteria.place)),
    );

    // Affinity's dates sit on the record and on the columns of the lists the
    // record is on; read those lists' rows for a modest set of matches.
    const entriesByRecord = new Map<string, CrmListEntry[]>();
    const lists = new Map<string, Pick<CrmList, 'fields'>>();
    const addEntry = (e: CrmListEntry) => {
      if (!e.record_id) return;
      const rows = entriesByRecord.get(e.record_id) ?? [];
      if (!rows.some((r) => r.id === e.id)) rows.push(e);
      entriesByRecord.set(e.record_id, rows);
    };
    if (list) {
      lists.set(list.id, list);
      listEntries.forEach(addEntry);
    }
    if (matched.length && matched.length <= ENTRY_LOOKUP_MAX) {
      const rows: CrmListEntry[] = [];
      for (const group of chunk(
        matched.map((r) => r.id),
        100,
      )) {
        rows.push(
          ...(await listAllPages(store, 'crm_list_entries', organizationId, {
            in: { record_id: group },
          })),
        );
      }
      rows.forEach(addEntry);
      const missing = [...new Set(rows.map((e) => e.list_id))].filter((id) => !lists.has(id));
      for (const group of chunk(missing, 100)) {
        for (const l of await listAllPages(store, 'crm_lists', organizationId, {
          in: { id: group },
        })) {
          lists.set(l.id, l);
        }
      }
    }

    let index: RelationshipIndex | null = null;
    let mail: CrmFinderResult['mail'] = 'unused';
    if (options.scope && matched.length) {
      const loaded = await getRelationshipIndex(store, organizationId, options.scope);
      if (loaded.ok) {
        index = loaded.value;
        mail = 'used';
      } else {
        mail = 'unavailable';
      }
    }

    const rows: CrmFinderRow[] = [];
    for (const record of matched) {
      const copilotAt = index
        ? evidenceFor(index, recordAddresses(index, record).addresses, now).evidence.lastContactAt
        : null;
      const lastContact = lastContactOf({
        recordFields: record.fields,
        entries: (entriesByRecord.get(record.id) ?? []).flatMap((e) => {
          const l = lists.get(e.list_id);
          return l ? [{ fields: l.fields, values: e.values }] : [];
        }),
        copilotAt,
      });
      if (criteria.years && !contactedWithin(lastContact, criteria.years, now)) continue;
      rows.push({
        id: record.id,
        kind: record.kind,
        name: record.name,
        domain: record.domain,
        primary_email: record.primary_email,
        location: recordLocation(record.fields),
        lastContact,
      });
    }
    rows.sort(compareFinderRows);

    return ok({
      rows: rows.slice(0, limit),
      ids: rows.map((r) => r.id),
      total: rows.length,
      scanned,
      truncated,
      mail,
      list: list ? { id: list.id, name: list.name, entity_type: list.entity_type } : null,
      needsNarrowing: false,
    });
  });
}
