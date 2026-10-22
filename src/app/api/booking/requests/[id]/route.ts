import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';
import { approveBookingRequest, markBookingRequest } from '@/lib/services/booking';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const BODY = z
  .object({ action: z.enum(['approve', 'decline', 'handled', 'added_by_hand']) })
  .strict();

/**
 * A person's answer to a booking request, from the Calendar tab's Booking requests drawer:
 * Approve (re-check, then the event on the host's calendar with the
 * requester invited), Decline, mark a message handled, or record that it was
 * added in Google Calendar by hand. Signed in, a member or above, from
 * Copilot's own pages, within a rate limit. Every answer is audited.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await calendarAuth(request, { bucket: 'booking', max: 30, write: true });
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Pick an answer.' });
  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return fail({ code: 'not_found', message: 'That request is not here any more.' });
  }
  const ctx = {
    store: getStore(),
    organizationId: gate.auth.organizationId,
    userId: gate.auth.userId,
  };
  if (parsed.data.action === 'approve') {
    const approved = await approveBookingRequest(ctx, id);
    if (!approved.ok) return fail(approved.error);
    return done({ outcome: approved.value });
  }
  const marked = await markBookingRequest(ctx, id, parsed.data.action);
  if (!marked.ok) return fail(marked.error);
  return done({ outcome: marked.value });
}
