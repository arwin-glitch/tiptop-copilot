'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/form';
import { cn } from '@/lib/util/cn';

/**
 * A search box that filters as you type.
 *
 * Every search in this app used to require pressing Enter, which reads as
 * broken to anyone used to a search field: you type, nothing happens, and the
 * page you are looking at still shows everything. This narrows the list while
 * you type and restores the full list the moment the box is empty.
 *
 * The filtering itself stays on the server. These pages are `force-dynamic`
 * and query the database directly, so a client-side filter could only ever
 * search the rows that happen to be loaded — which on `/meetings` is a page of
 * a much larger table. Searching a subset and calling it "search" is the kind
 * of quietly-wrong behaviour that is worse than no search at all.
 *
 * What that costs is a round trip per query, so:
 *
 * - Keystrokes are debounced. `DEBOUNCE_MS` is long enough to skip the middle
 *   of a typed word and short enough to feel immediate.
 * - Navigation uses `replace`, not `push`. Pushing would put every prefix of
 *   every query into history and make Back walk backwards through the typing.
 * - `scroll: false` keeps the viewport still; re-anchoring to the top on each
 *   keystroke is disorienting when the results are below the box.
 * - The request runs in a transition, so React keeps the current results on
 *   screen while the next ones load rather than blanking the list.
 */
const DEBOUNCE_MS = 250;

export interface LiveSearchProps {
  /** Path to navigate within, e.g. `/meetings`. */
  path: string;
  /** The query currently reflected in the URL, from the server component. */
  value: string;
  placeholder: string;
  /** Accessible name. The visible label is the placeholder and the icon. */
  label: string;
  /** Query-string key. Defaults to `q`. */
  param?: string;
  className?: string;
}

export function LiveSearch({
  path,
  value,
  placeholder,
  label,
  param = 'q',
  className,
}: LiveSearchProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [draft, setDraft] = React.useState(value);
  const [isPending, startTransition] = React.useTransition();

  // The URL is the source of truth. If it changes for any other reason — the
  // Back button, a link, a filter chip elsewhere on the page — the box follows
  // it rather than holding a stale query the results no longer reflect.
  //
  // Adjusted during render rather than in an effect. React re-runs this
  // component immediately with the new state and renders nothing in between,
  // whereas an effect would paint the stale query first and then correct it —
  // a visible flicker of the previous search on every Back.
  const [urlValue, setUrlValue] = React.useState(value);
  if (value !== urlValue) {
    setUrlValue(value);
    setDraft(value);
  }

  const commit = React.useCallback(
    (next: string) => {
      const search = new URLSearchParams(params.toString());
      const trimmed = next.trim();
      if (trimmed) search.set(param, trimmed);
      else search.delete(param);
      const qs = search.toString();
      startTransition(() => router.replace(qs ? `${path}?${qs}` : path, { scroll: false }));
    },
    [params, param, path, router],
  );

  React.useEffect(() => {
    // Already showing what the URL says: nothing to do. This is what makes the
    // effect idempotent when the server round-trip comes back and updates
    // `value` — without it, each response would schedule another navigation.
    if (draft.trim() === value) return;
    const timer = setTimeout(() => commit(draft), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, value, commit]);

  const clear = React.useCallback(() => {
    setDraft('');
    commit('');
  }, [commit]);

  return (
    <form
      className={cn('relative', className)}
      role="search"
      onSubmit={(e) => {
        // Enter still works, and skips the remaining debounce. It also keeps
        // the control meaningful if hydration has not happened yet.
        e.preventDefault();
        commit(draft);
      }}
    >
      <Search
        className={cn(
          'pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--fg-subtle)]',
          isPending && 'animate-pulse',
        )}
        aria-hidden="true"
      />
      <Input
        type="search"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && draft) {
            e.preventDefault();
            clear();
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        aria-busy={isPending}
        className={cn('pl-8', draft && 'pr-8')}
      />
      {draft ? (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear search"
          className="absolute top-1/2 right-2 grid size-5 -translate-y-1/2 place-items-center rounded-[var(--radius-sm)] text-[var(--fg-subtle)] hover:text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </form>
  );
}
