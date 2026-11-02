import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { forgetThreads } from '@/lib/services/inbox-live';
import {
  MAX_SNOOZE_IDS,
  readOpenSnoozes,
  SNOOZE_THREAD_ID,
  snoozeThreads,
  unsnoozeThreads,
  type SnoozeActor,
} from '@/lib/services/inbox-snooze';

export const dynamic = 'force-dynamic';

const IDS = z.array(z.string().regex(SNOOZE_THREAD_ID)).min(1).max(MAX_SNOOZE_IDS);

const BODY = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('snooze'),
    threadIds: IDS,
    /** An ISO instant; in the future and at most a year ahead (checkWakeAt). */
    wakeAt: z.string().min(1).max(40),
  }),
  z.object({ action: z.literal('unsnooze'), threadIds: IDS }),
]);

/**
 * Snooze from the Inbox tab (lib/services/inbox-snooze.ts): `snooze` takes
 * the threads out of the inbox until `wakeAt`, `unsnooze` puts them back now
 * (also the toast's Undo). Nothing is deleted. Before the table's migration
 * is run both answer 503 with `needsMigration`, and nothing changes.
 */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-snooze:${s.auth.userId}`, 60, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Nothing to snooze.' });

  const store = getStore();
  const actor: SnoozeActor = {
    organizationId: s.auth.organizationId,
    userId: s.auth.userId,
    integration: s.integration,
    demo: s.auth.isDemo,
  };
  const body = parsed.data;
  const res =
    body.action === 'snooze'
      ? await snoozeThreads(store, actor, body.threadIds, body.wakeAt)
      : await unsnoozeThreads(store, actor, body.threadIds);
  // Whatever happened, the cached copies of these threads may be stale now.
  forgetThreads(body.threadIds);
  if (!res.ok) return fail(res.error);
  return NextResponse.json({ ok: true, ...res.value });
}

/** The open snoozes, soonest first: thread id and wake time only. */
export async function GET() {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const open = await readOpenSnoozes(getStore(), s.auth.organizationId).catch(() => null);
  if (!open) return fail({ code: 'internal', message: 'Could not read the snoozed list.' });
  return NextResponse.json(
    {
      ok: true,
      state: open.state,
      snoozes: open.rows.map((r) => ({ threadId: r.thread_id, wakeAt: r.wake_at })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
