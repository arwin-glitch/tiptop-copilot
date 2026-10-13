import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { getAccessToken } from '@/lib/google/oauth';
import type { Integration } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Who is on a Gmail thread: the From, To and Cc of every message, no bodies.
 * Read scope only, metadata format. Used by the warm-intro search on Fund II.
 * Kept apart from gmail-send.ts, which is the only module that writes.
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
    // A thread that is gone is an answer ("not there"), not an outage.
    if (res.status === 404) return err('not_found', 'That conversation is not in the mailbox.');
    if (!res.ok) {
      return err('provider_unavailable', `Gmail returned ${res.status}.`, {
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    return ok((await res.json()) as T);
  } catch {
    return err('provider_unavailable', 'Could not reach Gmail.', { retryable: true });
  }
}

interface Msg {
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

const header = (m: Msg | undefined, name: string) =>
  m?.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

export interface ParticipantMessage {
  from: string;
  to: string;
  cc: string;
  at: string | null;
}

export interface ThreadParticipants {
  id: string;
  subject: string;
  messages: ParticipantMessage[];
}

/**
 * From/To/Cc/Subject of every message on a thread, drafts left out. A thread
 * that no longer exists, or holds only drafts, is `not_found`; anything else
 * that goes wrong is `provider_unavailable`.
 */
export async function readThreadParticipants(
  store: DataStore,
  integration: Integration,
  id: string,
): Promise<Result<ThreadParticipants>> {
  const res = await get<{ id: string; messages?: Msg[] }>(
    store,
    integration,
    `/threads/${encodeURIComponent(id)}?format=metadata` +
      '&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject',
  );
  if (!res.ok) return res;
  const real = (res.value.messages ?? []).filter((m) => !m.labelIds?.includes('DRAFT'));
  if (real.length === 0) return err('not_found', 'That conversation has no messages.');
  return ok({
    id: res.value.id ?? id,
    subject: header(real[0], 'Subject') || '(no subject)',
    messages: real.map((m) => ({
      from: header(m, 'From'),
      to: header(m, 'To'),
      cc: header(m, 'Cc'),
      at: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
    })),
  });
}
