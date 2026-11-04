import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { inboxTaskDetail } from '@/lib/email/thread-links';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { readLiveThread } from '@/lib/services/inbox-live';
import { createTask } from '@/lib/services/tasks';

export const dynamic = 'force-dynamic';

const BODY = z.object({ threadId: z.string().regex(/^[0-9a-f]{10,24}$/i) }).strict();

/**
 * Gmail's "Add to Tasks", as a Kraken task (the Tasks tab, not Google
 * Tasks): from a person's click on a conversation. The title is the
 * conversation's subject, read here rather than taken from the browser, and
 * the task links back to the conversation in the Inbox.
 */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-task:${s.auth.userId}`, 20, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Unknown conversation.' });
  const thread = await readLiveThread(getStore(), s.auth.organizationId, parsed.data.threadId);
  if (!thread.ok) return fail(thread.error);
  const from = [...thread.value.messages].reverse().find((m) => !m.fromUs) ?? null;
  const made = await createTask(s.auth, {
    title: thread.value.subject.trim() || '(no subject)',
    detail: inboxTaskDetail(thread.value.id, from?.fromName ?? null),
  });
  if (!made.ok) return fail(made.error);
  return NextResponse.json({ ok: true, taskId: made.value.id });
}
