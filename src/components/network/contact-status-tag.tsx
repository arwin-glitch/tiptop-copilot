import { Badge, type BadgeProps } from '@/components/ui/badge';
import {
  CONTACT_STATUS_LABELS,
  contactStatus,
  daysSinceContact,
  lastContactTone,
  type ContactStatus,
} from '@/lib/network/contact-status';
import { cn } from '@/lib/util/cn';

/**
 * The relationship status tag under a name (Recently contacted, Losing
 * touch, Lost touch, Never contacted), the last-contact cell of a list, and
 * the signal bars beside a connection. No 'use client': these render in
 * server pages and in the search palette alike.
 */

const TONE: Record<ContactStatus, NonNullable<BadgeProps['tone']>> = {
  recent: 'accent',
  losing: 'warn',
  lost: 'danger',
  never: 'outline',
};

export function ContactStatusTag({
  status,
  className,
  title,
}: {
  status: ContactStatus;
  className?: string;
  title?: string;
}) {
  return (
    <Badge
      tone={TONE[status]}
      className={className}
      data-contact-status={status}
      title={title ?? CONTACT_STATUS_LABELS[status]}
    >
      {CONTACT_STATUS_LABELS[status]}
    </Badge>
  );
}

const TEXT_TONE = {
  ok: 'text-[var(--accent)]',
  warn: 'text-[var(--warn)]',
  muted: 'text-[var(--fg-subtle)]',
} as const;

/** "12d ago" style: today, 3d, 5w, 4mo, 2y. */
export function shortAgo(days: number): string {
  if (days === 0) return 'today';
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.round(days / 7)}w ago`;
  if (days < 730) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

export function formatContactDate(at: string, timezone: string, withTime = false): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(new Date(at));
}

/** A list's Last contact cell: relative and the date, green recent, amber older, muted lost. */
export function LastContactCell({
  at,
  timezone,
  now = new Date(),
}: {
  at: string | null;
  timezone: string;
  now?: Date;
}) {
  const days = daysSinceContact(at, now);
  if (!at || days === null) {
    return <span className="text-[var(--fg-subtle)]">—</span>;
  }
  const tone = lastContactTone(contactStatus(at, now));
  return (
    <span className="tabular whitespace-nowrap" data-last-contact={tone}>
      <span className={cn('font-medium', TEXT_TONE[tone])}>{shortAgo(days)}</span>
      <span className="text-mini ml-1.5 text-[var(--fg-subtle)]">
        {formatContactDate(at, timezone)}
      </span>
    </span>
  );
}

/** Four signal bars, filled to `bars` (0–4), with the meaning for screen readers. */
export function SignalBars({ bars, className }: { bars: number; className?: string }) {
  return (
    <span
      className={cn('inline-flex items-end gap-[2px]', className)}
      role="img"
      aria-label={`Relationship strength ${bars} of 4`}
      data-signal-bars={bars}
    >
      {[1, 2, 3, 4].map((n) => (
        <span
          key={n}
          className={cn(
            'w-[3px] rounded-sm',
            n <= bars ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]',
          )}
          style={{ height: `${4 + n * 3}px` }}
        />
      ))}
    </span>
  );
}
