'use client';

import * as React from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import {
  buildGmailQuery,
  parseGmailQuery,
  WITHIN_OPTIONS,
  type AdvancedSearch,
} from '@/lib/email/inbox-folders';

const FIELD =
  'h-8 min-w-0 flex-1 border-b border-[var(--border-control)] bg-transparent px-1 text-sm text-[var(--fg)] placeholder:text-[var(--fg-subtle)] focus-visible:border-[var(--accent)] focus-visible:outline-none';

/**
 * Gmail's search bar: type Gmail search syntax and press Enter, or open the
 * options (the sliders) for From, To, Subject, Has the words, Doesn't have,
 * Date within and Has attachment, which write the same syntax into the box.
 */
export function InboxSearch({
  value,
  onChange,
  onSearch,
  onClear,
  searched,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSearch: (query: string) => void;
  onClear: () => void;
  /** A search is showing (the clear button). */
  searched: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<AdvancedSearch>(() => parseGmailQuery(''));
  const id = React.useId();

  const openOptions = () => {
    setForm(parseGmailQuery(value));
    setOpen(true);
  };
  const set = <K extends keyof AdvancedSearch>(key: K, v: AdvancedSearch[K]) =>
    setForm((f) => ({ ...f, [key]: v }));
  const submitForm = (e: React.FormEvent) => {
    e.preventDefault();
    const q = buildGmailQuery(form);
    onChange(q);
    setOpen(false);
    if (q) onSearch(q);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            onSearch(value.trim());
          }}
          data-tour="inbox-search"
          className="focus-within:shadow-raised flex h-12 min-w-0 flex-1 items-center gap-1 rounded-full bg-[var(--bg-sunken)] pr-1.5 pl-3 focus-within:bg-[var(--bg-raised)]"
        >
          <button
            type="submit"
            aria-label="Search"
            className="rounded-full p-2 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]"
          >
            <Search className="size-5" aria-hidden />
          </button>
          <label htmlFor="inbox-search" className="sr-only">
            Search email
          </label>
          <input
            id="inbox-search"
            type="search"
            ref={inputRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Search mail"
            autoComplete="off"
            className="h-full min-w-0 flex-1 bg-transparent text-base text-[var(--fg)] placeholder:text-[var(--fg-muted)] focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {searched || value ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={onClear}
              className="rounded-full p-2 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]"
            >
              <X className="size-5" aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Show search options"
            aria-expanded={open}
            onClick={() => (open ? setOpen(false) : openOptions())}
            className="rounded-full p-2 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]"
          >
            <SlidersHorizontal className="size-5" aria-hidden />
          </button>
        </form>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        aria-label="Search options"
        className="w-[min(36rem,calc(100vw-2rem))] p-4"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          document.getElementById(`${id}-from`)?.focus();
        }}
      >
        <form onSubmit={submitForm} className="space-y-2">
          {(
            [
              ['from', 'From'],
              ['to', 'To'],
              ['subject', 'Subject'],
              ['hasWords', 'Has the words'],
              ['doesntHave', "Doesn't have"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="flex items-center gap-3">
              <label
                htmlFor={`${id}-${key}`}
                className="w-28 shrink-0 text-sm text-[var(--fg-muted)]"
              >
                {label}
              </label>
              <input
                id={`${id}-${key}`}
                value={form[key]}
                onChange={(e) => set(key, e.target.value)}
                className={FIELD}
              />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <label
              htmlFor={`${id}-within`}
              className="w-28 shrink-0 text-sm text-[var(--fg-muted)]"
            >
              Date within
            </label>
            <select
              id={`${id}-within`}
              value={form.within}
              onChange={(e) => set('within', e.target.value as AdvancedSearch['within'])}
              className="h-8 rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] px-2 text-sm"
            >
              <option value="">Any time</option>
              {WITHIN_OPTIONS.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
            <label htmlFor={`${id}-date`} className="sr-only">
              Of date
            </label>
            <span className="text-sm text-[var(--fg-muted)]">of</span>
            <input
              id={`${id}-date`}
              type="date"
              value={form.date}
              onChange={(e) => set('date', e.target.value)}
              className="h-8 rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] px-2 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 pt-1 text-sm">
            <input
              type="checkbox"
              checked={form.hasAttachment}
              onChange={(e) => set('hasAttachment', e.target.checked)}
            />
            Has attachment
          </label>
          <p className="truncate font-mono text-xs text-[var(--fg-subtle)]" aria-live="polite">
            {buildGmailQuery(form) || 'Fill in a field to search.'}
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setForm(parseGmailQuery(''))}
            >
              Clear filter
            </Button>
            <Button type="submit" size="sm" variant="primary">
              Search
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
