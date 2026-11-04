import 'server-only';
import type { DataStore, Filter, QueryOptions } from '@/lib/db/store';
import {
  hasContactFilter,
  matchesContactFilter,
  NO_CONTACT_FILTER,
  type ContactFilter,
} from '@/lib/network/contact-status';
import type { CrmRecord, CrmRecordKind } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';
import { contactSummaries, type ContactSummary, type RelationshipScope } from './relationships';
import { crmGuard } from './crm';

/**
 * All People / All Companies, Affinity-style: every CRM person or company
 * with Connections, Last contact and the relationship status tag, filterable
 * by last contact ("N days or fewer", "more than N days", never contacted,
 * status) and sortable by last contact, first email or last meeting.
 *
 * Those columns are computed, not stored (from the cached relationship index,
 * see relationships.ts), so there is no migration. A plain A-to-Z page reads
 * one page from the database and computes the columns for those rows only.
 * Filtering or sorting on a computed column reads the matching records (up to
 * DIRECTORY_SCAN_MAX, a thousand per query), computes every one in memory,
 * and pages the result; the page says when it stopped short.
 */

export const DIRECTORY_SCAN_MAX = 5000;
const SCAN_PAGE = 1000;

export const DIRECTORY_SORTS = ['name', 'last_contact', 'first_email', 'last_meeting'] as const;
export type DirectorySort = (typeof DIRECTORY_SORTS)[number];

export function asDirectorySort(raw: string | null | undefined): DirectorySort {
  return (DIRECTORY_SORTS as readonly string[]).includes(raw ?? '')
    ? (raw as DirectorySort)
    : 'name';
}

export interface DirectoryRow {
  record: CrmRecord;
  /** Null when mail and calendar could not be read just now. */
  contact: ContactSummary | null;
}

export interface DirectoryPage {
  rows: DirectoryRow[];
  total: number;
  /** Records read to compute a filter or sort; 0 for a plain database page. */
  scanned: number;
  /** True when the scan stopped at DIRECTORY_SCAN_MAX. */
  truncated: boolean;
  /** False when the relationship columns could not be computed. */
  mail: boolean;
}

export interface DirectoryOptions {
  kind: CrmRecordKind;
  query?: string | null;
  filter?: ContactFilter;
  sort?: DirectorySort;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

const SORT_FIELD: Record<Exclude<DirectorySort, 'name'>, keyof ContactSummary> = {
  last_contact: 'lastContactAt',
  first_email: 'firstEmailAt',
  last_meeting: 'lastMeetingAt',
};

/** Rows by a date column; empty dates always last, whichever way. */
export function sortDirectory(
  rows: DirectoryRow[],
  sort: DirectorySort,
  dir: 'asc' | 'desc',
): DirectoryRow[] {
  if (sort === 'name') {
    const sorted = [...rows].sort((a, b) => a.record.name.localeCompare(b.record.name));
    return dir === 'desc' ? sorted.reverse() : sorted;
  }
  const field = SORT_FIELD[sort];
  const at = (r: DirectoryRow) => (r.contact?.[field] as string | null | undefined) ?? null;
  return [...rows].sort((a, b) => {
    const x = at(a);
    const y = at(b);
    if (x === y) return a.record.name.localeCompare(b.record.name);
    if (x === null) return 1;
    if (y === null) return -1;
    return dir === 'asc' ? x.localeCompare(y) : y.localeCompare(x);
  });
}

export async function listCrmDirectory(
  store: DataStore,
  organizationId: string,
  options: DirectoryOptions,
  scope: RelationshipScope,
): Promise<Result<DirectoryPage>> {
  return crmGuard<DirectoryPage>('read', 'list the CRM directory', async () => {
    const text = options.query?.trim().slice(0, 200);
    const columns = options.kind === 'person' ? ['name', 'primary_email'] : ['name', 'domain'];
    const where: Filter = {
      eq: { kind: options.kind },
      ...(text ? { textSearch: { columns, query: text } } : {}),
    };
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const filter = options.filter ?? NO_CONTACT_FILTER;
    const sort = options.sort ?? 'name';
    const dir = options.dir ?? (sort === 'name' ? 'asc' : 'desc');
    const byName: NonNullable<QueryOptions['orderBy']> = [
      { field: 'name', direction: dir === 'desc' && sort === 'name' ? 'desc' : 'asc' },
      { field: 'id', direction: 'asc' },
    ];

    if (!hasContactFilter(filter) && sort === 'name') {
      const [records, total] = await Promise.all([
        store.list('crm_records', organizationId, where, { orderBy: byName, limit, offset }),
        store.count('crm_records', organizationId, where),
      ]);
      const summaries = await contactSummaries(store, organizationId, records, scope);
      return ok({
        rows: records.map((record) => ({
          record,
          contact: summaries.ok ? (summaries.value[record.id] ?? null) : null,
        })),
        total,
        scanned: 0,
        truncated: false,
        mail: summaries.ok,
      });
    }

    const records: CrmRecord[] = [];
    let truncated = false;
    for (let from = 0; ; from += SCAN_PAGE) {
      const page = await store.list('crm_records', organizationId, where, {
        orderBy: byName,
        limit: SCAN_PAGE,
        offset: from,
      });
      records.push(...page);
      if (page.length < SCAN_PAGE) break;
      if (records.length >= DIRECTORY_SCAN_MAX) {
        truncated = true;
        break;
      }
    }
    const scanned = Math.min(records.length, DIRECTORY_SCAN_MAX);
    const summaries = await contactSummaries(
      store,
      organizationId,
      records.slice(0, DIRECTORY_SCAN_MAX),
      scope,
    );
    if (!summaries.ok) {
      return err(
        'provider_unavailable',
        "Mail and calendar couldn't be read just now, so last contact can't be filtered or sorted. Clear the filter to see everyone.",
        { retryable: true },
      );
    }
    const now = scope.now ?? new Date();
    const matched = records
      .slice(0, DIRECTORY_SCAN_MAX)
      .map((record) => ({ record, contact: summaries.value[record.id] ?? null }))
      .filter((row) => matchesContactFilter(row.contact?.lastContactAt ?? null, filter, now));
    const sorted = sortDirectory(matched, sort, dir);
    return ok({
      rows: sorted.slice(offset, offset + limit),
      total: sorted.length,
      scanned,
      truncated,
      mail: true,
    });
  });
}
