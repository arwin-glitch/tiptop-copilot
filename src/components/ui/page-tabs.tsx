'use client';

import * as React from 'react';
import Link, { useLinkStatus } from 'next/link';
import { cn } from '@/lib/util/cn';
import { tabHref } from '@/lib/util/page-tabs';

export interface PageTabItem {
  key: string;
  label: string;
  /** Shown after the label, and read as part of it. Only when already cheap to know. */
  count?: number;
}

/**
 * Subtabs under a page header: each section of a long page one click away
 * instead of a long scroll down to it.
 *
 * Links, not Radix tabs. The Radix `Tabs` in `tabs.tsx` renders every panel,
 * so every section's data would still load; here the URL (`?tab=<key>`) is the
 * state and the server renders only the active tab. That also makes a tab
 * deep-linkable and the Back button step through tabs. The look follows
 * `TabsTrigger`: the 2px accent underline on the current one.
 *
 * A `nav` with `aria-current="page"` on the current link, like the calendar's
 * day picker and the Reports filter chips. The links sit directly in a div,
 * not a list: tests count `main li` as the rows of the page.
 *
 * The bar sticks below whatever is already stuck to the top of the window
 * (the mobile header, the demo banner), so the tabs stay in reach while a
 * long tab is read.
 */
export function PageTabs({
  label,
  path,
  tabs,
  active,
  defaultKey,
  className,
}: {
  /** Accessible name of the bar, e.g. "Portfolio sections". */
  label: string;
  path: string;
  tabs: readonly PageTabItem[];
  /** The tab the server rendered. */
  active: string;
  defaultKey: string;
  className?: string;
}) {
  const sentinelRef = React.useRef<HTMLDivElement>(null);
  const navRef = React.useRef<HTMLElement>(null);
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const switching = React.useRef(false);

  // On a narrow screen the bar scrolls sideways: keep the current tab in view.
  // scrollLeft rather than scrollIntoView, which in Chrome also moves the
  // keyboard's focus starting point (see MobileNav).
  React.useEffect(() => {
    const scroller = scrollerRef.current;
    const current = scroller?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!scroller || !current) return;
    const start = current.offsetLeft - scroller.offsetLeft;
    const end = start + current.offsetWidth;
    if (start < scroller.scrollLeft || end > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = start - (scroller.clientWidth - current.offsetWidth) / 2;
    }
  }, [active]);

  // A switch made from far down a long tab lands at the top of the new one,
  // with the bar still stuck. A switch made near the top leaves the page where
  // it is. Only after a click here: Back and Forward keep their own position.
  React.useEffect(() => {
    if (!switching.current) return;
    switching.current = false;
    const sentinel = sentinelRef.current;
    const nav = navRef.current;
    if (!sentinel || !nav) return;
    const stuckAt = parseFloat(getComputedStyle(nav).top) || 0;
    const top = sentinel.getBoundingClientRect().top + window.scrollY - stuckAt;
    if (window.scrollY > top) window.scrollTo({ top, behavior: 'instant' });
  }, [active]);

  return (
    <>
      <div ref={sentinelRef} aria-hidden="true" />
      <nav
        ref={navRef}
        aria-label={label}
        // globals.css keys the window's scroll padding to this, so keyboard
        // focus never stops underneath the bar.
        data-page-tabs=""
        className={cn(
          'sticky top-[max(var(--app-header-h),var(--app-banner-h))] z-[var(--z-subnav)] -mx-[var(--gutter)] mb-5 border-b border-[var(--border)] bg-[var(--bg)]/95 px-[var(--gutter)] backdrop-blur lg:top-[var(--app-banner-h)]',
          className,
        )}
      >
        {/* Tighter on a phone, so four short labels fit a 375px screen. */}
        <div ref={scrollerRef} className="-mb-px flex scrollbar-thin overflow-x-auto sm:gap-1">
          {tabs.map((tab) => {
            const current = tab.key === active;
            return (
              <Link
                key={tab.key}
                href={tabHref(path, tab.key, defaultKey)}
                // No prefetch: an inactive tab costs the server nothing until
                // it is opened. The pending mark covers the wait instead.
                prefetch={false}
                scroll={false}
                aria-current={current ? 'page' : undefined}
                onClick={(event) => {
                  if (current || event.button !== 0) return;
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  switching.current = true;
                }}
                className={cn(
                  // The focus ring is drawn inside the link: the global ring
                  // sits 2px outside, where the sideways scroller clips it
                  // to a sliver on the top, bottom and first tab's left.
                  'relative inline-flex min-h-11 shrink-0 items-center border-b-2 px-2 text-sm font-medium whitespace-nowrap transition-colors duration-[var(--motion-fast)] focus-visible:-outline-offset-2 sm:px-3 lg:min-h-10',
                  current
                    ? 'border-[var(--accent)] text-[var(--fg)]'
                    : 'border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]',
                )}
              >
                {tab.label}
                {tab.count !== undefined ? (
                  <span className="tabular ml-1.5 text-xs text-[var(--fg-subtle)]">
                    {tab.count}
                  </span>
                ) : null}
                <PendingMark />
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}

/**
 * A faint pulsing underline on the tab being opened, while the server renders
 * it. Always rendered and only its opacity changes, so it never shifts layout.
 */
function PendingMark() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-x-2 -bottom-0.5 h-0.5 rounded-full bg-[var(--accent)] opacity-0 transition-opacity duration-[var(--motion-fast)] sm:inset-x-3',
        pending && 'animate-pulse opacity-60',
      )}
    />
  );
}
