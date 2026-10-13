import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/runtime';
import { canSend, readPrimarySignature, sendNew } from '@/lib/google/gmail-send';
import { ARWIN_SIGNATURE_HTML } from '@/lib/email/signatures';
import { parseAddresses } from '@/lib/email/addresses';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';

export const dynamic = 'force-dynamic';

const BODY = z.object({
  to: z.string().max(2000),
  cc: z.string().max(2000).default(''),
  subject: z.string().trim().max(300),
  body: z.string().trim().min(1).max(20_000),
  signature: z.enum(['nick', 'arwin']),
  forwardOf: z
    .string()
    .regex(/^[0-9a-f]{10,24}$/i)
    .nullish(),
});

/** A new email or a forward from Nick's inbox, only from a person's tap on Send. */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`email-send:${s.auth.userId}`, 30, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Write the email first.' });
  const to = parseAddresses(parsed.data.to);
  const cc = parseAddresses(parsed.data.cc);
  if (!to || to.length === 0) {
    return fail({ code: 'invalid_input', message: 'Check the To addresses.' });
  }
  if (!cc) return fail({ code: 'invalid_input', message: 'Check the Cc addresses.' });
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
  if (!signatureHtml) {
    return fail(
      {
        code: 'provider_unavailable',
        message:
          "Couldn't read Nick's signature from Gmail, so nothing was sent. Try again, or sign as Arwin.",
        retryable: true,
      },
      503,
    );
  }
  const sent = await sendNew(store, s.integration, {
    to: to.join(', '),
    cc: cc.join(', '),
    subject: parsed.data.subject || '(no subject)',
    body: parsed.data.body,
    signatureHtml,
    forwardMessageId: parsed.data.forwardOf ?? null,
  });
  if (!sent.ok) return fail(sent.error);
  return NextResponse.json({ ok: true, threadId: sent.value.threadId });
}
