import type { NextRequest } from 'next/server';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { daysOf } from '@/lib/booking/months';
import { getStore } from '@/lib/runtime';
import { bookingPreview, MAX_PREVIEW_DAYS } from '@/lib/services/booking-planner';
import { addDaysToKey } from '@/lib/util/time';

export const dynamic = 'force-dynamic';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * The Booking tab's live preview (D-078): the open times the public page
 * offers on each day, per kind of meeting, and why a day offers none. Either
 * a month (`?month=2026-11`) or a run of days (`?from=2026-10-22&days=14`).
 * Times only, like the public page: no title, guest or place of any entry
 * on the calendar. Signed in (any member), within a rate limit.
 */
export async function GET(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'booking-preview', max: 90 });
  if (!gate.ok) return gate.response;
  const params = request.nextUrl.searchParams;
  const month = params.get('month');
  const from = params.get('from');
  let range: { from: string; to: string } | null = null;
  if (month && MONTH.test(month)) {
    const days = daysOf(month);
    range = { from: days[0]!, to: days[days.length - 1]! };
  } else if (from && DAY.test(from)) {
    const count = Math.min(Math.max(Number(params.get('days')) || 14, 1), MAX_PREVIEW_DAYS);
    range = { from, to: addDaysToKey(from, count - 1) };
  }
  if (!range) return fail({ code: 'invalid_input', message: 'Pick a month or a first day.' });
  const preview = await bookingPreview(getStore(), gate.auth.organizationId, range);
  if (!preview.ok) return fail(preview.error);
  return done({ preview: preview.value });
}
