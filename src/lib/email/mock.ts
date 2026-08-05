import 'server-only';
import { buildDemoDb } from '@/lib/demo/fixtures';
import { sha256 } from '@/lib/util/hash';
import { ok, err, type Result } from '@/lib/util/result';
import type {
  EmailProvider,
  ListMessagesOptions,
  ListMessagesResult,
  RawEmailFull,
  RawEmailHeader,
} from './provider';

/**
 * Offline mailbox backed by the demo fixtures.
 *
 * It returns the *same* messages on every call, which is exactly what the
 * idempotency tests need: running sync twice must produce zero new rows the
 * second time. It also honours the `since` bound and the metadata/full split,
 * so the sync service is exercised for real rather than short-circuited.
 */
export class MockEmailProvider implements EmailProvider {
  readonly kind = 'mock' as const;

  private readonly now: Date;

  constructor(now: Date = new Date()) {
    this.now = now;
  }

  private fixtures() {
    return buildDemoDb(this.now);
  }

  private headers(): RawEmailHeader[] {
    const db = this.fixtures();
    return db.email_messages.map((m) => {
      const thread = db.email_threads.find((t) => t.id === m.thread_id);
      return {
        providerMessageId: m.provider_message_id,
        providerThreadId: thread?.provider_thread_id ?? `demo-thread-${m.thread_id.slice(-4)}`,
        subject: m.subject,
        snippet: m.snippet,
        from: { name: m.from_name, address: m.from_address },
        to: m.to_addresses.map((a) => ({ name: null, address: a })),
        cc: m.cc_addresses.map((a) => ({ name: null, address: a })),
        labels: m.labels,
        isUnread: m.is_unread,
        sentAt: m.sent_at,
        hasAttachments: m.has_attachments,
      };
    });
  }

  async listMessages(options: ListMessagesOptions): Promise<Result<ListMessagesResult>> {
    const sinceMs = Date.parse(options.since);
    const messages = this.headers()
      .filter((m) => Date.parse(m.sentAt) >= sinceMs)
      .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))
      .slice(0, options.maxResults);
    return ok({
      messages,
      // A stable cursor keyed on content: unchanged input, unchanged cursor.
      nextCursor: sha256(messages.map((m) => m.providerMessageId).join(',')).slice(0, 16),
      fellBackToFullSync: options.cursor === null,
    });
  }

  async getMessage(providerMessageId: string): Promise<Result<RawEmailFull>> {
    const db = this.fixtures();
    const message = db.email_messages.find((m) => m.provider_message_id === providerMessageId);
    if (!message) return err('not_found', 'No demo message with that id.');
    const header = this.headers().find((h) => h.providerMessageId === providerMessageId)!;
    const attachments = db.email_attachments
      .filter((a) => a.message_id === message.id)
      .map((a) => ({
        providerAttachmentId: a.provider_attachment_id ?? a.id,
        filename: a.filename,
        mimeType: a.mime_type,
        sizeBytes: a.size_bytes,
      }));
    return ok({ ...header, bodyText: message.body_text ?? '', attachments });
  }

  async getAttachment(
    _providerMessageId: string,
    providerAttachmentId: string,
  ): Promise<Result<Uint8Array>> {
    const db = this.fixtures();
    const attachment = db.email_attachments.find(
      (a) => a.provider_attachment_id === providerAttachmentId || a.id === providerAttachmentId,
    );
    if (!attachment?.extracted_text) {
      return err('not_found', 'No demo attachment content for that id.');
    }
    return ok(new TextEncoder().encode(attachment.extracted_text));
  }

  async getThread(providerThreadId: string): Promise<Result<RawEmailHeader[]>> {
    return ok(this.headers().filter((h) => h.providerThreadId === providerThreadId));
  }

  messageUrl(providerMessageId: string): string {
    // Demo mode has no external mailbox; link back into the app instead of
    // sending the user to a Gmail URL that would not resolve.
    return `/inbox?message=${encodeURIComponent(providerMessageId)}`;
  }
}
