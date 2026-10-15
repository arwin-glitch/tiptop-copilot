import { displayCrmValue } from '@/lib/crm/fields';
import type { CrmField, CrmFieldType, CrmValue } from '@/lib/types/domain';

/**
 * The shape of a list page: its URL state, its status ordering, and the
 * columns a reader has hidden.
 *
 * Pure, like fields.ts (the only thing it imports), because the server page and the
 * client table both read it — a runtime value exported from a 'use client'
 * module reaches a server component as a client reference proxy, not the value
 * (the same mistake once crashed `/deals` at request time).
 */

/* ------------------------------------------------------------ status order */

/** "3. First Meeting" → [3]; "8.2 Passed - Too early" → [8, 2]; "Passed" → null. */
function stagePrefix(label: string): number[] | null {
  const match = /^\s*(\d+(?:\.\d+)*)(?=[\s.):-]|$)/.exec(label);
  if (!match) return null;
  return (match[1] as string).split('.').map(Number);
}

/** Whether a stage carries its place in its name ("3. First Meeting"), so sorts by number. */
export function isNumberedStage(label: string): boolean {
  return stagePrefix(label) !== null;
}

function comparePrefixes(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    // A shorter prefix sorts first: "8" before "8.1".
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Status options in pipeline order.
 *
 * Affinity numbers its stages ("1. Sourced", "3. First Meeting", "8.2 Passed -
 * Too early", "10. Won / Signed"), and an import meets them in whatever order
 * the rows happened to use them — so a plain string sort would put "10. Won"
 * between "1." and "3.". Numbered options sort by their number, read as dotted
 * parts so 8.2 comes before 8.10; unnumbered options ("Passed", or an LP list's
 * "Prospect", "Contacted", …) keep their stored order after them, because that
 * order is the only signal there is.
 */
export function sortStatusOptions(options: readonly string[]): string[] {
  return options
    .map((label, index) => ({ label, index, prefix: stagePrefix(label) }))
    .sort((a, b) => {
      if (a.prefix && b.prefix) return comparePrefixes(a.prefix, b.prefix) || a.index - b.index;
      if (a.prefix) return -1;
      if (b.prefix) return 1;
      return a.index - b.index;
    })
    .map((o) => o.label);
}

/**
 * Stages in pipeline order with the one at `index` moved a place up (-1) or
 * down (+1). Only unnumbered stages move, and only past each other: a
 * numbered stage keeps the place its number gives it wherever it is stored.
 * Unchanged when the move is not possible.
 */
export function moveStage(options: readonly string[], index: number, delta: -1 | 1): string[] {
  const out = [...options];
  const a = out[index];
  const b = out[index + delta];
  if (a === undefined || b === undefined || isNumberedStage(a) || isNumberedStage(b)) return out;
  out[index] = b;
  out[index + delta] = a;
  return out;
}

export type CrmStatusTone = 'ok' | 'info' | 'neutral';

/**
 * A badge tone from a status label alone: closed-won reads green, closed-lost
 * grey, anything in flight blue. A guess from the words, so it only ever
 * colours a label and never decides anything.
 */
export function statusTone(label: string | null | undefined): CrmStatusTone {
  if (!label) return 'neutral';
  if (/\b(pass(ed)?|declined?|lost|dead|rejected|churned|no longer|not a fit)\b/i.test(label)) {
    return 'neutral';
  }
  if (/\b(won|signed|invested|committed|closed|funded|portfolio)\b/i.test(label)) return 'ok';
  return 'info';
}

/* ---------------------------------------------------------------- URL state */

export const CRM_LIST_PAGE_SIZE = 100;

export type CrmListViewMode = 'table' | 'board';

/** What a list page shows, as its URL says. */
export interface CrmListParams {
  q: string;
  /** A sort column (`title`, `position`, …) or field key; '' for list order. */
  sort: string;
  dir: 'asc' | 'desc';
  /** Status labels to keep; repeated `status=` params, since a label can contain a comma. */
  statuses: string[];
  /** 1-based. */
  page: number;
  view: CrmListViewMode;
}

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function all(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((v) => v.trim() !== '');
}

/** The list page's state from its search params, every value checked. */
export function parseCrmListParams(params: RawParams): CrmListParams {
  const page = Number.parseInt(first(params.page) ?? '', 10);
  const sort = first(params.sort) ?? '';
  return {
    q: (first(params.q) ?? '').trim().slice(0, 200),
    sort: /^[a-z][a-z0-9_]{0,59}$/.test(sort) ? sort : '',
    dir: first(params.dir) === 'desc' ? 'desc' : 'asc',
    statuses: [...new Set(all(params.status))].slice(0, 50),
    page: Number.isFinite(page) && page > 1 ? Math.min(page, 100_000) : 1,
    view: first(params.view) === 'board' ? 'board' : 'table',
  };
}

/**
 * The query string for a list page with some state changed, defaults left
 * out so a plain link stays plain. Changing anything but the page goes back
 * to page one — page 37 of a different filter is not a place anyone meant.
 */
export function crmListQuery(current: CrmListParams, changes: Partial<CrmListParams>): string {
  const next = { ...current, ...changes };
  if (!('page' in changes)) next.page = 1;
  const search = new URLSearchParams();
  if (next.view === 'board') search.set('view', 'board');
  if (next.q) search.set('q', next.q);
  for (const status of next.statuses) search.append('status', status);
  if (next.sort) {
    search.set('sort', next.sort);
    if (next.dir === 'desc') search.set('dir', 'desc');
  }
  if (next.page > 1) search.set('page', String(next.page));
  return search.toString();
}

export function crmListHref(
  listId: string,
  current: CrmListParams,
  changes: Partial<CrmListParams> = {},
): string {
  const qs = crmListQuery(current, changes);
  return qs ? `/lists/${listId}?${qs}` : `/lists/${listId}`;
}

/** Figures and dates start highest/newest first; names and stages A–Z. */
export function defaultSortDir(type: CrmFieldType | 'title'): 'asc' | 'desc' {
  return type === 'money' || type === 'number' || type === 'date' ? 'desc' : 'asc';
}

/* ----------------------------------------------------------- hidden columns */
//
// Which columns a reader has hidden, per list and per browser. The *hidden*
// set is what is stored, not the visible one, so a field a re-import adds
// shows up rather than staying invisible until someone goes looking for it.

export function crmColumnsKey(listId: string): string {
  return `crm-columns:${listId}`;
}

/** A stored hidden-column value as keys of fields the list still has. Garbage reads as none hidden. */
export function parseHiddenColumns(
  raw: string | null | undefined,
  fields: readonly Pick<CrmField, 'key'>[],
): Set<string> {
  if (!raw) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  const keys = new Set(fields.map((f) => f.key));
  return new Set(parsed.filter((k): k is string => typeof k === 'string' && keys.has(k)));
}

export function serializeHiddenColumns(hidden: Iterable<string>): string {
  return JSON.stringify([...new Set(hidden)].sort());
}

/**
 * Storage access that cannot throw. A private window, blocked site data or a
 * sandboxed preview makes `localStorage` itself throw on access, and a
 * preference is never worth an error on the page.
 */
export function readHiddenColumnsRaw(
  storage: () => Pick<Storage, 'getItem'> | null | undefined,
  listId: string,
): string | null {
  try {
    return storage()?.getItem(crmColumnsKey(listId)) ?? null;
  } catch {
    return null;
  }
}

/** False when the choice could not be stored; the page still applies it for this visit. */
export function writeHiddenColumns(
  storage: () => Pick<Storage, 'setItem' | 'removeItem'> | null | undefined,
  listId: string,
  hidden: Iterable<string>,
): boolean {
  try {
    const target = storage();
    if (!target) return false;
    const value = serializeHiddenColumns(hidden);
    if (value === '[]') target.removeItem(crmColumnsKey(listId));
    else target.setItem(crmColumnsKey(listId), value);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ values */

const DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/**
 * A stored value as the text a cell shows. Dates are formatted: a bare
 * `YYYY-MM-DD` as that calendar day (read in UTC, so it never slips to the
 * day before west of Greenwich), a date-time in the reader's time zone. An
 * import keeps a cell it could not parse as the original string, and that
 * string is shown as it is.
 */
export function formatCrmValue(
  field: Pick<CrmField, 'type'>,
  value: CrmValue | undefined,
  timeZone: string,
): string {
  if (field.type === 'date' && typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const t = Date.parse(`${value}T00:00:00Z`);
      return Number.isNaN(t) ? value : DAY_FORMAT.format(t);
    }
    const t = Date.parse(value);
    if (!Number.isNaN(t)) {
      return new Intl.DateTimeFormat('en-US', {
        timeZone,
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(t);
    }
  }
  return displayCrmValue(field, value);
}

/* ------------------------------------------------------------- board cards */

/** A board column as the page holds it: a status (null for none), its first cards, its full count. */
export interface BoardColumnLike<T extends { id: string }> {
  status: string | null;
  entries: T[];
  total: number;
}

/**
 * Board columns with status changes in flight applied: a card being moved
 * leaves its column and heads the one it is going to, and both counts follow.
 * A card heading for a column the board is not showing (filtered out by the
 * status chips) just leaves. Derived, never stored, so a failed save — which
 * drops the change — puts the card straight back.
 */
export function withPendingStatus<T extends { id: string }, C extends BoardColumnLike<T>>(
  columns: readonly C[],
  pending: Readonly<Record<string, { value: string | null }>>,
): C[] {
  const moving: { entry: T; to: string | null }[] = [];
  const kept = columns.map((column) => {
    const stay = column.entries.filter((entry) => {
      const change = pending[entry.id];
      if (!change || change.value === column.status) return true;
      moving.push({ entry, to: change.value });
      return false;
    });
    return {
      ...column,
      entries: stay,
      total: Math.max(0, column.total - (column.entries.length - stay.length)),
    };
  });
  for (const { entry, to } of moving) {
    const target = kept.find((c) => c.status === to);
    if (!target) continue;
    target.entries = [entry, ...target.entries];
    target.total += 1;
  }
  return kept;
}

/** The fields a board card shows under its title: the first few visible ones besides the status. */
export function boardCardFields(
  fields: readonly CrmField[],
  statusKey: string | null,
  hidden: ReadonlySet<string> = new Set(),
  max = 3,
): CrmField[] {
  return fields.filter((f) => f.key !== statusKey && !hidden.has(f.key)).slice(0, max);
}
