import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/runtime';
import {
  canSend,
  MAX_UPLOAD_BYTES,
  readPrimarySignature,
  sendComposed,
  sendNew,
  type MimeAttachment,
} from '@/lib/google/gmail-send';
import { ARWIN_SIGNATURE_HTML } from '@/lib/email/signatures';
import { parseAddresses } from '@/lib/email/addresses';
import { MAX_COMPOSE_HTML } from '@/lib/email/compose-html';
import { rateLimit } from '@/lib/security/limits';
import { recordAnswer } from '@/lib/services/email-session';
import { fail, personName, sessionAuth } from '@/lib/services/email-session-auth';
import { forgetThreads } from '@/lib/services/inbox-live';
import { readOriginal } from '@/lib/services/inbox-original';

export const dynamic = 'force-dynamic';

const GMAIL_ID = z.string().regex(/^[0-9a-f]{10,24}$/i);

const BODY = z.object({
  to: z.string().max(4000),
  cc: z.string().max(4000).default(''),
  bcc: z.string().max(4000).default(''),
  subject: z.string().trim().max(300),
  /** Plain text (the other tabs' compose window). */
  body: z.string().max(20_000).default(''),
  /** The Inbox's formatted body; sanitized before it is sent (compose-html.ts). */
  html: z.string().max(MAX_COMPOSE_HTML).nullish(),
  signature: z.enum(['nick', 'arwin']),
  forwardOf: GMAIL_ID.nullish(),
  /** A reply: the thread it goes on. */
  threadId: GMAIL_ID.nullish(),
  /** Forward as attachment: this message goes along whole (message/rfc822). */
  attachMessage: z.object({ threadId: GMAIL_ID, messageId: GMAIL_ID }).nullish(),
  /** The Gmail draft the window was saving to: it becomes the sent email. */
  draftId: z
    .string()
    .regex(/^[\w-]{1,100}$/)
    .nullish(),
  attachments: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        type: z.string().max(200).default('application/octet-stream'),
        /** Base64, no data: prefix. */
        data: z.string().max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 8),
      }),
    )
    .max(20)
    .default([]),
  /** The intro draft: names written [Full Name](LinkedIn URL) go out as links. */
  links: z.boolean().default(false),
});

/**
 * Send one email from Nick's inbox, only from a person's tap on Send: a new
 * email, a reply on a thread, a forward, or a draft finished in the compose
 * window. Nick's real Gmail signature (or Arwin's) is added here, never typed.
 */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`email-send:${s.auth.userId}`, 30, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Write the email first.' });
  const data = parsed.data;
  const to = parseAddresses(data.to);
  const cc = parseAddresses(data.cc);
  const bcc = parseAddresses(data.bcc);
  if (!to || !cc || !bcc) {
    return fail({ code: 'invalid_input', message: 'Check the addresses: one is not an email.' });
  }
  if (to.length + cc.length + bcc.length === 0) {
    return fail({ code: 'invalid_input', message: 'Add who it goes to.' });
  }
  if (!data.html && !data.body.trim() && !data.forwardOf && !data.attachMessage) {
    return fail({ code: 'invalid_input', message: 'Write the email first.' });
  }
  if (!s.integration || !canSend(s.integration) || s.auth.isDemo) {
    return fail(
      { code: 'forbidden', message: 'Sending is not turned on yet. Send it from Gmail instead.' },
      409,
    );
  }
  const attachments: MimeAttachment[] = data.attachments.map((a) => ({
    filename: a.name.replace(/[\r\n"\\/]+/g, '_'),
    mimeType: /^[\w.+-]+\/[\w.+-]+$/.test(a.type) ? a.type : 'application/octet-stream',
    data: Buffer.from(a.data, 'base64'),
  }));
  if (attachments.reduce((n, a) => n + a.data.length, 0) > MAX_UPLOAD_BYTES) {
    return fail({
      code: 'invalid_input',
      message: 'Attachments can be 7 MB in all from here. Attach bigger files in Gmail.',
    });
  }
  const store = getStore();
  if (data.attachMessage) {
    // Read with the read scope only; the person's Send is what sends it.
    const original = await readOriginal(
      store,
      s.auth.organizationId,
      s.integration,
      data.attachMessage.threadId,
      data.attachMessage.messageId,
    );
    if (!original.ok) return fail(original.error);
    attachments.push({
      // emlFileName already left out quotes, slashes and control characters.
      filename: original.value.fileName,
      mimeType: 'message/rfc822',
      data: original.value.bytes,
    });
  }
  const signatureHtml =
    data.signature === 'nick'
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
  // The intro draft's linked names keep their own path; everything else is the compose window's.
  const sent =
    data.links && !data.html
      ? await sendNew(store, s.integration, {
          to: to.join(', '),
          cc: cc.join(', '),
          subject: data.subject || '(no subject)',
          body: data.body,
          signatureHtml,
          forwardMessageId: data.forwardOf ?? null,
          links: true,
        })
      : await sendComposed(store, s.integration, {
          to: to.join(', '),
          cc: cc.join(', '),
          bcc: bcc.join(', '),
          subject: data.subject || '(no subject)',
          body: data.body,
          html: data.html ?? null,
          threadId: data.threadId ?? null,
          forwardMessageId: data.forwardOf ?? null,
          attachments,
          signatureHtml,
          draftId: data.draftId ?? null,
        });
  if (!sent.ok) return fail(sent.error);
  if (data.threadId) {
    forgetThreads([data.threadId]);
    // A reply from the Inbox answers the thread, as the email session's Send does.
    await recordAnswer(
      store,
      s.auth.organizationId,
      { id: s.auth.userId, name: personName(s.auth) },
      { id: data.threadId, answer: 'sent', signature: data.signature, viaApp: true },
    ).catch(() => undefined);
  }
  return NextResponse.json({ ok: true, threadId: sent.value.threadId });
}
