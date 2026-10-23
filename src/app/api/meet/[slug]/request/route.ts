import type { NextRequest } from 'next/server';
import { MESSAGE_SENT, SENT_MESSAGE, HELD_MESSAGE } from '@/lib/booking/public';
import { BOOKING_REQUEST_INPUT, firstProblem } from '@/lib/booking/request';
import {
  publicDone,
  publicFail,
  readJson,
  rememberBookingCookie,
  tokenOfManagePath,
  visitorGate,
} from '@/lib/booking/route-helpers';
import { getStore } from '@/lib/runtime';
import { nextOpenTimes, submitBookingRequest } from '@/lib/services/booking';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/**
 * A visitor's booking (or message) from the booking page (D-078). Public: no
 * session; it must come from the page itself, within the per-address and
 * per-email brakes and the caps. A free time that passes every rule is
 * booked at once (the invitation is Google's), held while calendar editing
 * is off, or waits for approval when Settings asks for that. The answer is
 * `{ ok, status: 'booked' | 'held' | 'pending' | 'message', manageUrl?,
 * booking? }`; a time taken a moment ago answers 409 with the next open times.
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
  const store = getStore();
  const saved = await submitBookingRequest(store, slug, parsed.data, {
    ipHash: gate.visitor.ipHash,
  });
  if (!saved.ok) {
    if (saved.error.code === 'conflict' && parsed.data.type !== 'message') {
      const next = await nextOpenTimes(store, slug, {
        type: parsed.data.type,
        kind: parsed.data.kind,
      });
      return publicFail(saved.error, 409, { next });
    }
    return publicFail(saved.error);
  }
  // The honeypot gets the same answer as a person, and nothing was kept.
  const { result } = saved.value;
  const message =
    result.status === 'message'
      ? MESSAGE_SENT
      : result.status === 'held'
        ? HELD_MESSAGE
        : result.status === 'pending'
          ? SENT_MESSAGE
          : 'Booked.';
  const response = publicDone({
    status: result.status,
    message,
    ...(result.manageUrl ? { manageUrl: result.manageUrl } : {}),
    ...(result.booking ? { booking: result.booking } : {}),
  });
  // This device remembers it, for "You have a meeting with ..." on the page.
  const token = tokenOfManagePath(result.manageUrl);
  return token ? rememberBookingCookie(response, request, slug, token) : response;
}
