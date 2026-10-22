import type { NextRequest } from 'next/server';
import { CHAT_REQUEST, runBookingChat } from '@/lib/booking/chat';
import { publicDone, publicFail, readJson, visitorGate } from '@/lib/booking/route-helpers';
import { getStore } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/**
 * The booking page assistant (D-078): the opening, the next open times, or
 * a question answered from the written answers (or sent to the booking
 * assistant routine on Arwin's own Claude plan: no API key, nothing billed).
 * Public: no session, from the page itself, braked per address before
 * anything is read. It never books: the widget sends a booking through the
 * public request route, like the form.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = visitorGate(request, {
    write: true,
    limits: [{ bucket: 'booking-chat', max: 60, windowMs: 600_000 }],
  });
  if (!gate.ok) return gate.response;
  const body = await readJson(request, 8_000);
  const parsed = CHAT_REQUEST.safeParse(body ?? {});
  if (!parsed.success) {
    return publicFail({ code: 'invalid_input', message: 'That message could not be read.' });
  }
  const { slug } = await context.params;
  const reply = await runBookingChat(getStore(), slug, parsed.data, {
    addressKey: gate.visitor.key,
    ipHash: gate.visitor.ipHash,
  });
  if (!reply.ok) return publicFail(reply.error);
  return publicDone({ ...reply.value });
}
