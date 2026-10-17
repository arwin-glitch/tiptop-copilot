import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { gmailGet, type GmailReadOptions } from '@/lib/google/gmail-get';
import type { Integration } from '@/lib/types/domain';
import { ok, type Result } from '@/lib/util/result';

/**
 * One message's headers and Gmail's own snippet, no body. Read scope only.
 * Used to sort company updates from everything else before any body is read:
 * who sent it, who it went to (to tell a bcc), and whether it came from a
 * mailing list. Fails fast unless a background caller passes `retry`
 * (`gmail-get.ts`).
 */

export interface MessageMeta {
  id: string;
  threadId: string;
  from: string;
  /** Who replies go to; for updates sent through Visible or Mailchimp, the founder. */
  replyTo?: string;
  to: string;
  cc: string;
  subject: string;
  /** ISO, from Gmail's internal date. */
  date: string | null;
  /** Gmail's snippet, still HTML-escaped. */
  snippet: string;
  labelIds: string[];
  /** Sent through a mailing list or bulk sender (List-Unsubscribe, List-Id, Precedence). */
  bulk: boolean;
}

interface RawMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

const HEADERS = [
  'From',
  'Reply-To',
  'To',
  'Cc',
  'Subject',
  'List-Unsubscribe',
  'List-Id',
  'Precedence',
];

export async function readMessageMeta(
  store: DataStore,
  integration: Integration,
  id: string,
  options: GmailReadOptions = {},
): Promise<Result<MessageMeta>> {
  const params = HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join('&');
  const res = await gmailGet<RawMessage>(
    store,
    integration,
    `/messages/${encodeURIComponent(id)}?format=metadata&${params}`,
    options,
  );
  if (!res.ok) return res;
  const m = res.value;
  const header = (name: string) =>
    m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  const precedence = header('Precedence').toLowerCase();
  return ok({
    id: m.id,
    threadId: m.threadId,
    from: header('From'),
    replyTo: header('Reply-To'),
    to: header('To'),
    cc: header('Cc'),
    subject: header('Subject'),
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
    snippet: m.snippet ?? '',
    labelIds: m.labelIds ?? [],
    bulk:
      Boolean(header('List-Unsubscribe')) ||
      Boolean(header('List-Id')) ||
      precedence === 'bulk' ||
      precedence === 'list',
  });
}
