'use client';

import * as React from 'react';
import { Clock, Filter, Mail, Search, SlidersHorizontal, User, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useStoredChoice } from '@/components/inbox/use-stored';
import {
  buildGmailQuery,
  parseGmailQuery,
  smartDate,
  WITHIN_OPTIONS,
  type AdvancedSearch,
} from '@/lib/email/inbox-folders';
import {
  addOperator,
  hasOperator,
  HISTORY_KEY,
  parseHistory,
  personQuery,
  pushHistory,
  QUICK_CHIPS,
  removeHistory,
} from '@/lib/email/search-suggest';
import type { LiveThreadRow } from '@/lib/services/inbox-live';
import type { SuggestedPerson } from '@/lib/services/inbox-suggest';
import { cn } from '@/lib/util/cn';

const FIELD =
  'h-8 min-w-0 flex-1 border-b border-[var(--border-control)] bg-transparent px-1 text-sm text-[var(--fg)] placeholder:text-[var(--fg-subtle)] focus-visible:border-[var(--accent)] focus-visible:outline-none';

/** Wait this long after the last keystroke before asking for suggestions. */
const DEBOUNCE_MS = 200;

type Item =
  | { kind: 'history'; q: string }
  | { kind: 'person'; person: SuggestedPerson }
  | { kind: 'thread'; row: LiveThreadRow };

interface Suggestions {
  people: SuggestedPerson[];
  threads: LiveThreadRow[];
}

const asString = (v: string | null) => v ?? '';

/**
 * Gmail's search bar. Focus it for the quick chips (Has attachment, Last 7
 * days, From me, Unread) and recent searches; type for matching people and
 * conversations; press Enter for the full search. The sliders open the
 * search options (From, To, Subject...), which write the same syntax into
 * the box and offer Gmail's Create filter.
 */
export function InboxSearch({
  value,
  onChange,
  onSearch,
  onClear,
  searched,
  inputRef,
  onOpenThread,
  onCreateFilter,
  timeZone,
}: {
  value: string;
  onChange: (value: string) => void;
  onSearch: (query: string) => void;
  onClear: () => void;
  /** A search is showing (the clear button). */
  searched: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** A suggested conversation was picked: open it. */
  onOpenThread: (row: LiveThreadRow) => void;
  /** Create filter, from the search options, with what they hold. */
  onCreateFilter: (form: AdvancedSearch) => void;
  timeZone: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<AdvancedSearch>(() => parseGmailQuery(''));
  const id = React.useId();
  const listId = `${id}-suggest`;

  // The dropdown under the box: chips, history and type-ahead.
  const [drop, setDrop] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const [rawHistory, setRawHistory] = useStoredChoice<string>(HISTORY_KEY, asString, '');
  const history = React.useMemo(() => parseHistory(rawHistory), [rawHistory]);
  const saveHistory = (next: string[]) => setRawHistory(JSON.stringify(next));
  const [found, setFound] = React.useState<{ q: string; s: Suggestions } | null>(null);
  const answers = React.useRef(new Map<string, Suggestions>());
  const wrapRef = React.useRef<HTMLDivElement>(null);

  const typed = value.trim();

  // Type-ahead: debounced, each new keystroke aborting the request before it.
  React.useEffect(() => {
    if (!drop || !typed) return;
    const cached = answers.current.get(typed.toLowerCase());
    if (cached) {
      setFound({ q: typed, s: cached });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/inbox/suggest?q=${encodeURIComponent(typed)}`, {
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: ({ ok: boolean } & Suggestions) | null) => {
          if (!j?.ok) return;
          const s = { people: j.people ?? [], threads: j.threads ?? [] };
          if (answers.current.size > 100) answers.current.clear();
          answers.current.set(typed.toLowerCase(), s);
          setFound({ q: typed, s });
        })
        .catch(() => undefined);
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [drop, typed]);

  const suggestions = typed && found && found.q === typed ? found.s : null;
  const matchingHistory = typed
    ? history
        .filter((h) => h.toLowerCase().includes(typed.toLowerCase()) && h !== typed)
        .slice(0, 3)
    : history;
  const items: Item[] = [
    ...matchingHistory.map((q) => ({ kind: 'history' as const, q })),
    ...(suggestions?.people ?? []).map((person) => ({ kind: 'person' as const, person })),
    ...(suggestions?.threads ?? []).map((row) => ({ kind: 'thread' as const, row })),
  ];
  const activeItem = active >= 0 && active < items.length ? items[active] : null;

  const run = (q: string) => {
    const clean = q.trim();
    setDrop(false);
    setActive(-1);
    if (clean) saveHistory(pushHistory(history, clean));
    onSearch(clean);
  };

  const choose = (item: Item) => {
    if (item.kind === 'history') {
      onChange(item.q);
      run(item.q);
    } else if (item.kind === 'person') {
      const q = personQuery(item.person.email);
      onChange(q);
      run(q);
    } else {
      setDrop(false);
      setActive(-1);
      onOpenThread(item.row);
    }
  };

  const chip = (operator: string) => {
    const q = addOperator(value, operator);
    onChange(q);
    run(q);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setDrop(true);
      if (!items.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((cur) => {
        const next = cur + step;
        if (next < -1) return items.length - 1;
        if (next >= items.length) return -1;
        return next;
      });
    } else if (e.key === 'Enter' && activeItem) {
      e.preventDefault();
      choose(activeItem);
    } else if (e.key === 'Escape') {
      if (drop) {
        e.preventDefault();
        e.stopPropagation();
        setDrop(false);
        setActive(-1);
      } else {
        inputRef.current?.blur();
      }
    }
  };

  const openOptions = () => {
    setDrop(false);
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
    if (q) run(q);
  };

  const optionId = (i: number) => `${id}-opt-${i}`;
  const showDrop = drop && !open;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          ref={wrapRef}
          className="relative min-w-0 flex-1"
          onBlur={(e) => {
            if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) {
              setDrop(false);
              setActive(-1);
            }
          }}
        >
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              run(value);
            }}
            data-tour="inbox-search"
            className={cn(
              'focus-within:shadow-raised flex h-12 min-w-0 flex-1 items-center gap-1 bg-[var(--bg-sunken)] pr-1.5 pl-3 focus-within:bg-[var(--bg-raised)]',
              showDrop ? 'rounded-t-3xl' : 'rounded-full',
            )}
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
              onChange={(e) => {
                onChange(e.target.value);
                setDrop(true);
                setActive(-1);
              }}
              onFocus={() => {
                if (!open) setDrop(true);
              }}
              onClick={() => {
                if (!open) setDrop(true);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search mail"
              autoComplete="off"
              aria-controls={showDrop ? listId : undefined}
              aria-activedescendant={showDrop && activeItem ? optionId(active) : undefined}
              aria-describedby={showDrop ? `${id}-hint` : undefined}
              className="h-full min-w-0 flex-1 bg-transparent text-base text-[var(--fg)] placeholder:text-[var(--fg-muted)] focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
            />
            {searched || value ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setActive(-1);
                  onClear();
                }}
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

          {showDrop ? (
            <div
              data-search-dropdown
              className="shadow-overlay absolute inset-x-0 top-full z-[var(--z-overlay)] rounded-b-3xl border-t border-[var(--border)] bg-[var(--bg-raised)] pb-2"
            >
              <p id={`${id}-hint`} className="sr-only">
                Use the up and down arrows to pick a suggestion, Enter to search, Escape to close.
              </p>
              <div
                role="group"
                aria-label="Quick filters"
                className="flex flex-wrap gap-2 px-4 pt-3 pb-2"
              >
                {QUICK_CHIPS.map((c) => {
                  const on = hasOperator(value, c.operator);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={on}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => chip(c.operator)}
                      className={cn(
                        'inline-flex h-8 items-center rounded-full border px-3 text-sm transition-colors',
                        on
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--fg)]'
                          : 'border-[var(--border-control)] text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]',
                      )}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>

              <ul
                id={listId}
                role="listbox"
                aria-label={typed ? 'Search suggestions' : 'Recent searches'}
                className="max-h-[min(24rem,60vh)] overflow-y-auto"
              >
                {items.map((item, i) => {
                  const isActive = i === active;
                  const rowClass = cn(
                    'flex cursor-pointer items-center gap-3 px-4 py-2 text-sm',
                    isActive ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]',
                  );
                  const header =
                    item.kind === 'person' && items[i - 1]?.kind !== 'person'
                      ? 'People'
                      : item.kind === 'thread' && items[i - 1]?.kind !== 'thread'
                        ? 'Conversations'
                        : null;
                  return (
                    <React.Fragment key={`${item.kind}-${i}`}>
                      {header ? (
                        <li
                          role="presentation"
                          className="px-4 pt-2 pb-1 text-[11px] font-medium tracking-wide text-[var(--fg-subtle)] uppercase"
                        >
                          {header}
                        </li>
                      ) : null}
                      <li
                        id={optionId(i)}
                        role="option"
                        aria-selected={isActive}
                        className={rowClass}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => choose(item)}
                      >
                        {item.kind === 'history' ? (
                          <>
                            <Clock
                              className="size-4 shrink-0 text-[var(--fg-subtle)]"
                              aria-hidden
                            />
                            <span className="min-w-0 flex-1 truncate">{item.q}</span>
                            <button
                              type="button"
                              aria-label={`Remove "${item.q}" from recent searches`}
                              title="Remove"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={(e) => {
                                e.stopPropagation();
                                setActive(-1);
                                saveHistory(removeHistory(history, item.q));
                              }}
                              className="rounded-full p-1 text-[var(--fg-subtle)] hover:bg-[var(--bg-sunken)] hover:text-[var(--fg)]"
                            >
                              <X className="size-3.5" aria-hidden />
                            </button>
                          </>
                        ) : item.kind === 'person' ? (
                          <>
                            <User className="size-4 shrink-0 text-[var(--fg-subtle)]" aria-hidden />
                            <span className="min-w-0 flex-1 truncate">
                              <span className="font-medium">{item.person.name}</span>{' '}
                              <span className="text-[var(--fg-muted)]">{item.person.email}</span>
                            </span>
                          </>
                        ) : (
                          <>
                            <Mail className="size-4 shrink-0 text-[var(--fg-subtle)]" aria-hidden />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{item.row.subject}</span>
                              <span className="block truncate text-xs text-[var(--fg-muted)]">
                                {item.row.who}
                              </span>
                            </span>
                            <span className="shrink-0 text-xs text-[var(--fg-subtle)] tabular-nums">
                              {smartDate(item.row.at, timeZone)}
                            </span>
                          </>
                        )}
                      </li>
                    </React.Fragment>
                  );
                })}
              </ul>

              {!typed && history.length ? (
                <div className="flex justify-end px-4 pt-1">
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setActive(-1);
                      saveHistory([]);
                    }}
                    className="text-xs text-[var(--fg-muted)] underline-offset-2 hover:text-[var(--fg)] hover:underline"
                  >
                    Clear recent searches
                  </button>
                </div>
              ) : null}
              {typed ? (
                <p className="px-4 pt-2 text-xs text-[var(--fg-subtle)]">
                  Press Enter to search all mail for{' '}
                  <span className="font-mono text-[var(--fg-muted)]">{typed}</span>
                </p>
              ) : !history.length ? (
                <p className="px-4 pt-1 text-xs text-[var(--fg-subtle)]">
                  Recent searches show here.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
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
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mr-auto"
              onClick={() => {
                setOpen(false);
                onCreateFilter(form);
              }}
            >
              <Filter aria-hidden /> Create filter
            </Button>
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
