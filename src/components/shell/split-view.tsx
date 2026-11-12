'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeftRight, Columns2, ExternalLink, X } from 'lucide-react';
import { cn } from '@/lib/util/cn';

/**
 * Split view: a second Kraken page beside the one you are on, like two tabs
 * side by side (Inbox next to Calendar, a deal next to its emails). The
 * right-hand pane is Kraken itself in a frame (same origin only, proxy.ts),
 * which drops its own rail and bars (`data-embedded`, set before paint in
 * the root layout). Links clicked inside it stay in it.
 *
 * Computers only (lg and up). Ctrl+\ opens and closes it; the divider drags;
 * the page, width and open state are remembered on this device.
 */

const KEY = 'kraken.split';
const MIN = 360;

/** Pages the pane offers in its menu; any Kraken page can be shown by link. */
export const SPLIT_PAGES: { href: string; label: string }[] = [
  { href: '/inbox', label: 'Inbox' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/today', label: 'Today' },
  { href: '/follow-ups', label: 'Follow-ups' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/deals', label: 'Deals' },
  { href: '/network', label: 'Network' },
  { href: '/meetings', label: 'Meetings' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/booking', label: 'Booking' },
  { href: '/ask', label: 'Ask Arwin' },
];

interface SplitState {
  open: boolean;
  path: string;
  width: number;
}

const START: SplitState = { open: false, path: '/inbox', width: 0 };

/** Only Kraken's own pages: a path, never another site. */
export function safeSplitPath(path: string | null | undefined): string {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/api/')) {
    return '/inbox';
  }
  return path.slice(0, 500);
}

function read(): SplitState {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return START;
    const v = JSON.parse(raw) as Partial<SplitState>;
    return {
      open: v.open === true,
      path: safeSplitPath(v.path),
      width: typeof v.width === 'number' ? v.width : 0,
    };
  } catch {
    return START;
  }
}

function save(state: SplitState) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private mode: split view still works, it just is not remembered.
  }
}

const OPEN_EVENT = 'kraken:split-open';
const TOGGLE_EVENT = 'kraken:split-toggle';

/** The sidebar's "Split view" button: opens or closes the pane. */
export function SplitViewButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(TOGGLE_EVENT))}
      title="Two pages side by side (Ctrl+\)"
      className={cn(
        'hidden w-full items-center gap-2 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-sm text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] lg:flex',
        className,
      )}
    >
      <Columns2 className="size-4" aria-hidden="true" />
      <span className="flex-1 text-left">Split view</span>
      <kbd className="text-mini text-[var(--fg-subtle)]">Ctrl \</kbd>
    </button>
  );
}

/** Open the split pane on a page (from a button anywhere). */
export function openInSplit(path: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: safeSplitPath(path) }));
}

export function SplitView() {
  const router = useRouter();
  const [state, setState] = React.useState<SplitState>(START);
  const [ready, setReady] = React.useState(false);
  const [embedded, setEmbedded] = React.useState(false);
  const frame = React.useRef<HTMLIFrameElement>(null);
  const dragging = React.useRef(false);

  // After mount only: the saved state lives in this device's storage.
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      setEmbedded(document.documentElement.hasAttribute('data-embedded'));
      setState(read());
      setReady(true);
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  const width = Math.max(
    MIN,
    Math.min(state.width || (typeof window === 'undefined' ? 600 : window.innerWidth * 0.45), 1400),
  );

  // The page on the left makes room for the pane.
  React.useEffect(() => {
    if (!ready || embedded) return;
    const root = document.documentElement;
    if (state.open) {
      root.setAttribute('data-split', '');
      root.style.setProperty('--split-w', `${Math.round(width)}px`);
    } else {
      root.removeAttribute('data-split');
    }
    save(state);
    return () => root.removeAttribute('data-split');
  }, [state, width, ready, embedded]);

  const update = React.useCallback((patch: Partial<SplitState>) => {
    setState((s) => ({ ...s, ...patch }));
  }, []);

  // Ctrl+\ (Cmd+\ on a Mac) opens and closes it; a button anywhere can open it on a page.
  React.useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault();
        setState((s) => ({ ...s, open: !s.open }));
      }
    };
    const onOpen = (e: Event) => {
      const path = safeSplitPath((e as CustomEvent<string>).detail);
      setState((s) => ({ ...s, open: true, path }));
    };
    const onToggle = () => setState((s) => ({ ...s, open: !s.open }));
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    window.addEventListener(TOGGLE_EVENT, onToggle);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
      window.removeEventListener(TOGGLE_EVENT, onToggle);
    };
  }, [embedded]);

  /** Where the pane is now (its own links move it). */
  const currentPanePath = () => {
    try {
      const loc = frame.current?.contentWindow?.location;
      if (loc && loc.origin === window.location.origin) {
        return safeSplitPath(`${loc.pathname}${loc.search}`);
      }
    } catch {
      // Not readable: fall back to the last page chosen.
    }
    return state.path;
  };

  const onDrag = (e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const w = window.innerWidth - e.clientX;
    update({ width: Math.max(MIN, Math.min(w, window.innerWidth - 480)) });
  };
  const onUp = () => {
    dragging.current = false;
  };

  if (!ready || embedded) return null;

  return (
    <>
      {state.open ? (
        <section
          aria-label="Split view"
          className="fixed top-[var(--titlebar-h)] right-0 bottom-0 z-[var(--z-header)] hidden flex-col border-l border-[var(--border-strong)] bg-[var(--bg)] lg:flex"
          style={{ width }}
        >
          {/* The divider: drag to resize. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize split view"
            onPointerDown={onDrag}
            onPointerMove={onMove}
            onPointerUp={onUp}
            className={cn(
              'absolute inset-y-0 -left-1.5 w-3 cursor-col-resize',
              'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-[var(--gold)] after:opacity-0 hover:after:opacity-100',
            )}
          />
          <div className="dark flex h-11 shrink-0 items-center gap-1.5 bg-[var(--bg-sidebar)] px-2 text-[var(--fg)]">
            <Columns2 className="ml-1 size-4 text-[var(--gold)]" aria-hidden="true" />
            <label className="sr-only" htmlFor="split-page">
              Page in split view
            </label>
            <select
              id="split-page"
              value={SPLIT_PAGES.some((p) => p.href === state.path) ? state.path : ''}
              onChange={(e) => e.target.value && update({ path: e.target.value })}
              className="h-8 min-w-0 flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg-raised)] px-2 text-sm"
            >
              {SPLIT_PAGES.some((p) => p.href === state.path) ? null : (
                <option value="">This page</option>
              )}
              {SPLIT_PAGES.map((p) => (
                <option key={p.href} value={p.href}>
                  {p.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              title="Swap sides"
              aria-label="Swap sides"
              onClick={() => {
                const right = currentPanePath();
                const left = safeSplitPath(`${window.location.pathname}${window.location.search}`);
                update({ path: left });
                router.push(right);
              }}
              className="inline-flex size-8 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]"
            >
              <ArrowLeftRight className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              title="Open full width"
              aria-label="Open this page full width"
              onClick={() => {
                const right = currentPanePath();
                update({ open: false });
                router.push(right);
              }}
              className="inline-flex size-8 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              title="Close split view (Ctrl+\)"
              aria-label="Close split view"
              onClick={() => update({ open: false })}
              className="inline-flex size-8 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
          <iframe
            ref={frame}
            key={state.path}
            title="Split view page"
            src={state.path}
            className="min-h-0 w-full flex-1 border-0 bg-[var(--bg)]"
          />
        </section>
      ) : null}
    </>
  );
}
