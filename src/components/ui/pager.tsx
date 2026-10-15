import * as React from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/util/cn';

/**
 * The foot of a long list shown one page at a time: "51–100 of 3,000" and
 * links to the previous and next page.
 *
 * For lists that can run to thousands of rows (Affinity's people, notes and
 * lists): every row is one or two clicks of paging away and the page never
 * grows into a long scroll, unlike "Show more", which stacks pages on one
 * another. Links, so it works before hydration and each page has a URL.
 */
export function Pager({
  page,
  pages,
  total,
  shown,
  offset,
  hrefFor,
  label = 'Pages',
  className,
}: {
  /** The page showing, counted from 1. */
  page: number;
  pages: number;
  /** Rows there are in all. */
  total: number;
  /** Rows on this page. */
  shown: number;
  /** Rows before this page. */
  offset: number;
  /** The URL of another page. */
  hrefFor: (page: number) => string;
  /** Accessible name of the navigation. */
  label?: string;
  className?: string;
}) {
  if (total <= 0 || shown <= 0) return null;
  const fmt = (n: number) => n.toLocaleString('en-US');
  return (
    <nav
      aria-label={label}
      className={cn(
        'mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--fg-muted)]',
        className,
      )}
    >
      <p className="tabular">
        {fmt(offset + 1)}–{fmt(offset + shown)} of {fmt(total)}
      </p>
      {pages > 1 ? (
        <div className="flex items-center gap-2">
          <PageLink href={page > 1 ? hrefFor(page - 1) : null} label="Previous page">
            <ChevronLeft aria-hidden="true" />
            Previous
          </PageLink>
          <span className="tabular text-xs">
            Page {fmt(page)} of {fmt(pages)}
          </span>
          <PageLink href={page < pages ? hrefFor(page + 1) : null} label="Next page">
            Next
            <ChevronRight aria-hidden="true" />
          </PageLink>
        </div>
      ) : null}
    </nav>
  );
}

function PageLink({
  href,
  label,
  children,
}: {
  href: string | null;
  label: string;
  children: React.ReactNode;
}) {
  if (!href) {
    return (
      <Button variant="secondary" size="sm" disabled aria-label={label}>
        {children}
      </Button>
    );
  }
  return (
    <Button asChild variant="secondary" size="sm">
      <Link href={href} aria-label={label} prefetch={false}>
        {children}
      </Link>
    </Button>
  );
}
