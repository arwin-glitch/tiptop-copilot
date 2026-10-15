import { CRM_ARRAY_FIELD_TYPES, statusFieldOf, validateCrmValue } from '@/lib/crm/fields';
import { fieldAllowed } from '@/lib/crm/lp-rule';
import type { Filter, Scalar } from '@/lib/db/store';
import type { CrmField, CrmFieldType, CrmList, CrmListEntry } from '@/lib/types/domain';

/**
 * Saved views on a list, Affinity-style: a named table or board with its own
 * columns, sort, filters and board grouping.
 *
 * Pure and dependency-light, like fields.ts and view.ts, because the server
 * page, the export route and the client controls all have to agree on what a
 * view means — which conditions a field takes, how a condition becomes a
 * database filter, how the URL spells it. Storage is the `views` jsonb array
 * on crm_lists (20261016010000_crm_views.sql), read only through
 * parseSavedViews, so a malformed or stale view (a field since removed) is
 * cleaned rather than trusted.
 */

/* --------------------------------------------------------------- the model */

/** The built-in view every list has: every column, list order, no filters. Never stored. */
export const CRM_ALL_VIEW_ID = 'all';
export const CRM_VIEWS_MAX = 50;
export const CRM_VIEW_NAME_MAX = 80;
export const CRM_VIEW_CONDITIONS_MAX = 20;
const STATUSES_MAX = 50;
const CONDITION_TEXT_MAX = 200;

/**
 * The computed "time in current status" column. Not a field: the leading
 * underscore keeps it out of the field-key alphabet (`[a-z][a-z0-9_]*`), so
 * it can never collide with an imported column.
 */
export const CRM_TIME_IN_STATUS_KEY = '_time_in_status';
// "Stage" rather than Affinity's "Status": the label must not contain the
// name of the field it times, or "Status" would name two columns.
export const CRM_TIME_IN_STATUS_LABEL = 'Time in Stage';

export type CrmViewLayout = 'table' | 'board';

export const CRM_CONDITION_OPS = [
  'is',
  'contains',
  'in',
  'empty',
  'not_empty',
  'gte',
  'lte',
] as const;
export type CrmConditionOp = (typeof CRM_CONDITION_OPS)[number];

/** One filter condition. A view's conditions all apply (AND). */
export interface CrmViewCondition {
  /** A field key of the list. */
  key: string;
  op: CrmConditionOp;
  /** For is / contains / gte / lte: a number on number and money fields, a `YYYY-MM-DD` day on dates, else text. */
  value?: string | number;
  /** For `in`: the status labels to keep. */
  values?: string[];
}

/** Everything a view decides about a list page — all of the page's state but the search and the page number. */
export interface CrmViewState {
  view: CrmViewLayout;
  /**
   * The visible columns in order: field keys and CRM_TIME_IN_STATUS_KEY. Null
   * is "every column in list order" (on the All view, minus the columns this
   * browser has hidden).
   */
  columns: string[] | null;
  /** A sort column (`title`, `position`, …) or field key; '' for list order. */
  sort: string;
  dir: 'asc' | 'desc';
  /** Pipeline-status labels to keep (the status chips). */
  statuses: string[];
  conditions: CrmViewCondition[];
  /** The status field the board is grouped by; '' for the list's pipeline field. */
  groupBy: string;
}

export interface CrmSavedView extends CrmViewState {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export const DEFAULT_VIEW_STATE: Readonly<CrmViewState> = Object.freeze({
  view: 'table',
  columns: null,
  sort: '',
  dir: 'asc',
  statuses: [],
  conditions: [],
  groupBy: '',
});

/** The view-state part of anything that carries one (a saved view, the page's params). */
export function viewStateOf(source: CrmViewState): CrmViewState {
  return {
    view: source.view,
    columns: source.columns ? [...source.columns] : null,
    sort: source.sort,
    dir: source.dir,
    statuses: [...source.statuses],
    conditions: source.conditions.map((c) => ({
      ...c,
      values: c.values ? [...c.values] : undefined,
    })),
    groupBy: source.groupBy,
  };
}

function canonicalCondition(c: CrmViewCondition): string {
  return JSON.stringify([c.key, c.op, c.value ?? null, c.values ? [...c.values].sort() : null]);
}

/**
 * Whether two states show the same page. Status chips and conditions are
 * sets (the order they were clicked in means nothing); column order matters.
 * A sort direction without a sort is no sort.
 */
export function sameViewState(a: CrmViewState, b: CrmViewState): boolean {
  const key = (s: CrmViewState) =>
    JSON.stringify({
      view: s.view,
      columns: s.columns,
      sort: s.sort,
      dir: s.sort ? s.dir : 'asc',
      statuses: [...s.statuses].sort(),
      conditions: s.conditions.map(canonicalCondition).sort(),
      groupBy: s.view === 'board' ? s.groupBy : '',
    });
  return key(a) === key(b);
}

/* ----------------------------------------------------- conditions by type */

const OPS_BY_TYPE: Record<CrmFieldType, readonly CrmConditionOp[]> = {
  text: ['contains', 'is', 'empty', 'not_empty'],
  url: ['contains', 'is', 'empty', 'not_empty'],
  email: ['contains', 'is', 'empty', 'not_empty'],
  status: ['in', 'empty', 'not_empty'],
  multi: ['is', 'contains', 'empty', 'not_empty'],
  person: ['contains', 'is', 'empty', 'not_empty'],
  company: ['contains', 'is', 'empty', 'not_empty'],
  number: ['gte', 'lte', 'is', 'empty', 'not_empty'],
  money: ['gte', 'lte', 'is', 'empty', 'not_empty'],
  date: ['gte', 'lte', 'is', 'empty', 'not_empty'],
};

/** The conditions a field of this type takes, the most useful first. */
export function conditionOps(type: CrmFieldType): readonly CrmConditionOp[] {
  return OPS_BY_TYPE[type] ?? OPS_BY_TYPE.text;
}

/** How a condition reads in the filter picker and on its chip. */
export function conditionOpLabel(op: CrmConditionOp, type: CrmFieldType): string {
  const array = CRM_ARRAY_FIELD_TYPES.has(type);
  switch (op) {
    case 'is':
      return array ? 'includes' : 'is';
    case 'contains':
      return 'contains';
    case 'in':
      return 'is any of';
    case 'empty':
      return 'is empty';
    case 'not_empty':
      return 'is not empty';
    case 'gte':
      return type === 'date' ? 'is on or after' : 'is at least';
    case 'lte':
      return type === 'date' ? 'is on or before' : 'is at most';
  }
}

export function conditionNeedsValue(op: CrmConditionOp): boolean {
  return op !== 'empty' && op !== 'not_empty';
}

function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** The day after a `YYYY-MM-DD`, for "on or before" as "before the next day". */
export function nextDay(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  return new Date(t + 86_400_000).toISOString().slice(0, 10);
}

/**
 * A condition checked against the list's fields, or null when it cannot
 * apply: an unknown field, an operator the field's type does not take, or a
 * value that does not parse (a number field given words).
 */
export function normalizeCondition(
  raw: unknown,
  fields: readonly CrmField[],
): CrmViewCondition | null {
  if (!raw || typeof raw !== 'object') return null;
  const { key, op, value, values } = raw as Record<string, unknown>;
  const field = fields.find((f) => f.key === key);
  if (!field || typeof op !== 'string') return null;
  if (!(conditionOps(field.type) as readonly string[]).includes(op)) return null;
  const condition = { key: field.key, op: op as CrmConditionOp };
  if (!conditionNeedsValue(condition.op)) return condition;

  if (condition.op === 'in') {
    if (!Array.isArray(values)) return null;
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const v of values) {
      const label = typeof v === 'string' ? v.trim() : '';
      if (!label || label.length > CONDITION_TEXT_MAX || seen.has(label)) continue;
      seen.add(label);
      kept.push(label);
    }
    return kept.length ? { ...condition, values: kept.slice(0, STATUSES_MAX) } : null;
  }

  if (field.type === 'number' || field.type === 'money') {
    const checked = validateCrmValue(
      field,
      typeof value === 'number' ? value : String(value ?? ''),
    );
    if (!checked.ok || typeof checked.value !== 'number') return null;
    return { ...condition, value: checked.value };
  }
  const text =
    typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  if (!text || text.length > CONDITION_TEXT_MAX) return null;
  if (field.type === 'date') {
    const day = text.slice(0, 10);
    return isDay(day) ? { ...condition, value: day } : null;
  }
  return { ...condition, value: field.type === 'email' ? text.toLowerCase() : text };
}

/** The slot a condition fills: one condition per slot, the later one winning. */
function conditionSlot(c: CrmViewCondition, field: CrmField | undefined): string {
  // On a list-valued field, "includes" and "contains" are both a substring
  // match on the same column and could not both be sent; they share a slot.
  if (field && CRM_ARRAY_FIELD_TYPES.has(field.type) && (c.op === 'is' || c.op === 'contains')) {
    return `${c.key}:match`;
  }
  return `${c.key}:${c.op}`;
}

/** Conditions normalized, at most one per field and operator (the later wins), capped. */
export function normalizeConditions(raw: unknown, fields: readonly CrmField[]): CrmViewCondition[] {
  if (!Array.isArray(raw)) return [];
  const bySlot = new Map<string, CrmViewCondition>();
  for (const item of raw) {
    const condition = normalizeCondition(item, fields);
    if (!condition) continue;
    const slot = conditionSlot(
      condition,
      fields.find((f) => f.key === condition.key),
    );
    bySlot.delete(slot);
    bySlot.set(slot, condition);
  }
  return [...bySlot.values()].slice(0, CRM_VIEW_CONDITIONS_MAX);
}

/* ---------------------------------------------------- conditions → filter */

function compareBound(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * Filter parts accumulated condition by condition, so two conditions on the
 * same column combine (AND) instead of the later overwriting the earlier: a
 * pair of bounds keeps the tighter one, two status lists keep what both
 * allow, and two exact values that differ match nothing at all.
 */
class FilterBuilder {
  readonly filter: Filter;
  private impossible = false;

  constructor(base: Filter) {
    this.filter = {
      ...base,
      eq: base.eq ? { ...base.eq } : undefined,
      in: base.in ? { ...base.in } : undefined,
      gte: base.gte ? { ...base.gte } : undefined,
      lt: base.lt ? { ...base.lt } : undefined,
      lte: base.lte ? { ...base.lte } : undefined,
      isNull: base.isNull ? [...base.isNull] : undefined,
      notNull: base.notNull ? [...base.notNull] : undefined,
      textContains: base.textContains ? { ...base.textContains } : undefined,
    };
  }

  eq(path: string, value: Scalar): void {
    const eq = (this.filter.eq ??= {});
    if (path in eq && eq[path] !== value) this.impossible = true;
    eq[path] = value;
  }

  in(path: string, values: readonly string[]): void {
    const all = (this.filter.in ??= {});
    const before = all[path];
    all[path] = before ? before.filter((v) => values.includes(v as string)) : [...values];
  }

  lower(path: string, value: string | number): void {
    const gte = (this.filter.gte ??= {});
    const before = gte[path];
    gte[path] = before === undefined || compareBound(value, before) > 0 ? value : before;
  }

  /** An inclusive upper bound. */
  upper(path: string, value: string | number): void {
    const lte = (this.filter.lte ??= {});
    const before = lte[path];
    lte[path] = before === undefined || compareBound(value, before) < 0 ? value : before;
  }

  /** An exclusive upper bound. */
  below(path: string, value: string | number): void {
    const lt = (this.filter.lt ??= {});
    const before = lt[path];
    lt[path] = before === undefined || compareBound(value, before) < 0 ? value : before;
  }

  isNull(path: string): void {
    const list = (this.filter.isNull ??= []);
    if (!list.includes(path)) list.push(path);
  }

  notNull(path: string): void {
    const list = (this.filter.notNull ??= []);
    if (!list.includes(path)) list.push(path);
  }

  contains(path: string, text: string): void {
    (this.filter.textContains ??= {})[path] = text;
  }

  build(): Filter {
    const out: Filter = {};
    for (const [k, v] of Object.entries(this.filter)) {
      if (v === undefined) continue;
      if (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && !Object.keys(v).length) {
        continue;
      }
      (out as Record<string, unknown>)[k] = v;
    }
    // Contradictory exact values: an `in` nothing can satisfy says "no rows"
    // in both stores without a special case.
    if (this.impossible) out.in = { ...out.in, id: [] };
    return out;
  }
}

/**
 * A filter for a list's entries: `base` (the list, the title search) narrowed
 * by the pipeline statuses (the chips) and every condition. Conditions on
 * fields the list no longer has are skipped — normalize first to drop them
 * visibly.
 *
 * How each condition reaches the database, the same in both stores:
 *   - text `is`: the value as text equals (`values->>key`), exactly
 *   - text `contains`: a case-insensitive substring of it
 *   - list fields (multi, people, companies): stored as a JSON array, so
 *     `contains` is a substring of the array's text and `includes` the
 *     quoted element (`"AI"`), both case-insensitive
 *   - status `is any of`: the value is one of the labels
 *   - numbers and money: compared as numbers (`values->key`, jsonb); `is` is
 *     a range of one value
 *   - dates: compared as ISO text, `on or before` as "before the next day"
 *     so a stored date-time on that day still counts
 *   - empty / not empty: the key absent or present (an empty value is never
 *     stored)
 */
export function compileEntryFilter(
  base: Filter,
  fields: readonly CrmField[],
  options: {
    statusKey?: string | null;
    statuses?: readonly string[] | null;
    conditions?: readonly CrmViewCondition[] | null;
  } = {},
): Filter {
  const builder = new FilterBuilder(base);
  const statuses = (options.statuses ?? []).filter((s) => typeof s === 'string' && s);
  if (options.statusKey && statuses.length) {
    builder.in(`values->>${options.statusKey}`, statuses);
  }
  for (const c of options.conditions ?? []) {
    const field = fields.find((f) => f.key === c.key);
    if (!field) continue;
    const text = `values->>${field.key}`;
    const json = `values->${field.key}`;
    const numeric = field.type === 'number' || field.type === 'money';
    const array = CRM_ARRAY_FIELD_TYPES.has(field.type);
    switch (c.op) {
      case 'empty':
        builder.isNull(text);
        break;
      case 'not_empty':
        builder.notNull(text);
        break;
      case 'in':
        builder.in(text, c.values ?? []);
        break;
      case 'contains':
        if (c.value !== undefined && c.value !== '') builder.contains(text, String(c.value));
        break;
      case 'is':
        if (c.value === undefined || c.value === '') break;
        if (numeric && typeof c.value === 'number') {
          builder.lower(json, c.value);
          builder.upper(json, c.value);
        } else if (field.type === 'date') {
          builder.lower(text, String(c.value));
          builder.below(text, nextDay(String(c.value)));
        } else if (array) {
          builder.contains(text, JSON.stringify(String(c.value)));
        } else {
          builder.eq(text, String(c.value));
        }
        break;
      case 'gte':
        if (c.value === undefined || c.value === '') break;
        if (numeric && typeof c.value === 'number') builder.lower(json, c.value);
        else if (field.type === 'date') builder.lower(text, String(c.value));
        break;
      case 'lte':
        if (c.value === undefined || c.value === '') break;
        if (numeric && typeof c.value === 'number') builder.upper(json, c.value);
        else if (field.type === 'date') builder.below(text, nextDay(String(c.value)));
        break;
    }
  }
  return builder.build();
}

/* ------------------------------------------------------------- normalizing */

const SORT_COLUMNS = ['title', 'position', 'created_at', 'updated_at'];
const COLUMN_KEY_RE = /^_?[a-z][a-z0-9_]{0,59}$/;

/** Whether a list has the computed time-in-status column: only when it has a status field. */
export function hasTimeInStatus(fields: readonly CrmField[]): boolean {
  return fields.some((f) => f.type === 'status');
}

/** The keys a view's columns may name on this list. */
export function columnKeys(fields: readonly CrmField[]): string[] {
  const keys = fields.map((f) => f.key);
  if (hasTimeInStatus(fields)) keys.push(CRM_TIME_IN_STATUS_KEY);
  return keys;
}

function cleanLabels(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    const label = typeof v === 'string' ? v.trim() : '';
    if (label && label.length <= CONDITION_TEXT_MAX && !out.includes(label)) out.push(label);
  }
  return out.slice(0, max);
}

/** A view state checked against the list: unknown columns, sorts, fields and groupings dropped. */
export function normalizeViewState(raw: unknown, fields: readonly CrmField[]): CrmViewState {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const keys = columnKeys(fields);
  let columns: string[] | null = null;
  if (Array.isArray(r.columns)) {
    columns = [];
    for (const k of r.columns) {
      if (
        typeof k === 'string' &&
        COLUMN_KEY_RE.test(k) &&
        keys.includes(k) &&
        !columns.includes(k)
      ) {
        columns.push(k);
      }
    }
  }
  const sort =
    typeof r.sort === 'string' &&
    (SORT_COLUMNS.includes(r.sort) || fields.some((f) => f.key === r.sort))
      ? r.sort
      : '';
  const groupBy =
    typeof r.groupBy === 'string' && fields.some((f) => f.key === r.groupBy && f.type === 'status')
      ? r.groupBy
      : '';
  return {
    view: r.view === 'board' ? 'board' : 'table',
    columns,
    sort,
    dir: r.dir === 'desc' ? 'desc' : 'asc',
    statuses: cleanLabels(r.statuses, STATUSES_MAX),
    conditions: normalizeConditions(r.conditions, fields),
    groupBy,
  };
}

const VIEW_ID_RE = /^[a-z0-9]{6,32}$/;

/** A view name as stored: trimmed, inner whitespace collapsed; null when empty or too long. */
export function cleanViewName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name || name.length > CRM_VIEW_NAME_MAX) return null;
  return name;
}

/**
 * A list's stored views, cleaned: malformed ones dropped, duplicate ids kept
 * once, states normalized against the list's current fields. Never throws —
 * the column may be absent (the migration not run) or hold anything.
 */
export function parseSavedViews(raw: unknown, fields: readonly CrmField[]): CrmSavedView[] {
  if (!Array.isArray(raw)) return [];
  const out: CrmSavedView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    const name = cleanViewName(r.name);
    if (!VIEW_ID_RE.test(id) || id === CRM_ALL_VIEW_ID || !name) continue;
    if (out.some((v) => v.id === id)) continue;
    const at = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : '');
    out.push({
      id,
      name,
      ...normalizeViewState(r, fields),
      created_at: at(r.created_at),
      updated_at: at(r.updated_at) || at(r.created_at),
    });
    if (out.length >= CRM_VIEWS_MAX) break;
  }
  return out;
}

export function isSavedViewId(value: string): boolean {
  return VIEW_ID_RE.test(value) && value !== CRM_ALL_VIEW_ID;
}

/* ------------------------------------------------------------- URL format */
//
// A condition in the URL is one `f` parameter: `key:op` or `key:op:value`,
// the value being everything after the second colon (keys and operators
// cannot contain one). `in` carries its labels as a JSON array, since a
// status label can contain any character.

export function encodeCondition(c: CrmViewCondition): string {
  if (c.op === 'in') return `${c.key}:in:${JSON.stringify(c.values ?? [])}`;
  if (!conditionNeedsValue(c.op)) return `${c.key}:${c.op}`;
  return `${c.key}:${c.op}:${c.value ?? ''}`;
}

/** A condition from its URL form, unvalidated (normalizeCondition checks it against the list). */
export function decodeCondition(raw: string): CrmViewCondition | null {
  const first = raw.indexOf(':');
  if (first <= 0) return null;
  const key = raw.slice(0, first);
  const rest = raw.slice(first + 1);
  const second = rest.indexOf(':');
  const op = second < 0 ? rest : rest.slice(0, second);
  const value = second < 0 ? undefined : rest.slice(second + 1);
  if (!COLUMN_KEY_RE.test(key) || !(CRM_CONDITION_OPS as readonly string[]).includes(op)) {
    return null;
  }
  const condition: CrmViewCondition = { key, op: op as CrmConditionOp };
  if (op === 'in') {
    try {
      const parsed: unknown = JSON.parse(value ?? '');
      if (!Array.isArray(parsed)) return null;
      condition.values = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      return null;
    }
    return condition;
  }
  if (conditionNeedsValue(condition.op)) {
    if (value === undefined || value === '') return null;
    condition.value = value;
  }
  return condition;
}

/* ---------------------------------------------------------------- columns */

/**
 * The columns the All view leaves out until someone shows them (Columns), on
 * a list with a status field:
 *   - Affinity's own "Time in Current Status", when the import kept it: the
 *     computed Time in Stage takes its place — it starts from that figure and
 *     keeps counting, where the imported column stays frozen at the import —
 *     so the two never sit side by side saying different things.
 *   - otherwise, on a list imported from Affinity, Time in Stage itself: with
 *     no figure from Affinity it is blank for every imported entry until its
 *     stage is changed in Copilot, so it is offered, not shown.
 * A list made in Copilot shows it: every entry there counts from when it was
 * added.
 */
export function defaultHiddenColumns(list: Pick<CrmList, 'source' | 'fields'>): string[] {
  if (!hasTimeInStatus(list.fields)) return [];
  const imported = importedTimeInStatusField(list.fields);
  if (imported) return [imported.key];
  return list.source === 'affinity' ? [CRM_TIME_IN_STATUS_KEY] : [];
}

/** The columns a table shows, in order: the view's own, else every column in list order minus the hidden ones. */
export function visibleColumnKeys(
  fields: readonly CrmField[],
  columns: readonly string[] | null,
  hidden: ReadonlySet<string> = new Set(),
): string[] {
  const keys = columnKeys(fields);
  if (columns) return columns.filter((k) => keys.includes(k));
  // Every column in list order, the computed status timer right after the
  // pipeline field it times.
  const ordered: string[] = [];
  const pipeline = statusFieldOf({ fields: [...fields] });
  for (const f of fields) {
    ordered.push(f.key);
    if (pipeline && f.key === pipeline.key) ordered.push(CRM_TIME_IN_STATUS_KEY);
  }
  return ordered.filter((k) => !hidden.has(k));
}

/* ------------------------------------------------------------------ totals */

export interface CrmSum {
  sum: number;
  /** Entries with a numeric value for the field. */
  count: number;
}

export interface CrmTotalsGroup {
  count: number;
  sums: Record<string, CrmSum>;
}

/** Sums of number and money fields across every entry a view matches, overall and per board column. */
export interface CrmTotals {
  /** Entries counted. */
  count: number;
  sums: Record<string, CrmSum>;
  /** By the grouping field's value ('' for none), when a grouping was asked for. */
  groups: Record<string, CrmTotalsGroup>;
  /** False when the entries ran past the cap and the sums cover only the first of them. */
  complete: boolean;
}

export function emptyTotals(): CrmTotals {
  return { count: 0, sums: {}, groups: {}, complete: true };
}

/**
 * The fields that get totals: numbers and money — except the amounts on an
 * LP list (a commitment, an allocation), which are never added up: LP
 * information is stages only (lp-rule.ts). The page, the board and the
 * totals query all ask here, so none of them sums what another hides.
 */
export function summableFields(
  list: Pick<CrmList, 'name'>,
  fields: readonly CrmField[],
): CrmField[] {
  return fields.filter((f) => (f.type === 'number' || f.type === 'money') && fieldAllowed(list, f));
}

function addSum(sums: Record<string, CrmSum>, key: string, value: unknown): void {
  const slot = (sums[key] ??= { sum: 0, count: 0 });
  if (typeof value === 'number' && Number.isFinite(value)) {
    slot.sum += value;
    slot.count += 1;
  }
}

/** Fold a page of entries into running totals. A value that is not a number (an unparsed import cell) is not counted. */
export function addToTotals(
  totals: CrmTotals,
  entries: readonly Pick<CrmListEntry, 'values'>[],
  sumKeys: readonly string[],
  groupKey: string | null,
): CrmTotals {
  for (const entry of entries) {
    totals.count += 1;
    const values = entry.values ?? {};
    for (const key of sumKeys) addSum(totals.sums, key, values[key]);
    if (groupKey) {
      const raw = values[groupKey];
      const label = typeof raw === 'string' ? raw : '';
      const group = (totals.groups[label] ??= { count: 0, sums: {} });
      group.count += 1;
      for (const key of sumKeys) addSum(group.sums, key, values[key]);
    }
  }
  return totals;
}

/** Totals with floating-point noise rounded off (to the cent). */
export function roundTotals(totals: CrmTotals): CrmTotals {
  const round = (sums: Record<string, CrmSum>) =>
    Object.fromEntries(
      Object.entries(sums).map(([k, s]) => [k, { ...s, sum: Math.round(s.sum * 100) / 100 }]),
    );
  return {
    ...totals,
    sums: round(totals.sums),
    groups: Object.fromEntries(
      Object.entries(totals.groups).map(([k, g]) => [k, { ...g, sums: round(g.sums) }]),
    ),
  };
}

/* ---------------------------------------------------------- time in status */

/** How an entry's time in its current status is known. */
export interface CrmTimeInStatus {
  /**
   * When the entry entered its current status: known for 'copilot' (the
   * latest change) and 'added' (when it was added), estimated for 'affinity'
   * (Affinity's figure counted back from the import that carried it).
   */
  since: string | null;
  /** Affinity's own "Time in Current Status" as the import left it, when there is no later change. */
  imported: string | null;
  source: 'copilot' | 'added' | 'affinity' | 'unknown';
  /** For 'affinity': when the import that carried Affinity's figure ran. */
  importedAt?: string | null;
}

/** An imported Affinity "Time in Current Status" column, if the list kept one. */
export function importedTimeInStatusField(fields: readonly CrmField[]): CrmField | null {
  return (
    fields.find((f) => /^\s*time\s+in\s+(current\s+)?(status|stage)\s*$/i.test(f.name)) ?? null
  );
}

const DURATION_UNIT_MS: Record<string, number> = {
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  mo: 30 * 86_400_000,
  y: 365 * 86_400_000,
};

/**
 * An imported "Time in Current Status" figure as a duration: a bare number is
 * days (what Affinity exports); "12d", "12 days", "3 weeks", "5h", "2 months"
 * are read too. Null for anything else, which is then shown as it was written.
 */
export function importedDurationMs(text: string): number | null {
  const match =
    /^\s*(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|mos|months?|y|yrs?|years?)?\s*$/i.exec(
      text,
    );
  if (!match) return null;
  const n = Number(match[1]);
  const unit = (match[2] ?? 'd').toLowerCase();
  const key = unit.startsWith('mo')
    ? 'mo'
    : unit.startsWith('h')
      ? 'h'
      : unit.startsWith('w')
        ? 'w'
        : unit.startsWith('y')
          ? 'y'
          : 'd';
  const ms = n * (DURATION_UNIT_MS[key] as number);
  return Number.isFinite(ms) ? ms : null;
}

/** "<1h", "5h", "12d": the unit a pipeline is judged in is days. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 3_600_000) return '<1h';
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/** Whole days since `since`, or null. */
export function daysSince(since: string | null, now: number = Date.now()): number | null {
  if (!since) return null;
  const t = Date.parse(since);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/**
 * The text a cell shows for an entry's time in status. An estimate from
 * Affinity's figure reads "~36d": the mark is visible text, not a hover, so a
 * phone shows it too.
 */
export function timeInStatusText(t: CrmTimeInStatus | undefined, now: number = Date.now()): string {
  if (!t) return '';
  if (t.since) {
    const ms = now - Date.parse(t.since);
    if (Number.isNaN(ms)) return '';
    const text = formatDuration(Math.max(0, ms));
    return t.source === 'affinity' ? `~${text}` : text;
  }
  if (t.imported) return /^\d+(\.\d+)?$/.test(t.imported) ? `${t.imported}d` : t.imported;
  return '';
}

/* --------------------------------------------------------------------- CSV */

const NUMERIC_TEXT = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

/**
 * One CSV cell (RFC 4180): quoted when it holds a comma, quote, line break
 * or edge whitespace, quotes doubled. A text cell a spreadsheet would run as
 * a formula (starting `=`, `+`, `-`, `@`, tab or carriage return) gets a
 * leading apostrophe — CRM text is imported from elsewhere and pasted in by
 * anyone, and opening an export must never execute it. Plain numbers, which
 * can start with a sign, are left as they are.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (typeof value === 'number') s = Number.isFinite(value) ? String(value) : '';
  else if (typeof value === 'boolean') s = value ? 'true' : 'false';
  else {
    s = value;
    if (/^[=+\-@\t\r]/.test(s) && !NUMERIC_TEXT.test(s)) s = `'${s}`;
  }
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(cells: readonly (string | number | boolean | null | undefined)[]): string {
  return cells.map(csvCell).join(',');
}

/**
 * A whole CSV document: CRLF line ends, and a byte-order mark first so Excel
 * reads it as UTF-8 rather than mangling every accented name.
 */
export function toCsv(
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
  options: { bom?: boolean } = {},
): string {
  const body = rows.map(csvRow).join('\r\n');
  return `${options.bom === false ? '' : '﻿'}${body}${rows.length ? '\r\n' : ''}`;
}

/** A stored value as an export cell: numbers stay numbers, lists join with "; " (what the import splits on). */
export function exportCellValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').join('; ');
  if (typeof value === 'string') return value;
  return null;
}
