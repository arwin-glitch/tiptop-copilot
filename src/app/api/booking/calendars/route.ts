import type { NextRequest } from 'next/server';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';
import { bookingCalendars } from '@/lib/services/booking-planner';

export const dynamic = 'force-dynamic';

/**
 * The host's calendars for the Booking tab's Calendars list (D-078): each
 * one's name and colour, and whether it blocks his time on the booking
 * link (by default, and now). Signed in (any member), within a rate limit.
 * The choice itself is saved with the other settings (PATCH
 * /api/booking/settings, `calendarChoices`).
 */
export async function GET(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'booking-calendars', max: 30 });
  if (!gate.ok) return gate.response;
  const found = await bookingCalendars(getStore(), gate.auth.organizationId);
  if (!found.ok) return fail(found.error);
  return done(found.value as unknown as Record<string, unknown>);
}
