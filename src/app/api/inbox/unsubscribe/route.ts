import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { oneClickUnsubscribe } from '@/lib/services/inbox-unsubscribe';

export const dynamic = 'force-dynamic';

const BODY = z.object({ messageId: z.string().regex(/^[0-9a-f]{10,24}$/i) }).strict();

/**
 * One-click unsubscribe (RFC 8058) for one message: only from a person's
 * click on Unsubscribe and then on the confirm naming the sender. The
 * address comes from the message's own header on Gmail, not this request.
 * The mailto and plain-link kinds never come here: the browser opens a
 * prefilled compose (a person clicks Send) or the sender's page.
 */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-unsubscribe:${s.auth.userId}`, 20, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Unknown message.' });
  const store = getStore();
  const done = await oneClickUnsubscribe(
    store,
    s.auth.isDemo,
    s.integration,
    parsed.data.messageId,
  );
  if (!done.ok) return fail(done.error);
  if (!s.auth.isDemo) {
    await recordAudit(store, {
      organizationId: s.auth.organizationId,
      userId: s.auth.userId,
      action: 'inbox.unsubscribed',
      entityType: 'gmail_message',
      entityId: null,
      metadata: {},
    }).catch(() => undefined);
  }
  return NextResponse.json({ ok: true });
}
