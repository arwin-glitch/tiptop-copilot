import type { Recommendation } from '@/lib/types/domain';

/**
 * The shape and ordering of the pipeline table.
 *
 * This lives in `lib` rather than beside the component on purpose. `SORT_KEYS`
 * is a runtime value used by both the server page (to validate `?sort=`) and
 * the client table (to type its headers), and a value exported from a
 * `'use client'` module is not the value on the server — it is a client
 * reference proxy. Importing it across the boundary compiled and typechecked
 * cleanly, then failed at request time with `SORT_KEYS.includes is not a
 * function`. Shared runtime values belong in a module neither side owns.
 */

export const SORT_KEYS = [
  'company',
  'stage',
  'score',
  'evidence',
  'confidence',
  'received',
] as const;

export type SortKey = (typeof SORT_KEYS)[number];
export type SortDirection = 'asc' | 'desc';

export interface DealRow {
  id: string;
  companyName: string;
  stageLabel: string;
  vertical: string | null;
  productSummary: string | null;
  receivedAt: string;
  /** Null when the deal has never been analysed — never rendered as zero. */
  recommendation: Recommendation | null;
  qualityScore: number | null;
  dataCompleteness: number | null;
  confidence: number | null;
  /** Pre-joined detail line: revenue, customers, funding stage. */
  facts: string;
}

/** Falls back to newest-first for an absent or unrecognised `?sort=`. */
export function asSortKey(value: string | undefined): SortKey {
  return SORT_KEYS.includes(value as SortKey) ? (value as SortKey) : 'received';
}

/**
 * Ordering.
 *
 * The rule that matters is where unscored deals go. A deal with no analysis has
 * no score, and sorting it as if it scored zero would bury a brand-new pitch
 * underneath everything that has already been judged and found wanting. So
 * unscored rows sort to the end in *either* direction — they are not low, they
 * are absent, and "sort by score ascending" should still not claim otherwise.
 */
export function sortRows(rows: DealRow[], sort: SortKey, direction: SortDirection): DealRow[] {
  const factor = direction === 'asc' ? 1 : -1;

  const numeric = (row: DealRow): number | null => {
    if (sort === 'score') return row.qualityScore;
    if (sort === 'evidence') return row.dataCompleteness;
    if (sort === 'confidence') return row.confidence;
    return null;
  };

  return [...rows].sort((a, b) => {
    if (sort === 'company') return factor * a.companyName.localeCompare(b.companyName);
    if (sort === 'stage') return factor * a.stageLabel.localeCompare(b.stageLabel);
    if (sort === 'received') {
      return factor * (Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    }

    const left = numeric(a);
    const right = numeric(b);
    if (left === null && right === null) return a.companyName.localeCompare(b.companyName);
    if (left === null) return 1;
    if (right === null) return -1;
    return factor * (left - right);
  });
}
