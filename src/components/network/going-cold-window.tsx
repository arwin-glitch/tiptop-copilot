import Link from 'next/link';
import { DEFAULT_GOING_COLD_DAYS } from '@/lib/network/strength';
import { cn } from '@/lib/util/cn';

const WINDOWS = [30, DEFAULT_GOING_COLD_DAYS, 90, 180] as const;

/**
 * What "going cold" means on the Network page, and the switch for how quiet
 * counts as cold. The window is URL state (`?days=`), so a link to the tab
 * keeps it.
 */
export function GoingColdWindow({ days }: { days: number }) {
  return (
    <p className="text-mini -mt-3 mb-6 text-[var(--fg-subtle)]">
      Includes Strong and Warm relationships from your mail and calendar with no email or meeting
      for {days}+ days and nothing booked. Quiet for:{' '}
      {WINDOWS.map((w, i) => (
        <span key={w}>
          {i > 0 ? ' · ' : null}
          <Link
            href={
              w === DEFAULT_GOING_COLD_DAYS ? '/network?tab=cold' : `/network?tab=cold&days=${w}`
            }
            aria-current={w === days ? 'true' : undefined}
            className={cn(
              'underline-offset-2 hover:underline',
              w === days ? 'font-semibold text-[var(--fg)]' : 'text-[var(--accent)]',
            )}
          >
            {w} days
          </Link>
        </span>
      ))}
    </p>
  );
}
