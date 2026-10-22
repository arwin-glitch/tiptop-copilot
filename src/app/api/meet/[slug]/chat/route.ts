import type { NextRequest } from 'next/server';
import { CHAT_REQUEST, runBookingChat } from '@/lib/booking/chat';
import { publicDone, publicFail, readJson, visitorGate } from '@/lib/booking/route-helpers';
import { getStore } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/**
 * One turn of the booking page's chatbot. Public: no session, from the page
 * itself, braked per address (the model's own, tighter brakes and the
 * monthly cap are in lib/booking/chat.ts). The answer is words, open times
 * and a form fill; the visitor still presses Send.
 */
export async function POST(request: NextRequest, context: Context) {
  // Braked before anything is read: the link, its settings and the spend
  // check are not free, so a flood stops here.
  const gate = visitorGate(request, {
    write: true,
    limits: [{ bucket: 'booking-chat', max: 60, windowMs: 600_000 }],
  });
  if (!gate.ok) return gate.response;
  const body = await readJson(request, 24_000);
  const parsed = CHAT_REQUEST.safeParse(body ?? {});
  if (!parsed.success) {
    return publicFail({ code: 'invalid_input', message: 'That message could not be read.' });
  }
  const { slug } = await context.params;
  const reply = await runBookingChat(getStore(), slug, parsed.data, {
    addressKey: gate.visitor.key,
  });
  if (!reply.ok) return publicFail(reply.error);
  return publicDone({ ...reply.value });
}
