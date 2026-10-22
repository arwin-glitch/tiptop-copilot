import type { NextRequest } from 'next/server';
import { firstProblem, RESCHEDULE_INPUT } from '@/lib/booking/request';
import { publicDone, publicFail, readJson, visitorGate } from '@/lib/booking/route-helpers';
import { getStore } from '@/lib/runtime';
import { rescheduleByToken } from '@/lib/services/booking-manage';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string; token: string }> };

/**
 * Move a booking from its own page (D-078): checked again against the live
 * calendar and every rule, then the same Google event moves, and Google tells
 * everyone invited. From the page itself only, braked per address.
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
  const parsed = RESCHEDULE_INPUT.safeParse((await readJson(request, 4_000)) ?? {});
  if (!parsed.success) {
    return publicFail({ code: 'invalid_input', message: firstProblem(parsed.error) });
  }
  if (parsed.data.website.trim()) return publicDone({});
  const { slug, token } = await context.params;
  const moved = await rescheduleByToken(getStore(), slug, token, parsed.data.start);
  if (!moved.ok) return publicFail(moved.error);
  return publicDone({ booking: moved.value, message: 'Rescheduled.' });
}
