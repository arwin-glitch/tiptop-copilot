import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/runtime';
import { canSend, readPrimarySignature, sendReply } from '@/lib/google/gmail-send';
import { ARWIN_SIGNATURE_HTML } from '@/lib/email/signatures';
import { recordAnswer } from '@/lib/services/email-session';
import { rateLimit } from '@/lib/security/limits';
import { fail, personName, sessionAuth } from '@/lib/services/email-session-auth';

export const dynamic = 'force-dynamic';

const BODY = z.object({
  id: z.string().regex(/^[0-9a-f]{10,24}$/i),
  body: z.string().trim().min(1).max(20_000),
  signature: z.enum(['nick', 'arwin']),
});

/**
 * Send one reply from Nick's inbox: the only send path in the product, and
 * only ever from a person's tap on Send in the email session.
 */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`email-send:${s.auth.userId}`, 30, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Write a reply first.' });
  if (!s.integration || !canSend(s.integration) || s.auth.isDemo) {
    return fail(
      { code: 'forbidden', message: 'Sending is not turned on yet. Send it from Gmail instead.' },
      409,
    );
  }
  const store = getStore();
  const signatureHtml =
    parsed.data.signature === 'nick'
      ? await readPrimarySignature(store, s.integration)
      : ARWIN_SIGNATURE_HTML;
  const sent = await sendReply(store, s.integration, {
    id: parsed.data.id,
    body: parsed.data.body,
    signatureHtml,
  });
  if (!sent.ok) return fail(sent.error);
  await recordAnswer(
    store,
    s.auth.organizationId,
    { id: s.auth.userId, name: personName(s.auth) },
    { id: parsed.data.id, answer: 'sent', signature: parsed.data.signature, viaApp: true },
  );
  return NextResponse.json({ ok: true, threadId: sent.value.threadId });
}
