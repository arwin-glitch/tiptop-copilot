import type { Filter, QueryOptions, Scalar } from './store';

/**
 * In-memory filter/sort evaluation, shared by the demo store and by tests.
 * Kept separate from the store so the semantics are testable in isolation and
 * so both stores agree on what a `Filter` means.
 */

function field(row: Record<string, unknown>, name: string): unknown {
  return row[name];
}

function looseEq(a: unknown, b: Scalar): boolean {
  if (b === null) return a === null || a === undefined;
  return a === b;
}

export function matchesFilter(row: Record<string, unknown>, filter?: Filter): boolean {
  if (!filter) return true;

  if (filter.eq) {
    for (const [k, v] of Object.entries(filter.eq)) {
      if (!looseEq(field(row, k), v)) return false;
    }
  }
  if (filter.neq) {
    for (const [k, v] of Object.entries(filter.neq)) {
      if (looseEq(field(row, k), v)) return false;
    }
  }
  if (filter.in) {
    for (const [k, values] of Object.entries(filter.in)) {
      const actual = field(row, k) as Scalar;
      if (!values.some((v) => looseEq(actual, v))) return false;
    }
  }
  if (filter.gte) {
    for (const [k, v] of Object.entries(filter.gte)) {
      const actual = field(row, k);
      if (actual == null) return false;
      if (!(compare(actual, v) >= 0)) return false;
    }
  }
  if (filter.lte) {
    for (const [k, v] of Object.entries(filter.lte)) {
      const actual = field(row, k);
      if (actual == null) return false;
      if (!(compare(actual, v) <= 0)) return false;
    }
  }
  if (filter.gt) {
    for (const [k, v] of Object.entries(filter.gt)) {
      const actual = field(row, k);
      if (actual == null) return false;
      if (!(compare(actual, v) > 0)) return false;
    }
  }
  if (filter.lt) {
    for (const [k, v] of Object.entries(filter.lt)) {
      const actual = field(row, k);
      if (actual == null) return false;
      if (!(compare(actual, v) < 0)) return false;
    }
  }
  if (filter.isNull) {
    for (const k of filter.isNull) {
      const actual = field(row, k);
      if (!(actual === null || actual === undefined)) return false;
    }
  }
  if (filter.notNull) {
    for (const k of filter.notNull) {
      const actual = field(row, k);
      if (actual === null || actual === undefined) return false;
    }
  }
  if (filter.arrayContains) {
    for (const [k, v] of Object.entries(filter.arrayContains)) {
      const actual = field(row, k);
      if (!Array.isArray(actual) || !actual.includes(v)) return false;
    }
  }
  if (filter.textSearch) {
    const q = filter.textSearch.query.trim().toLowerCase();
    if (q) {
      const hit = filter.textSearch.columns.some((c) => {
        const v = field(row, c);
        return typeof v === 'string' && v.toLowerCase().includes(q);
      });
      if (!hit) return false;
    }
  }
  return true;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function applyOptions<T extends Record<string, unknown>>(
  rows: T[],
  options?: QueryOptions,
): T[] {
  let out = rows;
  if (options?.orderBy?.length) {
    const orders = options.orderBy;
    out = [...out].sort((x, y) => {
      for (const o of orders) {
        const av = x[o.field];
        const bv = y[o.field];
        if (av == null && bv == null) continue;
        if (av == null) return o.direction === 'asc' ? -1 : 1;
        if (bv == null) return o.direction === 'asc' ? 1 : -1;
        const c = compare(av, bv);
        if (c !== 0) return o.direction === 'asc' ? c : -c;
      }
      return 0;
    });
  }
  const offset = options?.offset ?? 0;
  if (offset) out = out.slice(offset);
  if (options?.limit != null) out = out.slice(0, options.limit);
  return out;
}

/**
 * Lightweight relevance score used by the demo store's search. Deliberately
 * simple: term coverage plus a small bonus for exact-phrase presence. Real
 * deployments use Postgres `ts_rank`.
 */
export function textRank(query: string, haystack: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const hay = haystack.toLowerCase();
  const terms = q.split(/\W+/).filter((t) => t.length > 1);
  if (terms.length === 0) return hay.includes(q) ? 1 : 0;
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  const coverage = hits / terms.length;
  const phraseBonus = hay.includes(q) ? 0.25 : 0;
  return Math.min(1, coverage * 0.85 + phraseBonus);
}
