import { describe, expect, it } from 'vitest';
import type { DataStore, QueryOptions } from '@/lib/db/store';
import { chunk, listAllPages, PAGE_SIZE } from '@/lib/db/paging';

/** A store whose `list` honours limit and offset, like PostgREST's 1,000-row pages. */
function pagedStore(total: number) {
  const rows = Array.from({ length: total }, (_, i) => ({
    id: `row-${String(i).padStart(5, '0')}`,
  }));
  const calls: QueryOptions[] = [];
  const store = {
    list: async (_table: string, _org: string, _filter: unknown, options: QueryOptions = {}) => {
      calls.push(options);
      const offset = options.offset ?? 0;
      return rows.slice(offset, offset + Math.min(options.limit ?? PAGE_SIZE, PAGE_SIZE));
    },
  } as unknown as DataStore;
  return { store, calls };
}

describe('listAllPages', () => {
  it('reads past the 1,000-row cap, ordering by the caller’s fields plus id', async () => {
    const { store, calls } = pagedStore(2_345);
    const rows = await listAllPages(store, 'deals', 'org', undefined, [
      { field: 'received_at', direction: 'desc' },
    ]);
    expect(rows).toHaveLength(2_345);
    expect(calls.map((c) => c.offset)).toEqual([0, 1000, 2000]);
    expect(calls[0]?.orderBy).toEqual([
      { field: 'received_at', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ]);
  });

  it('asks once more after an exactly full last page, and stops on the empty one', async () => {
    const { store, calls } = pagedStore(2_000);
    expect(await listAllPages(store, 'deals', 'org')).toHaveLength(2_000);
    expect(calls).toHaveLength(3);
  });
});

describe('chunk', () => {
  it('splits into pieces of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 100)).toEqual([]);
  });
});
