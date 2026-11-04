import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/runtime';
import { saveDraft, trashDraft } from '@/lib/google/gmail-send';
import { parseAddresses } from '@/lib/email/addresses';
import { MAX_COMPOSE_HTML, sanitizeComposeHtml } from '@/lib/email/compose-html';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { forgetThreads, removeDemoDraft, saveDemoDraft } from '@/lib/services/inbox-live';
import {
  cancelScheduled,
  readScheduled,
  scheduleSend,
  sendScheduledNow,
  updateScheduled,
  type ScheduleActor,
  type ScheduledContent,
} from '@/lib/services/inbox-scheduled';

export const dynamic = 'force-dynamic';

const UUID = z.string().uuid();
const GMAIL_ID = z.string().regex(/^[0-9a-f]{10,24}$/i);
const CONTENT = {
  to: z.string().max(4000).default(''),
  cc: z.string().max(4000).default(''),
  bcc: z.string().max(4000).default(''),
  subject: z.string().max(300).default(''),
  html: z.string().max(MAX_COMPOSE_HTML).default(''),
  signature: z.enum(['nick', 'arwin']).default('nick'),
  threadId: GMAIL_ID.nullish(),
  forwardOf: GMAIL_ID.nullish(),
};

const BODY = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('schedule'),
    sendAt: z.string().min(1).max(40),
    /** The Gmail draft the window was saving to: it goes to Trash once scheduled. */
    draftId: z
      .string()
      .regex(/^[\w-]{1,100}$/)
      .nullish(),
    ...CONTENT,
  }),
  z.object({
    action: z.literal('update'),
    id: UUID,
    sendAt: z.string().min(1).max(40),
    ...CONTENT,
  }),
  z.object({ action: z.literal('sendNow'), id: UUID, ...CONTENT }),
  z.object({ action: z.literal('cancel'), id: UUID }),
]);

function content(body: {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  signature: 'nick' | 'arwin';
  threadId?: string | null;
  forwardOf?: string | null;
}): ScheduledContent | string {
  const to = parseAddresses(body.to);
  const cc = parseAddresses(body.cc);
  const bcc = parseAddresses(body.bcc);
  if (!to || !cc || !bcc) return 'Check the addresses: one is not an email.';
  if (to.length + cc.length + bcc.length === 0) return 'Add who it goes to.';
  return {
    to: to.join(', '),
    cc: cc.join(', '),
    bcc: bcc.join(', '),
    subject: body.subject,
    html: body.html,
    signature: body.signature,
    threadId: body.threadId ?? null,
    forwardOf: body.forwardOf ?? null,
  };
}

/**
 * Schedule send from the Inbox's compose window (lib/services/inbox-scheduled.ts):
 * `schedule` keeps an email to send at the time a person picked (that pick is
 * the send decision); `update` changes it while it waits; `sendNow` sends it
 * at once; `cancel` stops it and puts it back in Drafts. Before the table's
 * migration is run each answers 503 with `needsMigration`, and nothing is
 * stored or sent.
 */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-scheduled:${s.auth.userId}`, 30, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Nothing to schedule.' });
  const body = parsed.data;
  const store = getStore();
  const actor: ScheduleActor = {
    organizationId: s.auth.organizationId,
    userId: s.auth.userId,
    integration: s.integration,
    demo: s.auth.isDemo,
  };

  if (body.action === 'cancel') {
    const res = await cancelScheduled(store, actor, body.id);
    if (!res.ok) return fail(res.error);
    // Gmail turns a cancelled scheduled email back into a draft; so does Kraken.
    const row = res.value;
    const draft = {
      to: row.to_addresses,
      cc: row.cc_addresses,
      bcc: row.bcc_addresses,
      subject: row.subject,
    };
    if (actor.demo) {
      saveDemoDraft({
        ...draft,
        draftId: null,
        html: row.body_html,
        text: row.body_html.replace(/<[^>]+>/g, ' ').trim(),
        replyOn: row.thread_id,
      });
    } else if (s.integration) {
      const saved = await saveDraft(store, s.integration, {
        ...draft,
        body: '',
        html: row.body_html,
        threadId: row.thread_id,
      });
      if (!saved.ok) {
        return NextResponse.json({ ok: true, id: row.id, draft: false });
      }
    }
    return NextResponse.json({ ok: true, id: row.id, draft: true });
  }

  const c = content(body);
  if (typeof c === 'string') return fail({ code: 'invalid_input', message: c });

  if (body.action === 'schedule') {
    const res = await scheduleSend(store, actor, c, body.sendAt);
    if (!res.ok) return fail(res.error);
    // The draft it came from is now this scheduled email: off to Trash, as Gmail
    // moves it out of Drafts. Best-effort; a draft left behind is only a copy.
    if (body.draftId) {
      if (actor.demo) removeDemoDraft(body.draftId);
      else if (s.integration)
        await trashDraft(store, s.integration, body.draftId).catch(() => null);
    }
    return NextResponse.json({ ok: true, id: res.value.id, sendAt: res.value.send_at });
  }
  if (body.action === 'update') {
    const res = await updateScheduled(store, actor, body.id, c, body.sendAt);
    if (!res.ok) return fail(res.error);
    return NextResponse.json({ ok: true, id: res.value.id, sendAt: res.value.send_at });
  }
  const res = await sendScheduledNow(store, actor, body.id, c);
  if (!res.ok) return fail(res.error);
  if (c.threadId) forgetThreads([c.threadId]);
  return NextResponse.json({ ok: true, id: body.id });
}

/** One scheduled email, to open it in the compose window (`?id=`). */
export async function GET(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const id = UUID.safeParse(request.nextUrl.searchParams.get('id') ?? '');
  if (!id.success) return fail({ code: 'invalid_input', message: 'Bad id.' });
  const res = await readScheduled(getStore(), s.auth.organizationId, id.data);
  if (!res.ok) return fail(res.error);
  const r = res.value;
  return NextResponse.json(
    {
      ok: true,
      scheduled: {
        id: r.id,
        status: r.status,
        to: r.to_addresses,
        cc: r.cc_addresses,
        bcc: r.bcc_addresses,
        subject: r.subject,
        html: sanitizeComposeHtml(r.body_html),
        signature: r.signature,
        threadId: r.thread_id,
        forwardOf: r.forward_of,
        sendAt: r.send_at,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
