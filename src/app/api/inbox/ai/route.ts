import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { MESSAGE_ID } from '@/lib/email/raw-message';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { suggestReplies, translateMessage } from '@/lib/services/inbox-ai';

export const dynamic = 'force-dynamic';

const GMAIL_ID = z.string().regex(/^[0-9a-f]{10,24}$/i);

const BODY = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('replies'), threadId: GMAIL_ID }).strict(),
  z
    .object({
      kind: z.literal('translate'),
      threadId: GMAIL_ID,
      messageId: z.string().regex(MESSAGE_ID),
    })
    .strict(),
]);

/**
 * Kraken AI in the Inbox, on demand: three suggested replies for an open
 * conversation (they only fill the reply box), or one message translated to
 * English. Reads the conversation; never sends, drafts or changes anything.
 */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-ai:${s.auth.userId}`, 30, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Unknown message.' });
  const body = parsed.data;
  const res =
    body.kind === 'replies'
      ? await suggestReplies(s.auth, body.threadId)
      : await translateMessage(s.auth, body.threadId, body.messageId);
  if (!res.ok) return fail(res.error);
  return NextResponse.json(
    { ok: true, ...res.value },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
