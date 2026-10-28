import type { NextRequest } from 'next/server';
import { requireRole } from '@/lib/auth/session';
import { readChatbotPanel, saveChatbotConfig } from '@/lib/booking/chat';
import { CHATBOT_CONFIG_PATCH } from '@/lib/booking/chatbot-config';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/**
 * The Booking tab's assistant panel (D-078): its settings, whether the
 * booking assistant routine is set up and when it last answered, and the
 * public card's facts for the "Test a question" box. Signed in.
 */
export async function GET(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'booking-chatbot-read', max: 60 });
  if (!gate.ok) return gate.response;
  const panel = await readChatbotPanel(getStore(), gate.auth.organizationId);
  return done({ panel });
}

/**
 * Save the assistant's settings: on or off, the written questions and
 * answers, AI answers and their daily cap. Merged into the booking link's
 * settings document as `chatbot`; nothing else there changes. An admin or
 * the owner, from Kraken's own pages, within a rate limit.
 */
export async function PATCH(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'booking-chatbot', max: 30, write: true });
  if (!gate.ok) return gate.response;
  const admin = requireRole(gate.auth, 'admin');
  if (!admin.ok) return fail(admin.error);
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > 64_000) return fail({ code: 'invalid_input', message: 'That is too much to save.' });
  const parsed = CHATBOT_CONFIG_PATCH.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail({
      code: 'invalid_input',
      message: parsed.error.issues[0]?.message || 'Check the assistant settings.',
    });
  }
  const saved = await saveChatbotConfig(
    getStore(),
    gate.auth.organizationId,
    gate.auth.userId,
    parsed.data,
  );
  if (!saved.ok) return fail(saved.error);
  return done({ config: saved.value });
}
