import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { getAccessToken } from '@/lib/google/oauth';
import type { Integration } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Read-only view of Nick's Gmail inbox for the email session: which threads
 * are in the inbox right now, and who/what each one is. Uses the read scope
 * only. Kept apart from gmail-send.ts, which is the only module that writes.
 */

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_PAGES = 3;

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
    const res = await get<{ threads?: { id: string }[]; nextPageToken?: string }>(
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

/** Label id -> name, for the triage @-labels. */
export async function readLabelNames(
  store: DataStore,
  integration: Integration,
): Promise<Map<string, string>> {
  const res = await get<{ labels?: { id: string; name: string }[] }>(store, integration, '/labels');
  return new Map((res.ok ? (res.value.labels ?? []) : []).map((l) => [l.id, l.name]));
}

export interface InboxThreadMeta {
  id: string;
  who: string;
  subject: string;
  labelIds: string[];
  latestAt: string | null;
  /** True when the newest real message is from the mailbox itself (already answered). */
  lastFromUs: boolean;
}

interface Msg {
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
  const res = await get<{ messages?: Msg[] }>(
    store,
    integration,
    `/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
  );
  if (!res.ok) return null;
  const real = (res.value.messages ?? []).filter((m) => !m.labelIds?.includes('DRAFT'));
  const latest = real.at(-1);
  if (!latest) return null;
  const own = (integration.account_email ?? '').toLowerCase();
  const from = header(latest, 'From');
  const labels = [...new Set(real.flatMap((m) => m.labelIds ?? []))];
  return {
    id,
    who: displayName(from),
    subject: header(real[0], 'Subject') || '(no subject)',
    labelIds: labels,
    latestAt: latest.internalDate ? new Date(Number(latest.internalDate)).toISOString() : null,
    lastFromUs: Boolean(own) && from.toLowerCase().includes(own),
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
): Promise<Result<string[]>> {
  const ids: string[] = [];
  let pageToken = '';
  while (ids.length < max) {
    const res = await get<{ messages?: { id: string }[]; nextPageToken?: string }>(
      store,
      integration,
      `/messages?maxResults=${Math.min(100, max - ids.length)}&q=${encodeURIComponent(query)}${
        pageToken ? `&pageToken=${pageToken}` : ''
      }`,
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
  const res = await get<Msg & { id: string; threadId: string }>(
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
