import type { NextRequest } from 'next/server';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';
import { retryHeldBooking } from '@/lib/services/booking-manage';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Try now" on a held booking (D-078): Copilot tries to put it on the host's
 * calendar at once, past its backoff, with the same checks as every other
 * try (the time re-checked against the live calendar and every rule, one
 * event at most). Never an approval: a held booking was booked by the
 * visitor already. Signed in, a member or above, from Copilot's own pages,
 * within a rate limit. Answers what it came to.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await calendarAuth(request, { bucket: 'booking-retry', max: 20, write: true });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  if (!UUID.test(id))
    return fail({ code: 'not_found', message: 'This booking is not here any more.' });
  const tried = await retryHeldBooking(getStore(), gate.auth.organizationId, id);
  if (!tried.ok) return fail(tried.error);
  return done({ status: tried.value.status, holdReason: tried.value.holdReason });
}
