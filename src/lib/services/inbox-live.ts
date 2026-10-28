import 'server-only';
import { env, isDemoMode, type AppEnv } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { DEMO_USER } from '@/lib/demo/fixtures';
import { demoFollowUpThread } from '@/lib/demo/follow-up-emails-fixtures';
import { demoSourceThread } from '@/lib/demo/source-emails-fixtures';
import { isFromMailbox } from '@/lib/email/addresses';
import { isGmailId, isSyncedEmailId } from '@/lib/email/thread-links';
import { gmailThreadUrl } from '@/lib/deals/links';
import { gmailFailCode, type GmailReadOptions } from '@/lib/google/gmail-get';
import {
  displayName,
  listThreadPage,
  readLabelNames,
  readMessageThreadId,
  readThreadFull,
  readThreadMeta,
  type AttachmentRef,
  type FullThread,
  type InboxThreadMeta,
} from '@/lib/google/gmail-inbox';
import { canSend } from '@/lib/google/gmail-send';
import { DEMO_MAIL_LABELS } from '@/lib/demo/inbox-labels-fixtures';
import {
  applyLabelPlan,
  labelChoices,
  USER_LABEL_ID,
  type MailLabel,
} from '@/lib/email/inbox-actions';
import type { EmailMessage, EmailThread, Integration } from '@/lib/types/domain';
import { log } from '@/lib/security/redact';
import { scanForInjection } from '@/lib/security/injection';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type AppError, type Err, type Result } from '@/lib/util/result';
import { getPrimaryIntegration } from './inbox';

/**
 * The Inbox tab, straight from Gmail: the same mailbox, tabs and search Nick
 * sees in Gmail, read live. Replies, archive and labels go through the same
 * send path as the email session (gmail-send.ts), so nothing ever sends or
 * changes on its own.
 */

export type { AttachmentRef };

export const INBOX_TABS = ['primary', 'other', 'starred', 'sent'] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

const TAB_QUERY: Record<InboxTab, { labelIds: string[]; q?: string }> = {
  primary: { labelIds: ['INBOX'], q: 'category:primary' },
  other: { labelIds: ['INBOX'], q: '-category:primary' },
  starred: { labelIds: ['STARRED'] },
  sent: { labelIds: ['SENT'] },
};

export const THREAD_ID = /^[0-9a-f]{10,24}$/i;
const PAGE_SIZE = 40;
const FETCH_BATCH = 10;
/** Label names are re-read this often, so a label made in Gmail reaches the menu soon. */
const LABELS_TTL_MS = 10 * 60_000;
/** Sooner when a thread carries a label the cached names do not know, but not every poll. */
const LABELS_RECHECK_MS = 60_000;

export interface LiveThreadRow {
  id: string;
  who: string;
  subject: string;
  snippet: string;
  at: string | null;
  unread: boolean;
  starred: boolean;
  inInbox: boolean;
  /** Names of user labels on the thread (triage labels, categories left out). */
  labels: string[];
  /** Ids of every label of the person's own on the thread, for the Label menu. */
  labelIds: string[];
  lastFromUs: boolean;
  /** Text aimed at an AI assistant was found; shown, flagged, never acted on. */
  flagged: boolean;
}

export interface LiveThreadList {
  state: 'ok' | 'not_connected' | 'error';
  rows: LiveThreadRow[];
  nextPageToken: string | null;
  canAct: boolean;
  /** Labels can be changed from a tap: sending is on, or this is the demo. */
  canLabel: boolean;
  /** The person's own Gmail labels, for the Label menu. */
  labelChoices: MailLabel[];
  mailbox: string | null;
  message?: string;
}

export interface LiveMessage {
  id: string;
  fromName: string;
  from: string;
  to: string;
  cc: string;
  at: string | null;
  text: string;
  attachments: AttachmentRef[];
  fromUs: boolean;
  flagged: boolean;
}

export interface LiveThread {
  id: string;
  subject: string;
  unread: boolean;
  starred: boolean;
  inInbox: boolean;
  labels: string[];
  labelIds: string[];
  messages: LiveMessage[];
}

const cache = processWide('inbox-live', () => ({
  meta: new Map<string, InboxThreadMeta>(),
  labels: new Map<string, { at: number; names: Map<string, string> }>(),
}));

/** Test hook. */
export function resetInboxLiveCache(): void {
  cache.meta.clear();
  cache.labels.clear();
}

/**
 * Gmail's label id -> name map, cached per mailbox. `seen` are label ids just
 * read off threads: one the cache does not know (a label made in Gmail since)
 * re-reads the names, at most once a minute. `fresh` always re-reads. A failed
 * read keeps the names already known: a mailbox always has system labels, so
 * an empty answer is a failure, not a mailbox without labels.
 */
async function labelNames(
  store: DataStore,
  integration: Integration,
  now: number,
  options: { seen?: readonly string[]; fresh?: boolean } = {},
): Promise<Map<string, string>> {
  const hit = cache.labels.get(integration.id);
  if (hit && !options.fresh) {
    const age = now - hit.at;
    const unknown = options.seen?.some((id) => USER_LABEL_ID.test(id) && !hit.names.has(id));
    if (age < LABELS_TTL_MS && !(unknown && age >= LABELS_RECHECK_MS)) return hit.names;
  }
  const names = await readLabelNames(store, integration).catch(() => new Map<string, string>());
  if (names.size === 0) {
    // A failed read: keep what is known, and try again in a minute, not after the full TTL.
    const kept = hit?.names ?? names;
    cache.labels.set(integration.id, { at: now - LABELS_TTL_MS + LABELS_RECHECK_MS, names: kept });
    return kept;
  }
  cache.labels.set(integration.id, { at: now, names });
  return names;
}

/**
 * The person's own labels, for the Label menu and for checking a change
 * against: the demo's fictional ones in demo mode. `fresh` re-reads Gmail,
 * for a label id the cached list does not hold.
 */
export async function readLabelChoices(
  store: DataStore,
  integration: Integration | null,
  options: { fresh?: boolean; now?: Date } = {},
): Promise<MailLabel[]> {
  if (isDemoMode()) return [...DEMO_MAIL_LABELS];
  if (!integration) return [];
  const now = (options.now ?? new Date()).getTime();
  return labelChoices(await labelNames(store, integration, now, { fresh: options.fresh }));
}

/**
 * Forget what is cached about these threads, after the app changed them, so
 * the next list reads each one again from Gmail rather than trusting a cached
 * copy (Gmail's thread list can lag a write by a moment).
 */
export function forgetThreads(ids: readonly string[]): void {
  const prefixes = ids.map((id) => `${id.toLowerCase()}:`);
  for (const key of cache.meta.keys()) {
    const lower = key.toLowerCase();
    if (prefixes.some((p) => lower.startsWith(p))) cache.meta.delete(key);
  }
}

/** User label names for display: system labels and Gmail categories are left out. */
export function userLabels(labelIds: readonly string[], names: Map<string, string>): string[] {
  return labelIds
    .filter((id) => id.startsWith('Label_'))
    .map((id) => names.get(id))
    .filter((n): n is string => Boolean(n))
    .slice(0, 4);
}

/** Ids of the person's own labels on a thread, for the Label menu: no cap, no system labels. */
export function userLabelIds(labelIds: readonly string[]): string[] {
  return labelIds.filter((id) => USER_LABEL_ID.test(id));
}

function toRow(meta: InboxThreadMeta, snippet: string, names: Map<string, string>): LiveThreadRow {
  return {
    id: meta.id,
    who: meta.who,
    subject: meta.subject,
    snippet,
    at: meta.latestAt,
    unread: meta.labelIds.includes('UNREAD'),
    starred: meta.labelIds.includes('STARRED'),
    inInbox: meta.labelIds.includes('INBOX'),
    labels: userLabels(meta.labelIds, names),
    labelIds: userLabelIds(meta.labelIds),
    lastFromUs: meta.lastFromUs,
    flagged: scanForInjection(`${meta.subject}
${snippet}`).flagged,
  };
}

/** One page of a tab, or of a search across all mail when `q` is set. */
export async function listLiveThreads(
  store: DataStore,
  organizationId: string,
  options: { tab?: InboxTab; q?: string; pageToken?: string | null; now?: Date } = {},
): Promise<LiveThreadList> {
  const now = options.now ?? new Date();
  if (isDemoMode()) return demoList(store, organizationId, options);

  const integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
  if (!integration || integration.status === 'disconnected') {
    return {
      state: 'not_connected',
      rows: [],
      nextPageToken: null,
      canAct: false,
      canLabel: false,
      labelChoices: [],
      mailbox: null,
    };
  }
  const search = options.q?.trim();
  const tab = TAB_QUERY[options.tab ?? 'primary'];
  const page = await listThreadPage(store, integration, {
    q: search || tab.q,
    labelIds: search ? [] : tab.labelIds,
    pageToken: options.pageToken ?? undefined,
    max: PAGE_SIZE,
  });
  const base = {
    canAct: canSend(integration),
    canLabel: canSend(integration),
    mailbox: integration.account_email ?? null,
  };
  if (!page.ok) {
    return {
      state: 'error',
      rows: [],
      nextPageToken: null,
      message: page.error.message,
      labelChoices: [],
      ...base,
    };
  }

  // A thread's meta only changes when its historyId does, so cache on both.
  const key = (t: { id: string; historyId: string }) => `${t.id}:${t.historyId}`;
  const missing = page.value.threads.filter((t) => !cache.meta.has(key(t)));
  for (let i = 0; i < missing.length; i += FETCH_BATCH) {
    const batch = missing.slice(i, i + FETCH_BATCH);
    const metas = await Promise.all(
      batch.map((t) => readThreadMeta(store, integration, t.id).catch(() => null)),
    );
    batch.forEach((t, j) => {
      const meta = metas[j];
      if (meta) cache.meta.set(key(t), meta);
    });
  }
  if (cache.meta.size > 5000) cache.meta.clear();

  const seen = page.value.threads.flatMap((t) => cache.meta.get(key(t))?.labelIds ?? []);
  const names = await labelNames(store, integration, now.getTime(), { seen });
  const rows = page.value.threads
    .map((t) => {
      const meta = cache.meta.get(key(t));
      return meta ? toRow(meta, decodeEntities(t.snippet), names) : null;
    })
    .filter((r): r is LiveThreadRow => Boolean(r));
  return {
    state: 'ok',
    rows,
    nextPageToken: page.value.nextPageToken,
    labelChoices: labelChoices(names),
    ...base,
  };
}

/** The whole conversation, newest message last. */
export async function readLiveThread(
  store: DataStore,
  organizationId: string,
  id: string,
): Promise<Result<LiveThread>> {
  if (!THREAD_ID.test(id)) return err('invalid_input', 'Bad thread id.');
  if (isDemoMode()) return demoThread(store, organizationId, id);
  const integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
  if (!integration) return err('not_found', 'No mailbox is connected.');
  const thread = await readThreadFull(store, integration, id);
  if (!thread.ok) return thread;
  const names = await labelNames(store, integration, Date.now(), { seen: thread.value.labelIds });
  return ok(toLiveThread(thread.value, names, integration.account_email ?? ''));
}

export function toLiveThread(
  thread: FullThread,
  names: Map<string, string>,
  mailbox: string,
): LiveThread {
  return {
    id: thread.id,
    subject: thread.subject,
    unread: thread.labelIds.includes('UNREAD'),
    starred: thread.labelIds.includes('STARRED'),
    inInbox: thread.labelIds.includes('INBOX'),
    labels: userLabels(thread.labelIds, names),
    labelIds: userLabelIds(thread.labelIds),
    messages: thread.messages.map((m) => ({
      id: m.id,
      fromName: displayName(m.from),
      from: m.from,
      to: m.to,
      cc: m.cc,
      at: m.date,
      text: m.text,
      attachments: m.attachments,
      // The address itself, never a substring of the header: a lookalike is not us.
      fromUs: isFromMailbox(m.from, mailbox),
      flagged: scanForInjection(m.text).flagged,
    })),
  };
}

/* ------------------------------------------------------ opened by a link */

/**
 * A conversation opened from a link (`/inbox?thread=<id>`), and the row the
 * reading pane shows it under; or why it could not be opened. `requested` is
 * the id the link carried, which may be a message's rather than the thread's.
 */
export type OpenedThread =
  | { requested: string; row: LiveThreadRow; thread: LiveThread; error?: undefined }
  | { requested: string; error: string; row?: undefined; thread?: undefined };

/** A deep link waits this long on Gmail before saying it could not open the email. */
const OPEN_DEADLINE_MS = 6_000;

const NOT_OPENED = {
  invalid: "That link doesn't point at an email.",
  notFound:
    "That email isn't in the mailbox: it may have been deleted, or the link is from another account.",
  notConnected:
    "No mailbox is connected, so the email can't be opened here. Connect Google in Settings › Integrations.",
  busy: 'Gmail is busy right now. Try the link again in a minute.',
  noAnswer: "Gmail didn't answer. Try the link again in a minute.",
};

/** A failed open in words a person can act on, never Gmail's own. */
function openFailure(error: AppError): Err<AppError> {
  if (error.code === 'provider_unauthorized') {
    return err(
      'provider_unauthorized',
      'Gmail needs reconnecting in Settings › Integrations before the email can be opened here.',
    );
  }
  switch (gmailFailCode(error)) {
    case 'rate_limited':
    case 'deadline':
      return err('rate_limited', NOT_OPENED.busy, { retryable: true });
    case 'not_found':
      return err('not_found', NOT_OPENED.notFound);
    case 'gmail_4xx':
      return err('provider_unavailable', 'Gmail would not open this email here. Open it in Gmail.');
    default:
      return err('provider_unavailable', NOT_OPENED.noAnswer, { retryable: true });
  }
}

/**
 * One conversation for a link: a thread id, or a message id resolved to its
 * thread, wherever it is filed (archived, any label, not only the inbox).
 * Read scope only: nothing changes in Gmail, not even read or unread. Never
 * throws; a failure comes back as words a person can act on.
 */
export async function openLiveThread(
  store: DataStore,
  organizationId: string,
  id: string,
  options: { now?: Date; e?: AppEnv } = {},
): Promise<Result<LiveThread>> {
  try {
    if (!THREAD_ID.test(id)) return err('invalid_input', NOT_OPENED.invalid);
    if ((options.e ?? env()).demoMode) {
      const demo = await demoThread(store, organizationId, id);
      return demo.ok ? demo : err('not_found', NOT_OPENED.notFound);
    }
    const integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
    if (!integration || integration.status === 'disconnected') {
      return err('not_configured', NOT_OPENED.notConnected);
    }
    // Someone is waiting on it: one short deadline for every step, ahead of background reads.
    const opts: GmailReadOptions = {
      retry: { deadline: Date.now() + OPEN_DEADLINE_MS, front: true },
    };
    let full = await readThreadFull(store, integration, id, opts);
    if (!full.ok && full.error.details?.status === 404) {
      // A link may carry a message id: find its thread (read scope).
      const threadId = await readMessageThreadId(store, integration, id, opts);
      if (!threadId.ok) return openFailure(threadId.error);
      // The same id again would only 404 again.
      if (threadId.value !== id) {
        full = await readThreadFull(store, integration, threadId.value, opts);
      }
    }
    if (!full.ok) return openFailure(full.error);
    const names = await labelNames(store, integration, (options.now ?? new Date()).getTime(), {
      seen: full.value.labelIds,
    });
    return ok(toLiveThread(full.value, names, integration.account_email ?? ''));
  } catch {
    // No id in the line: it could say whose mail was opened.
    log.warn('Opening an email from a link failed unexpectedly');
    return err('internal', NOT_OPENED.noAnswer, { retryable: true });
  }
}

/** The list row for a conversation opened by a link, which may not be in any list. */
export function liveRowFromThread(thread: LiveThread): LiveThreadRow {
  const last = thread.messages.at(-1);
  return {
    id: thread.id,
    who: last?.fromName ?? '',
    subject: thread.subject,
    snippet: (last?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    at: last?.at ?? null,
    unread: thread.unread,
    starred: thread.starred,
    inInbox: thread.inInbox,
    labels: thread.labels,
    labelIds: thread.labelIds,
    lastFromUs: last?.fromUs ?? false,
    flagged: thread.messages.some((m) => m.flagged),
  };
}

/**
 * The Gmail id behind Kraken's own id for a synced email or thread (what
 * Today, a deal's sources and citations hold): the message's own Gmail id,
 * else its thread's. In the demo, the demo Inbox's id for that conversation.
 * Null when nothing synced has that id in this workspace. Never throws.
 */
async function syncedGmailId(
  store: DataStore,
  organizationId: string,
  id: string,
  demo: boolean,
): Promise<string | null> {
  try {
    const message = (await store.get('email_messages', organizationId, id)) as EmailMessage | null;
    if (message && !demo && isGmailId(message.provider_message_id)) {
      return message.provider_message_id;
    }
    const thread = (await store.get(
      'email_threads',
      organizationId,
      message?.thread_id ?? id,
    )) as EmailThread | null;
    if (!thread) return null;
    if (demo) return demoId(thread);
    return isGmailId(thread.provider_thread_id) ? thread.provider_thread_id : null;
  } catch {
    return null;
  }
}

/** The Gmail id a link's id stands for: as given, or looked up for a synced email. */
async function linkGmailId(
  store: DataStore,
  organizationId: string,
  requested: string,
): Promise<string | null> {
  if (isGmailId(requested)) return requested;
  if (!isSyncedEmailId(requested)) return null;
  return syncedGmailId(store, organizationId, requested, isDemoMode());
}

/** What the Inbox page hands the reading pane for `?thread=<id>`. Never throws. */
export async function openFromLink(
  store: DataStore,
  organizationId: string,
  requested: string,
): Promise<OpenedThread> {
  let id = requested;
  if (isSyncedEmailId(requested)) {
    const found = await linkGmailId(store, organizationId, requested);
    if (!found) return { requested, error: NOT_OPENED.notFound };
    id = found;
  }
  const opened = await openLiveThread(store, organizationId, id);
  return opened.ok
    ? { requested, row: liveRowFromThread(opened.value), thread: opened.value }
    : { requested, error: opened.error.message };
}

/**
 * Where `/inbox?thread=<id>&open=gmail` goes: the conversation in Gmail, in
 * the connected mailbox. Used for a synced email's "Gmail" link, whose Gmail
 * id only the server can look up. Null when the id stands for no email, so
 * the Inbox says it could not open it instead. Never throws.
 */
export async function gmailHrefForLink(
  store: DataStore,
  organizationId: string,
  requested: string,
): Promise<string | null> {
  const id = await linkGmailId(store, organizationId, requested);
  if (!id) return null;
  if (isDemoMode()) return gmailThreadUrl(id, DEMO_USER.email);
  const integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
  return gmailThreadUrl(id, integration?.account_email ?? null);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------ demo mode */

/** Demo threads get a hex id (the tail of their uuid) so the same routes serve them. */
const demoId = (thread: EmailThread) => thread.id.replace(/-/g, '').slice(-16);

const DEMO_LABEL_NAMES = new Map(DEMO_MAIL_LABELS.map((l) => [l.id, l.name]));

/** A demo thread's own labels: every one any of its messages carries. */
function demoLabelIds(list: readonly EmailMessage[]): string[] {
  return userLabelIds([...new Set(list.flatMap((m) => m.labels))]);
}

async function demoData(store: DataStore, organizationId: string) {
  const [threads, messages] = await Promise.all([
    store.list('email_threads', organizationId, {}) as Promise<EmailThread[]>,
    store.list('email_messages', organizationId, {}) as Promise<EmailMessage[]>,
  ]);
  const byThread = new Map<string, EmailMessage[]>();
  for (const m of messages) {
    const list = byThread.get(m.thread_id) ?? [];
    list.push(m);
    byThread.set(m.thread_id, list);
  }
  for (const list of byThread.values()) list.sort((a, b) => a.sent_at.localeCompare(b.sent_at));
  return { threads, byThread };
}

async function demoList(
  store: DataStore,
  organizationId: string,
  options: { tab?: InboxTab; q?: string },
): Promise<LiveThreadList> {
  const { threads, byThread } = await demoData(store, organizationId);
  const q = options.q?.trim().toLowerCase() ?? '';
  const rows = threads
    .map((t): LiveThreadRow | null => {
      const list = byThread.get(t.id) ?? [];
      const last = list.at(-1);
      if (!last) return null;
      return {
        id: demoId(t),
        who: last.from_name ?? last.from_address,
        subject: t.subject ?? '(no subject)',
        snippet: last.snippet,
        at: last.sent_at,
        unread: list.some((m) => m.is_unread),
        starred: false,
        inInbox: true,
        labels: userLabels(demoLabelIds(list), DEMO_LABEL_NAMES),
        labelIds: demoLabelIds(list),
        lastFromUs: false,
        flagged: list.some((m) => m.injection_flagged),
      };
    })
    .filter((r): r is LiveThreadRow => Boolean(r))
    .filter((r) =>
      q ? `${r.who} ${r.subject} ${r.snippet}`.toLowerCase().includes(q) : options.tab !== 'sent',
    )
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return {
    state: 'ok',
    rows,
    nextPageToken: null,
    canAct: false,
    // Label changes stay on the demo messages, so the demo can show them.
    canLabel: true,
    labelChoices: [...DEMO_MAIL_LABELS],
    mailbox: null,
  };
}

async function demoThread(
  store: DataStore,
  organizationId: string,
  id: string,
): Promise<Result<LiveThread>> {
  const { threads, byThread } = await demoData(store, organizationId);
  const thread = threads.find((t) => demoId(t) === id.toLowerCase());
  if (!thread) {
    // The emails behind the demo's Follow-ups and routine snapshots, which a
    // link from those pages opens here.
    const now = new Date();
    const fixture = demoFollowUpThread(id, now) ?? demoSourceThread(id, now);
    return fixture
      ? ok(toLiveThread(fixture, new Map(), DEMO_USER.email))
      : err('not_found', 'That conversation no longer exists.');
  }
  const list = byThread.get(thread.id) ?? [];
  return ok({
    id,
    subject: thread.subject ?? '(no subject)',
    unread: list.some((m) => m.is_unread),
    starred: false,
    inInbox: true,
    labels: userLabels(demoLabelIds(list), DEMO_LABEL_NAMES),
    labelIds: demoLabelIds(list),
    messages: list.map((m) => ({
      id: m.id,
      fromName: m.from_name ?? m.from_address,
      from: m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address,
      to: m.to_addresses.join(', '),
      cc: m.cc_addresses.join(', '),
      at: m.sent_at,
      text: m.body_text ?? m.snippet,
      attachments: [],
      fromUs: false,
      flagged: m.injection_flagged || scanForInjection(m.body_text ?? m.snippet).flagged,
    })),
  });
}

/**
 * A label change in demo mode: kept on the demo thread's messages, the way
 * Gmail keeps labels on messages. `plan` is already checked against the
 * demo's labels (planLabelChange); nothing reaches Gmail.
 */
export async function setDemoThreadLabels(
  store: DataStore,
  organizationId: string,
  id: string,
  plan: { add: string[]; remove: string[] },
): Promise<Result<true>> {
  if (!THREAD_ID.test(id)) return err('invalid_input', 'Bad thread id.');
  const { threads, byThread } = await demoData(store, organizationId);
  const thread = threads.find((t) => demoId(t) === id.toLowerCase());
  if (!thread) return err('not_found', 'That conversation no longer exists.');
  for (const m of byThread.get(thread.id) ?? []) {
    const own = userLabelIds(m.labels);
    const system = m.labels.filter((l) => !own.includes(l));
    await store.update('email_messages', organizationId, m.id, {
      labels: [...system, ...applyLabelPlan(own, plan)],
    });
  }
  return ok(true);
}
