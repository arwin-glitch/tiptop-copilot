import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/runtime';
import { archiveThread, canSend } from '@/lib/google/gmail-send';
import { recordAnswer } from '@/lib/services/email-session';
import { fail, personName, sessionAuth } from '@/lib/services/email-session-auth';

export const dynamic = 'force-dynamic';

const BODY = z.object({
  ids: z
    .array(z.string().regex(/^[0-9a-f]{10,24}$/i))
    .min(1)
    .max(150),
});

/**
 * Archive emails from the session. With sending turned on they leave the
 * inbox now; without it they are marked for Arwin to archive in Gmail.
 */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Nothing to archive.' });
  const store = getStore();
  const live = canSend(s.integration) && !s.auth.isDemo;
  let archived = 0;
  for (const id of parsed.data.ids) {
    const done = live && s.integration ? await archiveThread(store, s.integration, id) : null;
    if (done?.ok) archived++;
    await recordAnswer(
      store,
      s.auth.organizationId,
      { id: s.auth.userId, name: personName(s.auth) },
      { id, answer: 'archive', viaApp: Boolean(done?.ok) },
    );
  }
  return NextResponse.json({
    ok: true,
    archived,
    markedForArwin: parsed.data.ids.length - archived,
  });
}
