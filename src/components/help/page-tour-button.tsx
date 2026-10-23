'use client';

import { usePathname } from 'next/navigation';
import { CircleHelp } from 'lucide-react';
import { helpPageForPath, helpSectionFor } from '@/lib/help/registry';
import { startTour } from './tour-events';

/**
 * The small "?" beside a page's title: a guided tour of the page that is
 * open. Only on pages that have one (the main pages, not a deal or a list).
 * On a tab with a tour of its own (Portfolio › Jobs, say) it starts that one;
 * the tab is read at the click, so the button never waits on the URL.
 */
export function PageTourButton() {
  const pathname = usePathname();
  const page = helpPageForPath(pathname);
  if (!page) return null;
  return (
    <button
      type="button"
      onClick={() => {
        const tab = new URLSearchParams(window.location.search).get('tab');
        startTour(helpSectionFor(pathname, tab)?.id ?? page.id);
      }}
      aria-label="Tour this page"
      title="Show me around this page"
      className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[var(--border-strong)] text-[var(--fg-muted)] transition-colors duration-[var(--motion-instant)] hover:border-[var(--gold)] hover:text-[var(--fg)]"
    >
      <CircleHelp className="size-4" aria-hidden="true" />
    </button>
  );
}
