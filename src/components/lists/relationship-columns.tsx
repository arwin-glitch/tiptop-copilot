'use client';

import * as React from 'react';
import { AlertTriangle, HeartHandshake, RotateCw } from 'lucide-react';
import { StrengthBadge } from '@/components/network/strength-badge';
import { Button } from '@/components/ui/button';
import { FieldLabel } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { TableCell, TableHeaderCell } from '@/components/ui/table';
import {
  formatSmartValue,
  SMART_FIELD_KEYS,
  SMART_FIELD_LABELS,
  type RecordRelationshipRow,
  type SmartFieldKey,
} from '@/lib/network/strength';

/**
 * A list's optional relationship columns: Strength and the smart fields
 * (first and last email, last and next meeting, last contact), from Kraken's
 * own mail and calendar with Affinity's value as the marked fallback.
 *
 * Off until a reader turns them on, remembered per list in this browser like
 * hidden columns. Fetched for the rows on screen in one request to
 * /api/crm/relationships, only once a column is on, so a list nobody asked
 * this of costs nothing extra. Not sortable: the figures are not stored in
 * the database the list is sorted in. A failed fetch says so, in the toolbar
 * and in every cell, with a retry: it never reads as "no relationship".
 */

export const RELATIONSHIP_COLUMNS = ['strength', ...SMART_FIELD_KEYS] as const;
export type RelationshipColumn = (typeof RELATIONSHIP_COLUMNS)[number];

const LABELS: Record<RelationshipColumn, string> = { strength: 'Strength', ...SMART_FIELD_LABELS };
const EVENT = 'crm-relationship-columns-change';
const FAILED = "Relationship figures couldn't be loaded just now.";
const session = new Map<string, string>();

const storageKey = (listId: string) => `crm-relationship-columns:${listId}`;

function read(listId: string): string | null {
  if (session.has(listId)) return session.get(listId) ?? null;
  try {
    return window.localStorage.getItem(storageKey(listId));
  } catch {
    return null;
  }
}

function parse(raw: string | null): RelationshipColumn[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return RELATIONSHIP_COLUMNS.filter((c) => value.includes(c));
  } catch {
    return [];
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

export interface RelationshipColumnsState {
  shown: RelationshipColumn[];
  setShown: (next: RelationshipColumn[]) => void;
  rows: Record<string, RecordRelationshipRow>;
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Why the last fetch failed, when it did. */
  error: string | null;
  /** Fetch the rows on screen again after a failure. */
  retry: () => void;
}

export function useRelationshipColumns(
  listId: string,
  recordIds: readonly (string | null)[],
): RelationshipColumnsState {
  const raw = React.useSyncExternalStore(
    subscribe,
    () => read(listId),
    () => null,
  );
  const shown = React.useMemo(() => parse(raw), [raw]);
  const setShown = React.useCallback(
    (next: RelationshipColumn[]) => {
      const value = JSON.stringify(RELATIONSHIP_COLUMNS.filter((c) => next.includes(c)));
      session.set(listId, value);
      try {
        if (value === '[]') window.localStorage.removeItem(storageKey(listId));
        else window.localStorage.setItem(storageKey(listId), value);
      } catch {
        // A blocked store still keeps the choice for this visit.
      }
      window.dispatchEvent(new Event(EVENT));
    },
    [listId],
  );

  const ids = React.useMemo(
    () => [...new Set(recordIds.filter((id): id is string => !!id))].slice(0, 100).join(','),
    [recordIds],
  );
  const [loaded, setLoaded] = React.useState<{
    ids: string;
    rows: Record<string, RecordRelationshipRow>;
    error: string | null;
  } | null>(null);
  const wanted = shown.length > 0 && ids !== '';

  React.useEffect(() => {
    if (!wanted || loaded?.ids === ids) return;
    let live = true;
    fetch(`/api/crm/relationships?ids=${encodeURIComponent(ids)}`, { cache: 'no-store' })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          rows?: Record<string, RecordRelationshipRow>;
          error?: { message?: string };
        } | null;
        if (!live) return;
        if (res.ok && json?.ok && json.rows) {
          setLoaded({ ids, rows: json.rows, error: null });
          return;
        }
        const message =
          res.status === 429
            ? 'Too many requests for relationship figures. Try again in a minute.'
            : (json?.error?.message ?? FAILED);
        setLoaded({ ids, rows: {}, error: message });
      })
      .catch(() => {
        if (live) setLoaded({ ids, rows: {}, error: FAILED });
      });
    return () => {
      live = false;
    };
  }, [wanted, ids, loaded?.ids]);

  // Forgetting the failed answer is what makes the effect above ask again.
  const retry = React.useCallback(() => setLoaded(null), []);
  const current = loaded?.ids === ids ? loaded : null;
  return {
    shown,
    setShown,
    rows: current?.rows ?? {},
    status: !wanted ? 'idle' : !current ? 'loading' : current.error ? 'error' : 'ready',
    error: wanted ? (current?.error ?? null) : null,
    retry,
  };
}

/** The toolbar button that turns the relationship columns on and off, and says when they failed. */
export function RelationshipColumnsPicker({ state }: { state: RelationshipColumnsState }) {
  const { shown, setShown } = state;
  return (
    <>
      {state.status === 'error' ? (
        <span
          role="alert"
          className="text-mini inline-flex max-w-full flex-wrap items-center gap-1.5 text-[var(--warn)]"
          data-testid="relationship-columns-error"
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          {state.error ?? FAILED}
          <Button variant="ghost" size="sm" onClick={state.retry}>
            <RotateCw aria-hidden="true" />
            Retry
          </Button>
        </span>
      ) : null}
      <RelationshipColumnsMenu shown={shown} setShown={setShown} />
    </>
  );
}

function RelationshipColumnsMenu({
  shown,
  setShown,
}: Pick<RelationshipColumnsState, 'shown' | 'setShown'>) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm">
          <HeartHandshake aria-hidden="true" />
          Relationship
          {shown.length ? (
            <span className="tabular text-[var(--fg-subtle)]">{shown.length}</span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Relationship columns">
        <div className="px-1.5 pt-0.5 pb-2">
          <FieldLabel as="p">Relationship columns</FieldLabel>
          <p className="text-mini mt-1 text-[var(--fg-subtle)]">
            From your mail and calendar. Affinity&apos;s value shows, marked, where Kraken has none.
          </p>
        </div>
        <ul className="space-y-0.5">
          {RELATIONSHIP_COLUMNS.map((column) => {
            const id = `relationship-column-${column}`;
            return (
              <li key={column}>
                <label
                  htmlFor={id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-[var(--bg-hover)]"
                >
                  <input
                    id={id}
                    type="checkbox"
                    checked={shown.includes(column)}
                    onChange={(e) =>
                      setShown(
                        e.target.checked ? [...shown, column] : shown.filter((c) => c !== column),
                      )
                    }
                    className="size-3.5 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate">{LABELS[column]}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function RelationshipHeaderCells({ state }: { state: RelationshipColumnsState }) {
  return (
    <>
      {state.shown.map((column) => (
        <TableHeaderCell
          key={column}
          numeric={column !== 'strength'}
          title={
            column === 'first_email'
              ? 'The earlier of the first email in synced mail and Affinity’s, which reaches further back'
              : undefined
          }
        >
          {LABELS[column]}
        </TableHeaderCell>
      ))}
    </>
  );
}

export function RelationshipCells({
  state,
  recordId,
  timezone,
}: {
  state: RelationshipColumnsState;
  recordId: string | null;
  timezone: string;
}) {
  const row = recordId ? state.rows[recordId] : undefined;
  return (
    <>
      {state.shown.map((column) => (
        <TableCell
          key={column}
          numeric={column !== 'strength'}
          className="text-mini whitespace-nowrap"
          data-relationship-column={column}
        >
          {state.status === 'loading' && recordId ? (
            <span className="text-[var(--fg-subtle)]" aria-label="Loading">
              …
            </span>
          ) : state.status === 'error' && recordId ? (
            <span className="text-[var(--warn)]" title={state.error ?? FAILED}>
              Unavailable
            </span>
          ) : !row ? (
            <span className="text-[var(--fg-subtle)]">—</span>
          ) : column === 'strength' ? (
            <StrengthBadge label={row.label} score={row.score} summary={row.summary} />
          ) : (
            <SmartCell field={column} row={row} timezone={timezone} />
          )}
        </TableCell>
      ))}
    </>
  );
}

function SmartCell({
  field,
  row,
  timezone,
}: {
  field: SmartFieldKey;
  row: RecordRelationshipRow;
  timezone: string;
}) {
  const value = row.smart[field];
  if (!value.at) return <span className="text-[var(--fg-subtle)]">—</span>;
  const title =
    value.source === 'affinity'
      ? 'From the Affinity import'
      : value.scannedFrom
        ? `Earliest in synced mail, which reaches back to ${formatSmartValue({ at: value.scannedFrom, source: 'copilot' }, timezone)}`
        : 'From mail and calendar';
  return (
    <span title={title}>
      {formatSmartValue(value, timezone)}
      {value.source === 'affinity' ? (
        <span className="ml-1 text-[var(--label-gold)]">· Affinity</span>
      ) : null}
    </span>
  );
}
