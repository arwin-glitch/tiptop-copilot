import Link from 'next/link';
import { AlertTriangle, Bot, CheckCircle2 } from 'lucide-react';
import type { SorterStatusView } from '@/lib/deals/sorter-status';
import { cn } from '@/lib/util/cn';

/**
 * The one-line strip under the Deals header saying whether the deal-sorter is
 * keeping the pipeline current, and if not, the single thing to fix. The words
 * come from `describeDealSorterStatus`, so the strip and the empty state
 * always agree.
 */
export function DealSorterStatus({
  view,
  className,
}: {
  view: SorterStatusView;
  className?: string;
}) {
  const Icon = view.tone === 'warn' ? AlertTriangle : view.tone === 'ok' ? CheckCircle2 : Bot;
  return (
    <div
      role="status"
      aria-label="Deal-sorter status"
      className={cn(
        'mb-4 flex items-start gap-2.5 rounded-md border px-3 py-2 text-sm',
        view.tone === 'warn'
          ? 'border-[var(--warn)]/30 bg-[var(--warn-soft)]'
          : 'border-[var(--border)] bg-[var(--bg-raised)]',
        className,
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          view.tone === 'warn'
            ? 'text-[var(--warn)]'
            : view.tone === 'ok'
              ? 'text-[var(--ok)]'
              : 'text-[var(--fg-subtle)]',
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="break-words">
          {view.message}
          {view.configLink ? (
            <>
              {' '}
              <Link
                href="/diagnostics"
                className="text-[var(--accent)] underline-offset-2 hover:underline"
              >
                See what is configured
              </Link>
            </>
          ) : null}
        </p>
        {view.detail ? (
          <p className="text-mini mt-0.5 break-words text-[var(--fg-subtle)]">
            Last check: {view.detail}
          </p>
        ) : null}
      </div>
    </div>
  );
}
