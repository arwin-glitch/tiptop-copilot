'use client';

import * as React from 'react';
import { Columns3 } from 'lucide-react';
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
 * access guarded) and not in the URL; the server render shows every column
 * and the stored choice applies on hydration.
 */
export function useHiddenColumns(
  listId: string,
  fields: readonly CrmField[],
): [ReadonlySet<string>, (next: ReadonlySet<string>) => void] {
  const raw = React.useSyncExternalStore(
    subscribe,
    () =>
      sessionColumns.has(listId)
        ? (sessionColumns.get(listId) ?? null)
        : readHiddenColumnsRaw(storage, listId),
    () => null,
  );
  const hidden = React.useMemo(() => parseHiddenColumns(raw, fields), [raw, fields]);
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

/** Show or hide a list's field columns. The name column always stays. */
export function ColumnPicker({
  fields,
  hidden,
  onChange,
}: {
  fields: readonly CrmField[];
  hidden: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}) {
  const shown = fields.length - hidden.size;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm" disabled={fields.length === 0}>
          <Columns3 aria-hidden="true" />
          Columns
          <span className="tabular text-[var(--fg-subtle)]">
            {shown}/{fields.length}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Columns">
        <div className="flex items-center justify-between gap-2 px-1.5 pt-0.5 pb-2">
          <FieldLabel as="p">Columns</FieldLabel>
          <button
            type="button"
            onClick={() => onChange(new Set())}
            disabled={hidden.size === 0}
            className="text-mini text-[var(--accent)] underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50"
          >
            Show all
          </button>
        </div>
        <ul className="space-y-0.5">
          {fields.map((field) => {
            const id = `column-${field.key}`;
            return (
              <li key={field.key}>
                <label
                  htmlFor={id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-[var(--bg-hover)]"
                >
                  <input
                    id={id}
                    type="checkbox"
                    checked={!hidden.has(field.key)}
                    onChange={(e) => {
                      const next = new Set(hidden);
                      if (e.target.checked) next.delete(field.key);
                      else next.add(field.key);
                      onChange(next);
                    }}
                    className="size-3.5 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate">{field.name}</span>
                  <span className="text-micro text-[var(--fg-subtle)] uppercase">{field.type}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
