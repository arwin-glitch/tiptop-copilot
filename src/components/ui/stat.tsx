import * as React from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/util/cn';

/**
 * A single figure with its label.
 *
 * The awkward requirement here is invariant 1: unknown stays unknown. A metric
 * tile is the single most tempting place in any product to render a missing
 * number as `0` or `—` and move on, and both are lies — one asserts a value,
 * the other hides that anything is missing. So `value === null` is a first-class
 * state with its own rendering, and it is deliberately not silent.
 *
 * `trend` is likewise optional and separate: a figure with no comparison
 * period does not get an arrow, because an arrow with nothing behind it is
 * decoration pretending to be analysis.
 */
export function Stat({
  label,
  value,
  unit,
  hint,
  trend,
  unknownLabel = 'Not recorded',
  className,
  size = 'md',
}: {
  label: string;
  /** `null` means genuinely unknown. It is never rendered as zero. */
  value: string | number | null;
  unit?: string;
  hint?: string;
  trend?: Trend;
  unknownLabel?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const known = value !== null && value !== '';

  return (
    <div className={cn('min-w-0', className)}>
      <p className="text-micro font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
        {label}
      </p>

      <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
        {known ? (
          <>
            <span
              className={cn(
                'tabular leading-none font-semibold',
                size === 'sm' && 'text-title',
                size === 'md' && 'text-display',
                size === 'lg' && 'text-display-lg',
              )}
            >
              {value}
            </span>
            {unit ? <span className="text-note text-[var(--fg-muted)]">{unit}</span> : null}
            {trend ? <TrendMarker {...trend} /> : null}
          </>
        ) : (
          <span className="text-note text-[var(--fg-subtle)] italic">{unknownLabel}</span>
        )}
      </p>

      {hint ? <p className="text-mini mt-1 text-[var(--fg-subtle)]">{hint}</p> : null}
    </div>
  );
}

export interface Trend {
  /** Rendered verbatim, e.g. "+12" or "3 fewer". The caller owns the maths. */
  label: string;
  direction: 'up' | 'down' | 'flat';
  /**
   * Whether this movement is good news. Explicit rather than assumed, because
   * up is good for revenue and bad for burn, and the component cannot know
   * which it is looking at.
   */
  sentiment: 'good' | 'bad' | 'neutral';
  /** Names the comparison, e.g. "vs. last week". Announced, not just shown. */
  period?: string;
}

function TrendMarker({ label, direction, sentiment, period }: Trend) {
  const Icon =
    direction === 'up' ? ArrowUpRight : direction === 'down' ? ArrowDownRight : ArrowRight;

  return (
    <span
      className={cn(
        'text-mini inline-flex items-center gap-0.5 font-medium',
        sentiment === 'good' && 'text-[var(--ok)]',
        sentiment === 'bad' && 'text-[var(--danger)]',
        sentiment === 'neutral' && 'text-[var(--fg-muted)]',
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {label}
      {period ? <span className="sr-only"> {period}</span> : null}
    </span>
  );
}

/**
 * A row of figures.
 *
 * Ruled between columns rather than boxed, so a metrics strip reads as one
 * object instead of four floating cards. Boxing every number is the specific
 * habit that makes a dashboard look generated.
 */
export function StatGroup({
  children,
  className,
  columns = 4,
}: {
  children: React.ReactNode;
  className?: string;
  columns?: 2 | 3 | 4;
}) {
  return (
    <div
      className={cn(
        'shadow-raised grid gap-x-6 gap-y-5 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-[var(--gutter)]',
        'grid-cols-2',
        columns === 3 && 'sm:grid-cols-3',
        columns === 4 && 'sm:grid-cols-4',
        // The divider only appears once the columns actually line up; on a
        // two-up phone layout a vertical rule would cut through wrapped rows.
        'sm:gap-x-0 sm:divide-x sm:divide-[var(--border)] sm:[&>*]:px-5 sm:[&>*:first-child]:pl-0 sm:[&>*:last-child]:pr-0',
        className,
      )}
    >
      {children}
    </div>
  );
}
