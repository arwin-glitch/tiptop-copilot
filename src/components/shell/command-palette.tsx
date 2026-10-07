'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { cn } from '@/lib/util/cn';

interface Result {
  kind: 'deal' | 'portfolio' | 'lp' | 'person' | 'meeting' | 'task' | 'document';
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
};

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
  const shown = q.trim().length >= 2 ? results : [];

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
          description="Deals, portfolio, Fund II LPs, people, meetings, tasks and documents."
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
                setActive((a) => Math.min(a + 1, shown.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                go(shown[active]);
              }
            }}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          />
          <ul
            role="listbox"
            aria-label="Results"
            className="mt-3 max-h-[50dvh] space-y-0.5 overflow-y-auto"
          >
            {shown.map((r, i) => (
              <li key={`${r.kind}-${r.href}-${r.label}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(r)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left',
                    i === active ? 'bg-[var(--bg-hover)]' : '',
                  )}
                >
                  <span className="mt-0.5 w-16 shrink-0 text-[11px] text-[var(--fg-subtle)]">
                    {KIND_LABEL[r.kind]}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{r.label}</span>
                    {r.sub ? (
                      <span className="block truncate text-xs text-[var(--fg-muted)]">{r.sub}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {q.trim().length >= 2 && !loading && shown.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--fg-subtle)]">No matches.</p>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
