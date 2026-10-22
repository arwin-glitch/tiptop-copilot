'use client';

import * as React from 'react';
import { Coffee, Moon, UtensilsCrossed, Video } from 'lucide-react';
import type { PreviewKey } from '@/lib/booking/engine';
import { dateLabel } from '@/lib/booking/months';
import {
  dayWideReason,
  PREVIEW_KEYS,
  PREVIEW_LABEL,
  REASON_CHIP,
  type PreviewCode,
  type PreviewDay,
  type ReasonTone,
} from '@/lib/booking/planner-status';
import { timeLabel } from '@/lib/booking/public';
import { cn } from '@/lib/util/cn';

/**
 * How the Booking tab shows "no times" and open times: a coloured chip per
 * rule (a few words; the full reason on hover and for screen readers), a
 * small icon per kind of meeting, and the "Why no times?" list of days.
 */

export const KIND_ICON: Record<PreviewKey, React.ComponentType<{ className?: string }>> = {
  call: Video,
  coffee: Coffee,
  lunch: UtensilsCrossed,
  dinner: Moon,
};

const TONE_CLASS: Record<ReasonTone, string> = {
  muted: 'border-[var(--border)] bg-[var(--bg-sunken)] text-[var(--fg-muted)]',
  closed: 'border-transparent bg-[var(--neutral-soft)] text-[var(--fg)]',
  busy: 'border-transparent bg-[var(--info-soft)] text-[var(--info)]',
  warn: 'border-transparent bg-[var(--warn-soft)] text-[var(--warn)]',
};

export function ReasonChip({
  code,
  reason,
  wrap = false,
  className,
}: {
  code: PreviewCode;
  reason: string | null;
  /** Let the label wrap (a narrow calendar cell) instead of cutting it short. */
  wrap?: boolean;
  className?: string;
}) {
  const chip = REASON_CHIP[code];
  return (
    <span
      title={reason ?? undefined}
      data-reason={code}
      className={cn(
        'inline-flex max-w-full items-center border px-2 py-0.5 text-[11px] leading-4 font-medium',
        wrap ? 'rounded-md' : 'rounded-full',
        TONE_CLASS[chip.tone],
        className,
      )}
    >
      <span className={wrap ? 'leading-tight' : 'truncate'}>{chip.label}</span>
      {reason ? <span className="sr-only">: {reason}</span> : null}
    </span>
  );
}

/** One kind's line for a day: its open times, or the rule that closes it. */
export function KindLine({
  kind,
  day,
  zone,
  maxTimes = 6,
}: {
  kind: PreviewKey;
  day: PreviewDay;
  zone: string;
  maxTimes?: number;
}) {
  const plan = day.plans[kind];
  const Icon = KIND_ICON[kind];
  const shown = plan.times.slice(0, maxTimes);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
      <span className="inline-flex w-20 shrink-0 items-center gap-1.5 text-[var(--fg-muted)]">
        <Icon className="size-3.5 text-[var(--accent)]" aria-hidden="true" />
        {PREVIEW_LABEL[kind]}
      </span>
      {plan.times.length ? (
        <>
          {shown.map((t) => (
            <span
              key={t}
              className="tabular rounded-md border border-[var(--border)] bg-[var(--bg-raised)] px-1.5 py-0.5 text-xs"
            >
              {timeLabel(t, zone)}
            </span>
          ))}
          {plan.times.length > shown.length ? (
            <span className="text-xs text-[var(--fg-subtle)]">
              +{plan.times.length - shown.length} more
            </span>
          ) : null}
        </>
      ) : plan.code ? (
        <ReasonChip code={plan.code} reason={plan.reason} />
      ) : null}
    </div>
  );
}

/**
 * "Why no times?": each day, and for each kind of meeting the rule that
 * closes it (or its open times). A day closed for one reason across every
 * kind (a Monday, a closed month) is one short line, so the list stays
 * readable.
 */
export function WhyNoTimes({
  days,
  zone,
  compactDayWide = true,
}: {
  days: readonly PreviewDay[];
  zone: string;
  compactDayWide?: boolean;
}) {
  return (
    <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
      {days.map((day) => {
        const wide = compactDayWide ? dayWideReason(day) : null;
        return (
          <li
            key={day.date}
            data-day={day.date}
            aria-label={dateLabel(day.date)}
            className={cn(
              'grid gap-2 px-3 py-2 sm:grid-cols-[7.5rem_1fr] sm:items-start',
              wide && 'bg-[var(--bg-sunken)]/50',
            )}
          >
            <span className="tabular text-sm font-medium">{dateLabel(day.date)}</span>
            {wide ? (
              <div>
                <ReasonChip code={wide.code} reason={wide.reason} />
              </div>
            ) : (
              <div className="grid gap-1">
                {PREVIEW_KEYS.map((k) => (
                  <KindLine key={k} kind={k} day={day} zone={zone} maxTimes={4} />
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
