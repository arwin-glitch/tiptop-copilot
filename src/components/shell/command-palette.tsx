'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, Clock, Search, X } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ContactStatusTag, formatContactDate } from '@/components/network/contact-status-tag';
import { connectionsLabel } from '@/lib/network/contact-status';
import type { SearchPreview } from '@/lib/services/search-preview';
import { cn } from '@/lib/util/cn';
import { announceSearchState, SEARCH_OPEN_EVENT } from './search-events';

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
    | 'crm_person'
    | 'crm_note'
    | 'space'
    | 'harmonic_person'
    | 'harmonic_company'
    | 'lookup';
  label: string;
  sub: string | null;
  href: string;
  recordId?: string;
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
  crm_note: 'Note',
  space: 'Space',
  harmonic_person: 'Person · Harmonic',
  harmonic_company: 'Company · Harmonic',
  lookup: 'Look up',
};

/** The CRM's results, shown as a group of their own under a "Lists" heading. */
function inListsGroup(result: Result): boolean {
  return result.kind.startsWith('crm_');
}

/**
 * Someone nobody has met yet: what Harmonic's API found (when the plan allows
 * it) and, always, rows that open the same name on LinkedIn and in Harmonic
 * with the logins TipTop already has. Free; nothing is saved.
 */
function lookupRows(q: string): Result[] {
  const term = q.trim();
  if (term.length < 2) return [];
  const words = encodeURIComponent(term);
  return [
    {
      kind: 'lookup',
      label: `Find "${term}" on LinkedIn`,
      sub: 'People search, in a new tab',
      href: `https://www.linkedin.com/search/results/people/?keywords=${words}`,
    },
    {
      kind: 'lookup',
      label: `Find "${term}" in Harmonic`,
      sub: 'People search with TipTop’s Harmonic seat, in a new tab',
      href: 'https://console.harmonic.ai/dashboard/people',
    },
    {
      kind: 'lookup',
      label: `Find "${term}" on Google`,
      sub: 'In a new tab',
      href: `https://www.google.com/search?q=${words}`,
    },
  ];
}

/** People and companies from Harmonic, met or not: a group of their own, last. */
function inHarmonicGroup(result: Result): boolean {
  return result.kind.startsWith('harmonic_');
}

/* ---------------------------------------------------------------- recents */

/**
 * The last ten results opened from search, in this browser only: a viewer's
 * convenience, like Affinity's Recent Searches. Storage can be missing or
 * refuse (private windows), so every read and write is guarded and the
 * palette works the same without it.
 */
const RECENTS_KEY = 'kraken.search.recents.v1';
const RECENTS_MAX = 10;

function readRecents(): Result[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is Result =>
          !!r &&
          typeof r === 'object' &&
          typeof (r as Result).label === 'string' &&
          typeof (r as Result).href === 'string' &&
          (r as Result).href.startsWith('/') &&
          typeof (r as Result).kind === 'string' &&
          (r as Result).kind in KIND_LABEL,
      )
      .slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

function writeRecents(list: Result[]) {
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX)));
  } catch {
    // Not remembered; nothing else changes.
  }
}

function remember(result: Result) {
  const { kind, label, sub, href, recordId } = result;
  const entry: Result = { kind, label, sub, href, ...(recordId ? { recordId } : {}) };
  writeRecents([entry, ...readRecents().filter((r) => r.href !== href)]);
}

/* ---------------------------------------------------------------- palette */

/**
 * Ctrl+K / Cmd+K search across the whole app, Affinity-style: it opens on
 * your recent searches, and the highlighted company or person (arrow keys or
 * hover) shows a preview on the right — where they sit, their relationship
 * status, counts, and the last contact — with Enter or ↗ opening the page.
 * The button sits in the sidebar and mobile header; the shortcut works
 * anywhere. In the desktop app the top bar's "Search Kraken" field opens it
 * instead (openSearch, ./search-events), and both buttons here are hidden;
 * there it hangs just under that field, like Slack's, rather than mid-window.
 * Results come from /api/search, previews from /api/search/preview (cached
 * here per record), and are in-app links only.
 */
export function CommandPalette({
  className,
  shortcut = true,
}: {
  className?: string;
  /**
   * Only one mounted palette listens for Ctrl+K, or two would toggle each
   * other; the same one answers openSearch().
   */
  shortcut?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const [results, setResults] = React.useState<Result[]>([]);
  // Bumped when a recent search is removed, so the list re-reads storage.
  const [, setRecentsTick] = React.useState(0);
  const [active, setActive] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const changeOpen = React.useCallback((next: boolean) => {
    if (next) setActive(0);
    setOpen(next);
  }, []);

  React.useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => {
          if (!o) setActive(0);
          return !o;
        });
      }
    };
    const onOpen = () => changeOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(SEARCH_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(SEARCH_OPEN_EVENT, onOpen);
    };
  }, [shortcut, changeOpen]);

  // The desktop app's top bar shows its Search field pressed while this is open.
  React.useEffect(() => {
    if (!open) return;
    announceSearchState(true);
    return () => announceSearchState(false);
  }, [open]);

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

  // Too short to search: the recent searches instead of the last results.
  // The Lists group goes last, so the arrow keys walk the list as drawn.
  const searching = q.trim().length >= 2;
  // Read from this browser's storage while the palette is open and empty.
  const recents = open && !searching ? readRecents() : [];
  const shown = searching ? results : [];
  const general = shown.filter((r) => !inListsGroup(r) && !inHarmonicGroup(r));
  const lists = shown.filter(inListsGroup);
  const harmonic = searching ? [...shown.filter(inHarmonicGroup), ...lookupRows(q)] : [];
  const ordered = searching ? [...general, ...lists, ...harmonic] : recents;
  const current = ordered[Math.min(active, ordered.length - 1)];

  const go = (result: Result | undefined) => {
    if (!result) return;
    // A look-up row opens LinkedIn, Harmonic or Google in a new tab and is
    // not kept in recent searches.
    if (result.kind === 'lookup') {
      window.open(result.href, '_blank', 'noopener,noreferrer');
      return;
    }
    remember(result);
    setOpen(false);
    setQ('');
    router.push(result.href);
  };

  const forget = (href: string) => {
    const next = readRecents().filter((r) => r.href !== href);
    writeRecents(next);
    setRecentsTick((t) => t + 1);
    setActive((a) => Math.max(0, Math.min(a, next.length - 1)));
  };

  return (
    <>
      <button
        type="button"
        onClick={() => changeOpen(true)}
        className={cn(
          'flex items-center gap-2 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-sm text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]',
          className,
        )}
      >
        <Search className="size-3.5" aria-hidden />
        <span>Search</span>
        <kbd className="ml-auto hidden text-[11px] text-[var(--fg-subtle)] lg:inline">Ctrl K</kbd>
      </button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          title="Search"
          description="Companies, people, deals, lists, notes, portfolio, Fund II LPs, meetings, tasks and documents."
          // In the desktop app: under the bar's Search field, which it opened
          // (both are centred on the window). Anywhere else, unchanged. Wide
          // enough on a desktop screen for the preview beside the results.
          className="md:max-w-3xl [:root[data-desktop-frame]_&]:top-[calc(var(--titlebar-h)+0.375rem)] [:root[data-desktop-frame]_&]:translate-y-0"
        >
          <input
            autoFocus
            type="search"
            aria-label="Search everything"
            placeholder="Company, person, deal, note…"
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
                go(current);
              }
            }}
            className="w-full rounded-md border border-[var(--border-control)] bg-[var(--bg)] px-3 py-2 text-sm"
          />
          <div className="mt-3 flex min-h-0 gap-4">
            <div className="min-w-0 flex-1">
              {!searching ? (
                <RecentList
                  recents={recents}
                  active={active}
                  onHover={setActive}
                  onPick={go}
                  onForget={forget}
                />
              ) : (
                <ul
                  role="listbox"
                  aria-label="Results"
                  className="max-h-[50dvh] space-y-0.5 overflow-y-auto"
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
                  {harmonic.length > 0 ? (
                    <li role="group" aria-labelledby="search-group-harmonic">
                      <p
                        id="search-group-harmonic"
                        role="presentation"
                        className="text-micro px-2.5 pt-3 pb-1 font-medium tracking-wider text-[var(--fg-subtle)] uppercase"
                      >
                        Not met yet
                      </p>
                      <ul role="none" className="space-y-0.5">
                        {harmonic.map((r, k) => (
                          <ResultOption
                            key={`${r.kind}-${r.href}-${r.label}`}
                            result={r}
                            active={general.length + lists.length + k === active}
                            onHover={() => setActive(general.length + lists.length + k)}
                            onPick={() => go(r)}
                          />
                        ))}
                      </ul>
                    </li>
                  ) : null}
                </ul>
              )}
              {searching && !loading && shown.length === 0 ? (
                <p className="mt-3 text-sm text-[var(--fg-subtle)]">No matches.</p>
              ) : null}
            </div>
            {current ? <PreviewPane result={current} onOpen={() => go(current)} /> : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RecentList({
  recents,
  active,
  onHover,
  onPick,
  onForget,
}: {
  recents: Result[];
  active: number;
  onHover: (i: number) => void;
  onPick: (r: Result) => void;
  onForget: (href: string) => void;
}) {
  if (recents.length === 0) {
    return (
      <p className="px-1 py-2 text-sm text-[var(--fg-subtle)]">
        Type two letters to search. What you open from here shows up as a recent search next time.
      </p>
    );
  }
  return (
    <div>
      <p
        id="search-recents"
        className="text-micro flex items-center gap-1.5 px-2.5 pb-1 font-medium tracking-wider text-[var(--fg-subtle)] uppercase"
      >
        <Clock className="size-3" aria-hidden />
        Recent searches
      </p>
      <ul
        role="listbox"
        aria-labelledby="search-recents"
        className="max-h-[50dvh] space-y-0.5 overflow-y-auto"
      >
        {recents.map((r, i) => (
          <ResultOption
            key={r.href}
            result={r}
            active={i === active}
            onHover={() => onHover(i)}
            onPick={() => onPick(r)}
            onForget={() => onForget(r.href)}
          />
        ))}
      </ul>
    </div>
  );
}

function initials(label: string): string {
  const words = label
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .trim()
    .split(/\s+/);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
}

function Avatar({ result }: { result: Result }) {
  const company =
    result.kind === 'crm_company' ||
    result.kind === 'harmonic_company' ||
    result.kind === 'portfolio' ||
    result.kind === 'deal';
  return (
    <span
      aria-hidden
      className={cn(
        'text-micro flex size-7 shrink-0 items-center justify-center font-semibold',
        company ? 'rounded-md' : 'rounded-full',
        'bg-[var(--accent-soft)] text-[var(--accent)]',
      )}
    >
      {initials(result.label)}
    </span>
  );
}

function ResultOption({
  result,
  active,
  onHover,
  onPick,
  onForget,
}: {
  result: Result;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
  onForget?: () => void;
}) {
  return (
    <li role="option" aria-selected={active} className="group relative">
      <button
        type="button"
        onMouseEnter={onHover}
        onClick={onPick}
        className={cn(
          'relative flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left',
          // Focus stays in the input, so this row is the only sign of what
          // Enter opens. A tint alone is about 1.2:1 against the dialog; the
          // inset ring and the gold rule each clear 3:1.
          active
            ? 'bg-[var(--bg-hover)] shadow-[inset_0_0_0_1px_var(--border-control)] before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-[var(--gold)]'
            : '',
          onForget ? 'pr-9' : '',
        )}
      >
        <Avatar result={result} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{result.label}</span>
          <span className="block truncate text-xs text-[var(--fg-muted)]">
            {[KIND_LABEL[result.kind], result.sub].filter(Boolean).join(' • ')}
          </span>
        </span>
      </button>
      {onForget ? (
        <button
          type="button"
          onClick={onForget}
          aria-label={`Remove ${result.label} from recent searches`}
          className="absolute top-1/2 right-2 hidden -translate-y-1/2 rounded p-1 text-[var(--fg-subtle)] group-hover:block hover:bg-[var(--bg-raised)] hover:text-[var(--fg)] focus-visible:block"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </li>
  );
}

/* ---------------------------------------------------------------- preview */

const previewCache = new Map<string, SearchPreview | 'error'>();

function usePreview(recordId: string | undefined) {
  const [state, setState] = React.useState<{ id: string; value: SearchPreview | 'error' } | null>(
    null,
  );
  React.useEffect(() => {
    if (!recordId || previewCache.has(recordId)) return;
    const controller = new AbortController();
    // Arrowing down a list should not fire a request per row passed.
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/search/preview?id=${encodeURIComponent(recordId)}`, {
          signal: controller.signal,
        });
        const body = (await res.json()) as { ok?: boolean; preview?: SearchPreview };
        const value = body.ok && body.preview ? body.preview : 'error';
        if (value !== 'error') previewCache.set(recordId, value);
        if (previewCache.size > 100) {
          previewCache.delete(previewCache.keys().next().value as string);
        }
        setState({ id: recordId, value });
      } catch {
        // Moved on to another row.
      }
    }, 120);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [recordId]);
  if (!recordId) return null;
  return previewCache.get(recordId) ?? (state?.id === recordId ? state.value : null);
}

function PreviewPane({ result, onOpen }: { result: Result; onOpen: () => void }) {
  const preview = usePreview(result.recordId);
  return (
    <aside
      aria-label="Preview"
      data-testid="search-preview"
      className="hidden max-h-[50dvh] w-72 shrink-0 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--bg-raised)] p-4 md:block"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-serif text-base leading-tight font-semibold">
            {preview && preview !== 'error' ? preview.name : result.label}
          </p>
          <p className="text-mini mt-0.5 truncate text-[var(--fg-muted)]">
            {preview && preview !== 'error'
              ? [preview.sub, preview.industry ?? preview.title].filter(Boolean).join(' • ') ||
                KIND_LABEL[result.kind]
              : [KIND_LABEL[result.kind], result.sub].filter(Boolean).join(' • ')}
          </p>
        </div>
        <Link
          href={result.href}
          onClick={(e) => {
            e.preventDefault();
            onOpen();
          }}
          aria-label={`Open ${result.label}`}
          className="shrink-0 rounded-md border border-[var(--border)] p-1.5 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
        >
          <ArrowUpRight className="size-3.5" aria-hidden />
        </Link>
      </div>
      {!result.recordId ? (
        <p className="mt-3 text-xs text-[var(--fg-subtle)]">Press Enter to open.</p>
      ) : preview === null ? (
        <div className="mt-4 space-y-2" aria-hidden>
          <div className="h-4 w-28 animate-pulse rounded bg-[var(--bg-hover)]" />
          <div className="h-3 w-full animate-pulse rounded bg-[var(--bg-hover)]" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-[var(--bg-hover)]" />
        </div>
      ) : preview === 'error' ? (
        <p className="mt-3 text-xs text-[var(--fg-subtle)]">
          The preview could not be loaded. Press Enter to open the page.
        </p>
      ) : (
        <PreviewBody preview={preview} />
      )}
    </aside>
  );
}

function PreviewBody({ preview }: { preview: SearchPreview }) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { contact, counts } = preview;
  const pipeline = preview.lists[0];
  return (
    <div className="mt-3 space-y-3 text-xs">
      {pipeline ? (
        <p className="text-[var(--fg-muted)]">
          {pipeline.name}
          {preview.listCount > 1 ? ` · +${preview.listCount - 1} more` : ''}
        </p>
      ) : null}
      {contact ? <ContactStatusTag status={contact.status} /> : null}
      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1.5">
        <dt className="text-[var(--fg-subtle)]">Owner</dt>
        <dd className="truncate">{preview.owner ?? '—'}</dd>
        <dt className="text-[var(--fg-subtle)]">Status</dt>
        <dd className="truncate">{preview.stage ?? '—'}</dd>
        <dt className="text-[var(--fg-subtle)]">Amount</dt>
        <dd className="tabular truncate">{preview.amount ?? '—'}</dd>
        <dt className="text-[var(--fg-subtle)]">Connections</dt>
        <dd className="truncate">{connectionsLabel(contact?.connections ?? []) ?? '—'}</dd>
      </dl>
      <ul className="grid grid-cols-3 gap-2 text-center" aria-label="Counts">
        {(
          [
            ['Notes', counts.notesCapped ? `${counts.notes}+` : String(counts.notes)],
            ['Connections', String(counts.connections)],
            ['Reminders', String(counts.reminders)],
          ] as const
        ).map(([label, n]) => (
          <li key={label} className="rounded-md border border-[var(--border)] px-1 py-1.5">
            <span className="tabular block text-sm font-semibold">{n}</span>
            <span className="text-micro text-[var(--fg-subtle)]">{label}</span>
          </li>
        ))}
      </ul>
      <div>
        <p className="text-micro font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
          Last contact
        </p>
        {contact?.lastContactAt ? (
          <p className="mt-1">
            <span className="font-medium">
              {formatContactDate(contact.lastContactAt, timezone, true)}
            </span>
            {contact.lastTouchText ? (
              <span className="block text-[var(--fg-muted)]">{contact.lastTouchText}</span>
            ) : null}
          </p>
        ) : (
          <p className="mt-1 text-[var(--fg-subtle)]">No email or meeting on record.</p>
        )}
      </div>
    </div>
  );
}
