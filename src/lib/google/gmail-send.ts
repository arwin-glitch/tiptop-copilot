import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { getAccessToken } from '@/lib/google/oauth';
import { log } from '@/lib/security/redact';
import type { Integration } from '@/lib/types/domain';
import { htmlToPlainText } from '@/lib/util/text';
import { err, ok, type Result } from '@/lib/util/result';
import { lineWithLinksToHtml, textWithLinks } from '@/lib/email/name-links';
import { SEND_SCOPES } from './send-scopes';

/**
 * The only send path in the product: Send in the email session and the Inbox,
 * and campaigns (one email per recipient) once a person confirms one.
 *
 * Sending is a separate, opt-in grant. The default Google connection stays
 * read-only (see oauth.ts); the mailbox owner turns sending on from Settings,
 * which asks Google for `gmail.modify` on top of the read scopes. Without that
 * grant, `canSend` is false and every function here that writes refuses.
 *
 * Rules this module keeps:
 * - It sends only when a signed-in person taps Send on one email, or taps
 *   Send on a campaign's review screen (which shows the recipient count, the
 *   from-address, the subject and a sample) and keeps its page open while the
 *   batches go. Nothing in the AI tools, the routines or the cron jobs
 *   imports it, and nothing here runs on a schedule.
 * - A reply goes on an existing thread, to the recipients of the draft already
 *   on that thread (or, with no draft, reply-all to the latest message). A new
 *   email or forward (sendNew) goes to the addresses the person typed. Either
 *   way, only from the connected mailbox.
 * - Reading the draft and the signature needs only the read scope.
 */

export { SEND_SCOPES };

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** Media upload: a whole RFC 822 message as the body, up to 35 MB, unlike the JSON path. */
const UPLOAD_BASE = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';

export function canSend(integration: Integration | null): boolean {
  return Boolean(integration && SEND_SCOPES.every((s) => integration.scopes.includes(s)));
}

interface Header {
  name: string;
  value: string;
}
interface Part {
  mimeType?: string;
  headers?: Header[];
  body?: { data?: string };
  parts?: Part[];
}
interface Message {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: Part;
}

async function gmail<T>(
  store: DataStore,
  integration: Integration,
  path: string,
  init?: RequestInit,
  base: string = BASE,
): Promise<Result<T>> {
  const token = await getAccessToken(store, integration);
  if (!token.ok) return token;
  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token.value}` },
    });
    if (response.status === 401 || response.status === 403) {
      return err('provider_unauthorized', 'Gmail refused. Sending may need to be turned on again.');
    }
    if (response.status === 404) return err('not_found', 'That email no longer exists in Gmail.');
    if (!response.ok) {
      log.warn('Gmail send-path request failed', {
        path: path.split('?')[0],
        status: response.status,
      });
      return err('provider_unavailable', 'Gmail is unavailable right now. Try again.', {
        retryable: true,
      });
    }
    if (response.status === 204) return ok(undefined as T);
    return ok((await response.json()) as T);
  } catch {
    return err('provider_unavailable', 'Could not reach Gmail.', { retryable: true });
  }
}

const b64urlDecode = (data: string) =>
  Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const b64urlEncode = (text: string) =>
  Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const header = (m: Message | undefined, name: string) =>
  m?.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

function bodyText(part: Part | undefined): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return b64urlDecode(part.body.data);
  for (const child of part.parts ?? []) {
    const text = bodyText(child);
    if (text) return text;
  }
  if (part.mimeType === 'text/html' && part.body?.data)
    return htmlToPlainText(b64urlDecode(part.body.data));
  return '';
}

/** The id in a queue item may be a thread id or a message id; Gmail links accept both. */
async function resolveThreadId(
  store: DataStore,
  integration: Integration,
  id: string,
): Promise<Result<string>> {
  const thread = await gmail<{ id: string }>(store, integration, `/threads/${id}?format=minimal`);
  if (thread.ok) return ok(thread.value.id);
  const message = await gmail<Message>(store, integration, `/messages/${id}?format=minimal`);
  if (message.ok) return ok(message.value.threadId);
  return message;
}

export interface LiveDraft {
  threadId: string;
  draftId: string | null;
  to: string;
  cc: string;
  subject: string;
  /** The draft text without any signature, or empty when there is no draft. */
  body: string;
  /** The message this reply answers. */
  replyToMessageId: string;
}

const MAX_DRAFT_PAGES = 5;

async function findDraftOnThread(
  store: DataStore,
  integration: Integration,
  threadId: string,
): Promise<Result<{ id: string; message: Message } | null>> {
  let pageToken = '';
  for (let page = 0; page < MAX_DRAFT_PAGES; page++) {
    const list = await gmail<{
      drafts?: { id: string; message: { id: string; threadId: string } }[];
      nextPageToken?: string;
    }>(store, integration, `/drafts?maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`);
    if (!list.ok) return list;
    const hit = list.value.drafts?.find((d) => d.message.threadId === threadId);
    if (hit) {
      const full = await gmail<{ id: string; message: Message }>(
        store,
        integration,
        `/drafts/${hit.id}?format=full`,
      );
      if (!full.ok) return full;
      return ok(full.value);
    }
    if (!list.value.nextPageToken) break;
    pageToken = list.value.nextPageToken;
  }
  return ok(null);
}

/** What the session card shows: the draft as it is in Gmail right now. */
export async function readLiveDraft(
  store: DataStore,
  integration: Integration,
  id: string,
): Promise<Result<LiveDraft>> {
  const threadId = await resolveThreadId(store, integration, id);
  if (!threadId.ok) return threadId;
  const thread = await gmail<{ messages?: Message[] }>(
    store,
    integration,
    `/threads/${threadId.value}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Message-ID`,
  );
  if (!thread.ok) return thread;
  const own = (integration.account_email ?? '').toLowerCase();
  const real = (thread.value.messages ?? []).filter((m) => !m.labelIds?.includes('DRAFT'));
  const latest = real.at(-1);
  if (!latest) return err('not_found', 'That thread has no messages.');

  const draft = await findDraftOnThread(store, integration, threadId.value);
  if (!draft.ok) return draft;
  if (draft.value) {
    const m = draft.value.message;
    return ok({
      threadId: threadId.value,
      draftId: draft.value.id,
      to: header(m, 'To'),
      cc: header(m, 'Cc'),
      subject: header(m, 'Subject') || header(latest, 'Subject'),
      body: stripQuoted(bodyText(m.payload)),
      replyToMessageId: latest.id,
    });
  }

  // No draft: reply-all to the latest message, never to ourselves.
  const fromLatest = header(latest, 'From');
  const sentByUs = fromLatest.toLowerCase().includes(own);
  const to = sentByUs ? header(latest, 'To') : fromLatest;
  const ccParts = [header(latest, 'Cc'), sentByUs ? '' : header(latest, 'To')]
    .join(',')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !s.toLowerCase().includes(own) && s !== to);
  const subject = header(latest, 'Subject');
  return ok({
    threadId: threadId.value,
    draftId: null,
    to,
    cc: [...new Set(ccParts)].join(', '),
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    body: '',
    replyToMessageId: latest.id,
  });
}

/** Drop the quoted history Gmail adds under a reply ("On ... wrote:"). */
export function stripQuoted(text: string): string {
  const cut = text.search(/\n\s*On .{0,200}wrote:\s*\n/);
  return (cut >= 0 ? text.slice(0, cut) : text).trimEnd();
}

/** The mailbox's own default signature (HTML), read with the read scope. */
export async function readPrimarySignature(
  store: DataStore,
  integration: Integration,
): Promise<string | null> {
  const list = await gmail<{
    sendAs?: {
      sendAsEmail: string;
      isPrimary?: boolean;
      isDefault?: boolean;
      signature?: string;
    }[];
  }>(store, integration, '/settings/sendAs');
  if (!list.ok) return null;
  const pick =
    list.value.sendAs?.find((s) => s.isDefault) ?? list.value.sendAs?.find((s) => s.isPrimary);
  return pick?.signature?.trim() ? pick.signature : null;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The typed body as HTML, one div per line, every character escaped. With
 * `links` (the intro draft only), names written [Full Name](LinkedIn URL)
 * become links to those profiles; nothing else does (`email/name-links.ts`).
 */
export function bodyToHtml(body: string, options: { links?: boolean } = {}): string {
  const html = options.links ? lineWithLinksToHtml : escapeHtml;
  return body
    .trim()
    .split(/\n/)
    .map((line) => (line.trim() ? `<div>${html(line)}</div>` : '<div><br></div>'))
    .join('');
}

/** RFC 2822 reply with plain and HTML parts. Exported for tests. */
export function buildReplyMime(input: {
  from: string;
  to: string;
  cc: string;
  subject: string;
  inReplyTo: string;
  references: string;
  body: string;
  signatureHtml: string | null;
  /** Names written [Full Name](LinkedIn URL) go out as links (the intro draft). */
  links?: boolean;
}): string {
  const boundary = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const signatureText = input.signatureHtml ? htmlToPlainText(input.signatureHtml) : '';
  const plain = input.links ? textWithLinks(input.body.trim()) : input.body.trim();
  const text = signatureText ? `${plain}\n\n--\n${signatureText}` : plain;
  const html = `<div dir="ltr">${bodyToHtml(input.body, { links: input.links })}${
    input.signatureHtml ? `<br><div class="gmail_signature">${input.signatureHtml}</div>` : ''
  }</div>`;
  const clean = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();
  const headers = [
    `From: ${clean(input.from)}`,
    `To: ${clean(input.to)}`,
    input.cc ? `Cc: ${clean(input.cc)}` : '',
    `Subject: ${clean(input.subject)}`,
    input.inReplyTo ? `In-Reply-To: ${clean(input.inReplyTo)}` : '',
    input.references ? `References: ${clean(input.references)}` : '',
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);
  return [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text, 'utf8').toString('base64'),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64'),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/**
 * Send one reply on the thread, from the connected mailbox, then remove the
 * draft it replaces. Refuses without the send grant.
 */
export async function sendReply(
  store: DataStore,
  integration: Integration,
  input: { id: string; body: string; signatureHtml: string | null },
): Promise<Result<{ messageId: string; threadId: string }>> {
  if (!canSend(integration)) {
    return err('forbidden', 'Sending is not turned on for this mailbox.');
  }
  if (!input.body.trim()) return err('invalid_input', 'The reply is empty.');
  const draft = await readLiveDraft(store, integration, input.id);
  if (!draft.ok) return draft;
  if (!draft.value.to.trim()) return err('invalid_input', 'No recipient found on this thread.');

  const original = await gmail<Message>(
    store,
    integration,
    `/messages/${draft.value.replyToMessageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
  );
  if (!original.ok) return original;
  const messageIdHeader = header(original.value, 'Message-ID');
  const references = [header(original.value, 'References'), messageIdHeader]
    .filter(Boolean)
    .join(' ');

  const raw = buildReplyMime({
    from: integration.account_email ?? '',
    to: draft.value.to,
    cc: draft.value.cc,
    subject: draft.value.subject,
    inReplyTo: messageIdHeader,
    references,
    body: input.body,
    signatureHtml: input.signatureHtml,
  });
  const sent = await gmail<{ id: string; threadId: string }>(store, integration, '/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64urlEncode(raw), threadId: draft.value.threadId }),
  });
  if (!sent.ok) return sent;
  if (draft.value.draftId) {
    const removed = await gmail<void>(store, integration, `/drafts/${draft.value.draftId}`, {
      method: 'DELETE',
    });
    if (!removed.ok) log.warn('Sent, but the old draft could not be removed', {});
  }
  return ok({ messageId: sent.value.id, threadId: sent.value.threadId });
}

/** Take a thread out of the inbox (Gmail's Archive). Refuses without the send grant. */
export async function archiveThread(
  store: DataStore,
  integration: Integration,
  id: string,
): Promise<Result<true>> {
  if (!canSend(integration)) return err('forbidden', 'Archiving needs sending turned on.');
  const threadId = await resolveThreadId(store, integration, id);
  if (!threadId.ok) return threadId;
  const res = await gmail<unknown>(store, integration, `/threads/${threadId.value}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
  });
  return res.ok ? ok(true) : res;
}

/** The only labels the inbox may change: read state, star, and inbox (archive / move back). */
export type InboxLabel = 'UNREAD' | 'STARRED' | 'INBOX';

/** Add or remove those labels on a whole thread. Refuses without the send grant. */
export async function setThreadLabels(
  store: DataStore,
  integration: Integration,
  id: string,
  change: { add?: InboxLabel[]; remove?: InboxLabel[] },
): Promise<Result<true>> {
  if (!canSend(integration)) return err('forbidden', 'This needs sending turned on.');
  const threadId = await resolveThreadId(store, integration, id);
  if (!threadId.ok) return threadId;
  const res = await gmail<unknown>(store, integration, `/threads/${threadId.value}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addLabelIds: change.add ?? [], removeLabelIds: change.remove ?? [] }),
  });
  return res.ok ? ok(true) : res;
}

export interface MimeAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

/** RFC 2822 new message (no thread), plain + HTML, optionally with attachments. Exported for tests. */
export function buildNewMime(input: {
  from: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  signatureHtml: string | null;
  attachments?: MimeAttachment[];
  links?: boolean;
}): string {
  const reply = buildReplyMime({ ...input, inReplyTo: '', references: '' });
  if (!input.attachments?.length) return reply;
  // Re-wrap: the alternative part becomes the first part of a multipart/mixed.
  const split = reply.indexOf('\r\n\r\n');
  const headerLines = reply.slice(0, split).split('\r\n');
  const altType = headerLines.find((h) => h.startsWith('Content-Type: multipart/alternative'))!;
  const outer = headerLines.filter((h) => !h.startsWith('Content-Type: multipart/alternative'));
  const mixed = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const clean = (v: string) => v.replace(/[\r\n"]+/g, ' ').trim();
  const parts = input.attachments.map((a) =>
    [
      `--${mixed}`,
      `Content-Type: ${clean(a.mimeType) || 'application/octet-stream'}; name="${clean(a.filename)}"`,
      `Content-Disposition: attachment; filename="${clean(a.filename)}"`,
      'Content-Transfer-Encoding: base64',
      '',
      (a.data.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n'),
    ].join('\r\n'),
  );
  return [
    ...outer,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    altType,
    '',
    reply.slice(split + 4),
    ...parts,
    `--${mixed}--`,
    '',
  ].join('\r\n');
}

const MAX_FORWARD_BYTES = 20 * 1024 * 1024;

interface AttachmentPart {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string; size?: number };
  parts?: AttachmentPart[];
}

function attachmentParts(part: AttachmentPart | undefined, out: AttachmentPart[] = []) {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) out.push(part);
  for (const child of part.parts ?? []) attachmentParts(child, out);
  return out;
}

/**
 * Send a new email (or a forward, which carries the original's attachments)
 * from the connected mailbox, from a person's tap on Send. Refuses without the
 * send grant.
 */
export async function sendNew(
  store: DataStore,
  integration: Integration,
  input: {
    to: string;
    cc: string;
    subject: string;
    body: string;
    signatureHtml: string | null;
    forwardMessageId?: string | null;
    /** Names written [Full Name](LinkedIn URL) go out as links (the intro draft). */
    links?: boolean;
  },
): Promise<Result<{ messageId: string; threadId: string }>> {
  if (!canSend(integration)) return err('forbidden', 'Sending is not turned on for this mailbox.');
  if (!input.to.trim()) return err('invalid_input', 'Add who it goes to.');
  if (!input.body.trim()) return err('invalid_input', 'The email is empty.');

  const attachments: MimeAttachment[] = [];
  if (input.forwardMessageId) {
    const original = await gmail<Message & { payload?: AttachmentPart }>(
      store,
      integration,
      `/messages/${input.forwardMessageId}?format=full`,
    );
    if (!original.ok) return original;
    let total = 0;
    for (const part of attachmentParts(original.value.payload)) {
      total += part.body?.size ?? 0;
      if (total > MAX_FORWARD_BYTES) {
        return err('invalid_input', 'The attachments are over 20 MB. Forward this one from Gmail.');
      }
      const data = await gmail<{ data: string }>(
        store,
        integration,
        `/messages/${input.forwardMessageId}/attachments/${part.body!.attachmentId}`,
      );
      if (!data.ok) return data;
      attachments.push({
        filename: part.filename!,
        mimeType: part.mimeType ?? 'application/octet-stream',
        data: Buffer.from(data.value.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
      });
    }
  }

  const raw = buildNewMime({
    from: integration.account_email ?? '',
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    body: input.body,
    signatureHtml: input.signatureHtml,
    attachments,
    links: input.links,
  });
  const sent = await gmail<{ id: string; threadId: string }>(store, integration, '/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64urlEncode(raw) }),
  });
  if (!sent.ok) return sent;
  return ok({ messageId: sent.value.id, threadId: sent.value.threadId });
}

/** A header value, RFC 2047-encoded when it is not plain ASCII (a subject with an em dash). */
export function encodeHeaderValue(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/**
 * One campaign email as RFC 2822: plain and HTML alternatives (the HTML
 * already carries the signature and, when the campaign tracks, the pixel and
 * tracked links), attachments, and, only when the campaign has its
 * unsubscribe link switched on, the List-Unsubscribe headers mail providers
 * show as their own unsubscribe button. Exported for tests.
 */
export function buildCampaignMime(input: {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: MimeAttachment[];
  listUnsubscribe?: string | null;
}): string {
  const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const alt = `a_${stamp}`;
  const mixed = `m_${stamp}`;
  const clean = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();
  const quoted = (v: string) => v.replace(/[\r\n"]+/g, ' ').trim();
  const wrap = (data: Buffer) => (data.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
  const alternative = [
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(input.text, 'utf8')),
    `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(input.html, 'utf8')),
    `--${alt}--`,
  ];
  const headers = [
    `From: ${clean(input.from)}`,
    `To: ${clean(input.to)}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    input.listUnsubscribe ? `List-Unsubscribe: <${clean(input.listUnsubscribe)}>` : '',
    input.listUnsubscribe ? 'List-Unsubscribe-Post: List-Unsubscribe=One-Click' : '',
    'MIME-Version: 1.0',
  ].filter(Boolean);
  if (!input.attachments?.length) {
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      '',
      ...alternative,
      '',
    ].join('\r\n');
  }
  const parts = input.attachments.flatMap((a) => [
    `--${mixed}`,
    `Content-Type: ${quoted(a.mimeType) || 'application/octet-stream'}; name="${quoted(a.filename)}"`,
    `Content-Disposition: attachment; filename="${quoted(a.filename)}"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap(a.data),
  ]);
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    ...alternative,
    ...parts,
    `--${mixed}--`,
    '',
  ].join('\r\n');
}

/**
 * Send one campaign email to one recipient from the connected mailbox.
 * Called only by a campaign batch that a person confirmed and is driving from
 * their open page, or by "Send test to me". Refuses without the send grant.
 */
export async function sendCampaignEmail(
  store: DataStore,
  integration: Integration,
  input: {
    to: string;
    subject: string;
    html: string;
    text: string;
    attachments?: MimeAttachment[];
    listUnsubscribe?: string | null;
  },
): Promise<Result<{ messageId: string; threadId: string }>> {
  if (!canSend(integration)) return err('forbidden', 'Sending is not turned on for this mailbox.');
  if (!input.to.trim()) return err('invalid_input', 'No recipient.');
  if (!input.text.trim()) return err('invalid_input', 'The email is empty.');
  const raw = buildCampaignMime({ ...input, from: integration.account_email ?? '' });
  const sent = await gmail<{ id: string; threadId: string }>(
    store,
    integration,
    '/messages/send?uploadType=media',
    { method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: raw },
    UPLOAD_BASE,
  );
  if (!sent.ok) return sent;
  return ok({ messageId: sent.value.id, threadId: sent.value.threadId });
}
