'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { X } from 'lucide-react';
import { tourSteps, type ResolvedStep } from '@/lib/help/registry';
import { placeCard, type Box, type Size } from '@/lib/help/placement';
import { TOUR_ATTR, TOUR_PARAM } from '@/lib/help/tour-ids';
import { cn } from '@/lib/util/cn';
import { ASK_PANEL_EVENT, type AskPanelDetail } from '@/components/ask/ask-events';
import { readStoredTour, startTour, TOUR_START_EVENT, writeStoredTour } from './tour-events';

/**
 * The guided-tour engine, mounted once in the app layout.
 *
 * A tour is a list of steps from lib/help/registry.ts, each naming a page and
 * a `data-tour` target. The engine opens the page if it is not already open,
 * waits for the target to render (pages stream), scrolls it into view, dims
 * everything else around a cut-out, and puts a small card beside it: the
 * step, "2 of 5", Back / Next / Done. Esc or the X ends it. A step whose
 * target never shows (an empty state, a phone layout, a closed section) is
 * skipped rather than waited on, unless the 2-minute tour names a stand-in
 * for it on that page: then the stand-in is shown in its place.
 *
 * It must never get in the way of the page: the dimming lets every click
 * through, the card is the only thing that catches the pointer, a failure
 * anywhere renders nothing (an error boundary), and leaving the tour's page
 * by any other route simply ends the tour.
 *
 * State lives in sessionStorage, so a tour survives the page changes it makes
 * and a reload, and ends with the tab.
 *
 * The tour waits while the Ask Arwin panel is open (a step may invite a tap
 * on its launcher): the panel is modal, so a tour card and scrim over it
 * would only grey it out and steal its clicks. The tour comes back, at the
 * same step, when the panel closes.
 */

/** How long a page that just opened gets to render a target: it may still be streaming. */
const FIRST_WAIT_MS = 5_000;
/** Once something on the page has been found, a missing target is skipped quickly. */
const SETTLED_WAIT_MS = 700;
const POLL_MS = 120;
/** A search longer than this shows a "finding it" card instead of nothing. */
const SLOW_AFTER_MS = 450;
/** Breathing room between the target and the edge of the cut-out. */
const SPOT_PAD = 6;

interface ActiveTour {
  id: string;
  index: number;
  /** The way the reader is moving, so a missing step is skipped in that direction. */
  dir: 1 | -1;
}

type Phase = 'idle' | 'navigating' | 'seeking' | 'shown';

export function TourHost() {
  return (
    <TourBoundary>
      <React.Suspense fallback={null}>
        <TourParamListener />
      </React.Suspense>
      <TourEngine />
    </TourBoundary>
  );
}

/** A tour that throws takes nothing else down with it: it disappears, and stays gone. */
class TourBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch() {
    writeStoredTour(null);
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * `?tour=<id>` starts that tour, then the parameter is dropped (without a
 * server round trip) so a reload does not start it again. Its own component
 * for the Suspense boundary `useSearchParams` wants.
 */
function TourParamListener() {
  const params = useSearchParams();
  const value = params.get(TOUR_PARAM);

  React.useEffect(() => {
    if (value === null) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete(TOUR_PARAM);
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // The tour still starts; the parameter just stays in the address bar.
    }
    if (tourSteps(value).length > 0) startTour(value);
  }, [value]);

  return null;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== 'hidden' && style.opacity !== '0';
}

/** The first element on screen carrying the target: the sidebar's or the bottom bar's copy, say. */
function findTarget(target: string): Element | null {
  try {
    const all = document.querySelectorAll(`[${TOUR_ATTR}="${CSS.escape(target)}"]`);
    for (const el of all) if (isVisible(el)) return el;
  } catch {
    // A selector the browser rejects is a missing target, not a crash.
  }
  return null;
}

/**
 * The part of the element its scrolling ancestors actually show: a sidebar
 * link below the fold of the sidebar's own scroller has a rect on screen, but
 * sits behind the account block. The cut-out is drawn around this part only.
 */
function shownRect(el: Element): Box {
  const r = el.getBoundingClientRect();
  let top = r.top;
  let left = r.left;
  let bottom = r.bottom;
  let right = r.right;
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const style = window.getComputedStyle(p);
    if (style.position === 'fixed') break;
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const c = p.getBoundingClientRect();
    if (style.overflowY !== 'visible') {
      top = Math.max(top, c.top);
      bottom = Math.min(bottom, c.bottom);
    }
    if (style.overflowX !== 'visible') {
      left = Math.max(left, c.left);
      right = Math.min(right, c.right);
    }
  }
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Scroll the target into view unless it already is (clear of the fixed bars at either end). */
function reveal(el: Element) {
  try {
    const rect = el.getBoundingClientRect();
    const shown = shownRect(el);
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const topClear = 64;
    const bottomClear = vw < 1024 ? 96 : 24;
    const clipped = shown.height < rect.height - 1 || shown.width < rect.width - 1;
    if (clipped && rect.height <= vh * 0.55) {
      // Hidden inside a scroller of its own (the sidebar, the bottom bar):
      // scroll that, not the page.
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      return;
    }
    const inView =
      rect.top >= topClear && rect.bottom <= vh - bottomClear && rect.left >= 0 && rect.right <= vw;
    if (inView) return;
    const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
    if (rect.height > vh * 0.55) {
      // A tall target shows from its top, clear of the sticky banner and header.
      window.scrollBy({ top: rect.top - topClear - 24, behavior });
      return;
    }
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior });
  } catch {
    // Not scrolled; the cut-out still follows the target wherever it is.
  }
}

function TourEngine() {
  const pathname = usePathname();
  const router = useRouter();
  const [tour, setTour] = React.useState<ActiveTour | null>(null);
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [found, setFound] = React.useState<{
    el: Element;
    key: string;
    /** The step's stand-in was found, not the step itself. */
    standIn: boolean;
  } | null>(null);
  const [layout, setLayout] = React.useState<{ rect: Box; viewport: Size } | null>(null);
  const [cardSize, setCardSize] = React.useState<Size>({ width: 352, height: 200 });
  const [slow, setSlow] = React.useState(false);
  const [askOpen, setAskOpen] = React.useState(false);

  const tourId = tour?.id ?? null;
  const steps = React.useMemo(() => (tourId ? tourSteps(tourId) : []), [tourId]);
  const step: ResolvedStep | undefined = tour ? steps[tour.index] : undefined;
  const stepKey = tour ? `${tour.id}:${tour.index}` : '';

  /** The live tour, set synchronously, so an effect from a stale render can tell it is stale. */
  const tourRef = React.useRef<ActiveTour | null>(null);
  /** The path the engine last saw while a tour ran. */
  const pathRef = React.useRef<string | null>(null);
  /** The path the tour is on, or on its way to. Any other path means the reader left. */
  const expectedRef = React.useRef<string | null>(null);
  const arrivedRef = React.useRef(0);
  /** Something on this page was found already, so it has finished rendering. */
  const settledRef = React.useRef(false);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);

  const update = React.useCallback((next: ActiveTour | null) => {
    tourRef.current = next;
    setTour(next);
    if (next) writeStoredTour({ id: next.id, index: next.index });
    else writeStoredTour(null);
  }, []);

  const end = React.useCallback(() => {
    update(null);
    setPhase('idle');
    setFound(null);
    setLayout(null);
    setSlow(false);
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    try {
      if (back?.isConnected) back.focus({ preventScroll: true });
    } catch {
      // Focus stays where it is.
    }
  }, [update]);

  const begin = React.useCallback(
    (id: string, index = 0) => {
      const count = tourSteps(id).length;
      if (count === 0 || index >= count) return;
      if (!tourRef.current) {
        const active = document.activeElement;
        returnFocusRef.current =
          active instanceof HTMLElement && active !== document.body ? active : null;
      }
      pathRef.current = null;
      expectedRef.current = null;
      settledRef.current = false;
      arrivedRef.current = performance.now();
      setFound(null);
      setLayout(null);
      setSlow(false);
      update({ id, index, dir: 1 });
    },
    [update],
  );

  const skip = React.useCallback(() => {
    const t = tourRef.current;
    if (!t) return;
    const next = t.index + t.dir;
    // Nothing earlier to go back to: carry on forward instead.
    update(next < 0 ? { ...t, index: t.index + 1, dir: 1 } : { ...t, index: next });
  }, [update]);

  const goNext = React.useCallback(() => {
    const t = tourRef.current;
    if (!t) return;
    if (t.index >= tourSteps(t.id).length - 1) end();
    else update({ ...t, index: t.index + 1, dir: 1 });
  }, [end, update]);

  const goBack = React.useCallback(() => {
    const t = tourRef.current;
    if (!t || t.index === 0) return;
    update({ ...t, index: t.index - 1, dir: -1 });
  }, [update]);

  // The Ask Arwin panel opening pauses the tour; closing it brings it back.
  React.useEffect(() => {
    const onPanel = (event: Event) =>
      setAskOpen(Boolean((event as CustomEvent<AskPanelDetail>).detail?.open));
    window.addEventListener(ASK_PANEL_EVENT, onPanel);
    return () => window.removeEventListener(ASK_PANEL_EVENT, onPanel);
  }, []);

  // A tour in progress before a reload, and every later start.
  React.useEffect(() => {
    const stored = readStoredTour();
    // Deferred a tick: the start is an event like any other, not part of mounting.
    const timer = stored ? window.setTimeout(() => begin(stored.id, stored.index), 0) : 0;
    const onStart = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (id) begin(id);
    };
    window.addEventListener(TOUR_START_EVENT, onStart);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(TOUR_START_EVENT, onStart);
    };
  }, [begin]);

  // Be on the step's page: go there if needed, end the tour if the reader went elsewhere.
  React.useEffect(() => {
    if (!tour || tour !== tourRef.current) return;
    if (!step) {
      // Ran off the end (the last steps were all missing).
      const timer = window.setTimeout(end, 0);
      return () => window.clearTimeout(timer);
    }
    const moved = pathRef.current !== null && pathRef.current !== pathname;
    pathRef.current = pathname;
    if (moved) {
      if (pathname !== expectedRef.current) {
        const timer = window.setTimeout(end, 0);
        return () => window.clearTimeout(timer);
      }
      arrivedRef.current = performance.now();
      settledRef.current = false;
    }
    const want = step.path ?? expectedRef.current ?? pathname;
    expectedRef.current = want;
    const timer = window.setTimeout(() => {
      if (want !== pathname) {
        setLayout(null);
        setPhase('navigating');
        router.push(want);
      } else {
        setPhase('seeking');
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [tour, step, pathname, router, end]);

  // A page change or a search that takes a moment shows a "finding it" card.
  React.useEffect(() => {
    if (phase !== 'navigating' && phase !== 'seeking') return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [phase, stepKey]);

  // Find the step's target, or skip the step.
  React.useEffect(() => {
    if (phase !== 'seeking' || !tour || !step || tour !== tourRef.current) return;
    // Only on the step's own page: a page with the same target (every page
    // has a header) must not be mistaken for the one being opened.
    const want = step.path ?? expectedRef.current;
    if (want && want !== pathname) return;
    let cancelled = false;
    let timer = 0;
    const started = performance.now();
    const sinceArrival = started - arrivedRef.current;
    const budget =
      settledRef.current || sinceArrival >= FIRST_WAIT_MS
        ? SETTLED_WAIT_MS
        : Math.max(SETTLED_WAIT_MS, FIRST_WAIT_MS - sinceArrival);

    const look = () => {
      if (cancelled || tourRef.current !== tour) return;
      const own = findTarget(step.target);
      const el = own ?? (step.standIn ? findTarget(step.standIn.target) : null);
      if (el) {
        settledRef.current = true;
        reveal(el);
        setSlow(false);
        setFound({ el, key: stepKey, standIn: own === null });
        setPhase('shown');
        return;
      }
      if (performance.now() - started >= budget) {
        skip();
        return;
      }
      timer = window.setTimeout(look, POLL_MS);
    };
    timer = window.setTimeout(look, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [phase, tour, step, stepKey, pathname, skip]);

  // Follow the target every frame while it is shown: smooth scrolling, sticky
  // bars and late layout all move it. If it disappears, look for it again.
  React.useEffect(() => {
    if (phase !== 'shown' || !found) return;
    let frame = 0;
    let last = '';
    const tick = () => {
      try {
        const el = found.el;
        if (!el.isConnected || !isVisible(el)) {
          setPhase('seeking');
          return;
        }
        const shown = shownRect(el);
        const r = shown.width >= 1 && shown.height >= 1 ? shown : el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const signature = [r.top, r.left, r.width, r.height, vw, vh].map(Math.round).join(',');
        if (signature !== last) {
          last = signature;
          setLayout({
            rect: { top: r.top, left: r.left, width: r.width, height: r.height },
            viewport: { width: vw, height: vh },
          });
        }
        frame = window.requestAnimationFrame(tick);
      } catch {
        setPhase('seeking');
      }
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [phase, found]);

  const showCard = phase === 'shown' && found?.key === stepKey && layout !== null && !askOpen;

  // The card's real size, for placing it.
  React.useLayoutEffect(() => {
    const card = cardRef.current;
    if (!showCard || !card) return;
    const measure = () => {
      const width = card.offsetWidth;
      const height = card.offsetHeight;
      setCardSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, [showCard, stepKey]);

  // Focus moves into the card with each step, so the keyboard is where the tour is.
  React.useEffect(() => {
    if (!showCard) return;
    try {
      cardRef.current
        ?.querySelector<HTMLElement>('[data-tour-next]')
        ?.focus({ preventScroll: true });
    } catch {
      // Focus stays where it is.
    }
  }, [showCard, stepKey]);

  // Esc ends the tour from anywhere on the page (while the Ask panel is open,
  // Esc is the panel's).
  const active = tour !== null && !askOpen;
  React.useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      // An Esc something else already took (a dialog closing) is not for the tour.
      if (event.key === 'Escape' && !event.defaultPrevented) end();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, end]);

  if (!tour || !step || askOpen) return null;

  const total = steps.length;
  const last = tour.index === total - 1;
  // The stand-in's own words and placement, when it is what was found.
  const shown = found?.key === stepKey && found.standIn && step.standIn ? step.standIn : step;
  const position =
    showCard && layout ? placeCard(layout.rect, cardSize, layout.viewport, shown.placement) : null;
  const spot =
    layout && phase !== 'navigating'
      ? {
          top: layout.rect.top - SPOT_PAD,
          left: layout.rect.left - SPOT_PAD,
          width: layout.rect.width + SPOT_PAD * 2,
          height: layout.rect.height + SPOT_PAD * 2,
        }
      : null;

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[var(--z-tour)]" data-tour-layer="">
      {spot ? (
        <div
          aria-hidden="true"
          data-tour-spotlight=""
          className="absolute rounded-[var(--radius-card)] shadow-[0_0_0_200vmax_var(--tour-scrim)] ring-2 ring-[var(--accent)] motion-safe:transition-[top,left,width,height] motion-safe:duration-[var(--motion-base)] motion-safe:ease-[var(--ease-standard)]"
          style={spot}
        />
      ) : null}

      {showCard && position ? (
        <div
          key={stepKey}
          ref={cardRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby="tour-step-title"
          aria-describedby="tour-step-body"
          // The Ask launcher steps aside for dialogs; not for this one.
          data-tour-card=""
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') goNext();
            else if (event.key === 'ArrowLeft') goBack();
          }}
          className={cn(
            'shadow-overlay motion-safe:animate-rise pointer-events-auto fixed rounded-[var(--radius-panel)] border border-[var(--border-strong)] bg-[var(--bg-overlay)] p-4 text-[var(--fg)]',
            // A gold hairline along the top: the one accent on the card.
            'before:pointer-events-none before:absolute before:inset-x-5 before:top-0 before:h-px before:bg-[var(--gold)]',
            position.mode === 'float' ? 'w-[22rem]' : 'inset-x-3',
            position.mode === 'dock' && position.edge === 'top'
              ? 'top-[calc(env(safe-area-inset-top)+0.75rem)]'
              : null,
            position.mode === 'dock' && position.edge === 'bottom'
              ? 'bottom-[calc(env(safe-area-inset-bottom)+4.75rem)]'
              : null,
          )}
          style={position.mode === 'float' ? { top: position.top, left: position.left } : undefined}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-micro pt-1 font-medium tracking-[0.16em] text-[var(--label-gold)] uppercase">
              {step.pageName} · <span className="tabular">{tour.index + 1}</span> of{' '}
              <span className="tabular">{total}</span>
            </p>
            <button
              type="button"
              onClick={end}
              aria-label="End tour"
              title="End tour (Esc)"
              className="-mt-1 -mr-1 flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--fg-muted)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
          <h2 id="tour-step-title" className="text-title mt-0.5 font-serif font-semibold">
            {shown.title}
          </h2>
          <p id="tour-step-body" className="mt-1 text-sm text-[var(--fg-muted)]">
            {shown.body}
          </p>
          {total > 1 && total <= 24 ? (
            <div aria-hidden="true" className="mt-3 flex flex-wrap gap-1">
              {steps.map((s, i) => (
                <span
                  key={`${s.target}-${i}`}
                  className={cn(
                    'h-1.5 rounded-full transition-[width,background-color] duration-[var(--motion-fast)]',
                    i === tour.index
                      ? 'w-4 bg-[var(--accent)]'
                      : i < tour.index
                        ? 'w-1.5 bg-[var(--accent)] opacity-50'
                        : 'w-1.5 bg-[var(--border-strong)]',
                  )}
                />
              ))}
            </div>
          ) : null}
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-mini hidden text-[var(--fg-subtle)] sm:inline">Esc to exit</span>
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={goBack}
                disabled={tour.index === 0}
                className="inline-flex h-9 items-center rounded-md border border-[var(--border-strong)] bg-[var(--bg-raised)] px-3.5 text-sm font-medium text-[var(--fg)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--bg-hover)] disabled:pointer-events-none disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="button"
                data-tour-next=""
                onClick={goNext}
                className="shadow-raised inline-flex h-9 items-center rounded-md bg-[var(--primary)] px-4 text-sm font-medium text-[var(--primary-fg)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--primary-hover)]"
              >
                {last ? 'Done' : 'Next'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!showCard && slow ? (
        <div
          role="status"
          className="shadow-overlay pointer-events-auto fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] mx-auto flex max-w-sm items-center justify-between gap-3 rounded-[var(--radius-panel)] border border-[var(--border-strong)] bg-[var(--bg-overlay)] px-4 py-3 text-sm text-[var(--fg)] lg:bottom-6"
        >
          <span>
            {phase === 'navigating' ? `Opening ${step.pageName}…` : 'Finding the next stop…'}
          </span>
          <button
            type="button"
            onClick={end}
            className="text-sm font-medium text-[var(--accent)] underline-offset-2 hover:underline"
          >
            End tour
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
