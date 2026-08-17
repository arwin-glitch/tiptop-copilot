import * as React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/util/cn';

/**
 * The table primitive.
 *
 * There was no table in this product before this file: `/deals` and
 * `/portfolio` were lists of cards, and the only `<table>` anywhere was the AI
 * deal-comparison grid. So this is written for the job the product actually
 * has — a few hundred rows of mixed prose and figures, read by one person
 * scanning for the row that needs them.
 *
 * Three decisions worth knowing about:
 *
 * 1. **The scroll container is mandatory, not optional.** A wide table on a
 *    phone must scroll inside itself; the Playwright suite asserts that
 *    `document.documentElement` never scrolls sideways on any page. `Table`
 *    therefore always renders its own `overflow-x` wrapper and callers cannot
 *    opt out.
 * 2. **`border-separate`, not `border-collapse`.** Collapsed borders are
 *    dropped by a `position: sticky` header — the border belongs to the
 *    collapsed grid rather than the cell, so it scrolls away and the header
 *    floats untethered over the rows. Separated borders stay attached.
 * 3. **No vertical rules.** Alignment does the column separation. Ruling both
 *    axes is what makes a dense table read as a spreadsheet.
 */
export function Table({
  className,
  caption,
  stickyHeader = false,
  containerClassName,
  children,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement> & {
  /**
   * Describes the table for screen readers. Visually hidden: the surrounding
   * `SectionHeading` is the visible title, and repeating it would be noise.
   */
  caption: string;
  stickyHeader?: boolean;
  containerClassName?: string;
}) {
  return (
    <div
      className={cn(
        '-mx-[var(--gutter)] scrollbar-thin overflow-x-auto px-[var(--gutter)] sm:mx-0 sm:px-0',
        stickyHeader && 'max-h-[70dvh] overflow-y-auto',
        containerClassName,
      )}
      // A scrollable region needs to be focusable to be reachable by keyboard,
      // and needs a name once it is focusable.
      tabIndex={0}
      role="region"
      aria-label={caption}
    >
      <table
        className={cn(
          'w-full border-separate border-spacing-0 text-left text-sm',
          '[--table-sticky:var(--z-sticky)]',
          className,
        )}
        {...props}
      >
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export function TableHead({
  className,
  sticky = false,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement> & { sticky?: boolean }) {
  return (
    <thead
      className={cn(
        sticky && '[&_th]:sticky [&_th]:top-0 [&_th]:z-[var(--table-sticky)]',
        className,
      )}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}

export function TableRow({
  className,
  interactive = false,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & {
  /** Adds the hover affordance. Only set it when the row actually does something. */
  interactive?: boolean;
}) {
  return (
    <tr
      className={cn(
        interactive &&
          'transition-colors duration-[var(--motion-instant)] hover:bg-[var(--bg-hover)]',
        className,
      )}
      {...props}
    />
  );
}

type Align = 'start' | 'end';

const alignClass: Record<Align, string> = {
  start: 'text-left',
  end: 'text-right',
};

/**
 * A column header.
 *
 * When `sort` is supplied the label becomes a button and the cell carries
 * `aria-sort`, which is the pattern assistive technology actually reads — a
 * clickable `<th>` with no button inside is not reachable by keyboard.
 */
export function TableHeaderCell({
  className,
  align = 'start',
  numeric = false,
  sort,
  children,
  ...props
  // `align` is omitted from the native attributes on purpose: the deprecated
  // HTML `align` attribute has its own union ("left" | "center" | …) and
  // intersecting it with ours collapses the prop to `never`.
}: Omit<React.ThHTMLAttributes<HTMLTableCellElement>, 'align'> & {
  align?: Align;
  numeric?: boolean;
  sort?: {
    direction: 'asc' | 'desc' | null;
    onToggle: () => void;
  };
}) {
  const effectiveAlign: Align = numeric ? 'end' : align;
  return (
    <th
      scope="col"
      aria-sort={
        sort
          ? sort.direction === 'asc'
            ? 'ascending'
            : sort.direction === 'desc'
              ? 'descending'
              : 'none'
          : undefined
      }
      className={cn(
        'text-micro border-b border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2.5 font-medium tracking-wider whitespace-nowrap text-[var(--fg-subtle)] uppercase',
        alignClass[effectiveAlign],
        className,
      )}
      {...props}
    >
      {sort ? (
        <button
          type="button"
          onClick={sort.onToggle}
          className={cn(
            'inline-flex items-center gap-1 rounded transition-colors duration-[var(--motion-instant)] hover:text-[var(--fg)]',
            effectiveAlign === 'end' && 'flex-row-reverse',
            sort.direction && 'text-[var(--fg)]',
          )}
        >
          {children}
          {sort.direction === 'asc' ? (
            <ArrowUp className="size-3" aria-hidden="true" />
          ) : sort.direction === 'desc' ? (
            <ArrowDown className="size-3" aria-hidden="true" />
          ) : (
            <ChevronsUpDown className="size-3 opacity-40" aria-hidden="true" />
          )}
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function TableCell({
  className,
  align = 'start',
  numeric = false,
  ...props
}: Omit<React.TdHTMLAttributes<HTMLTableCellElement>, 'align'> & {
  align?: Align;
  /** Right-aligns and switches on tabular figures so digits line up column-wise. */
  numeric?: boolean;
}) {
  const effectiveAlign: Align = numeric ? 'end' : align;
  return (
    <td
      className={cn(
        'border-b border-[var(--border)] px-3 py-3 align-top',
        alignClass[effectiveAlign],
        numeric && 'tabular',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A row header — the cell that names the row, usually the company. Kept as a
 * `<th scope="row">` so a screen reader announces it alongside every other
 * cell in the row rather than reading twelve unlabelled values.
 */
export function TableRowHeader({
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="row"
      className={cn(
        'border-b border-[var(--border)] px-3 py-3 text-left align-top font-medium',
        className,
      )}
      {...props}
    />
  );
}
