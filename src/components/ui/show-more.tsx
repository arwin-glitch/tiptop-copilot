'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/util/cn';

/**
 * The foot of a long list rendered a page at a time: how much of it is
 * showing, and a control for the next page.
 *
 * A tab that renders every row (hundreds of meeting notes, each with its full
 * text) is the same long scroll the subtabs were meant to end, one click
 * deeper. So a long list starts at one page and grows on request.
 *
 * Two forms. With `href`, the next page is a server render of the same URL
 * with `?show=` grown (see `showMoreHref`), so rows not shown are never sent.
 * With `onMore`, a client list that already holds its rows shows more of them.
 * Either way the control sits below the rows, so the new ones arrive above it.
 */
export function ShowMore({
  shown,
  total,
  step,
  href,
  onMore,
  note,
  className,
}: {
  /** Rows on screen. */
  shown: number;
  /** Rows there are in all (or, for a capped read, all that can be shown). */
  total: number;
  /** Rows the next page adds. */
  step: number;
  href?: string;
  onMore?: () => void;
  /** A line shown once every row is on screen, e.g. how to reach older ones. */
  note?: string;
  className?: string;
}) {
  const more = Math.min(step, Math.max(total - shown, 0));
  if (more === 0 && !note) return null;
  const label = `Show ${more} more`;
  return (
    <div className={cn('mt-4 flex flex-wrap items-center justify-between gap-3', className)}>
      <p className="tabular text-mini text-[var(--fg-subtle)]">
        {more > 0 ? `Showing ${Math.min(shown, total)} of ${total}` : note}
      </p>
      {more > 0 ? (
        href ? (
          <Button asChild variant="secondary">
            <Link href={href} scroll={false} prefetch={false}>
              {label}
            </Link>
          </Button>
        ) : (
          <Button variant="secondary" onClick={onMore}>
            {label}
          </Button>
        )
      ) : null}
    </div>
  );
}
