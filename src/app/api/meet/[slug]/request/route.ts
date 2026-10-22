import type { NextRequest } from 'next/server';
import { BOOKING_REQUEST_INPUT, firstProblem } from '@/lib/booking/request';
import { BOOKED_MESSAGE, SENT_MESSAGE } from '@/lib/booking/public';
import { publicDone, publicFail, readJson, visitorGate } from '@/lib/booking/route-helpers';
import { getStore } from '@/lib/runtime';
import { submitBookingRequest, type SubmitStatus } from '@/lib/services/booking';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/**
 * A visitor's meeting request (or message) from the booking page. Public:
 * no session; it must come from the page itself, within the per-address and
 * per-email brakes, and at most three requests may wait per email address.
 * It is kept as pending; with Instant booking on, the service then books a
 * free time once (D-074 addendum). The answer's `status` says which:
 * 'booked', 'pending' or 'message'. An instant booking that could not go
 * through is just 'pending': the visitor never sees an error for it.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = visitorGate(request, {
    write: true,
    limits: [
      { bucket: 'booking-request', max: 5, windowMs: 600_000 },
      { bucket: 'booking-request-day', max: 20, windowMs: 86_400_000 },
    ],
  });
  if (!gate.ok) return gate.response;
  const body = await readJson(request);
  const parsed = BOOKING_REQUEST_INPUT.safeParse(body ?? {});
  if (!parsed.success) {
    return publicFail({ code: 'invalid_input', message: firstProblem(parsed.error) });
  }
  const { slug } = await context.params;
  const saved = await submitBookingRequest(getStore(), slug, parsed.data, {
    ipHash: gate.visitor.ipHash,
  });
  if (!saved.ok) return publicFail(saved.error);
  // The honeypot gets the answer of a request that waits, and nothing was
  // kept: never "booked", since nothing was.
  const status: SubmitStatus =
    saved.value.kind === 'saved'
      ? saved.value.status
      : parsed.data.type === 'message'
        ? 'message'
        : 'pending';
  return publicDone({ status, message: status === 'booked' ? BOOKED_MESSAGE : SENT_MESSAGE });
}
