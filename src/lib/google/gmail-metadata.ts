import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { getAccessToken } from '@/lib/google/oauth';
import type { Integration } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * One message's headers and Gmail's own snippet, no body. Read scope only.
 * Used to sort company updates from everything else before any body is read:
 * who sent it, who it went to (to tell a bcc), and whether it came from a
 * mailing list.
 */

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function get<T>(
  store: DataStore,
  integration: Integration,
  path: string,
): Promise<Result<T>> {
  const token = await getAccessToken(store, integration);
  if (!token.ok) return token;
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token.value}` },
    });
    if (!res.ok) return err('provider_unavailable', `Gmail returned ${res.status}.`);
    return ok((await res.json()) as T);
  } catch {
    return err('provider_unavailable', 'Could not reach Gmail.');
  }
}

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
): Promise<Result<MessageMeta>> {
  const params = HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join('&');
  const res = await get<RawMessage>(
    store,
    integration,
    `/messages/${encodeURIComponent(id)}?format=metadata&${params}`,
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
