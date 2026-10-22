import Link from 'next/link';
import { AlertTriangle, CalendarPlus } from 'lucide-react';
import { BOOKING_TAB_PATH } from '@/lib/booking/bookings';
import type { BookingTodaySummary } from '@/lib/services/booking-alerts';

/**
 * Today's quiet lines about the booking link (D-074, D-078): what happened
 * in the last day (new bookings, moves, cancellations with the latest note),
 * how many requests wait for an answer (approve first), and, when a time is
 * held because calendar editing is off, the one thing to do about it. Lines,
 * not cards: they take no room from Top priorities or the glance cards, and
 * nothing shows when there is nothing to say.
 */

/** The grant flow that turns calendar editing on (the opt-in event scope). */
export const TURN_ON_EDITING_HREF = '/api/integrations/google/start?calendar=1';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function hasBookingNews(
  summary: BookingTodaySummary | null,
): summary is BookingTodaySummary {
  return Boolean(
    summary &&
    (summary.waiting || summary.held || summary.booked || summary.moved || summary.cancelled),
  );
}

export function BookingRequestsLine({ summary }: { summary: BookingTodaySummary }) {
  const news = [
    summary.booked ? `${plural(summary.booked, 'new booking')}` : null,
    summary.moved ? `${plural(summary.moved, 'move')}` : null,
    summary.cancelled ? `${plural(summary.cancelled, 'cancellation')}` : null,
  ].filter(Boolean);
  return (
    <div className="mb-5 space-y-1.5 text-sm text-[var(--fg-muted)]">
      {summary.held ? (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md border border-[var(--warn)]/30 bg-[var(--warn-soft)] px-3 py-2 text-[var(--fg)]">
          <AlertTriangle className="size-3.5 shrink-0 text-[var(--warn)]" aria-hidden="true" />
          <span>
            {plural(summary.held, 'booking time is', 'booking times are')} held. Turn on calendar
            editing so invites go out automatically.
          </span>
          <a href={TURN_ON_EDITING_HREF} className="link-inline font-medium">
            Turn on calendar editing →
          </a>
        </p>
      ) : null}
      {news.length ? (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <CalendarPlus className="size-3.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
          <span>Booking link, last day: {news.join(' · ')}.</span>
          {summary.latestNote ? (
            <span className="text-[var(--fg)]">{summary.latestNote}</span>
          ) : null}
          <Link href={BOOKING_TAB_PATH} className="link-inline">
            Open Booking →
          </Link>
        </p>
      ) : null}
      {summary.waiting ? (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <CalendarPlus className="size-3.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
          <span>
            {summary.waiting} booking {summary.waiting === 1 ? 'request' : 'requests'} waiting.
          </span>
          <Link href="/calendar#booking-requests" className="link-inline">
            Review in Calendar →
          </Link>
        </p>
      ) : null}
    </div>
  );
}
