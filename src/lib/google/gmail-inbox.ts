import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { gmailGet, type GmailReadOptions } from '@/lib/google/gmail-get';
import type { Integration } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';
import { htmlToPlainText } from '@/lib/util/text';
import { MAX_RAW_BYTES } from '@/lib/email/raw-message';

/**
 * Read-only view of Nick's Gmail inbox for the email session: which threads
 * are in the inbox right now, and who/what each one is. Uses the read scope
 * only. Kept apart from gmail-send.ts, which is the only module that writes.
 *
 * Every read fails fast unless its caller passes `GmailReadOptions.retry`,
 * which background reads and the follow-up full email do (`gmail-get.ts`).
 */

const MAX_PAGES = 3;

/**
 * Thread ids in the inbox now, newest first (up to 300). `query` narrows it,
 * e.g. "category:primary" for the Primary tab only.
 */
export async function listInboxThreadIds(
  store: DataStore,
  integration: Integration,
  query = '',
): Promise<Result<string[]>> {
  const ids: string[] = [];
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await gmailGet<{ threads?: { id: string }[]; nextPageToken?: string }>(
      store,
      integration,
      `/threads?labelIds=INBOX&maxResults=100${query ? `&q=${encodeURIComponent(query)}` : ''}${
        pageToken ? `&pageToken=${pageToken}` : ''
      }`,
    );
    if (!res.ok) return res;
    for (const t of res.value.threads ?? []) ids.push(t.id);
    if (!res.value.nextPageToken) break;
    pageToken = res.value.nextPageToken;
  }
  return ok(ids);
}

/** A label's colour as Gmail stores it: both hex, e.g. "#fb4c2f" on "#ffffff". */
export interface GmailLabelColor {
  bg: string;
  fg: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Gmail's labels: id -> name, and id -> colour for the ones given a colour in Gmail. */
export async function readLabelDirectory(
  store: DataStore,
  integration: Integration,
): Promise<{ names: Map<string, string>; colors: Map<string, GmailLabelColor> }> {
  const res = await gmailGet<{
    labels?: {
      id: string;
      name: string;
      color?: { backgroundColor?: string; textColor?: string };
    }[];
  }>(store, integration, '/labels');
  const labels = res.ok ? (res.value.labels ?? []) : [];
  const colors = new Map<string, GmailLabelColor>();
  for (const l of labels) {
    const bg = l.color?.backgroundColor;
    const fg = l.color?.textColor;
    // Only plain hex reaches a style attribute.
    if (bg && fg && HEX.test(bg) && HEX.test(fg)) colors.set(l.id, { bg, fg });
  }
  return { names: new Map(labels.map((l) => [l.id, l.name])), colors };
}

/** Label id -> name, for the triage @-labels. */
export async function readLabelNames(
  store: DataStore,
  integration: Integration,
): Promise<Map<string, string>> {
  return (await readLabelDirectory(store, integration)).names;
}

export interface InboxThreadMeta {
  id: string;
  who: string;
  subject: string;
  labelIds: string[];
  latestAt: string | null;
  /** True when the newest real message is from the mailbox itself (already answered). */
  lastFromUs: boolean;
  /** The address the thread's first message came from (who started it). */
  firstFromAddress?: string | null;
  /** The newest real message's sender, name and address (the search's people suggestions). */
  latestFrom?: { name: string; address: string | null };
  /** Who wrote each message, oldest first (drafts left out), for Gmail's "Name, me 3". */
  senders?: { name: string; me: boolean }[];
  /** Who the newest message went to, for the Sent folder's "To: name". */
  toName?: string;
  /** A draft sits on the thread (Gmail's red "Draft" in the row). */
  hasDraft?: boolean;
  /** Some message is multipart/mixed: it carries an attachment. */
  hasAttachment?: boolean;
}

interface Msg {
  id?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

const header = (m: Msg | undefined, name: string) =>
  m?.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

/** "Jane Doe <jane@x.com>" -> "Jane Doe"; bare address -> its local part. */
export function displayName(from: string): string {
  const named = /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1]?.trim();
  if (named) return named;
  const addr = /<?([^<>\s]+@[^<>\s]+)>?/.exec(from)?.[1] ?? from;
  return addr.split('@')[0] ?? addr;
}

export async function readThreadMeta(
  store: DataStore,
  integration: Integration,
  id: string,
): Promise<InboxThreadMeta | null> {
  const res = await gmailGet<{ messages?: Msg[] }>(
    store,
    integration,
    `/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=To&metadataHeaders=Content-Type`,
  );
  if (!res.ok) return null;
  const all = res.value.messages ?? [];
  const real = all.filter((m) => !m.labelIds?.includes('DRAFT'));
  const latest = real.at(-1);
  if (!latest) return null;
  const own = (integration.account_email ?? '').toLowerCase();
  const from = header(latest, 'From');
  const labels = [...new Set(real.flatMap((m) => m.labelIds ?? []))];
  const isOwn = (value: string) => {
    const addr = /<?([^<>\s"]+@[^<>\s"]+)>?/.exec(value)?.[1]?.toLowerCase();
    return Boolean(own) && addr === own;
  };
  return {
    senders: real.map((m) => ({
      name: displayName(header(m, 'From')),
      me: isOwn(header(m, 'From')),
    })),
    toName: displayName(header(latest, 'To').split(',')[0] ?? ''),
    latestFrom: {
      name: displayName(from),
      address: /<?([^<>\s"]+@[^<>\s"]+)>?/.exec(from)?.[1]?.toLowerCase() ?? null,
    },
    hasDraft: all.some((m) => m.labelIds?.includes('DRAFT')),
    hasAttachment: real.some((m) => /multipart\/mixed/i.test(header(m, 'Content-Type'))),
    id,
    who: displayName(from),
    subject: header(real[0], 'Subject') || '(no subject)',
    labelIds: labels,
    latestAt: latest.internalDate ? new Date(Number(latest.internalDate)).toISOString() : null,
    lastFromUs: Boolean(own) && from.toLowerCase().includes(own),
    firstFromAddress:
      /<?([^<>\s"]+@[^<>\s"]+)>?/.exec(header(real[0], 'From'))?.[1]?.toLowerCase() ?? null,
  };
}

export interface MessageHeadline {
  id: string;
  threadId: string;
  subject: string;
  at: string | null;
}

/** Message ids matching a Gmail search, anywhere in the mailbox, newest first. */
export async function listMessageIds(
  store: DataStore,
  integration: Integration,
  query: string,
  max = 300,
  options: GmailReadOptions = {},
): Promise<Result<string[]>> {
  const ids: string[] = [];
  let pageToken = '';
  while (ids.length < max) {
    const res = await gmailGet<{ messages?: { id: string }[]; nextPageToken?: string }>(
      store,
      integration,
      `/messages?maxResults=${Math.min(100, max - ids.length)}&q=${encodeURIComponent(query)}${
        pageToken ? `&pageToken=${pageToken}` : ''
      }`,
      options,
    );
    if (!res.ok) return res;
    for (const m of res.value.messages ?? []) ids.push(m.id);
    if (!res.value.nextPageToken) break;
    pageToken = res.value.nextPageToken;
  }
  return ok(ids);
}

/** Subject and time of one message, no body. */
export async function readMessageHeadline(
  store: DataStore,
  integration: Integration,
  id: string,
): Promise<MessageHeadline | null> {
  const res = await gmailGet<Msg & { id: string; threadId: string }>(
    store,
    integration,
    `/messages/${id}?format=metadata&metadataHeaders=Subject`,
  );
  if (!res.ok) return null;
  return {
    id,
    threadId: res.value.threadId,
    subject: header(res.value, 'Subject'),
    at: res.value.internalDate ? new Date(Number(res.value.internalDate)).toISOString() : null,
  };
}

/**
 * One message's sender and unsubscribe headers (List-Unsubscribe and
 * List-Unsubscribe-Post), re-read before a one-click unsubscribe so the
 * address posted to is the message's own, never one the browser sent.
 */
export async function readUnsubscribeHeaders(
  store: DataStore,
  integration: Integration,
  id: string,
): Promise<Result<{ from: string; listUnsubscribe: string; listUnsubscribePost: string }>> {
  const res = await gmailGet<Msg & { id: string }>(
    store,
    integration,
    `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post`,
  );
  if (!res.ok) return res;
  return ok({
    from: header(res.value, 'From'),
    listUnsubscribe: header(res.value, 'List-Unsubscribe'),
    listUnsubscribePost: header(res.value, 'List-Unsubscribe-Post'),
  });
}

/**
 * The thread a message belongs to. `format=minimal` carries ids and labels
 * only, no headers or body. Unlike readMessageHeadline, a failure comes back
 * as the error, so a caller can tell a rate limit from a missing message.
 */
export async function readMessageThreadId(
  store: DataStore,
  integration: Integration,
  id: string,
  options: GmailReadOptions = {},
): Promise<Result<string>> {
  const res = await gmailGet<{ threadId?: string }>(
    store,
    integration,
    `/messages/${id}?format=minimal`,
    options,
  );
  if (!res.ok) return res;
  return res.value.threadId
    ? ok(res.value.threadId)
    : err('not_found', 'That message has no thread.');
}

/* ------------------------------------------------------------ live inbox */

export interface ThreadStub {
  id: string;
  snippet: string;
  historyId: string;
}

/**
 * One page of threads for a Gmail search (optionally limited to label ids).
 * `total` is Gmail's own estimate of the whole list (the pager's "of N").
 * Spam and Trash need `includeSpamTrash`.
 */
export async function listThreadPage(
  store: DataStore,
  integration: Integration,
  options: {
    q?: string;
    labelIds?: string[];
    pageToken?: string;
    max?: number;
    includeSpamTrash?: boolean;
  },
): Promise<Result<{ threads: ThreadStub[]; nextPageToken: string | null; total?: number }>> {
  const params = new URLSearchParams({ maxResults: String(options.max ?? 50) });
  for (const label of options.labelIds ?? []) params.append('labelIds', label);
  if (options.q) params.set('q', options.q);
  if (options.pageToken) params.set('pageToken', options.pageToken);
  if (options.includeSpamTrash) params.set('includeSpamTrash', 'true');
  const res = await gmailGet<{
    threads?: ThreadStub[];
    nextPageToken?: string;
    resultSizeEstimate?: number;
  }>(store, integration, `/threads?${params.toString()}`);
  if (!res.ok) return res;
  return ok({
    threads: res.value.threads ?? [],
    nextPageToken: res.value.nextPageToken ?? null,
    total: res.value.resultSizeEstimate,
  });
}

/** A label's own counts (Gmail's labels.get): threads in it, and how many unread. */
export async function readLabelCount(
  store: DataStore,
  integration: Integration,
  labelId: string,
): Promise<{ total: number; unread: number } | null> {
  const res = await gmailGet<{ threadsTotal?: number; threadsUnread?: number }>(
    store,
    integration,
    `/labels/${encodeURIComponent(labelId)}`,
  );
  if (!res.ok) return null;
  return { total: res.value.threadsTotal ?? 0, unread: res.value.threadsUnread ?? 0 };
}

/** Whether any thread in the inbox carries a category label: an empty category's tab is hidden. */
export async function inboxCategoryHasMail(
  store: DataStore,
  integration: Integration,
  categoryLabel: string,
): Promise<boolean> {
  const res = await gmailGet<{ threads?: { id: string }[] }>(
    store,
    integration,
    `/threads?maxResults=1&labelIds=INBOX&labelIds=${encodeURIComponent(categoryLabel)}`,
  );
  return res.ok && (res.value.threads?.length ?? 0) > 0;
}

/* --------------------------------------------------------------- drafts */

export interface DraftStub {
  draftId: string;
  messageId: string;
  threadId: string;
  to: string;
  subject: string;
  snippet: string;
  at: string | null;
}

/** One page of Gmail's drafts, newest first, each with its headline. Read scope only. */
export async function listDraftPage(
  store: DataStore,
  integration: Integration,
  options: { pageToken?: string; max?: number; q?: string } = {},
): Promise<Result<{ drafts: DraftStub[]; nextPageToken: string | null; total?: number }>> {
  const params = new URLSearchParams({ maxResults: String(options.max ?? 50) });
  if (options.pageToken) params.set('pageToken', options.pageToken);
  if (options.q) params.set('q', options.q);
  const list = await gmailGet<{
    drafts?: { id: string; message: { id: string; threadId: string } }[];
    nextPageToken?: string;
    resultSizeEstimate?: number;
  }>(store, integration, `/drafts?${params.toString()}`);
  if (!list.ok) return list;
  const drafts: DraftStub[] = [];
  const ids = list.value.drafts ?? [];
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const got = await Promise.all(
      batch.map((d) =>
        gmailGet<{ id: string; message: Msg & { id: string; threadId: string; snippet?: string } }>(
          store,
          integration,
          `/drafts/${d.id}?format=metadata`,
        ).catch(() => null),
      ),
    );
    got.forEach((res, j) => {
      if (!res?.ok) return;
      const m = res.value.message;
      drafts.push({
        draftId: batch[j]!.id,
        messageId: m.id,
        threadId: m.threadId,
        to: header(m, 'To'),
        subject: header(m, 'Subject'),
        snippet: m.snippet ?? '',
        at: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
      });
    });
  }
  return ok({
    drafts,
    nextPageToken: list.value.nextPageToken ?? null,
    total: list.value.resultSizeEstimate,
  });
}

export interface DraftFull {
  draftId: string;
  messageId: string;
  threadId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  html: string;
}

/** One draft whole, to open into the compose window. Read scope only. */
export async function readDraftFull(
  store: DataStore,
  integration: Integration,
  draftId: string,
): Promise<Result<DraftFull>> {
  const res = await gmailGet<{
    id: string;
    message: Msg & { id: string; threadId: string; payload?: FullPart };
  }>(store, integration, `/drafts/${encodeURIComponent(draftId)}?format=full`);
  if (!res.ok) return res;
  const m = res.value.message;
  const html = findText(m.payload, 'text/html');
  const plain = findText(m.payload, 'text/plain');
  return ok({
    draftId: res.value.id,
    messageId: m.id,
    threadId: m.threadId,
    to: header(m, 'To'),
    cc: header(m, 'Cc'),
    bcc: header(m, 'Bcc'),
    subject: header(m, 'Subject'),
    text: (plain || htmlToPlainText(html)).replace(/\r\n/g, '\n').trim(),
    html,
  });
}

interface FullPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: FullPart[];
}

const decode = (data: string) =>
  Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function findText(part: FullPart | undefined, mime: string): string {
  if (!part) return '';
  if (part.mimeType === mime && part.body?.data && !part.filename) return decode(part.body.data);
  for (const child of part.parts ?? []) {
    const text = findText(child, mime);
    if (text) return text;
  }
  return '';
}

export interface AttachmentRef {
  name: string;
  id: string;
  mimeType: string;
  size: number;
}

function attachmentRefs(part: FullPart | undefined, out: AttachmentRef[] = []): AttachmentRef[] {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) {
    out.push({
      name: part.filename,
      id: part.body.attachmentId,
      mimeType: part.mimeType ?? 'application/octet-stream',
      size: part.body.size ?? 0,
    });
  }
  for (const child of part.parts ?? []) attachmentRefs(child, out);
  return out;
}

/** One attachment's bytes. Read scope only. */
export async function readAttachment(
  store: DataStore,
  integration: Integration,
  messageId: string,
  attachmentId: string,
): Promise<Result<Buffer>> {
  const res = await gmailGet<{ data?: string }>(
    store,
    integration,
    `/messages/${messageId}/attachments/${attachmentId}`,
  );
  if (!res.ok) return res;
  if (!res.value.data) return err('not_found', 'That attachment is empty.');
  return ok(Buffer.from(res.value.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

/**
 * One message's original RFC 822 source (Show original, Download message,
 * Forward as attachment). Its size is read first, so a message over
 * MAX_RAW_BYTES is refused without fetching it. Read scope only.
 */
export async function readMessageRaw(
  store: DataStore,
  integration: Integration,
  messageId: string,
): Promise<Result<Buffer>> {
  if (!/^[0-9a-f]{10,24}$/i.test(messageId)) return err('invalid_input', 'Unknown message.');
  const size = await gmailGet<{ sizeEstimate?: number }>(
    store,
    integration,
    `/messages/${messageId}?format=minimal`,
  );
  if (!size.ok) return size;
  if ((size.value.sizeEstimate ?? 0) > MAX_RAW_BYTES) {
    return err('invalid_input', 'That message is over 10 MB. Open it in Gmail for its original.');
  }
  const res = await gmailGet<{ raw?: string }>(
    store,
    integration,
    `/messages/${messageId}?format=raw`,
  );
  if (!res.ok) return res;
  if (!res.value.raw) return err('not_found', 'Gmail sent no source for that message.');
  return ok(Buffer.from(res.value.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

export interface FullMessage {
  id: string;
  from: string;
  to: string;
  cc: string;
  date: string | null;
  subject: string;
  text: string;
  attachments: AttachmentRef[];
  labelIds: string[];
  /** The List-Unsubscribe and List-Unsubscribe-Post headers, when the sender gave them. */
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
}

export interface FullThread {
  id: string;
  subject: string;
  labelIds: string[];
  messages: FullMessage[];
}

/** The whole conversation as plain text, drafts left out. Read scope only. */
export async function readThreadFull(
  store: DataStore,
  integration: Integration,
  id: string,
  options: GmailReadOptions = {},
): Promise<Result<FullThread>> {
  const res = await gmailGet<{
    id: string;
    messages?: (Msg & { id: string; payload?: FullPart })[];
  }>(store, integration, `/threads/${id}?format=full`, options);
  if (!res.ok) return res;
  const messages = (res.value.messages ?? [])
    .filter((m) => !m.labelIds?.includes('DRAFT'))
    .map((m) => {
      const plain = findText(m.payload, 'text/plain');
      const html = plain ? '' : findText(m.payload, 'text/html');
      return {
        id: m.id,
        from: header(m, 'From'),
        to: header(m, 'To'),
        cc: header(m, 'Cc'),
        date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
        subject: header(m, 'Subject'),
        text: (plain || htmlToPlainText(html)).replace(/\r\n/g, '\n').trim(),
        attachments: attachmentRefs(m.payload),
        labelIds: m.labelIds ?? [],
        listUnsubscribe: header(m, 'List-Unsubscribe'),
        listUnsubscribePost: header(m, 'List-Unsubscribe-Post'),
      };
    });
  if (messages.length === 0) return err('not_found', 'That conversation has no messages.');
  return ok({
    id: res.value.id,
    subject: messages[0]!.subject || '(no subject)',
    labelIds: [...new Set(messages.flatMap((m) => m.labelIds))],
    messages,
  });
}
