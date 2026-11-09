'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Clock, Search } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { cn } from '@/lib/util/cn';
import {
  filterTab,
  nextTab,
  queryWords,
  readHarmonicAnswer,
  TABS,
  tabCounts,
  type Result,
  type TabId,
} from './search/palette-model';
import { PreviewPanel, SuggestionsPanel, type PreviewCache } from './search/preview-panel';
import { ResultOption } from './search/result-row';
import { announceSearchState, SEARCH_OPEN_EVENT } from './search-events';

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
  harmonic_lookup: 'Harmonic',
};

/** The CRM's results, shown as a group of their own under a "Lists" heading. */
function inListsGroup(result: Result): boolean {
  return result.kind.startsWith('crm_');
}

/**
 * Someone nobody has met yet. First a row that asks Harmonic (TipTop's seat,
 * 100 free look-ups a day) on a page of its own — only when clicked, never per
 * keystroke — then rows that open the same name on LinkedIn and Google in a
 * new tab. Nothing is saved.
 */
function lookupRows(q: string): Result[] {
  const term = q.trim();
  if (term.length < 2) return [];
  const words = encodeURIComponent(term);
  return [
    {
      kind: 'harmonic_lookup',
      label: `Search Harmonic for "${term}"`,
      sub: 'TipTop’s Harmonic seat · uses 1 of 100 free daily look-ups',
      href: `/network/harmonic?q=${words}`,
    },
    {
      kind: 'lookup',
      label: `Find "${term}" on LinkedIn`,
      sub: 'People search, in a new tab',
      href: `https://www.linkedin.com/search/results/people/?keywords=${words}`,
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
          (r as Result).kind in KIND_LABEL &&
          (r as Result).kind !== 'harmonic_lookup',
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
  // Harmonic's hits reopen its look-up page, which can spend a look-up.
  if (result.origin === 'harmonic') return;
  const { kind, label, sub, href, recordId } = result;
  const entry: Result = { kind, label, sub, href, ...(recordId ? { recordId } : {}) };
  writeRecents([entry, ...readRecents().filter((r) => r.href !== href)]);
}

/* ---------------------------------------------------------------- palette */

interface Section {
  id: string;
  label: string;
  rows: Result[];
}

/** Harmonic is asked only after the query has rested this long. */
const HARMONIC_PAUSE_MS = 1000;
const HARMONIC_MIN = 3;

/**
 * Ctrl+K / Cmd+K search across the whole app, laid out like Affinity's: the
 * field on top, a tab row (Top Matches, Companies, People, Deals, Lists,
 * Notes, Meetings) with counts, results on the left (logo or avatar, the
 * name with the typed letters in bold, its domain or email and a tag) and
 * on the right a preview of the highlighted row (logo, status, description,
 * counts, last contact) or, with nothing highlighted, tips and recent
 * searches. It opens on your recent searches; arrow keys preview, Enter or
 * the open icon opens, Tab switches tabs. Once a query of three letters or
 * more has rested for a second, Harmonic is asked once for people and
 * companies nobody has met (once per distinct query, never per keystroke;
 * each costs one of the day's free look-ups), and LinkedIn / Google look-up
 * rows sit at the very bottom. The button sits in the sidebar and mobile
 * header; the shortcut works anywhere. In the desktop app the top bar's
 * "Search Kraken" field opens it instead (openSearch, ./search-events), and
 * both buttons here are hidden; there it hangs just under that field.
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
  const [tab, setTab] = React.useState<TabId>('top');
  // Terms already sent to Harmonic (warm-up or look-up) in this session.
  const warmed = React.useRef(new Set<string>());
  const [results, setResults] = React.useState<Result[]>([]);
  // Bumped when a recent search is removed, so the list re-reads storage.
  const [, setRecentsTick] = React.useState(0);
  const [active, setActive] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  // Previews for one palette session (a Map kept across renders).
  const [previews] = React.useState<PreviewCache>(() => new Map());
  // Harmonic hits per lowercased query, the query being asked, how many free
  // look-ups are left, and whether to stop asking (not connected, used up).
  const [harmonicHits, setHarmonicHits] = React.useState<Record<string, Result[]>>({});
  const [harmonicAsking, setHarmonicAsking] = React.useState<string | null>(null);
  const [harmonicLeft, setHarmonicLeft] = React.useState<number | null>(null);
  const [harmonicOff, setHarmonicOff] = React.useState(false);

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
    return () => {
      announceSearchState(false);
      // Previews are kept for one palette session.
      previews.clear();
    };
  }, [open, previews]);

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
        setResults(Array.isArray(body.results) ? body.results : []);
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

  // Harmonic, once per distinct query that has rested a second; aborted when
  // the query changes, skipped for the session once it is off or used up.
  const harmonicTerm = q.trim();
  const harmonicKey = harmonicTerm.toLowerCase();
  const harmonicKnown = harmonicKey in harmonicHits;
  React.useEffect(() => {
    if (!open || harmonicOff || harmonicKnown || harmonicTerm.length < HARMONIC_MIN) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setHarmonicAsking(harmonicKey);
      try {
        const res = await fetch(`/api/search/harmonic?q=${encodeURIComponent(harmonicTerm)}`, {
          signal: controller.signal,
        });
        const answer = readHarmonicAnswer(res.status, await res.json().catch(() => null));
        warmed.current.add(harmonicKey);
        if (answer.remaining !== null) setHarmonicLeft(answer.remaining);
        if (answer.off) setHarmonicOff(true);
        setHarmonicHits((prev) => ({ ...prev, [harmonicKey]: answer.hits }));
      } catch {
        // Aborted by a newer query, or offline: asked again if it comes back.
      } finally {
        setHarmonicAsking((k) => (k === harmonicKey ? null : k));
      }
    }, HARMONIC_PAUSE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open, harmonicOff, harmonicKnown, harmonicTerm, harmonicKey]);

  // Too short to search: the recent searches instead of the last results.
  const searching = q.trim().length >= 2;
  // Read from this browser's storage while the palette is open.
  const recents = open ? readRecents() : [];
  const shown = searching ? results : [];
  const words = queryWords(q);
  const general = shown.filter((r) => !inListsGroup(r) && !inHarmonicGroup(r));
  const lists = shown.filter(inListsGroup);
  const fromServer = shown.filter(inHarmonicGroup);
  const seen = new Set(fromServer.map((r) => `${r.kind}:${r.label.toLowerCase()}`));
  const fetched = (searching ? (harmonicHits[harmonicKey] ?? []) : []).filter(
    (r) => !seen.has(`${r.kind}:${r.label.toLowerCase()}`),
  );
  const harmonic = [...fromServer, ...fetched];
  const lookups = searching ? lookupRows(q) : [];
  const matches = [...general, ...lists, ...harmonic];
  const counts = tabCounts(matches);
  const tabLabel = TABS.find((t) => t.id === tab)?.label ?? '';

  // Top Matches: results, then lists, then Harmonic, then the look-up rows
  // last. The other tabs: their kinds only, in the same order.
  const sections: Section[] = !searching
    ? []
    : (tab === 'top'
        ? [
            { id: 'results', label: 'Search Results', rows: general },
            { id: 'lists', label: 'Lists', rows: lists },
            { id: 'harmonic', label: 'Harmonic · Not met yet', rows: harmonic },
            { id: 'lookup', label: 'Look up', rows: lookups },
          ]
        : [{ id: tab, label: tabLabel, rows: filterTab(matches, tab) }]
      ).filter((s) => s.rows.length > 0);
  const ordered = searching ? sections.flatMap((s) => s.rows) : recents;
  const activeIndex = Math.max(0, Math.min(active, ordered.length - 1));
  const current = ordered[activeIndex];

  // Harmonic's look-up page takes about ten seconds. When the "Search
  // Harmonic" row is highlighted for a moment (arrow keys or hover), start
  // it, so the answer is usually ready by the click. Once per term; the
  // server shares one call between this and the page and keeps it a day.
  const warmTerm = current?.kind === 'harmonic_lookup' ? q.trim() : '';
  React.useEffect(() => {
    if (warmTerm.length < 2 || warmed.current.has(warmTerm.toLowerCase())) return;
    const timer = window.setTimeout(() => {
      warmed.current.add(warmTerm.toLowerCase());
      void fetch(`/api/search/harmonic?q=${encodeURIComponent(warmTerm)}`, {
        method: 'POST',
        keepalive: true,
      }).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [warmTerm]);

  const go = (result: Result | undefined) => {
    if (!result) return;
    // A look-up row opens LinkedIn or Google in a new tab and is not kept in
    // recent searches.
    if (result.kind === 'lookup') {
      window.open(result.href, '_blank', 'noopener,noreferrer');
      return;
    }
    // The Harmonic row opens in Kraken, but is not kept either: reopening it
    // from recents would spend another of the day's free look-ups.
    if (result.kind !== 'harmonic_lookup') remember(result);
    setOpen(false);
    setQ('');
    setTab('top');
    router.push(result.href);
  };

  const forget = (href: string) => {
    const next = readRecents().filter((r) => r.href !== href);
    writeRecents(next);
    setRecentsTick((t) => t + 1);
    setActive((a) => Math.max(0, Math.min(a, next.length - 1)));
  };

  const switchTab = (next: TabId) => {
    setTab(next);
    setActive(0);
  };

  const optionId = (i: number) => `search-option-${i}`;
  const starts = sections.map((_, i) =>
    sections.slice(0, i).reduce((n, s) => n + s.rows.length, 0),
  );

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
          className="min-[720px]:max-w-4xl [:root[data-desktop-frame]_&]:top-[calc(var(--titlebar-h)+0.375rem)] [:root[data-desktop-frame]_&]:translate-y-0"
        >
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--fg-subtle)]"
              aria-hidden
            />
            <input
              autoFocus
              type="search"
              role="combobox"
              aria-expanded={ordered.length > 0}
              aria-controls="search-listbox"
              aria-activedescendant={current ? optionId(activeIndex) : undefined}
              aria-label="Search everything"
              placeholder="Search companies, people, deals, notes…"
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
                } else if (e.key === 'Tab' && searching && !e.altKey && !e.ctrlKey) {
                  e.preventDefault();
                  switchTab(nextTab(tab, e.shiftKey ? -1 : 1));
                }
              }}
              className="w-full rounded-md border border-[var(--border-control)] bg-[var(--bg)] py-2 pr-3 pl-9 text-sm"
            />
          </div>
          {searching ? (
            <div
              role="tablist"
              aria-label="Result types"
              className="mt-2 flex gap-1 overflow-x-auto border-b border-[var(--border)]"
            >
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`search-tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls="search-tabpanel"
                  tabIndex={-1}
                  onClick={() => switchTab(t.id)}
                  className={cn(
                    '-mb-px shrink-0 border-b-2 px-2.5 py-1.5 text-xs font-medium whitespace-nowrap',
                    tab === t.id
                      ? 'border-[var(--gold)] text-[var(--fg)]'
                      : 'border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]',
                  )}
                >
                  {t.label}
                  {counts[t.id] > 0 ? (
                    <span className="tabular ml-1 text-[var(--fg-subtle)]">{counts[t.id]}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          <div className="mt-3 flex min-h-0 gap-4">
            <div
              className="min-w-0 flex-1"
              {...(searching
                ? {
                    role: 'tabpanel',
                    id: 'search-tabpanel',
                    'aria-labelledby': `search-tab-${tab}`,
                  }
                : {})}
            >
              {!searching ? (
                <RecentList
                  recents={recents}
                  active={activeIndex}
                  optionId={optionId}
                  onHover={setActive}
                  onPick={go}
                  onForget={forget}
                />
              ) : (
                <ul
                  id="search-listbox"
                  role="listbox"
                  aria-label="Results"
                  className="max-h-[56dvh] space-y-0.5 overflow-y-auto"
                >
                  {sections.map((s, si) => (
                    <li key={s.id} role="group" aria-labelledby={`search-group-${s.id}`}>
                      <p
                        id={`search-group-${s.id}`}
                        role="presentation"
                        className="text-micro px-2.5 pt-2 pb-1 font-medium tracking-wider text-[var(--fg-subtle)] uppercase"
                      >
                        {s.label}
                      </p>
                      <ul role="none" className="space-y-0.5">
                        {s.rows.map((r, j) => {
                          const i = starts[si]! + j;
                          return (
                            <ResultOption
                              key={`${r.kind}-${r.href}-${r.label}`}
                              id={optionId(i)}
                              result={r}
                              kindLabel={KIND_LABEL[r.kind] ?? ''}
                              words={r.matched?.length ? r.matched : words}
                              active={i === activeIndex}
                              onHover={() => setActive(i)}
                              onPick={() => go(r)}
                            />
                          );
                        })}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
              {searching && !loading && ordered.length === 0 ? (
                <p className="mt-3 px-2.5 text-sm text-[var(--fg-subtle)]">
                  {tab === 'top' ? 'No matches.' : `No ${tabLabel.toLowerCase()} match.`}
                </p>
              ) : null}
              {searching && harmonicAsking === harmonicKey ? (
                <p className="text-micro mt-2 px-2.5 text-[var(--fg-subtle)]">Asking Harmonic…</p>
              ) : null}
            </div>
            {current ? (
              <PreviewPanel
                key={`${current.kind}-${current.href}-${current.label}`}
                result={current}
                kindLabel={KIND_LABEL[current.kind] ?? ''}
                cache={previews}
                onOpen={() => go(current)}
              />
            ) : (
              <SuggestionsPanel
                recents={recents}
                onPick={go}
                harmonicLeft={harmonicLeft}
                noMatches={searching}
              />
            )}
          </div>
          {harmonicLeft !== null || harmonicOff ? (
            <p className="text-micro mt-2 text-right text-[var(--fg-subtle)]">
              {harmonicLeft !== null
                ? `Harmonic: ${harmonicLeft} free look-up${harmonicLeft === 1 ? '' : 's'} left today`
                : 'Harmonic look-ups are off for now'}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function RecentList({
  recents,
  active,
  optionId,
  onHover,
  onPick,
  onForget,
}: {
  recents: Result[];
  active: number;
  optionId: (i: number) => string;
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
        id="search-listbox"
        role="listbox"
        aria-labelledby="search-recents"
        className="max-h-[56dvh] space-y-0.5 overflow-y-auto"
      >
        {recents.map((r, i) => (
          <ResultOption
            key={r.href}
            id={optionId(i)}
            result={r}
            kindLabel={KIND_LABEL[r.kind] ?? ''}
            words={[]}
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
