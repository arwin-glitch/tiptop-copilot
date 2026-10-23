import type { NextRequest } from 'next/server';
import { readPublicAnswer } from '@/lib/booking/chat';
import { publicDone, publicFail, visitorGate } from '@/lib/booking/route-helpers';
import { getStore } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/**
 * The booking page assistant's poll for a routine answer (D-078): pending,
 * answered (plain text, made safe on the way in) or expired. Public: no
 * session, read-only, braked per address (the widget asks every few seconds
 * for up to three minutes).
 */
export async function GET(request: NextRequest, context: Context) {
  const gate = visitorGate(request, {
    limits: [{ bucket: 'booking-chat-answer', max: 90, windowMs: 600_000 }],
  });
  if (!gate.ok) return gate.response;
  const id = request.nextUrl.searchParams.get('id') ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return publicFail({ code: 'not_found', message: 'That question is not here any more.' });
  }
  const { slug } = await context.params;
  const view = await readPublicAnswer(getStore(), slug, id);
  if (!view.ok) return publicFail(view.error);
  return publicDone({ status: view.value.status, answer: view.value.answer });
}
