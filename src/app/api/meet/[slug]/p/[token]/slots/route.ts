import type { NextRequest } from 'next/server';
import { publicDone, visitorGate } from '@/lib/booking/route-helpers';
import { getStore } from '@/lib/runtime';
import { pickSlots } from '@/lib/services/booking-picks';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string; token: string }> };

/**
 * The starts a pick's guest may book (Pick times): start and end instants
 * inside the host's picked ranges, nothing else. Public: the token in the
 * path is the only key, braked per address. A used, cancelled, expired or
 * unknown pick answers "closed" with no times.
 */
export async function GET(request: NextRequest, context: Context) {
  const gate = visitorGate(request, {
    limits: [{ bucket: 'booking-pick-slots', max: 60, windowMs: 600_000 }],
  });
  if (!gate.ok) return gate.response;
  const { slug, token } = await context.params;
  const slots = await pickSlots(getStore(), slug, token);
  return publicDone({ ...slots });
}
