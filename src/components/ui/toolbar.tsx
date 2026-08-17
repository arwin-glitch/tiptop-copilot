'use client';

import * as React from 'react';
import { cn } from '@/lib/util/cn';

/**
 * The filter and control strip that sits above a list or table.
 *
 * It exists because the same arrangement was being rebuilt inline on every
 * screen that filters anything, and because the strip needs to be one object
 * rather than a row of loose controls: on a dense screen the eye should find
 * "the controls" once, not four separate widgets.
 *
 * `sticky` keeps it in place while the rows scroll underneath. It sits below
 * the header layer deliberately — a toolbar that covers the page heading has
 * won an argument it should have lost.
 */
export function Toolbar({
  children,
  sticky = false,
  className,
  'aria-label': ariaLabel = 'Filters',
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { sticky?: boolean }) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2.5',
        sticky &&
          'sticky top-0 z-[var(--z-sticky)] -mx-[var(--gutter)] border-b border-[var(--border)] bg-[var(--bg)]/95 px-[var(--gutter)] py-2.5 backdrop-blur',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** Pushes everything after it to the far end of the toolbar. */
export function ToolbarSpacer() {
  return <div className="flex-1" aria-hidden="true" />;
}

/**
 * A horizontally scrolling row of filter chips.
 *
 * The overflow is deliberate and local: on a phone the stage filters are wider
 * than the screen, and the alternative — wrapping to four lines — pushes the
 * actual content below the fold. The negative margin lets the row bleed to the
 * screen edge so it is visibly scrollable rather than appearing cut off.
 */
export function FilterChipRow({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      // `role="group"` so the aria-label is actually honoured — an aria-label on
      // a bare div is ignored by most screen readers.
      role="group"
      className={cn('-mx-1 flex scrollbar-thin gap-1.5 overflow-x-auto px-1 pb-1', className)}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * A toggleable filter.
 *
 * `aria-pressed` rather than a checkbox: these are toggle buttons that re-run a
 * query, not form state to be submitted. The count is inside the button on
 * purpose — it is part of the label a screen reader should read, because
 * "Seed" and "Seed, 12" are different pieces of information.
 */
export function FilterChip({
  label,
  count,
  pressed,
  onToggle,
  className,
}: {
  label: string;
  count?: number;
  pressed: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={pressed}
      className={cn(
        'text-note shrink-0 rounded-full border px-3 py-1 whitespace-nowrap transition-colors duration-[var(--motion-instant)]',
        pressed
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] font-medium text-[var(--fg)]'
          : 'border-[var(--border)] text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]',
        className,
      )}
    >
      {label}
      {count !== undefined ? (
        <span className="tabular ml-1.5 text-[var(--fg-subtle)]">{count}</span>
      ) : null}
    </button>
  );
}
