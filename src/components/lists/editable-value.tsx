'use client';

import * as React from 'react';
import { Pencil } from 'lucide-react';
import { CrmValueView } from '@/components/lists/crm-value';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import { sortStatusOptions } from '@/lib/crm/view';
import type { CrmField, CrmValue } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';

/** What the box holds while editing: text for most kinds, the ticked choices for tags. */
function draftOf(field: CrmField, value: CrmValue | undefined): string | string[] {
  if (field.type === 'multi') return Array.isArray(value) ? value : [];
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join('; ');
  if (field.type === 'date' && typeof value === 'string') return value.slice(0, 10);
  return String(value);
}

/**
 * One value of a row, shown as it reads and edited in place: a dropdown for
 * a status, ticks for tags, a date picker for a date, a box for the rest.
 * Saving goes through `onSave`, which checks the value against the column on
 * the server; until the page re-renders with it, the saved value is shown.
 */
export function EditableCrmValue({
  field,
  value,
  timezone,
  entryTitle,
  onSave,
}: {
  field: CrmField;
  value: CrmValue | undefined;
  timezone: string;
  entryTitle: string;
  /** Resolves to the stored value once saved, or undefined when it was not. */
  onSave: (next: string | string[] | null) => Promise<CrmValue | undefined>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<string | string[]>(() => draftOf(field, value));
  const [saving, startSaving] = React.useTransition();
  // The value saved here, shown until the page's own copy catches up.
  const [saved, setSaved] = React.useState<{ from: CrmValue | undefined; to: CrmValue } | null>(
    null,
  );
  const shown = saved && saved.from === value ? saved.to : value;
  const label = `${field.name} for ${entryTitle}`;

  const start = () => {
    setDraft(draftOf(field, shown));
    setEditing(true);
  };

  const save = () =>
    startSaving(async () => {
      const next = Array.isArray(draft) ? draft : draft.trim() === '' ? null : draft;
      const stored = await onSave(next);
      if (stored === undefined) return;
      setSaved({ from: value, to: stored });
      setEditing(false);
    });

  if (!editing) {
    return (
      <span className="flex min-w-0 items-start justify-between gap-2">
        <CrmValueView field={field} value={shown} timezone={timezone} />
        <button
          type="button"
          onClick={start}
          aria-label={`Edit ${label}`}
          className="shrink-0 rounded p-1 text-[var(--fg-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
      </span>
    );
  }

  const options = field.type === 'status' ? sortStatusOptions(field.options ?? []) : [];
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {field.type === 'status' && options.length ? (
        <Select
          aria-label={label}
          value={draft as string}
          onChange={(e) => setDraft(e.target.value)}
          className="h-8 text-sm"
          autoFocus
        >
          <option value="">No {field.name.toLowerCase()}</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      ) : field.type === 'multi' && field.options?.length ? (
        <fieldset aria-label={label} className="max-h-40 scrollbar-thin overflow-y-auto">
          {field.options.map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-[var(--bg-hover)]"
            >
              <input
                type="checkbox"
                checked={(draft as string[]).includes(option)}
                onChange={(e) =>
                  setDraft((d) =>
                    e.target.checked
                      ? [...(d as string[]), option]
                      : (d as string[]).filter((v) => v !== option),
                  )
                }
                className="size-3.5 accent-[var(--accent)]"
              />
              <span className="min-w-0 truncate">{option}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <Input
          aria-label={label}
          type={field.type === 'date' ? 'date' : field.type === 'email' ? 'email' : 'text'}
          inputMode={field.type === 'number' || field.type === 'money' ? 'decimal' : undefined}
          value={draft as string}
          onChange={(e) => setDraft(e.target.value)}
          className={cn(
            'h-8 text-sm',
            (field.type === 'number' || field.type === 'money') && 'tabular',
          )}
          autoFocus
        />
      )}
      <span className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={saving} disabled={saving}>
          Save
        </Button>
      </span>
    </form>
  );
}
