import * as React from 'react';
import { cn } from '@/lib/util/cn';
import { FieldLabel } from '@/components/ui/card';

export function PageShell({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mx-auto w-full max-w-6xl px-4 py-6 sm:px-6', className)} {...props} />;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
  meta,
  className,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
  /**
   * A line under the subtitle for things that belong to the identity of the
   * page rather than to its content — a website, a domain, a source. Added so
   * the deal page could stop hanging its website link off the header with a
   * negative margin.
   */
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('mb-6 flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        {eyebrow ? (
          <p className="text-micro mb-1 font-medium tracking-[0.12em] text-[var(--fg-subtle)] uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="sm:text-display font-serif text-2xl leading-tight font-semibold">{title}</h1>
        {subtitle ? (
          <p className="mt-1.5 max-w-2xl text-sm text-[var(--fg-muted)]">{subtitle}</p>
        ) : null}
        {meta ? <div className="mt-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function SectionHeading({
  children,
  count,
  action,
  className,
}: {
  children: React.ReactNode;
  count?: number;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-3 flex items-baseline justify-between gap-3', className)}>
      <h2 className="font-serif text-lg font-semibold">
        {children}
        {count !== undefined ? (
          <span className="tabular ml-2 text-sm font-normal text-[var(--fg-subtle)]">{count}</span>
        ) : null}
      </h2>
      {action}
    </div>
  );
}

/** Label / value row used throughout the deal detail screens. */
export function DataRow({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-1 py-2 sm:grid-cols-[180px_1fr] sm:gap-4', className)}>
      <FieldLabel as="dt" className="sm:pt-0.5">
        {label}
      </FieldLabel>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}
