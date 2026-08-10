import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { getAccessToken } from '@/lib/google/oauth';
import { log } from '@/lib/security/redact';
import type { Integration } from '@/lib/types/domain';
import { htmlToPlainText } from '@/lib/util/text';
import { err, ok, type Result } from '@/lib/util/result';
import type {
  EmailProvider,
  ListMessagesOptions,
  ListMessagesResult,
  RawEmailAddress,
  RawEmailAttachmentRef,
  RawEmailFull,
  RawEmailHeader,
} from './provider';

/**
 * Gmail adapter over the REST API.
 *
 * Deliberately not the `googleapis` package: two endpoints do not justify a
 * ~50 MB dependency and a generated client whose shapes drift. The request
 * shapes are pinned here and covered by fixture-driven tests.
 *
 * Incremental sync uses `history.list` against the stored historyId, falling
 * back to a bounded `messages.list` when the history window has expired
 * (Google keeps roughly a week).
 */

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export class GmailProvider implements EmailProvider {
  readonly kind = 'gmail' as const;

  constructor(
    private readonly store: DataStore,
    private readonly integration: Integration,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<Result<T>> {
    const token = await getAccessToken(this.store, this.integration);
    if (!token.ok) return token;
    try {
      const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token.value}` },
      });
      if (response.status === 401 || response.status === 403) {
        return err(
          'provider_unauthorized',
          'Gmail rejected the request. The connection may need to be re-authorised.',
        );
      }
      if (response.status === 429) {
        return err('quota_exceeded', 'Gmail rate limit reached. Sync will resume shortly.', {
          retryable: true,
        });
      }
      if (response.status === 404) {
        return err('not_found', 'That Gmail record no longer exists.');
      }
      if (!response.ok) {
        log.warn('Gmail request failed', { path, status: response.status });
        return err('provider_unavailable', 'Gmail is unavailable right now.', { retryable: true });
      }
      return ok((await response.json()) as T);
    } catch {
      return err('provider_unavailable', 'Could not reach Gmail.', { retryable: true });
    }
  }

  /**
   * Register for push notifications on this mailbox.
   *
   * Gmail does not call an application directly: it publishes to a Cloud
   * Pub/Sub topic, which then pushes to whatever endpoint the subscription
   * names. So this call registers interest, and the delivery path is
   * configured entirely in Google Cloud.
   *
   * The registration lapses after seven days — Google's limit, not a choice —
   * so `expiresAt` is stored and the daily job renews it. A watch that silently
   * stopped would look exactly like a quiet mailbox.
   *
   * The returned historyId is the point to resume from. It is only used when
   * there is no cursor already; overwriting a live cursor with this would skip
   * everything that arrived between the last sync and now.
   */
  async watch(topicName: string): Promise<Result<{ historyId: string; expiresAt: string }>> {
    const response = await this.request<{ historyId?: string; expiration?: string }>('/watch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topicName,
        // INBOX only. Watching every label would wake the app for drafts, sent
        // mail and label changes — noise that costs a cold start each time.
        labelIds: ['INBOX'],
        labelFilterBehavior: 'include',
      }),
    });
    if (!response.ok) return response;

    const { historyId, expiration } = response.value;
    if (!historyId || !expiration) {
      return err('provider_unavailable', 'Gmail did not return a watch registration.', {
        retryable: true,
      });
    }
    // `expiration` is epoch milliseconds as a string.
    return ok({
      historyId,
      expiresAt: new Date(Number(expiration)).toISOString(),
    });
  }

  /**
   * Cancel push notifications.
   *
   * Called on disconnect. Without it Gmail keeps publishing to the topic for a
   * mailbox nobody is watching, and the endpoint answers every one of them.
   */
  async stopWatch(): Promise<Result<true>> {
    const response = await this.request<unknown>('/stop', { method: 'POST' });
    if (!response.ok) return response;
    return ok(true);
  }

  async listMessages(options: ListMessagesOptions): Promise<Result<ListMessagesResult>> {
    if (options.cursor) {
      const incremental = await this.listViaHistory(options);
      if (incremental.ok) return incremental;
      // 404 from history.list means the cursor aged out; a full window is correct.
      if (incremental.error.code !== 'not_found') return incremental;
    }
    return this.listViaQuery(options, options.cursor !== null);
  }

  private async listViaHistory(options: ListMessagesOptions): Promise<Result<ListMessagesResult>> {
    const params = new URLSearchParams({
      startHistoryId: options.cursor ?? '',
      historyTypes: 'messageAdded',
      maxResults: String(Math.min(options.maxResults, 500)),
    });
    const result = await this.request<{
      history?: { messagesAdded?: { message: { id: string } }[] }[];
      historyId?: string;
    }>(`/history?${params.toString()}`);
    if (!result.ok) return result;

    const ids = new Set<string>();
    for (const h of result.value.history ?? []) {
      for (const added of h.messagesAdded ?? []) ids.add(added.message.id);
    }
    const messages = await this.hydrateHeaders([...ids].slice(0, options.maxResults));
    if (!messages.ok) return messages;
    return ok({
      messages: messages.value,
      nextCursor: result.value.historyId ?? options.cursor,
      fellBackToFullSync: false,
    });
  }

  private async listViaQuery(
    options: ListMessagesOptions,
    isFallback: boolean,
  ): Promise<Result<ListMessagesResult>> {
    const afterSeconds = Math.floor(Date.parse(options.since) / 1000);
    const params = new URLSearchParams({
      maxResults: String(Math.min(options.maxResults, 500)),
      q: `after:${afterSeconds}`,
    });
    const list = await this.request<{ messages?: { id: string }[] }>(
      `/messages?${params.toString()}`,
    );
    if (!list.ok) return list;

    const headers = await this.hydrateHeaders(
      (list.value.messages ?? []).map((m) => m.id).slice(0, options.maxResults),
    );
    if (!headers.ok) return headers;

    const profile = await this.request<{ historyId?: string }>('/profile');
    return ok({
      messages: headers.value,
      nextCursor: profile.ok ? (profile.value.historyId ?? null) : null,
      fellBackToFullSync: isFallback,
    });
  }

  /**
   * Metadata-only hydration. `format=metadata` means Google never returns the
   * body, so a routine sync cannot pull message content into our storage.
   */
  private async hydrateHeaders(ids: string[]): Promise<Result<RawEmailHeader[]>> {
    const out: RawEmailHeader[] = [];
    for (const id of ids) {
      const params = new URLSearchParams({ format: 'metadata' });
      for (const h of ['Subject', 'From', 'To', 'Cc', 'Date']) params.append('metadataHeaders', h);
      const message = await this.request<GmailMessage>(`/messages/${id}?${params.toString()}`);
      if (!message.ok) {
        if (message.error.code === 'not_found') continue;
        return message;
      }
      out.push(toHeader(message.value));
    }
    return ok(out);
  }

  async getMessage(providerMessageId: string): Promise<Result<RawEmailFull>> {
    const message = await this.request<GmailMessage>(`/messages/${providerMessageId}?format=full`);
    if (!message.ok) return message;
    const header = toHeader(message.value);
    const { text, attachments } = flattenPayload(message.value.payload);
    return ok({ ...header, bodyText: text, attachments });
  }

  async getAttachment(
    providerMessageId: string,
    providerAttachmentId: string,
  ): Promise<Result<Uint8Array>> {
    const result = await this.request<{ data?: string; size?: number }>(
      `/messages/${providerMessageId}/attachments/${providerAttachmentId}`,
    );
    if (!result.ok) return result;
    if (!result.value.data) return err('not_found', 'The attachment body was empty.');
    return ok(new Uint8Array(Buffer.from(result.value.data, 'base64url')));
  }

  async getThread(providerThreadId: string): Promise<Result<RawEmailHeader[]>> {
    const result = await this.request<{ messages?: GmailMessage[] }>(
      `/threads/${providerThreadId}?format=metadata`,
    );
    if (!result.ok) return result;
    return ok((result.value.messages ?? []).map(toHeader));
  }

  messageUrl(providerMessageId: string): string {
    return `https://mail.google.com/mail/u/0/#all/${providerMessageId}`;
  }
}

/* ------------------------------------------------------------- transforms */

export function parseAddressList(value: string | undefined): RawEmailAddress[] {
  if (!value) return [];
  return value
    .split(',')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const angled = /^(.*?)<([^>]+)>$/.exec(raw);
      if (angled) {
        const name = (angled[1] ?? '').trim().replace(/^"|"$/g, '');
        return { name: name || null, address: (angled[2] ?? '').trim().toLowerCase() };
      }
      return { name: null, address: raw.toLowerCase() };
    })
    .filter((a) => a.address.includes('@'));
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

export function toHeader(message: GmailMessage): RawEmailHeader {
  const headers = message.payload?.headers;
  const from = parseAddressList(headerValue(headers, 'From'))[0] ?? {
    name: null,
    address: 'unknown@unknown.invalid',
  };
  const sentAt = message.internalDate
    ? new Date(Number(message.internalDate)).toISOString()
    : new Date().toISOString();
  return {
    providerMessageId: message.id,
    providerThreadId: message.threadId,
    subject: headerValue(headers, 'Subject') ?? null,
    snippet: decodeEntities(message.snippet ?? ''),
    from,
    to: parseAddressList(headerValue(headers, 'To')),
    cc: parseAddressList(headerValue(headers, 'Cc')),
    labels: message.labelIds ?? [],
    isUnread: (message.labelIds ?? []).includes('UNREAD'),
    sentAt,
    hasAttachments: hasAttachmentPart(message.payload),
  };
}

function hasAttachmentPart(part: GmailPart | undefined): boolean {
  if (!part) return false;
  if (part.filename && part.filename.length > 0 && part.body?.attachmentId) return true;
  return (part.parts ?? []).some(hasAttachmentPart);
}

/**
 * Walk the MIME tree, preferring text/plain and falling back to a text
 * rendering of text/html. HTML is converted to text here and never stored or
 * rendered as markup.
 */
export function flattenPayload(payload: GmailPart | undefined): {
  text: string;
  attachments: RawEmailAttachmentRef[];
} {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: RawEmailAttachmentRef[] = [];

  const walk = (part: GmailPart | undefined, depth: number): void => {
    if (!part || depth > 12) return;
    const mime = part.mimeType ?? '';
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        providerAttachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: mime || 'application/octet-stream',
        sizeBytes: part.body.size ?? 0,
      });
    } else if (mime === 'text/plain' && part.body?.data) {
      plain.push(decodeBody(part.body.data));
    } else if (mime === 'text/html' && part.body?.data) {
      html.push(htmlToPlainText(decodeBody(part.body.data)));
    }
    for (const child of part.parts ?? []) walk(child, depth + 1);
  };

  walk(payload, 0);
  const text = (plain.length > 0 ? plain.join('\n\n') : html.join('\n\n')).trim();
  return { text, attachments };
}

function decodeBody(data: string): string {
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
