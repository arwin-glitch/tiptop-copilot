import type { NextRequest } from 'next/server';
import { requireRole } from '@/lib/auth/session';
import { BOOKING_SCOPES, type BookingScope } from '@/lib/booking/bookings';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';
import { listLinkBookings } from '@/lib/services/booking-manage';

export const dynamic = 'force-dynamic';

/**
 * The booking link's bookings for the Booking tab (D-078):
 * `?scope=upcoming|past|messages` -> `{ bookings: LinkBooking[],
 * calendarEditing }`. Signed in, a member or above. Held times are placed
 * first when calendar editing is on.
 */
export async function GET(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'booking-list', max: 60 });
  if (!gate.ok) return gate.response;
  const member = requireRole(gate.auth, 'member');
  if (!member.ok) return fail(member.error);
  const raw = request.nextUrl.searchParams.get('scope') ?? 'upcoming';
  if (!(BOOKING_SCOPES as readonly string[]).includes(raw)) {
    return fail({ code: 'invalid_input', message: 'Pick upcoming, past or messages.' });
  }
  const list = await listLinkBookings(getStore(), gate.auth.organizationId, raw as BookingScope);
  return done({
    bookings: list.bookings,
    available: list.available,
    calendarEditing: list.calendarEditing,
  });
}
