'use client';

import * as React from 'react';
import Link from 'next/link';
import { CalendarCheck } from 'lucide-react';

/** The old address of the requests drawer, from Today's line and older links. */
const OLD_HASH = '#booking-requests';

/**
 * The Calendar tab's small "Booking link" shortcut (D-078): over the page
 * header's top right, out of the flow so the calendar never moves, it goes
 * to the Booking tab. A link to the old requests drawer on this page
 * (/calendar#booking-requests) is sent on to the Bookings subtab, where the
 * drawer now opens.
 */
export function BookingShortcut({ waiting }: { waiting: number }) {
  React.useEffect(() => {
    if (window.location.hash === OLD_HASH) {
      window.location.replace(`/booking?tab=bookings${OLD_HASH}`);
    }
  }, []);
  return (
    <Link
      href="/booking"
      data-tour="calendar-bookings"
      className="dark shadow-raised absolute top-0 right-0 z-10 inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--gold-rule)] bg-[var(--bg-raised)] px-3 text-[13px] font-medium text-[var(--fg)] hover:bg-[var(--bg-hover)]"
    >
      <CalendarCheck className="size-3.5 text-[var(--accent)]" aria-hidden="true" />
      <span>Booking link</span>
      {waiting ? (
        <span className="tabular rounded-full bg-[var(--primary)] px-1.5 text-[11px] leading-[18px] font-semibold text-[var(--primary-fg)]">
          {waiting}
          <span className="sr-only"> waiting</span>
        </span>
      ) : null}
    </Link>
  );
}
