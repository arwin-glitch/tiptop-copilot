import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { senderAddress } from '@/lib/email/inbox-filters';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { blockSender } from '@/lib/services/inbox-filters';
import { forgetLabelNames } from '@/lib/services/inbox-live';

export const dynamic = 'force-dynamic';

const BODY = z.object({ address: z.string().max(320) }).strict();

/**
 * Block a sender: only from a person's click on Block and then on its
 * confirm. Makes one Gmail filter (skip inbox, mark read, label "Blocked");
 * never Spam or Trash by filter, never a forward. Undone by Unblock in the
 * Filters list, which deletes that filter.
 */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-filters:${s.auth.userId}`, 20, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  const address = parsed.success ? senderAddress(parsed.data.address) : null;
  if (!address) return fail({ code: 'invalid_input', message: 'That sender has no address.' });
  const store = getStore();
  const done = await blockSender(
    store,
    s.auth.organizationId,
    s.auth.isDemo,
    s.integration,
    address,
  );
  if (!done.ok) return fail(done.error);
  forgetLabelNames();
  if (!s.auth.isDemo) {
    await recordAudit(store, {
      organizationId: s.auth.organizationId,
      userId: s.auth.userId,
      action: 'inbox.sender_blocked',
      entityType: 'gmail_filter',
      entityId: null,
      metadata: { applied: done.value.applied },
    }).catch(() => undefined);
  }
  return NextResponse.json({ ok: true, address, ...done.value });
}
