import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/runtime';
import { canSend, setThreadLabels, type InboxLabel } from '@/lib/google/gmail-send';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';

export const dynamic = 'force-dynamic';

const ACTIONS: Record<string, { add?: InboxLabel[]; remove?: InboxLabel[] }> = {
  archive: { remove: ['INBOX'] },
  inbox: { add: ['INBOX'] },
  read: { remove: ['UNREAD'] },
  unread: { add: ['UNREAD'] },
  star: { add: ['STARRED'] },
  unstar: { remove: ['STARRED'] },
};

const BODY = z.object({
  ids: z
    .array(z.string().regex(/^[0-9a-f]{10,24}$/i))
    .min(1)
    .max(100),
  action: z.enum(['archive', 'inbox', 'read', 'unread', 'star', 'unstar']),
});

/**
 * Archive, move back to the inbox, read/unread and star, from a person's tap
 * in the Inbox tab. Nothing is deleted: there is no trash or delete action.
 */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-modify:${s.auth.userId}`, 120, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Nothing to change.' });
  if (!s.integration || !canSend(s.integration) || s.auth.isDemo) {
    return fail(
      {
        code: 'forbidden',
        message: 'Changing mail from the app needs sending turned on. Do it in Gmail instead.',
      },
      409,
    );
  }
  const store = getStore();
  const change = ACTIONS[parsed.data.action]!;
  let done = 0;
  for (const id of parsed.data.ids) {
    const res = await setThreadLabels(store, s.integration, id, change);
    if (res.ok) done++;
  }
  if (done === 0) {
    return fail({ code: 'provider_unavailable', message: 'Gmail did not take that. Try again.' });
  }
  return NextResponse.json({ ok: true, done });
}
