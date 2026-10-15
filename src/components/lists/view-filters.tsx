'use client';

import * as React from 'react';
import { Filter as FilterIcon, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FieldLabel } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/form';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { displayCrmValue } from '@/lib/crm/fields';
import {
  conditionNeedsValue,
  conditionOpLabel,
  conditionOps,
  normalizeConditions,
  type CrmConditionOp,
  type CrmViewCondition,
} from '@/lib/crm/saved-views';
import { formatCrmValue, sortStatusOptions } from '@/lib/crm/view';
import type { CrmField } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';

/** A condition being edited: its value as typed, checked only on Apply. */
interface Draft {
  id: number;
  key: string;
  op: CrmConditionOp;
  value: string;
  values: string[];
}

function toDraft(c: CrmViewCondition, id: number): Draft {
  return {
    id,
    key: c.key,
    op: c.op,
    value: c.value === undefined ? '' : String(c.value),
    values: c.values ? [...c.values] : [],
  };
}

function fromDraft(d: Draft): CrmViewCondition {
  if (d.op === 'in') return { key: d.key, op: d.op, values: d.values };
  if (!conditionNeedsValue(d.op)) return { key: d.key, op: d.op };
  return { key: d.key, op: d.op, value: d.value };
}

/** "Amount is at least $1,000,000", the way a chip and a screen reader say a condition. */
export function describeCondition(
  c: CrmViewCondition,
  fields: readonly CrmField[],
  timezone = 'UTC',
): string {
  const field = fields.find((f) => f.key === c.key);
  if (!field) return '';
  const op = conditionOpLabel(c.op, field.type);
  if (!conditionNeedsValue(c.op)) return `${field.name} ${op}`;
  if (c.op === 'in') return `${field.name} ${op} ${(c.values ?? []).join(', ')}`;
  const value =
    field.type === 'date'
      ? formatCrmValue(field, String(c.value ?? ''), timezone)
      : typeof c.value === 'number'
        ? displayCrmValue(field, c.value)
        : String(c.value ?? '');
  return `${field.name} ${op} ${value}`;
}

/**
 * "Filter": the view's conditions, edited in a popover and applied together —
 * each one a field, a condition the field's type takes and a value, all of
 * which must hold. Applying goes through the URL, so the server filters the
 * whole list, not the page on screen.
 */
export function FilterMenu({
  fields,
  conditions,
  onApply,
}: {
  fields: readonly CrmField[];
  conditions: readonly CrmViewCondition[];
  onApply: (next: CrmViewCondition[]) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [drafts, setDrafts] = React.useState<Draft[]>([]);
  const nextId = React.useRef(1);
  const uid = React.useId();

  const reset = () => {
    setDrafts(conditions.map((c) => toDraft(c, nextId.current++)));
    setProblem('');
  };

  const update = (id: number, patch: Partial<Draft>) => {
    setProblem('');
    setDrafts((current) => current.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };

  const add = () => {
    const field = fields[0];
    if (!field) return;
    setDrafts((current) => [
      ...current,
      {
        id: nextId.current++,
        key: field.key,
        op: conditionOps(field.type)[0] as CrmConditionOp,
        value: '',
        values: [],
      },
    ]);
  };

  const [problem, setProblem] = React.useState('');

  const apply = () => {
    const next = normalizeConditions(drafts.map(fromDraft), fields);
    // A filter that cannot apply (no value, or words in a number) is said,
    // not silently dropped.
    const usable = drafts.filter((d) => normalizeConditions([fromDraft(d)], fields).length).length;
    if (usable < drafts.length) {
      setProblem('Give every filter a value it can use, or remove it.');
      return;
    }
    onApply(next);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) reset();
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm" disabled={fields.length === 0}>
          <FilterIcon aria-hidden="true" />
          Filter
          {conditions.length ? (
            <span className="tabular text-[var(--fg-subtle)]">{conditions.length}</span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Filters" className="w-[min(36rem,calc(100vw-2rem))]">
        <div className="flex items-center justify-between gap-2 px-1.5 pt-0.5 pb-2">
          <FieldLabel as="p">Filters · all must match</FieldLabel>
          <button
            type="button"
            onClick={() => setDrafts([])}
            disabled={drafts.length === 0}
            className="text-mini text-[var(--accent)] underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50"
          >
            Clear all
          </button>
        </div>
        {drafts.length === 0 ? (
          <p className="px-1.5 pb-2 text-sm text-[var(--fg-subtle)]">
            No filters. Add one to narrow the list by any field.
          </p>
        ) : (
          <ul className="space-y-2 px-1.5" aria-label="Filter conditions">
            {drafts.map((draft, index) => {
              const field = fields.find((f) => f.key === draft.key) ?? fields[0];
              if (!field) return null;
              const ops = conditionOps(field.type);
              const prefix = `${uid}-${draft.id}`;
              return (
                <li
                  key={draft.id}
                  className="flex flex-wrap items-start gap-2 rounded-md border border-[var(--border)] p-2"
                >
                  <Select
                    aria-label={`Filter ${index + 1} field`}
                    value={field.key}
                    onChange={(e) => {
                      const next = fields.find((f) => f.key === e.target.value);
                      if (!next) return;
                      update(draft.id, {
                        key: next.key,
                        op: conditionOps(next.type)[0] as CrmConditionOp,
                        value: '',
                        values: [],
                      });
                    }}
                    className="h-8 w-40 text-sm"
                  >
                    {fields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                  <Select
                    aria-label={`Filter ${index + 1} condition`}
                    value={draft.op}
                    onChange={(e) => update(draft.id, { op: e.target.value as CrmConditionOp })}
                    className="h-8 w-36 text-sm"
                  >
                    {ops.map((op) => (
                      <option key={op} value={op}>
                        {conditionOpLabel(op, field.type)}
                      </option>
                    ))}
                  </Select>
                  <div className="min-w-32 flex-1">
                    <ConditionValue
                      id={prefix}
                      index={index}
                      field={field}
                      draft={draft}
                      onChange={(patch) => update(draft.id, patch)}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setDrafts((current) => current.filter((d) => d.id !== draft.id))}
                    aria-label={`Remove filter ${index + 1}`}
                    className="rounded p-1.5 text-[var(--fg-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {problem ? (
          <p role="alert" className="mt-2 px-1.5 text-xs text-[var(--danger)]">
            {problem}
          </p>
        ) : null}
        <div className="mt-3 flex items-center justify-between gap-2 px-1.5 pb-1">
          <Button type="button" variant="ghost" size="sm" onClick={add}>
            <Plus aria-hidden="true" />
            Add filter
          </Button>
          <Button type="button" variant="primary" size="sm" onClick={apply}>
            Apply filters
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ConditionValue({
  id,
  index,
  field,
  draft,
  onChange,
}: {
  id: string;
  index: number;
  field: CrmField;
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const label = `Filter ${index + 1} value`;
  if (!conditionNeedsValue(draft.op)) return null;
  if (draft.op === 'in') {
    const options = sortStatusOptions(field.options ?? []);
    if (!options.length) {
      return (
        <Input
          aria-label={label}
          value={draft.values.join('; ')}
          onChange={(e) =>
            onChange({
              values: e.target.value
                .split(';')
                .map((v) => v.trim())
                .filter(Boolean),
            })
          }
          placeholder="Labels, separated by ;"
          className="h-8 text-sm"
        />
      );
    }
    return (
      <fieldset aria-label={label} className="max-h-40 scrollbar-thin overflow-y-auto">
        {options.map((option, i) => {
          const checkId = `${id}-opt-${i}`;
          return (
            <label
              key={option}
              htmlFor={checkId}
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-[var(--bg-hover)]"
            >
              <input
                id={checkId}
                type="checkbox"
                checked={draft.values.includes(option)}
                onChange={(e) =>
                  onChange({
                    values: e.target.checked
                      ? [...draft.values, option]
                      : draft.values.filter((v) => v !== option),
                  })
                }
                className="size-3.5 accent-[var(--accent)]"
              />
              <span className="min-w-0 truncate">{option}</span>
            </label>
          );
        })}
      </fieldset>
    );
  }
  if (field.type === 'date') {
    return (
      <Input
        aria-label={label}
        type="date"
        value={draft.value}
        onChange={(e) => onChange({ value: e.target.value })}
        className="h-8 text-sm"
      />
    );
  }
  const numeric = field.type === 'number' || field.type === 'money';
  return (
    <Input
      aria-label={label}
      inputMode={numeric ? 'decimal' : undefined}
      value={draft.value}
      onChange={(e) => onChange({ value: e.target.value })}
      onKeyDown={(e) => {
        // Enter applies from the popover's Apply button; keep it from
        // submitting anything around the toolbar.
        if (e.key === 'Enter') e.preventDefault();
      }}
      placeholder={
        field.type === 'money'
          ? 'e.g. 1,000,000 or $1M'
          : numeric
            ? 'A number'
            : field.type === 'multi' && field.options?.length
              ? field.options.slice(0, 2).join(', ')
              : 'Text'
      }
      className={cn('h-8 text-sm', numeric && 'tabular')}
    />
  );
}

/**
 * The view's conditions as chips under the toolbar, each removable on its
 * own, so what narrows the list is always on screen.
 */
export function ConditionChips({
  fields,
  conditions,
  timezone,
  onRemove,
}: {
  fields: readonly CrmField[];
  conditions: readonly CrmViewCondition[];
  timezone: string;
  onRemove: (index: number) => void;
}) {
  if (!conditions.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Active filters">
      {conditions.map((c, i) => {
        const text = describeCondition(c, fields, timezone);
        if (!text) return null;
        return (
          <li
            key={`${c.key}:${c.op}:${i}`}
            className="text-note inline-flex items-center gap-1 rounded-full border border-[var(--accent)] bg-[var(--accent-soft)] py-0.5 pr-1 pl-3"
          >
            <span>{text}</span>
            <button
              type="button"
              onClick={() => onRemove(i)}
              aria-label={`Remove filter: ${text}`}
              className="rounded-full p-0.5 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
