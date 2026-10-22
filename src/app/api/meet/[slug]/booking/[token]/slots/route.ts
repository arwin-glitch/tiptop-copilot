import type { NextRequest } from 'next/server';
import { publicDone, publicFail, visitorGate } from '@/lib/booking/route-helpers';
import { getStore } from '@/lib/runtime';
import { manageSlots } from '@/lib/services/booking-manage';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string; token: string }> };

/**
 * Open times to move a booking to (D-078): the booking page's own rules,
 * with this booking left out so the times next to it are offered. Start and
 * end instants only.
 */
export async function GET(request: NextRequest, context: Context) {
  const gate = visitorGate(request, {
    limits: [{ bucket: 'booking-manage-slots', max: 60, windowMs: 600_000 }],
  });
  if (!gate.ok) return gate.response;
  const { slug, token } = await context.params;
  const slots = await manageSlots(getStore(), slug, token);
  if (!slots) return publicFail({ code: 'not_found', message: 'This booking is not here any more.' });
  return publicDone({ ...slots });
}
