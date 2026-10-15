import type { Filter, QueryOptions, Scalar } from './store';

/**
 * In-memory filter/sort evaluation, shared by the demo store and by tests.
 * Kept separate from the store so the semantics are testable in isolation and
 * so both stores agree on what a `Filter` means.
 */

/**
 * A column's value, or a JSON path into a jsonb column in PostgREST's syntax:
 * `values->amount` is the value as stored (so numbers compare as numbers, as
 * jsonb ordering does), `values->>status` is it as text — strings as they are,
 * anything else as JSON — which is what Postgres's `->>` returns.
 */
function field(row: Record<string, unknown>, name: string): unknown {
  if (!name.includes('->')) return row[name];
  const [column, ...rest] = name.split(/(->>?)/);
  let value: unknown = row[column as string];
  let asText = false;
  for (let i = 0; i < rest.length; i += 2) {
    const op = rest[i];
    const key = rest[i + 1] as string;
    value =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)[key]
        : undefined;
    asText = op === '->>';
  }
  if (value === undefined || value === null) return null;
  if (!asText || typeof value === 'string') return value;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
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
  if (filter.arrayOverlaps) {
    for (const [k, values] of Object.entries(filter.arrayOverlaps)) {
      const actual = field(row, k);
      if (!Array.isArray(actual) || !values.some((v) => actual.includes(v))) return false;
    }
  }
  if (filter.textSearch) {
    const q = filter.textSearch.query.trim().toLowerCase();
    const prefix = filter.textSearch.mode === 'prefix';
    if (q) {
      const hit = filter.textSearch.columns.some((c) => {
        const v = field(row, c);
        if (typeof v !== 'string') return false;
        return prefix ? v.toLowerCase().startsWith(q) : v.toLowerCase().includes(q);
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
        const av = field(x, o.field);
        const bv = field(y, o.field);
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
