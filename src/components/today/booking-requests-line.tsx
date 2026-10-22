import Link from 'next/link';
import { CalendarPlus } from 'lucide-react';

/**
 * Today's one quiet line about the booking link: how many requests wait for
 * an answer, and where to answer them (the Calendar tab's Booking requests drawer). Shown only
 * when at least one waits. A line, not a card: it takes no room from Top
 * priorities or the glance cards.
 */
export function BookingRequestsLine({ count }: { count: number }) {
  return (
    <p className="mb-5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-[var(--fg-muted)]">
      <CalendarPlus className="size-3.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
      <span>
        {count} booking {count === 1 ? 'request' : 'requests'} waiting.
      </span>
      <Link href="/calendar#booking-requests" className="link-inline">
        Review in Calendar →
      </Link>
    </p>
  );
}
