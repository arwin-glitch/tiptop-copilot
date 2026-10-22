import type { BookingRequest } from '@/lib/types/domain';

/**
 * The link's bookings as the Booking tab shows them (D-078): one shape for a
 * meeting booked at once, a held time, a request waiting for approval, a
 * cancelled or declined one, and a message. Pure and client-safe: the
 * Bookings API (GET /api/booking/bookings) returns exactly this, and the
 * tab renders it. Never the manage token or its hash, never the sender's
 * address hash.
 */

export type LinkBookingStatus = 'booked' | 'held' | 'pending' | 'cancelled' | 'declined' | 'message';

export interface LinkBooking {
  id: string;
  status: LinkBookingStatus;
  type: 'call' | 'in_person' | 'message';
  kind: 'coffee' | 'lunch' | 'dinner' | null;
  startsAt: string | null;
  endsAt: string | null;
  name: string;
  email: string;
  company: string | null;
  guests: string[];
  placeName: string | null;
  placeArea: string | null;
  note: string | null;
  deckUrl: string | null;
  cancelNote: string | null;
  source: 'form' | 'chatbot';
  createdAt: string;
  rescheduledCount: number;
  /** The event in Google Calendar, when Copilot made it. */
  eventLink: string | null;
}

export const BOOKING_SCOPES = ['upcoming', 'past', 'messages'] as const;
export type BookingScope = (typeof BOOKING_SCOPES)[number];

/** The status the tab shows for a stored row. */
export function linkStatus(row: Pick<BookingRequest, 'status' | 'meeting_type'>): LinkBookingStatus {
  if (row.meeting_type === 'message') return 'message';
  switch (row.status) {
    case 'booked':
    case 'approved':
      return 'booked';
    case 'held':
      return 'held';
    case 'pending':
      return 'pending';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'declined';
  }
}

/**
 * Google Calendar's own link to an event: `eid` is the event id and its
 * calendar, base64 without padding (what Google puts in an event's htmlLink).
 */
export function googleEventLink(eventId: string | null, calendarId: string | null): string | null {
  if (!eventId || !calendarId) return null;
  const raw = `${eventId} ${calendarId}`;
  // Event and calendar ids are plain ASCII, so btoa reads them as they are.
  const base64 =
    typeof Buffer !== 'undefined' ? Buffer.from(raw, 'utf8').toString('base64') : btoa(raw);
  return `https://www.google.com/calendar/event?eid=${base64.replace(/=+$/, '')}`;
}

export function toLinkBooking(row: BookingRequest): LinkBooking {
  return {
    id: row.id,
    status: linkStatus(row),
    type: row.meeting_type,
    kind: row.kind,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    name: row.name,
    email: row.email,
    company: row.company,
    guests: [...(row.guest_emails ?? [])],
    placeName: row.place_name,
    placeArea: row.place_area,
    note: row.note,
    deckUrl: row.deck_url,
    cancelNote: row.cancel_note ?? null,
    source: row.source,
    createdAt: row.created_at,
    rescheduledCount: row.rescheduled_count ?? 0,
    eventLink: googleEventLink(row.event_id, row.calendar_id),
  };
}

/**
 * Which list a booking belongs on: messages apart; a meeting is upcoming
 * until it ends (a cancelled one too, until its time, so a fresh
 * cancellation and its note are seen), then past.
 */
export function bookingScope(booking: LinkBooking, now: Date): BookingScope {
  if (booking.type === 'message') return 'messages';
  const end = Date.parse(booking.endsAt ?? booking.startsAt ?? '');
  return Number.isFinite(end) && end > now.getTime() ? 'upcoming' : 'past';
}

/** Upcoming soonest first; past and messages newest first. */
export function sortBookings(list: LinkBooking[], scope: BookingScope): LinkBooking[] {
  const key = (b: LinkBooking) => b.startsAt ?? b.createdAt;
  return [...list].sort((a, b) =>
    scope === 'upcoming' ? key(a).localeCompare(key(b)) : key(b).localeCompare(key(a)),
  );
}
