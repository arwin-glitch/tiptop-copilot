'use client';

import * as React from 'react';
import Link from 'next/link';
import { CalendarCheck2, CalendarClock, Hourglass, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  bookedTitle,
  HELD_MESSAGE,
  MESSAGE_SENT,
  SENT_MESSAGE,
  type BookingOutcomeStatus,
  type PublicBookingView,
} from '@/lib/booking/public';
import { AddToCalendarButton, BookingDetails, bookingZone } from './booking-details';

/**
 * What a visitor sees once they book (D-078): "You're booked with Nick",
 * when (their zone and the host's), what and where, who is coming, "Add to
 * calendar", and the booking's own page to reschedule or cancel. A held
 * time and a request that waits say so plainly, naming no person: the link
 * works without anyone watching it.
 */
export function BookingConfirmation({
  status,
  booking,
  manageUrl,
  hostName,
  visitorZone,
  onAnother,
}: {
  status: BookingOutcomeStatus;
  booking: PublicBookingView | null;
  manageUrl: string | null;
  hostName: string;
  visitorZone: string | null;
  onAnother: () => void;
}) {
  const icon =
    status === 'booked' ? (
      <CalendarCheck2 className="mx-auto size-9 text-[var(--accent)]" aria-hidden="true" />
    ) : status === 'held' ? (
      <Hourglass className="mx-auto size-9 text-[var(--accent)]" aria-hidden="true" />
    ) : status === 'message' ? (
      <MessageSquare className="mx-auto size-9 text-[var(--accent)]" aria-hidden="true" />
    ) : (
      <CalendarClock className="mx-auto size-9 text-[var(--accent)]" aria-hidden="true" />
    );
  const [title, sub] =
    status === 'booked'
      ? [
          bookedTitle(hostName),
          booking ? `The calendar invitation is on its way to ${booking.email}.` : null,
        ]
      : status === 'held'
        ? ['Your time is held', HELD_MESSAGE.replace(/^Your time is held\.\s*/, '')]
        : status === 'message'
          ? [MESSAGE_SENT, `Your message is with ${hostName}.`]
          : [SENT_MESSAGE, null];

  return (
    <section
      className="shadow-raised mx-auto max-w-lg rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--bg-raised)] p-5 sm:p-6"
      aria-live="polite"
      aria-labelledby="booking-confirmed-title"
    >
      <div className="text-center">
        {icon}
        <h1 id="booking-confirmed-title" className="mt-3 font-serif text-2xl font-semibold">
          {title}
        </h1>
        {sub ? <p className="mt-1.5 text-sm text-[var(--fg-muted)]">{sub}</p> : null}
      </div>
      {booking ? (
        <div className="mt-5 border-t border-[var(--border)] pt-5">
          <BookingDetails booking={booking} zone={bookingZone(booking, visitorZone)} />
        </div>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-5">
        {booking && status === 'booked' ? (
          <AddToCalendarButton booking={booking} hostName={hostName} manageUrl={manageUrl} />
        ) : null}
        {manageUrl ? (
          <Link
            href={manageUrl}
            className="inline-flex h-9 items-center rounded-md px-3.5 text-sm font-medium text-[var(--accent)] underline decoration-[color:var(--link-underline)] underline-offset-4 hover:text-[var(--accent-hover)]"
          >
            Reschedule or cancel
          </Link>
        ) : null}
        <Button type="button" variant="ghost" className="sm:ml-auto" onClick={onAnother}>
          {status === 'message' ? 'Back to the booking page' : 'Book another time'}
        </Button>
      </div>
      {manageUrl ? (
        <p className="mt-3 text-xs text-[var(--fg-subtle)]">
          To change or cancel later, come back to this booking link on this device
          {status === 'booked' ? ', or use the link in your invitation' : ''}.
        </p>
      ) : null}
    </section>
  );
}
