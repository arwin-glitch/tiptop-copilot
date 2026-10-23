import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { CANCEL_NOTE_MAX } from '@/lib/booking/request';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';
import { cancelBookingFromCopilot } from '@/lib/services/booking-manage';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const BODY = z.object({ note: z.string().trim().max(CANCEL_NOTE_MAX).optional() }).strict();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cancel a link booking from Copilot's Booking tab (D-078): the Google event
 * deleted with Google's cancellation to everyone invited, the booking marked
 * cancelled by the team. Signed in, a member or above, from Copilot's own
 * pages, within a rate limit; audited.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await calendarAuth(request, { bucket: 'booking-cancel', max: 20, write: true });
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return fail({
      code: 'invalid_input',
      message: `Keep the note under ${CANCEL_NOTE_MAX} characters.`,
    });
  }
  const { id } = await context.params;
  if (!UUID.test(id))
    return fail({ code: 'not_found', message: 'This booking is not here any more.' });
  const cancelled = await cancelBookingFromCopilot(
    { store: getStore(), organizationId: gate.auth.organizationId, userId: gate.auth.userId },
    id,
    parsed.data.note ?? '',
  );
  if (!cancelled.ok) return fail(cancelled.error);
  return done({
    removedEvent: cancelled.value.removedEvent,
    calendarLeft: cancelled.value.calendarLeft,
  });
}
