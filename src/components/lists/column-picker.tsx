'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, Columns3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { FieldLabel } from '@/components/ui/card';
import {
  parseHiddenColumns,
  readHiddenColumnsRaw,
  serializeHiddenColumns,
  writeHiddenColumns,
} from '@/lib/crm/view';
import type { CrmField } from '@/lib/types/domain';

const COLUMNS_EVENT = 'crm-columns-change';

/**
 * This visit's choices, by list. Read ahead of localStorage so a choice holds
 * for the session even where storage is blocked and the write was refused.
 */
const sessionColumns = new Map<string, string>();

function storage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(COLUMNS_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(COLUMNS_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/**
 * The columns hidden on a list, remembered per list in this browser. A
 * preference rather than shared state, so it lives in localStorage (every
 * access guarded) and not in the URL. Until this browser has chosen, the
 * list's `defaults` are hidden (defaultHiddenColumns) — the server render
 * hides the same ones — and a stored choice applies on hydration.
 */
export function useHiddenColumns(
  listId: string,
  fields: readonly Pick<CrmField, 'key'>[],
  defaults: readonly string[] = [],
): [ReadonlySet<string>, (next: ReadonlySet<string>) => void] {
  const raw = React.useSyncExternalStore(
    subscribe,
    () =>
      sessionColumns.has(listId)
        ? (sessionColumns.get(listId) ?? null)
        : readHiddenColumnsRaw(storage, listId),
    () => null,
  );
  const hidden = React.useMemo(
    () => parseHiddenColumns(raw, fields, defaults),
    [raw, fields, defaults],
  );
  const setHidden = React.useCallback(
    (next: ReadonlySet<string>) => {
      sessionColumns.set(listId, serializeHiddenColumns(next));
      writeHiddenColumns(storage, listId, next);
      window.dispatchEvent(new Event(COLUMNS_EVENT));
    },
    [listId],
  );
  return [hidden, setHidden];
}

/** A column the picker offers: a field of the list, or a computed one. */
export interface PickerColumn {
  key: string;
  name: string;
  /** What the column holds, shown small beside its name. */
  type: string;
}

/**
 * Show, hide and order a list's columns. The name column always stays first.
 * Shown columns come first, in their order, each with a move up and a move
 * down; hidden ones follow in list order. What a change does — remember it
 * in this browser, or change the view — is the page's call (`onChange`).
 */
export function ColumnPicker({
  columns,
  visible,
  onChange,
}: {
  /** Every column there is, in list order. */
  columns: readonly PickerColumn[];
  /** The keys shown, in order. */
  visible: readonly string[];
  /** `how`: a checkbox, "Show all", or a move — a page may treat a move differently. */
  onChange: (next: string[], how: 'toggle' | 'all' | 'move') => void;
}) {
  const shown = visible.filter((k) => columns.some((c) => c.key === k));
  const hidden = columns.filter((c) => !shown.includes(c.key));
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const ordered = [...shown.map((k) => byKey.get(k) as PickerColumn), ...hidden];

  const move = (key: string, delta: -1 | 1) => {
    const next = [...shown];
    const i = next.indexOf(key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j] as string, next[i] as string];
    onChange(next, 'move');
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm" disabled={columns.length === 0}>
          <Columns3 aria-hidden="true" />
          Columns
          <span className="tabular text-[var(--fg-subtle)]">
            {shown.length}/{columns.length}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Columns">
        <div className="flex items-center justify-between gap-2 px-1.5 pt-0.5 pb-2">
          <FieldLabel as="p">Columns</FieldLabel>
          <button
            type="button"
            onClick={() => onChange([...shown, ...hidden.map((c) => c.key)], 'all')}
            disabled={hidden.length === 0}
            className="text-mini text-[var(--accent)] underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50"
          >
            Show all
          </button>
        </div>
        <ul className="max-h-[60dvh] scrollbar-thin space-y-0.5 overflow-y-auto">
          {ordered.map((column) => {
            const id = `column-${column.key}`;
            const index = shown.indexOf(column.key);
            const isShown = index >= 0;
            return (
              <li key={column.key} className="flex items-center gap-1">
                <label
                  htmlFor={id}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-[var(--bg-hover)]"
                >
                  <input
                    id={id}
                    type="checkbox"
                    checked={isShown}
                    onChange={(e) =>
                      onChange(
                        e.target.checked
                          ? [...shown, column.key]
                          : shown.filter((k) => k !== column.key),
                        'toggle',
                      )
                    }
                    className="size-3.5 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate">{column.name}</span>
                  <span className="text-micro text-[var(--fg-subtle)] uppercase">
                    {column.type}
                  </span>
                </label>
                {isShown ? (
                  <span className="flex shrink-0">
                    <button
                      type="button"
                      onClick={() => move(column.key, -1)}
                      disabled={index === 0}
                      aria-label={`Move ${column.name} up`}
                      className="rounded p-1 text-[var(--fg-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] disabled:pointer-events-none disabled:opacity-30"
                    >
                      <ArrowUp className="size-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(column.key, 1)}
                      disabled={index === shown.length - 1}
                      aria-label={`Move ${column.name} down`}
                      className="rounded p-1 text-[var(--fg-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] disabled:pointer-events-none disabled:opacity-30"
                    >
                      <ArrowDown className="size-3.5" aria-hidden="true" />
                    </button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
