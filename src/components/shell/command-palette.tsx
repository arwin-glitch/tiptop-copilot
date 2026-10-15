'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { cn } from '@/lib/util/cn';

interface Result {
  kind:
    | 'deal'
    | 'portfolio'
    | 'lp'
    | 'person'
    | 'meeting'
    | 'task'
    | 'document'
    | 'crm_list'
    | 'crm_company'
    | 'crm_person';
  label: string;
  sub: string | null;
  href: string;
}

const KIND_LABEL: Record<Result['kind'], string> = {
  deal: 'Deal',
  portfolio: 'Portfolio',
  lp: 'Fund II',
  person: 'Person',
  meeting: 'Meeting',
  task: 'Task',
  document: 'Document',
  crm_list: 'List',
  crm_company: 'Company',
  crm_person: 'Person',
};

/** The CRM's results, shown as a group of their own under a "Lists" heading. */
function inListsGroup(result: Result): boolean {
  return result.kind.startsWith('crm_');
}

/**
 * Ctrl+K / Cmd+K search across the whole app. The button sits in the sidebar
 * and mobile header; the shortcut works anywhere except while typing in a
 * field. Results come from /api/search and are in-app links only.
 */
export function CommandPalette({
  className,
  shortcut = true,
}: {
  className?: string;
  /** Only one mounted palette listens for Ctrl+K, or two would toggle each other. */
  shortcut?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const [results, setResults] = React.useState<Result[]>([]);
  const [active, setActive] = React.useState(0);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut]);

  React.useEffect(() => {
    if (q.trim().length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        const body = (await res.json()) as { results?: Result[] };
        setResults(body.results ?? []);
        setActive(0);
      } catch {
        // Aborted by the next keystroke, or offline: keep the last results.
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [q]);

  // Too short to search: show nothing rather than the last query's results.
  // The Lists group goes last, so the arrow keys walk the list as drawn.
  const shown = q.trim().length >= 2 ? results : [];
  const general = shown.filter((r) => !inListsGroup(r));
  const lists = shown.filter(inListsGroup);
  const ordered = [...general, ...lists];

  const go = (result: Result | undefined) => {
    if (!result) return;
    setOpen(false);
    setQ('');
    router.push(result.href);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'flex items-center gap-2 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-sm text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]',
          className,
        )}
      >
        <Search className="size-3.5" aria-hidden />
        <span>Search</span>
        <kbd className="ml-auto hidden text-[11px] text-[var(--fg-subtle)] lg:inline">Ctrl K</kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Search"
          description="Deals, portfolio, Fund II LPs, people, meetings, tasks, documents and lists."
        >
          <input
            autoFocus
            type="search"
            aria-label="Search everything"
            placeholder="Company, person, meeting…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, ordered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                go(ordered[active]);
              }
            }}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          />
          <ul
            role="listbox"
            aria-label="Results"
            className="mt-3 max-h-[50dvh] space-y-0.5 overflow-y-auto"
          >
            {general.map((r, i) => (
              <ResultOption
                key={`${r.kind}-${r.href}-${r.label}`}
                result={r}
                active={i === active}
                onHover={() => setActive(i)}
                onPick={() => go(r)}
              />
            ))}
            {lists.length > 0 ? (
              <li role="group" aria-labelledby="search-group-lists">
                <p
                  id="search-group-lists"
                  role="presentation"
                  className="text-micro px-2.5 pt-3 pb-1 font-medium tracking-wider text-[var(--fg-subtle)] uppercase"
                >
                  Lists
                </p>
                <ul role="none" className="space-y-0.5">
                  {lists.map((r, j) => (
                    <ResultOption
                      key={`${r.kind}-${r.href}-${r.label}`}
                      result={r}
                      active={general.length + j === active}
                      onHover={() => setActive(general.length + j)}
                      onPick={() => go(r)}
                    />
                  ))}
                </ul>
              </li>
            ) : null}
          </ul>
          {q.trim().length >= 2 && !loading && shown.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--fg-subtle)]">No matches.</p>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ResultOption({
  result,
  active,
  onHover,
  onPick,
}: {
  result: Result;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <li role="option" aria-selected={active}>
      <button
        type="button"
        onMouseEnter={onHover}
        onClick={onPick}
        className={cn(
          'flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left',
          active ? 'bg-[var(--bg-hover)]' : '',
        )}
      >
        <span className="mt-0.5 w-16 shrink-0 text-[11px] text-[var(--fg-subtle)]">
          {KIND_LABEL[result.kind]}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{result.label}</span>
          {result.sub ? (
            <span className="block truncate text-xs text-[var(--fg-muted)]">{result.sub}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
