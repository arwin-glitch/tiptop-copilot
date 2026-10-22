'use client';

import * as React from 'react';
import { CalendarPlus, Clock, MapPin, Users, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KIND_LABEL } from '@/lib/booking/config';
import { icsFile } from '@/lib/booking/event';
import {
  callOptionLabel,
  slotLabel,
  timeLabel,
  zoneName,
  type PublicBookingView,
} from '@/lib/booking/public';

/**
 * One booking, as the visitor sees it on the confirmation and on its own
 * page (D-078): when (their zone, and the host's when it differs), what and
 * where (the call's provider and link, or the place with its map), and who
 * is coming. Plus "Add to calendar", a file built here in the browser.
 */

/** "30-min Zoom call", "30-min Google Meet", "Coffee, 1 hour". */
export function meetingWhat(booking: Pick<PublicBookingView, 'type' | 'kind' | 'video'>): string {
  if (booking.type === 'call') return callOptionLabel(booking.video?.label ?? '');
  return `${booking.kind ? KIND_LABEL[booking.kind] : 'In person'}, 1 hour`;
}

/** The zone a booking's time is read in: in person, the host's (they will be there). */
export function bookingZone(booking: PublicBookingView, visitorZone: string | null): string {
  if (booking.type === 'in_person') return booking.hostTimeZone;
  return visitorZone ?? booking.visitorTimeZone ?? booking.hostTimeZone;
}

export function BookingDetails({
  booking,
  zone,
  struck = false,
}: {
  booking: PublicBookingView;
  zone: string;
  /** A cancelled booking: the time is shown struck through. */
  struck?: boolean;
}) {
  const at = new Date(booking.startsAt);
  const when = `${slotLabel(booking.startsAt, zone)} to ${timeLabel(booking.endsAt, zone)}`;
  const hostWhen =
    zone !== booking.hostTimeZone && zoneName(zone, at) !== zoneName(booking.hostTimeZone, at)
      ? `${slotLabel(booking.startsAt, booking.hostTimeZone)} ${zoneName(booking.hostTimeZone, at)}`
      : null;
  return (
    <dl className="space-y-3 text-sm">
      <Row icon={<Clock className="size-4" aria-hidden="true" />} label="When">
        <span className={struck ? 'line-through' : undefined}>{when}</span>
        <span className="block text-xs text-[var(--fg-muted)]">
          {zoneName(zone, at)}
          {hostWhen ? ` · ${hostWhen}` : ''}
        </span>
      </Row>
      {booking.type === 'call' ? (
        <Row icon={<Video className="size-4" aria-hidden="true" />} label="Where">
          <span>{meetingWhat(booking)}</span>
          {booking.video?.url && !struck ? (
            <a
              href={booking.video.url}
              target="_blank"
              rel="noopener noreferrer"
              className="link-inline block truncate text-xs"
            >
              {booking.video.url.replace(/^https?:\/\//, '')}
            </a>
          ) : (
            <span className="block text-xs text-[var(--fg-muted)]">
              {struck ? '' : 'The link is in the calendar invitation.'}
            </span>
          )}
        </Row>
      ) : (
        <Row icon={<MapPin className="size-4" aria-hidden="true" />} label="Where">
          <span>
            {meetingWhat(booking)}
            {booking.place ? ` at ${booking.place.name}` : ''}
          </span>
          {booking.place?.area ? (
            <span className="block text-xs text-[var(--fg-muted)]">{booking.place.area}</span>
          ) : null}
          {booking.place?.mapUrl ? (
            <a
              href={booking.place.mapUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="link-inline text-xs"
            >
              Open map<span className="sr-only"> for {booking.place.name}</span>
            </a>
          ) : null}
        </Row>
      )}
      <Row icon={<Users className="size-4" aria-hidden="true" />} label="Who">
        <span>
          You <span className="text-[var(--fg-muted)]">({booking.email})</span>
        </span>
        {booking.guests.length ? (
          <ul aria-label="Guests" className="mt-0.5 text-xs text-[var(--fg-muted)]">
            {booking.guests.map((g) => (
              <li key={g} className="truncate">
                {g}
              </li>
            ))}
          </ul>
        ) : null}
      </Row>
    </dl>
  );
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <dt className="text-micro font-medium tracking-[0.12em] text-[var(--label-gold)] uppercase">
          {label}
        </dt>
        <dd className="mt-0.5 min-w-0 break-words">{children}</dd>
      </div>
    </div>
  );
}

/** "Add to calendar": an .ics file built in the browser, with the booking's own page. */
export function AddToCalendarButton({
  booking,
  hostName,
  manageUrl,
}: {
  booking: PublicBookingView;
  hostName: string;
  /** The booking's own page, a path on this site. */
  manageUrl: string | null;
}) {
  const download = () => {
    const page = manageUrl ? new URL(manageUrl, window.location.origin).toString() : null;
    const title =
      booking.type === 'call'
        ? `Call with ${hostName}`
        : `${booking.kind ? KIND_LABEL[booking.kind] : 'Meeting'} with ${hostName}`;
    const location =
      booking.type === 'call'
        ? (booking.video?.url ?? booking.video?.label ?? '')
        : [booking.place?.name, booking.place?.area].filter(Boolean).join(', ');
    const text = icsFile({
      uid: `${booking.startsAt}-${booking.email}@booking.tiptop-copilot`,
      title,
      start: booking.startsAt,
      end: booking.endsAt,
      location,
      description: page ? `Reschedule or cancel: ${page}` : undefined,
      url: page,
    });
    const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  return (
    <Button type="button" variant="secondary" onClick={download}>
      <CalendarPlus aria-hidden="true" />
      Add to calendar
    </Button>
  );
}
