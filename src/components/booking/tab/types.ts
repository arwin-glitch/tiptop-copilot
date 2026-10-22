/**
 * A booking as the Bookings list shows it: the shared contract's
 * `LinkBooking` (lib/booking/bookings.ts, from the bookings API,
 * GET /api/booking/bookings?scope=upcoming|past|messages), copied here
 * field for field so this tab builds before that module lands.
 *
 * TODO(integrator): once lib/booking/bookings.ts is in, replace this with
 * `export type { LinkBooking as TabBooking } from '@/lib/booking/bookings';`
 * (`visitorTimeZone` is read when the API sends it, and is optional).
 */
export interface TabBooking {
  id: string;
  status: 'booked' | 'held' | 'pending' | 'cancelled' | 'declined' | 'message';
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
  eventLink: string | null;
  /** The visitor's own zone, when the API sends it (not in the contract). */
  visitorTimeZone?: string | null;
}
