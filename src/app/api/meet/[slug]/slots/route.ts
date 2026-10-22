import type { NextRequest } from 'next/server';
import { publicDone, visitorGate } from '@/lib/booking/route-helpers';
import { getStore } from '@/lib/runtime';
import { publicSlots } from '@/lib/services/booking';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/**
 * Open times on a booking link: start and end instants for one meeting type
 * (and kind), nothing else. Public: no session, a per-address brake. A link
 * that is off, missing or not set up answers "closed" with no times.
 */
export async function GET(request: NextRequest, context: Context) {
  const gate = visitorGate(request, {
    limits: [{ bucket: 'booking-slots', max: 120, windowMs: 600_000 }],
  });
  if (!gate.ok) return gate.response;
  const { slug } = await context.params;
  const params = request.nextUrl.searchParams;
  const slots = await publicSlots(getStore(), slug, {
    type: params.get('type'),
    kind: params.get('kind'),
  });
  return publicDone({ ...slots });
}
