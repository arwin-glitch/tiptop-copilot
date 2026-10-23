import type { NextRequest } from 'next/server';
import { publicDone, publicFail, visitorGate } from '@/lib/booking/route-helpers';
import { getStore } from '@/lib/runtime';
import { loadManagePage } from '@/lib/services/booking-manage';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string; token: string }> };

/**
 * A booking's own page as data (D-078): the booking as it stands, after a
 * look at the calendar. Public: the token in the path is the only key (its
 * SHA-256 finds the row; the token is never stored or logged), braked per
 * address. Nothing about the host's calendar is returned.
 */
export async function GET(request: NextRequest, context: Context) {
  const gate = visitorGate(request, {
    limits: [{ bucket: 'booking-manage', max: 60, windowMs: 600_000 }],
  });
  if (!gate.ok) return gate.response;
  const { slug, token } = await context.params;
  const page = await loadManagePage(getStore(), slug, token);
  if (page.state !== 'ok') {
    return publicFail({ code: 'not_found', message: 'This booking is not here any more.' });
  }
  return publicDone({ page });
}
