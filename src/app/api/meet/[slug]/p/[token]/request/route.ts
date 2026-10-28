import type { NextRequest } from 'next/server';
import { HELD_MESSAGE } from '@/lib/booking/public';
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
import { pickSlots, submitPickBooking } from '@/lib/services/booking-picks';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string; token: string }> };

/**
 * A guest books one of a pick's starts (Pick times). Public: from the page
 * itself, within the same per-address and per-email brakes as the booking
 * link. Booked at once (or held while the calendar cannot be written),
 * never waiting for approval. The answer is `{ ok, status: 'booked' |
 * 'held', message, manageUrl?, booking? }`; a start taken a moment ago
 * answers 409 with the starts that remain (`next`), a pick that is gone 404.
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
  const { slug, token } = await context.params;
  const store = getStore();
  const saved = await submitPickBooking(store, slug, token, parsed.data, {
    ipHash: gate.visitor.ipHash,
  });
  if (!saved.ok) {
    if (saved.error.code === 'conflict') {
      const left = await pickSlots(store, slug, token).catch(() => null);
      return publicFail(saved.error, 409, { next: left?.state === 'ok' ? left.slots : [] });
    }
    return publicFail(saved.error);
  }
  const { result } = saved.value;
  const response = publicDone({
    status: result.status,
    message: result.status === 'held' ? HELD_MESSAGE : 'Booked.',
    ...(result.manageUrl ? { manageUrl: result.manageUrl } : {}),
    ...(result.booking ? { booking: result.booking } : {}),
  });
  const manageToken = tokenOfManagePath(result.manageUrl);
  return manageToken ? rememberBookingCookie(response, request, slug, manageToken) : response;
}
