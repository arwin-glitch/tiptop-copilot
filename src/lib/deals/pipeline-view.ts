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
  'activity',
] as const;

export type SortKey = (typeof SORT_KEYS)[number];
export type SortDirection = 'asc' | 'desc';

export interface DealRow {
  id: string;
  companyName: string;
  /** The deal's stage key, which the stage filter matches on. */
  stageKey: string;
  stageLabel: string;
  /** Position in the thesis's stage list; unknown stages sort last. */
  stageOrder: number;
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
  /** The deal-sorter's fit flag, when the deal came from it. */
  fit: 'likely' | 'possible' | 'unlikely' | null;
  /** Where the deal came from (referral source or the routine's source). */
  source: string | null;
  /** Day of the latest activity the deal-sorter saw (YYYY-MM-DD), if any. */
  lastActivity: string | null;
  nextStep: string | null;
  /** The evidence behind the deal-sorter's stage view. */
  evidence: string | null;
  /** Label of the stage the deal-sorter suggests, when it differs from the current one. */
  suggestedStageLabel: string | null;
  /** Whether the deal-sorter has touched this deal at all. */
  isRoutine: boolean;
}

/**
 * Which columns the table shows. The score columns are only worth their width
 * when something can score: with no AI provider and not one analysis stored,
 * every cell would be a dash, so the table shows what the deal-sorter knows
 * instead — fit, source and last activity.
 */
export type ColumnMode = 'scores' | 'routine';

export function chooseColumnMode(input: {
  aiAvailable: boolean;
  anyAnalysis: boolean;
}): ColumnMode {
  return !input.aiAvailable && !input.anyAnalysis ? 'routine' : 'scores';
}

export const FIT_FILTERS = ['likely', 'possible', 'unlikely'] as const;
export type FitFilter = (typeof FIT_FILTERS)[number];

/** A `?fit=` value, or null for none or an unrecognised one. */
export function asFitFilter(value: string | undefined): FitFilter | null {
  return FIT_FILTERS.includes(value as FitFilter) ? (value as FitFilter) : null;
}

export const FIT_LABELS: Record<FitFilter, string> = {
  likely: 'Likely fit',
  possible: 'Possible fit',
  unlikely: 'Unlikely fit',
};

/** Falls back to newest-first for an absent or unrecognised `?sort=`. */
export function asSortKey(value: string | undefined): SortKey {
  return SORT_KEYS.includes(value as SortKey) ? (value as SortKey) : 'received';
}

/** The part of the pipeline view that lives in the URL and is applied in the browser. */
export interface PipelineView {
  /** A stage key, or '' for all. An unknown key matches no deal. */
  stage: string;
  fit: FitFilter | null;
  sort: SortKey;
  direction: SortDirection;
}

export function readPipelineView(params: { get(key: string): string | null }): PipelineView {
  return {
    stage: params.get('stage') ?? '',
    fit: asFitFilter(params.get('fit') ?? undefined),
    sort: asSortKey(params.get('sort') ?? undefined),
    direction: params.get('dir') === 'asc' ? 'asc' : 'desc',
  };
}

/** The query keys the view owns; the search (`q`) and `archived` stay with the server. */
export const VIEW_KEYS = ['stage', 'fit', 'sort', 'dir'] as const;
export type ViewParams = Record<(typeof VIEW_KEYS)[number], string | null>;

/** The view's raw query values, an empty one counting as absent. */
export function viewParams(params: { get(key: string): string | null }): ViewParams {
  return {
    stage: params.get('stage') || null,
    fit: params.get('fit') || null,
    sort: params.get('sort') || null,
    dir: params.get('dir') || null,
  };
}

export function sameViewParams(a: ViewParams, b: ViewParams): boolean {
  return VIEW_KEYS.every((key) => a[key] === b[key]);
}

/** `search` with the view's keys set from `view`; every other key is kept. */
export function withViewParams(search: string, view: ViewParams): URLSearchParams {
  const next = new URLSearchParams(search);
  for (const key of VIEW_KEYS) {
    const value = view[key];
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
}

export function filterRows(
  rows: DealRow[],
  { stage, fit }: { stage: string; fit: FitFilter | null },
): DealRow[] {
  return rows.filter((row) => (!stage || row.stageKey === stage) && (!fit || row.fit === fit));
}

/**
 * Deals per stage key, within the active fit filter, so each stage chip counts
 * what clicking it would show. The "All" chip is the sum.
 */
export function stageCounts(rows: DealRow[], fit: FitFilter | null): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (fit && row.fit !== fit) continue;
    counts[row.stageKey] = (counts[row.stageKey] ?? 0) + 1;
  }
  return counts;
}

/** Deals per fit flag, within the active stage filter. */
export function fitCounts(rows: DealRow[], stage: string): Record<FitFilter, number> {
  const counts: Record<FitFilter, number> = { likely: 0, possible: 0, unlikely: 0 };
  for (const row of rows) {
    if (stage && row.stageKey !== stage) continue;
    if (row.fit) counts[row.fit] = (counts[row.fit] ?? 0) + 1;
  }
  return counts;
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
    // Pipeline order, not alphabetical: "Diligence" before "Founder meeting"
    // reads as nonsense to anyone who works the funnel.
    if (sort === 'stage') {
      return factor * (a.stageOrder - b.stageOrder) || a.companyName.localeCompare(b.companyName);
    }
    if (sort === 'activity') {
      const at = (row: DealRow) => Date.parse(row.lastActivity ?? row.receivedAt) || 0;
      return factor * (at(a) - at(b)) || a.companyName.localeCompare(b.companyName);
    }
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
