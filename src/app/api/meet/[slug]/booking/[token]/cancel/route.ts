import type { NextRequest } from 'next/server';
import { CANCEL_INPUT, firstProblem } from '@/lib/booking/request';
import {
  publicDone,
  publicFail,
  readJson,
  rememberBookingCookie,
  visitorGate,
} from '@/lib/booking/route-helpers';
import { getStore } from '@/lib/runtime';
import { cancelByToken } from '@/lib/services/booking-manage';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string; token: string }> };

/**
 * Cancel a booking from its own page (D-078), with an optional note (500
 * characters at most) that reaches the host as a Kraken alert. The Google
 * event is deleted and Google sends everyone its cancellation. From the page
 * itself only, braked per address.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = visitorGate(request, {
    write: true,
    limits: [
      { bucket: 'booking-manage-write', max: 10, windowMs: 600_000 },
      { bucket: 'booking-manage-write-day', max: 30, windowMs: 86_400_000 },
    ],
  });
  if (!gate.ok) return gate.response;
  const parsed = CANCEL_INPUT.safeParse((await readJson(request, 4_000)) ?? {});
  if (!parsed.success) {
    return publicFail({ code: 'invalid_input', message: firstProblem(parsed.error) });
  }
  if (parsed.data.website.trim()) return publicDone({});
  const { slug, token } = await context.params;
  const cancelled = await cancelByToken(getStore(), slug, token, parsed.data.note);
  if (!cancelled.ok) return publicFail(cancelled.error);
  // Forgotten on this device: there is no meeting to point to any more.
  return rememberBookingCookie(
    publicDone({ booking: cancelled.value, message: 'Cancelled.' }),
    request,
    slug,
    null,
  );
}
