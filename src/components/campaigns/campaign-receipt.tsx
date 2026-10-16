import { AlertTriangle, Check, ChevronRight } from 'lucide-react';
import {
  deliveredHint,
  issuesHint,
  receiptHeadline,
  type CampaignReceipt as Receipt,
  type ReceiptVariant,
} from '@/lib/campaigns/receipt';
import { cn } from '@/lib/util/cn';
import { formatMonthDay, formatTime } from '@/lib/util/time';

const TILE =
  'min-w-0 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--bg-sunken)] px-3 py-2.5 text-left';
const LABEL = 'text-micro block font-medium tracking-wider text-[var(--fg-subtle)] uppercase';
// A step smaller on a phone, where three tiles share about 300px; it wraps
// rather than spill out of its tile when a count runs to four digits.
const VALUE =
  'tabular sm:text-title mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-base leading-none font-semibold';
const HINT = 'text-mini mt-1 block text-[var(--fg-subtle)]';

const yearIn = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(new Date(iso));

/** "Friday, October 16, 2026 at 3:05 PM CDT", for the Sent tile's hover. */
function fullDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(iso));
}

/**
 * The receipt at the top of a finished campaign, like the one Affinity emails
 * after a bulk send: when it went, how many it reached, how many need a look.
 * Tapping Issues shows those people in the recipients list below.
 */
export function CampaignReceipt({
  receipt,
  variant,
  at,
  timezone,
  now,
  onShowIssues,
}: {
  receipt: Receipt;
  variant: ReceiptVariant;
  /** When it finished (or, stopped, the last email), ISO. */
  at: string | null;
  timezone: string;
  /** The server's clock (ISO), so an earlier year's send shows its year. */
  now: string;
  onShowIssues?: () => void;
}) {
  const clean = receipt.issues === 0;
  const headline = receiptHeadline(receipt, variant);
  const issuesInner = (
    <>
      <span className={LABEL}>Issues</span>
      <span className={VALUE}>
        {receipt.issues}
        {clean ? (
          <Check className="size-4 text-[var(--ok)]" strokeWidth={3} aria-label="None" />
        ) : (
          <AlertTriangle className="size-4" aria-hidden="true" />
        )}
      </span>
      <span className={cn(HINT, !clean && 'text-[var(--warn)]')}>
        {issuesHint(receipt)}
        {!clean && onShowIssues ? (
          <span className="mt-0.5 flex items-center gap-0.5 font-medium underline underline-offset-2">
            See who
            <ChevronRight className="size-3" aria-hidden="true" />
          </span>
        ) : null}
      </span>
    </>
  );

  return (
    <section
      aria-label="Campaign receipt"
      className="shadow-raised rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-[var(--gutter)]"
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-full',
            clean
              ? 'bg-[var(--ok-soft)] text-[var(--ok)]'
              : 'bg-[var(--warn-soft)] text-[var(--warn)]',
          )}
        >
          {clean ? (
            <Check className="size-4" strokeWidth={3} />
          ) : (
            <AlertTriangle className="size-4" />
          )}
        </span>
        <h2 className="font-serif text-lg leading-tight font-semibold">{headline}</h2>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-3">
        <div className={TILE}>
          <span className={LABEL}>{variant === 'stopped' ? 'Last sent' : 'Sent'}</span>
          {at ? (
            <>
              <time dateTime={at} title={fullDateTime(at, timezone)} className={cn(VALUE, 'block')}>
                {formatMonthDay(at, timezone)}
              </time>
              {/* The year only when it is not this year; a phone has no hover. */}
              <span className={HINT}>
                {yearIn(at, timezone) === yearIn(now, timezone)
                  ? formatTime(at, timezone)
                  : `${yearIn(at, timezone)} · ${formatTime(at, timezone)}`}
              </span>
            </>
          ) : (
            <span className="text-note mt-1 block text-[var(--fg-subtle)] italic">
              Not recorded
            </span>
          )}
        </div>
        <div className={TILE}>
          <span className={LABEL}>Delivered</span>
          {/* The gap matches the space after the slash: "106 / 106". */}
          <span className={cn(VALUE, 'gap-x-1')}>
            <span>{receipt.delivered}</span>{' '}
            <span className="whitespace-nowrap">/ {receipt.total}</span>
          </span>
          <span className={HINT}>{deliveredHint(receipt)}</span>
        </div>
        {!clean && onShowIssues ? (
          <button
            type="button"
            onClick={onShowIssues}
            className={cn(
              TILE,
              'border-[var(--warn)]/40 bg-[var(--warn-soft)] text-[var(--warn)] transition-colors hover:border-[var(--warn)]',
            )}
          >
            {issuesInner}
          </button>
        ) : (
          <div
            className={cn(
              TILE,
              !clean && 'border-[var(--warn)]/40 bg-[var(--warn-soft)] text-[var(--warn)]',
            )}
          >
            {issuesInner}
          </div>
        )}
      </div>
      {receipt.skipped > 0 ? (
        <p className="text-mini mt-3 text-[var(--fg-subtle)]">
          Skipped people were never sent this email: they had unsubscribed, were added after you
          confirmed, or the campaign was cancelled first. They are not counted as issues.
        </p>
      ) : null}
    </section>
  );
}
