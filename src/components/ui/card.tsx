import * as React from 'react';
import { cn } from '@/lib/util/cn';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // A raised surface now actually looks raised. The border alone was
        // doing all the work, which is why a page of cards read as a page of
        // outlines. `--elevation-raised` is deliberately faint — one step, not
        // a drop shadow.
        'shadow-raised rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-start justify-between gap-3 px-4 pt-4 pb-3 sm:px-5', className)}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  as: Tag = 'h2',
  ...props
}: React.HTMLAttributes<HTMLHeadingElement> & { as?: 'h1' | 'h2' | 'h3' | 'h4' }) {
  return <Tag className={cn('text-base leading-tight font-semibold', className)} {...props} />;
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('mt-1 text-sm text-[var(--fg-muted)]', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 pb-4 sm:px-5', className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-t border-[var(--border)] px-4 py-3 sm:px-5',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The small uppercase label that names a value, a sub-section or a column.
 *
 * It renders as whatever element the position calls for, because this label is
 * sometimes a real heading in the document outline (`h2`/`h3` inside a card),
 * sometimes the term half of a definition list (`dt`), and sometimes just a
 * caption (`p`/`span`). Getting that wrong is not cosmetic — the accessibility
 * suite reads the heading structure.
 *
 * `font-sans` is explicit because the base layer sets a serif face on h1–h3,
 * and a serif micro-caps label looks like a mistake.
 */
export function FieldLabel({
  className,
  as: Tag = 'span',
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  as?: 'span' | 'p' | 'dt' | 'h2' | 'h3' | 'h4';
}) {
  return (
    <Tag
      className={cn(
        'text-micro font-sans font-medium tracking-wider text-[var(--fg-subtle)] uppercase',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A value that may be unknown. Renders an explicit "Not stated" rather than an
 * empty cell, because a blank looks like a rendering bug and an unknown is a
 * real, meaningful state in this product.
 */
export function FieldValue({
  value,
  className,
  unknownLabel = 'Not stated',
}: {
  value: string | number | null | undefined;
  className?: string;
  unknownLabel?: string;
}) {
  if (value === null || value === undefined || value === '') {
    return (
      <span className={cn('text-sm text-[var(--fg-subtle)] italic', className)}>
        {unknownLabel}
      </span>
    );
  }
  return <span className={cn('text-sm', className)}>{value}</span>;
}
