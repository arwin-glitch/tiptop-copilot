import * as React from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/util/cn';
import { Button } from './button';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('skeleton rounded-md', className)} aria-hidden="true" {...props} />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn('h-3.5', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

/**
 * Empty states always say what to do next. A bare "No results" tells the user
 * nothing they did not already know.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description: string;
  action?: { label: string; href?: string; onClick?: () => void };
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-dashed border-[var(--border-strong)] px-6 py-10 text-center',
        className,
      )}
    >
      {icon ? <div className="mb-3 text-[var(--fg-subtle)]">{icon}</div> : null}
      <p className="font-serif text-base font-semibold">{title}</p>
      <p className="mt-1.5 max-w-md text-sm text-[var(--fg-muted)]">{description}</p>
      {action ? (
        <div className="mt-4">
          {action.href ? (
            <Button asChild size="sm" variant="secondary">
              <a href={action.href}>{action.label}</a>
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Error surface that states what failed *and* what still works, so a partial
 * outage does not read as a total one.
 */
export function ErrorState({
  title,
  message,
  stillUsable,
  retry,
  className,
}: {
  title: string;
  message: string;
  stillUsable?: string;
  retry?: { label: string; onClick: () => void };
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-[var(--radius-card)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-4 py-3',
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--danger)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--danger)]">{title}</p>
          <p className="mt-1 text-sm text-[var(--fg)]">{message}</p>
          {stillUsable ? (
            <p className="mt-1.5 text-xs text-[var(--fg-muted)]">Still available: {stillUsable}</p>
          ) : null}
          {retry ? (
            <Button size="sm" variant="secondary" className="mt-3" onClick={retry.onClick}>
              {retry.label}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function Notice({
  children,
  tone = 'info',
  className,
}: {
  children: React.ReactNode;
  tone?: 'info' | 'warn';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm',
        tone === 'info'
          ? 'border-[var(--info)]/25 bg-[var(--info-soft)] text-[var(--fg)]'
          : 'border-[var(--warn)]/30 bg-[var(--warn-soft)] text-[var(--fg)]',
        className,
      )}
    >
      {tone === 'info' ? (
        <Info className="mt-0.5 size-4 shrink-0 text-[var(--info)]" aria-hidden="true" />
      ) : (
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warn)]" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * The only component that renders provider- or model-supplied text.
 *
 * It renders a string as text content — never as markup — so an email body
 * containing HTML or a script tag is displayed, not executed. There is no
 * `dangerouslySetInnerHTML` anywhere in this codebase and an ESLint rule
 * enforces that.
 */
export function PlainText({
  text,
  className,
  maxLines,
}: {
  text: string | null | undefined;
  className?: string;
  maxLines?: number;
}) {
  if (!text) {
    return <span className="text-sm text-[var(--fg-subtle)] italic">No content</span>;
  }
  return (
    <div
      className={cn('plain-text text-sm leading-relaxed', className)}
      style={
        maxLines
          ? {
              display: '-webkit-box',
              WebkitLineClamp: maxLines,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }
          : undefined
      }
    >
      {text}
    </div>
  );
}
