import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/runtime';
import { readDraftFull } from '@/lib/google/gmail-inbox';
import { canSend, saveDraft, trashDraft } from '@/lib/google/gmail-send';
import { MAX_COMPOSE_HTML, sanitizeComposeHtml, textToComposeHtml } from '@/lib/email/compose-html';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import {
  forgetThreads,
  readDemoDraft,
  removeDemoDraft,
  restoreDemoDraft,
  saveDemoDraft,
} from '@/lib/services/inbox-live';
import type { DemoDraft } from '@/lib/demo/inbox-folder-fixtures';

export const dynamic = 'force-dynamic';

const DRAFT_ID = z.string().regex(/^[\w-]{1,100}$/);
const GMAIL_ID = z.string().regex(/^[0-9a-f]{10,24}$/i);

const BODY = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    draftId: DRAFT_ID.nullish(),
    to: z.string().max(4000).default(''),
    cc: z.string().max(4000).default(''),
    bcc: z.string().max(4000).default(''),
    subject: z.string().max(300).default(''),
    html: z.string().max(MAX_COMPOSE_HTML).default(''),
    threadId: GMAIL_ID.nullish(),
  }),
  z.object({ action: z.literal('discard'), draftId: DRAFT_ID }),
]);

/** Demo drafts discarded this process, so Undo can put them back. */
const discarded = new Map<string, DemoDraft>();

/**
 * The compose window's Gmail draft: `save` writes it (a new draft, or the
 * one it is already saving to), `discard` moves it to Trash (never deleted
 * for good). Saving changes nothing anyone else sees; it sends nothing. In
 * demo mode the demo's own Drafts folder keeps it.
 */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-drafts:${s.auth.userId}`, 120, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Nothing to save.' });
  const body = parsed.data;

  if (s.auth.isDemo) {
    if (body.action === 'discard') {
      const gone = removeDemoDraft(body.draftId);
      if (gone) discarded.set(gone.draftId, gone);
      return NextResponse.json({ ok: true });
    }
    const html = sanitizeComposeHtml(body.html);
    const saved = saveDemoDraft({
      draftId: body.draftId ?? null,
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      html,
      text: html
        .replace(/<\/(div|p|li)>|<br>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .trim(),
      replyOn: body.threadId ?? null,
    });
    return NextResponse.json({ ok: true, draftId: saved.draftId, threadId: saved.threadId });
  }

  if (!s.integration || !canSend(s.integration)) {
    return fail(
      { code: 'forbidden', message: 'Saving drafts needs sending turned on. Nothing was saved.' },
      409,
    );
  }
  const store = getStore();
  if (body.action === 'discard') {
    const res = await trashDraft(store, s.integration, body.draftId);
    if (!res.ok) return fail(res.error);
    return NextResponse.json({ ok: true });
  }
  const saved = await saveDraft(store, s.integration, {
    draftId: body.draftId ?? null,
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    subject: body.subject,
    body: '',
    html: body.html,
    threadId: body.threadId ?? null,
  });
  if (!saved.ok) return fail(saved.error);
  if (body.threadId) forgetThreads([body.threadId]);
  return NextResponse.json({
    ok: true,
    draftId: saved.value.draftId,
    threadId: saved.value.threadId,
  });
}

/** One draft whole, to open it in the compose window (`?id=<draft id>`); Undo of a demo discard (`&restore=1`). */
export async function GET(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const id = DRAFT_ID.safeParse(request.nextUrl.searchParams.get('id') ?? '');
  if (!id.success) return fail({ code: 'invalid_input', message: 'Bad draft id.' });
  if (s.auth.isDemo) {
    if (request.nextUrl.searchParams.get('restore') === '1') {
      const back = discarded.get(id.data);
      if (back) restoreDemoDraft(back);
      discarded.delete(id.data);
    }
    const d = readDemoDraft(id.data);
    if (!d) return fail({ code: 'not_found', message: 'That draft is gone.' });
    return NextResponse.json({
      ok: true,
      draft: {
        draftId: d.draftId,
        threadId: d.replyOn,
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        html: d.html || textToComposeHtml(d.text),
      },
    });
  }
  if (!s.integration) return fail({ code: 'not_found', message: 'No mailbox is connected.' });
  const draft = await readDraftFull(getStore(), s.integration, id.data);
  if (!draft.ok) return fail(draft.error);
  const d = draft.value;
  return NextResponse.json(
    {
      ok: true,
      draft: {
        draftId: d.draftId,
        // A reply draft carries its thread; a new email's own thread is just itself.
        threadId: d.threadId,
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        html: d.html ? sanitizeComposeHtml(d.html) : textToComposeHtml(d.text),
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
