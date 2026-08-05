import type { Result } from '@/lib/util/result';

/**
 * Mailbox provider seam.
 *
 * Gmail is the only implementation the brief asks for, but nothing above this
 * interface knows that. Adding Microsoft Graph means writing one adapter with
 * these five methods and registering it in `lib/runtime.ts`; no service, route
 * or component changes.
 *
 * Two-phase by design: `listMessages` returns metadata only (the default,
 * cheap, privacy-preserving path) and `getMessage` fetches a full body only
 * when something has decided it is worth reading.
 */

export interface RawEmailAddress {
  name: string | null;
  address: string;
}

/** Metadata-only view. No body, no attachment content. */
export interface RawEmailHeader {
  providerMessageId: string;
  providerThreadId: string;
  subject: string | null;
  snippet: string;
  from: RawEmailAddress;
  to: RawEmailAddress[];
  cc: RawEmailAddress[];
  labels: string[];
  isUnread: boolean;
  sentAt: string;
  hasAttachments: boolean;
}

export interface RawEmailAttachmentRef {
  providerAttachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** Full message, fetched only on demand. */
export interface RawEmailFull extends RawEmailHeader {
  bodyText: string;
  attachments: RawEmailAttachmentRef[];
}

export interface ListMessagesOptions {
  /** Provider history cursor from the previous run; enables incremental sync. */
  cursor: string | null;
  /** Absolute lower bound, used for the first run and as a safety net. */
  since: string;
  maxResults: number;
}

export interface ListMessagesResult {
  messages: RawEmailHeader[];
  nextCursor: string | null;
  /** True when the provider could not do an incremental fetch and did a full one. */
  fellBackToFullSync: boolean;
}

export interface EmailProvider {
  readonly kind: 'gmail' | 'mock';
  listMessages(options: ListMessagesOptions): Promise<Result<ListMessagesResult>>;
  getMessage(providerMessageId: string): Promise<Result<RawEmailFull>>;
  getAttachment(
    providerMessageId: string,
    providerAttachmentId: string,
  ): Promise<Result<Uint8Array>>;
  getThread(providerThreadId: string): Promise<Result<RawEmailHeader[]>>;
  /** Deep link to the message in the provider's own UI. */
  messageUrl(providerMessageId: string): string;
}
