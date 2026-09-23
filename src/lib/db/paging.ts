import type { DataStore, Filter, QueryOptions, Row, TableName } from './store';

/**
 * PostgREST caps a response at 1,000 rows by default, and `store.list` with no
 * limit silently returns only that first page. Tables that can outgrow it —
 * the deal pipeline once the deal-sorter backfills it — are read through this
 * instead: pages of 1,000, ordered by the caller's fields plus `id` so the
 * page boundaries are stable.
 */
export const PAGE_SIZE = 1000;

export async function listAllPages<T extends TableName>(
  store: DataStore,
  table: T,
  organizationId: string,
  filter?: Filter,
  orderBy: NonNullable<QueryOptions['orderBy']> = [],
): Promise<Row<T>[]> {
  const out: Row<T>[] = [];
  const order = [...orderBy, { field: 'id', direction: 'asc' as const }];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const rows = await store.list(table, organizationId, filter, {
      orderBy: order,
      limit: PAGE_SIZE,
      offset,
    });
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

/** Split ids into chunks for an `in` filter that stays well inside URL limits. */
export function chunk<T>(items: readonly T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
