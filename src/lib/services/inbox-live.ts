import 'server-only';
import { env, isDemoMode, type AppEnv } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { DEMO_USER } from '@/lib/demo/fixtures';
import { demoFollowUpThread } from '@/lib/demo/follow-up-emails-fixtures';
import { demoSourceThread } from '@/lib/demo/source-emails-fixtures';
import {
  demoDrafts,
  demoFolderFullThread,
  demoFolderThreads,
  type DemoDraft,
} from '@/lib/demo/inbox-folder-fixtures';
import { isFromMailbox } from '@/lib/email/addresses';
import { isGmailId, isSyncedEmailId } from '@/lib/email/thread-links';
import { gmailThreadUrl } from '@/lib/deals/links';
import { gmailFailCode, type GmailReadOptions } from '@/lib/google/gmail-get';
import {
  displayName,
  inboxCategoryHasMail,
  listDraftPage,
  listThreadPage,
  readLabelCount,
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
import {
  CATEGORIES,
  CATEGORY_LABEL,
  folderLabelId,
  folderQuery,
  senderLine,
  type Category,
  type FolderId,
} from '@/lib/email/inbox-folders';
import type { EmailMessage, EmailThread, Integration } from '@/lib/types/domain';
import { log } from '@/lib/security/redact';
import { scanForInjection } from '@/lib/security/injection';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type AppError, type Err, type Result } from '@/lib/util/result';
import { getPrimaryIntegration } from './inbox';
import { readOpenSnoozes, wakeDueSnoozes } from './inbox-snooze';
import { countScheduled, listScheduledRows } from './inbox-scheduled';

/**
 * The Inbox tab, straight from Gmail: the same mailbox, folders, category
 * tabs and search Nick sees in Gmail, read live. Replies, archive, delete
 * (to Trash) and labels go through the same send path as the email session
 * (gmail-send.ts), so nothing ever sends or changes on its own.
 */

export type { AttachmentRef };

/** The old tab names (`?tab=`), still read: each is a folder now. */
export const INBOX_TABS = ['primary', 'other', 'starred', 'snoozed', 'sent'] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

export const THREAD_ID = /^[0-9a-f]{10,24}$/i;
/** Gmail's page: 50 conversations. */
export const PAGE_SIZE = 50;
const FETCH_BATCH = 10;
/** Label names are re-read this often, so a label made in Gmail reaches the menu soon. */
const LABELS_TTL_MS = 10 * 60_000;
/** Sooner when a thread carries a label the cached names do not know, but not every poll. */
const LABELS_RECHECK_MS = 60_000;
/** The left nav's counts are read again at most this often (and after any change). */
const NAV_TTL_MS = 60_000;

export interface LiveThreadRow {
  id: string;
  /** What the row is: a conversation, a Gmail draft, or a scheduled send. */
  kind?: 'thread' | 'draft' | 'scheduled';
  /** Gmail's "Name, me" for a conversation; for a draft or scheduled send, who it goes to. */
  who: string;
  /** Messages in the thread, shown after the names when more than one. */
  count?: number;
  subject: string;
  snippet: string;
  at: string | null;
  unread: boolean;
  starred: boolean;
  inInbox: boolean;
  important?: boolean;
  inTrash?: boolean;
  inSpam?: boolean;
  /** A draft sits on the thread: Gmail's "Draft" marker. */
  hasDraft?: boolean;
  hasAttachment?: boolean;
  /** Names of user labels on the thread (triage labels, categories left out). */
  labels: string[];
  /** Ids of every label of the person's own on the thread, for the Label menu. */
  labelIds: string[];
  lastFromUs: boolean;
  /** Text aimed at an AI assistant was found; shown, flagged, never acted on. */
  flagged: boolean;
  /** On the Snoozed tab: when the thread comes back to the inbox. */
  snoozedUntil?: string | null;
  /** A Drafts row: the Gmail draft it opens. */
  draftId?: string;
  /** A Scheduled row: the scheduled send it opens, and when it goes. */
  scheduledId?: string;
  sendAt?: string;
}

/** The left nav's numbers, as Gmail shows them. Null when unknown. */
export interface InboxNav {
  inboxUnread: number | null;
  drafts: number | null;
  spamUnread: number | null;
  scheduled: number | null;
  /** The category tabs with mail in them; Primary is always there. */
  categories: Category[];
}

export interface LiveThreadList {
  state: 'ok' | 'not_connected' | 'error';
  rows: LiveThreadRow[];
  nextPageToken: string | null;
  /** Gmail's estimate of the whole folder, for "1–50 of N"; null when unknown. */
  total?: number | null;
  folder?: FolderId;
  category?: Category;
  nav?: InboxNav;
  /** Sending is on: Send, and every change made from a tap. */
  canAct: boolean;
  /** Mail can be changed from a tap (archive, delete, spam, star...): sending is on, or the demo. */
  canModify?: boolean;
  /** Labels can be changed from a tap: sending is on, or this is the demo. */
  canLabel: boolean;
  /** Threads can be snoozed from a tap: sending is on, or this is the demo. */
  canSnooze: boolean;
  /** False when Snooze's table is not there yet (its migration not run). */
  snoozeReady?: boolean;
  /** False when Schedule send's table is not there yet (its migration not run). */
  scheduleReady?: boolean;
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
  important?: boolean;
  inTrash?: boolean;
  inSpam?: boolean;
  labels: string[];
  labelIds: string[];
  messages: LiveMessage[];
}

const cache = processWide('inbox-live', () => ({
  meta: new Map<string, InboxThreadMeta>(),
  labels: new Map<string, { at: number; names: Map<string, string> }>(),
  nav: new Map<string, { at: number; nav: Omit<InboxNav, 'scheduled'> }>(),
}));

/** The demo mailbox's state: label changes on demo threads, and its drafts. */
const demoState = processWide('inbox-live-demo', () => ({
  /** Thread id -> its Gmail system labels, once something here changed them. */
  system: new Map<string, string[]>(),
  drafts: null as DemoDraft[] | null,
}));

/** Test hook. */
export function resetInboxLiveCache(): void {
  cache.meta.clear();
  cache.labels.clear();
  cache.nav.clear();
  demoState.system.clear();
  demoState.drafts = null;
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

/** A label made from the Label menu: the cached names are read again next time. */
export function forgetLabelNames(): void {
  cache.labels.clear();
}

/**
 * Forget what is cached about these threads, after the app changed them, so
 * the next list reads each one again from Gmail rather than trusting a cached
 * copy (Gmail's thread list can lag a write by a moment). The nav's counts go
 * too: an archive or a delete changes them.
 */
export function forgetThreads(ids: readonly string[]): void {
  const prefixes = ids.map((id) => `${id.toLowerCase()}:`);
  for (const key of cache.meta.keys()) {
    const lower = key.toLowerCase();
    if (prefixes.some((p) => lower.startsWith(p))) cache.meta.delete(key);
  }
  cache.nav.clear();
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

/** The flags a row and the reading pane read off a thread's system labels. */
function systemFlags(labelIds: readonly string[]) {
  return {
    unread: labelIds.includes('UNREAD'),
    starred: labelIds.includes('STARRED'),
    inInbox: labelIds.includes('INBOX'),
    important: labelIds.includes('IMPORTANT'),
    inTrash: labelIds.includes('TRASH'),
    inSpam: labelIds.includes('SPAM'),
  };
}

function toRow(
  meta: InboxThreadMeta,
  snippet: string,
  names: Map<string, string>,
  folder?: FolderId,
): LiveThreadRow {
  const line = meta.senders?.length ? senderLine(meta.senders) : null;
  // Sent shows who it went to, as Gmail does ("To: Sam").
  const who =
    folder === 'sent' && meta.lastFromUs && meta.toName
      ? `To: ${meta.toName}`
      : (line?.names ?? meta.who);
  return {
    id: meta.id,
    kind: 'thread',
    who,
    count: line?.count ?? 0,
    subject: meta.subject,
    snippet,
    at: meta.latestAt,
    ...systemFlags(meta.labelIds),
    hasDraft: meta.hasDraft ?? false,
    hasAttachment: meta.hasAttachment ?? false,
    labels: userLabels(meta.labelIds, names),
    labelIds: userLabelIds(meta.labelIds),
    lastFromUs: meta.lastFromUs,
    flagged: scanForInjection(`${meta.subject}
${snippet}`).flagged,
  };
}

export interface ListOptions {
  folder?: FolderId;
  category?: Category;
  /** The old tab name, read when `folder` is not given. */
  tab?: InboxTab;
  q?: string;
  pageToken?: string | null;
  now?: Date;
}

/** The folder and category a request means, the old tab names included. */
export function resolveView(options: ListOptions): { folder: FolderId; category: Category } {
  if (options.folder) return { folder: options.folder, category: options.category ?? 'primary' };
  switch (options.tab) {
    case 'starred':
    case 'snoozed':
    case 'sent':
      return { folder: options.tab, category: 'primary' };
    case 'other':
      return { folder: 'inbox', category: 'promotions' };
    default:
      return { folder: 'inbox', category: options.category ?? 'primary' };
  }
}

const notConnected = (): LiveThreadList => ({
  state: 'not_connected',
  rows: [],
  nextPageToken: null,
  canAct: false,
  canModify: false,
  canLabel: false,
  canSnooze: false,
  labelChoices: [],
  mailbox: null,
});

/**
 * The left nav's counts and the category tabs with mail, cached a minute per
 * mailbox and forgotten after any change made here. Every read is a cheap
 * labels.get or a one-thread list; a failure leaves that number unknown.
 */
async function readNav(
  store: DataStore,
  integration: Integration,
  organizationId: string,
  now: number,
): Promise<InboxNav> {
  const scheduled = await countScheduled(store, organizationId).catch(() => null);
  const hit = cache.nav.get(integration.id);
  if (hit && now - hit.at < NAV_TTL_MS) return { ...hit.nav, scheduled };
  const [inbox, drafts, spam, ...hasMail] = await Promise.all([
    readLabelCount(store, integration, 'INBOX').catch(() => null),
    readLabelCount(store, integration, 'DRAFT').catch(() => null),
    readLabelCount(store, integration, 'SPAM').catch(() => null),
    ...(['promotions', 'social', 'updates', 'forums'] as const).map((c) =>
      inboxCategoryHasMail(store, integration, CATEGORY_LABEL[c]).catch(() => false),
    ),
  ]);
  const others = (['promotions', 'social', 'updates', 'forums'] as const).filter(
    (_, i) => hasMail[i],
  );
  const nav = {
    inboxUnread: inbox?.unread ?? null,
    drafts: drafts?.total ?? null,
    spamUnread: spam?.unread ?? null,
    categories: ['primary', ...others] as Category[],
  };
  cache.nav.set(integration.id, { at: now, nav });
  return { ...nav, scheduled };
}

/** One page of a folder, or of a search across all mail when `q` is set. */
export async function listLiveThreads(
  store: DataStore,
  organizationId: string,
  options: ListOptions = {},
): Promise<LiveThreadList> {
  const now = options.now ?? new Date();
  const view = resolveView(options);
  if (isDemoMode()) {
    // Snoozes that came due go back first, so they are in the list this read.
    const woke = await wakeDueSnoozes(store, organizationId, { demo: true, now });
    await markDemoThreadsUnread(store, organizationId, woke.woken);
    return demoList(store, organizationId, { ...options, ...view, now });
  }

  const integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
  if (!integration || integration.status === 'disconnected') return notConnected();
  // Snoozes that came due go back to the inbox before Gmail is read: one
  // indexed read when none are due, and a failure never holds up the list.
  const woke = await wakeDueSnoozes(store, organizationId, { demo: false, integration, now });
  if (woke.woken.length) forgetThreads(woke.woken);

  const search = options.q?.trim();
  const navRead = readNav(store, integration, organizationId, now.getTime()).catch(
    (): InboxNav => ({
      inboxUnread: null,
      drafts: null,
      spamUnread: null,
      scheduled: null,
      categories: ['primary'],
    }),
  );
  const base = {
    canAct: canSend(integration),
    canModify: canSend(integration),
    canLabel: canSend(integration),
    canSnooze: canSend(integration),
    snoozeReady: woke.state !== 'needs_migration',
    mailbox: integration.account_email ?? null,
    folder: view.folder,
    category: view.category,
  };

  let listed: Omit<LiveThreadList, keyof typeof base | 'nav'>;
  if (!search && view.folder === 'snoozed') {
    listed = await snoozedList(store, organizationId, integration, now);
  } else if (!search && view.folder === 'drafts') {
    listed = await draftsList(store, integration, now, options.pageToken ?? undefined);
  } else if (!search && view.folder === 'scheduled') {
    listed = await scheduledList(store, organizationId, integration, now);
  } else {
    listed = await gmailList(store, integration, view, search, options.pageToken ?? null, now);
  }
  return { ...listed, ...base, nav: await navRead };
}

async function gmailList(
  store: DataStore,
  integration: Integration,
  view: { folder: FolderId; category: Category },
  search: string | undefined,
  pageToken: string | null,
  now: Date,
) {
  const query = folderQuery(view.folder, view.category) ?? { labelIds: ['INBOX'] };
  const page = await listThreadPage(store, integration, {
    // A search reads all mail, as Gmail's search box does.
    q: search || query.q,
    labelIds: search ? [] : query.labelIds,
    includeSpamTrash: search ? false : query.includeSpamTrash,
    pageToken: pageToken ?? undefined,
    max: PAGE_SIZE,
  });
  if (!page.ok) {
    return {
      state: 'error' as const,
      rows: [],
      nextPageToken: null,
      message: page.error.message,
      labelChoices: [],
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
      return meta ? toRow(meta, decodeEntities(t.snippet), names, view.folder) : null;
    })
    .filter((r): r is LiveThreadRow => Boolean(r));
  return {
    state: 'ok' as const,
    rows,
    nextPageToken: page.value.nextPageToken,
    total: page.value.total ?? null,
    labelChoices: labelChoices(names),
  };
}

/**
 * The Snoozed tab: the open snoozes, soonest wake first, each read from Gmail
 * once (cached under the thread's id, forgotten when the app changes it).
 */
async function snoozedList(
  store: DataStore,
  organizationId: string,
  integration: Integration,
  now: Date,
) {
  const open = await readOpenSnoozes(store, organizationId).catch(() => null);
  if (!open) {
    return {
      state: 'error' as const,
      rows: [],
      nextPageToken: null,
      message: 'Could not read the snoozed list.',
      labelChoices: [],
    };
  }
  const key = (id: string) => `${id}:snoozed`;
  const snoozes = open.rows.slice(0, PAGE_SIZE);
  const missing = snoozes.filter((s) => !cache.meta.has(key(s.thread_id)));
  for (let i = 0; i < missing.length; i += FETCH_BATCH) {
    const batch = missing.slice(i, i + FETCH_BATCH);
    const metas = await Promise.all(
      batch.map((s) => readThreadMeta(store, integration, s.thread_id).catch(() => null)),
    );
    batch.forEach((s, j) => {
      const meta = metas[j];
      if (meta) cache.meta.set(key(s.thread_id), meta);
    });
  }
  const seen = snoozes.flatMap((s) => cache.meta.get(key(s.thread_id))?.labelIds ?? []);
  const names = await labelNames(store, integration, now.getTime(), { seen });
  const rows = snoozes
    .map((s): LiveThreadRow | null => {
      const meta = cache.meta.get(key(s.thread_id));
      return meta ? { ...toRow(meta, '', names), snoozedUntil: s.wake_at } : null;
    })
    .filter((r): r is LiveThreadRow => Boolean(r));
  return {
    state: 'ok' as const,
    rows,
    nextPageToken: null,
    total: open.rows.length,
    labelChoices: labelChoices(names),
    snoozeReady: open.state === 'ok',
  };
}

/** Gmail's Drafts, newest first: each row opens its draft in the compose window. */
async function draftsList(
  store: DataStore,
  integration: Integration,
  now: Date,
  pageToken: string | undefined,
) {
  const [page, names] = await Promise.all([
    listDraftPage(store, integration, { pageToken, max: PAGE_SIZE }),
    labelNames(store, integration, now.getTime()),
  ]);
  if (!page.ok) {
    return {
      state: 'error' as const,
      rows: [],
      nextPageToken: null,
      message: page.error.message,
      labelChoices: labelChoices(names),
    };
  }
  return {
    state: 'ok' as const,
    rows: page.value.drafts.map((d) => draftRow(d, decodeEntities(d.snippet))),
    nextPageToken: page.value.nextPageToken,
    total: page.value.total ?? null,
    labelChoices: labelChoices(names),
  };
}

function draftRow(
  d: { draftId: string; threadId: string; to: string; subject: string; at: string | null },
  snippet: string,
): LiveThreadRow {
  const to = d.to
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map(displayName);
  return {
    id: d.threadId,
    kind: 'draft',
    draftId: d.draftId,
    who: to.length ? to.join(', ') : '(no recipients)',
    subject: d.subject || '(no subject)',
    snippet,
    at: d.at,
    unread: false,
    starred: false,
    inInbox: false,
    hasDraft: true,
    labels: [],
    labelIds: [],
    lastFromUs: true,
    flagged: false,
  };
}

/** Kraken's Scheduled list: what goes out later, soonest first. */
async function scheduledList(
  store: DataStore,
  organizationId: string,
  integration: Integration | null,
  now: Date,
) {
  const names = integration
    ? await labelNames(store, integration, now.getTime())
    : new Map<string, string>();
  const listed = await listScheduledRows(store, organizationId);
  return {
    state: 'ok' as const,
    rows: listed.rows,
    nextPageToken: null,
    total: listed.rows.length,
    labelChoices: integration ? labelChoices(names) : [...DEMO_MAIL_LABELS],
    scheduleReady: listed.state === 'ok',
  };
}

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
    ...systemFlags(thread.labelIds),
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
    kind: 'thread',
    who: last?.fromName ?? '',
    subject: thread.subject,
    snippet: (last?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    at: last?.at ?? null,
    unread: thread.unread,
    starred: thread.starred,
    inInbox: thread.inInbox,
    important: thread.important ?? false,
    inTrash: thread.inTrash ?? false,
    inSpam: thread.inSpam ?? false,
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

/** The Gmail system labels a demo conversation carries now: as written, or as changed here. */
function demoSystem(id: string, base: readonly string[]): string[] {
  return demoState.system.get(id) ?? base.filter((l) => !USER_LABEL_ID.test(l));
}

/** A store thread's system labels as its messages carry them, read state included. */
function storeSystemBase(list: readonly EmailMessage[]): string[] {
  const labels = new Set(list.flatMap((m) => m.labels).filter((l) => !USER_LABEL_ID.test(l)));
  labels.delete('UNREAD');
  if (list.some((m) => m.is_unread)) labels.add('UNREAD');
  return [...labels];
}

interface DemoConversation {
  row: LiveThreadRow;
  system: string[];
  full: () => LiveThread;
}

/** Every demo conversation: the synced demo mail, then the other folders' fixtures. */
async function demoConversations(
  store: DataStore,
  organizationId: string,
  now: Date,
): Promise<DemoConversation[]> {
  const { threads, byThread } = await demoData(store, organizationId);
  const out: DemoConversation[] = [];
  for (const t of threads) {
    const list = byThread.get(t.id) ?? [];
    const last = list.at(-1);
    if (!last) continue;
    const id = demoId(t);
    const system = demoSystem(id, storeSystemBase(list));
    const labelIds = demoLabelIds(list);
    const flags = systemFlags(system);
    const line = senderLine(
      list.map((m) => ({
        name: m.from_name ?? m.from_address,
        me: m.from_address === DEMO_USER.email,
      })),
    );
    const row: LiveThreadRow = {
      id,
      kind: 'thread',
      who: line.names,
      count: line.count,
      subject: t.subject ?? '(no subject)',
      snippet: last.snippet,
      at: last.sent_at,
      ...flags,
      hasAttachment: list.some((m) => m.has_attachments),
      labels: userLabels(labelIds, DEMO_LABEL_NAMES),
      labelIds,
      lastFromUs: false,
      flagged: list.some((m) => m.injection_flagged),
    };
    out.push({
      row,
      system,
      full: () => ({
        id,
        subject: row.subject,
        ...flags,
        labels: row.labels,
        labelIds,
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
      }),
    });
  }
  for (const f of demoFolderThreads(now)) {
    const system = demoSystem(f.id, f.labels);
    const flags = systemFlags(system);
    const last = f.messages.at(-1)!;
    const line = senderLine(
      f.messages.map((m) => ({
        name: displayName(m.from),
        me: isFromMailbox(m.from, DEMO_USER.email),
      })),
    );
    const fromUs = isFromMailbox(last.from, DEMO_USER.email);
    out.push({
      row: {
        id: f.id,
        kind: 'thread',
        who: line.names,
        count: line.count,
        subject: f.subject,
        snippet: last.text.replace(/\s+/g, ' ').slice(0, 160),
        at: last.at,
        ...flags,
        labels: [],
        labelIds: [],
        lastFromUs: fromUs,
        flagged: false,
      },
      system,
      full: () => {
        const live = toLiveThread(demoFolderFullThread(f), new Map(), DEMO_USER.email);
        return { ...live, ...flags };
      },
    });
  }
  return out;
}

/** Whether a demo conversation is in a folder, the way Gmail files it. */
function inDemoFolder(
  c: DemoConversation,
  view: { folder: FolderId; category: Category },
  snoozed: boolean,
): boolean {
  const has = (l: string) => c.system.includes(l);
  const binned = has('TRASH') || has('SPAM');
  const label = folderLabelId(view.folder);
  if (label) return !binned && c.row.labelIds.includes(label);
  switch (view.folder) {
    case 'inbox': {
      if (!has('INBOX') || binned || snoozed) return false;
      const cats = CATEGORIES.filter((k) => k !== 'primary').filter((k) => has(CATEGORY_LABEL[k]));
      return view.category === 'primary' ? cats.length === 0 : cats.includes(view.category);
    }
    case 'starred':
      return has('STARRED') && !binned;
    case 'important':
      return has('IMPORTANT') && !binned;
    case 'sent':
      return has('SENT') && !binned;
    case 'all':
      return !binned;
    case 'spam':
      return has('SPAM') && !has('TRASH');
    case 'trash':
      return has('TRASH');
    default:
      return false;
  }
}

function demoDraftList(now: Date): DemoDraft[] {
  demoState.drafts ??= demoDrafts(now);
  return demoState.drafts;
}

async function demoList(
  store: DataStore,
  organizationId: string,
  options: ListOptions & { folder: FolderId; category: Category; now: Date },
): Promise<LiveThreadList> {
  const [all, open] = await Promise.all([
    demoConversations(store, organizationId, options.now),
    readOpenSnoozes(store, organizationId).catch(() => ({ state: 'ok' as const, rows: [] })),
  ]);
  // Snoozed threads are out of the inbox until they wake, as in Gmail; the
  // Snoozed tab lists them with their wake time.
  const snoozedUntil = new Map(open.rows.map((s) => [s.thread_id, s.wake_at]));
  const q = options.q?.trim().toLowerCase() ?? '';
  const view = { folder: options.folder, category: options.category };
  const drafts = demoDraftList(options.now);
  const scheduled = await listScheduledRows(store, organizationId);

  let rows: LiveThreadRow[];
  if (!q && view.folder === 'drafts') {
    rows = drafts
      .map((d) => draftRow(d, d.text.replace(/\s+/g, ' ').slice(0, 160)))
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  } else if (!q && view.folder === 'scheduled') {
    rows = scheduled.rows;
  } else if (!q && view.folder === 'snoozed') {
    rows = all
      .filter((c) => snoozedUntil.has(c.row.id))
      .map((c) => ({ ...c.row, inInbox: false, snoozedUntil: snoozedUntil.get(c.row.id) }))
      .sort((a, b) => (a.snoozedUntil ?? '').localeCompare(b.snoozedUntil ?? ''));
  } else {
    rows = all
      .filter((c) =>
        q
          ? !c.system.includes('TRASH') &&
            !c.system.includes('SPAM') &&
            `${c.row.who} ${c.row.subject} ${c.row.snippet}`.toLowerCase().includes(q)
          : inDemoFolder(c, view, snoozedUntil.has(c.row.id)),
      )
      .map((c) => ({
        ...c.row,
        hasDraft: drafts.some((d) => d.replyOn === c.row.id),
        ...(snoozedUntil.has(c.row.id) ? { inInbox: false } : {}),
      }))
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  }

  const inboxRows = all.filter(
    (c) =>
      inDemoFolder(c, { folder: 'inbox', category: 'primary' }, snoozedUntil.has(c.row.id)) ||
      CATEGORIES.slice(1).some((k) =>
        inDemoFolder(c, { folder: 'inbox', category: k }, snoozedUntil.has(c.row.id)),
      ),
  );
  const categories = CATEGORIES.filter(
    (k) =>
      k === 'primary' ||
      all.some((c) =>
        inDemoFolder(c, { folder: 'inbox', category: k }, snoozedUntil.has(c.row.id)),
      ),
  );
  return {
    state: 'ok',
    rows,
    nextPageToken: null,
    total: rows.length,
    folder: view.folder,
    category: view.category,
    nav: {
      inboxUnread: inboxRows.filter((c) => c.row.unread).length,
      drafts: drafts.length,
      spamUnread: all.filter((c) => c.system.includes('SPAM') && c.row.unread).length,
      scheduled: scheduled.state === 'ok' ? scheduled.rows.length : null,
      categories,
    },
    canAct: false,
    // Changes stay on the demo mailbox alone; nothing reaches Gmail.
    canModify: true,
    // Label changes stay on the demo messages, so the demo can show them.
    canLabel: true,
    // Snoozes are kept on demo rows alone; nothing reaches Gmail.
    canSnooze: true,
    snoozeReady: open.state === 'ok',
    scheduleReady: scheduled.state === 'ok',
    labelChoices: [...DEMO_MAIL_LABELS],
    mailbox: null,
  };
}

async function demoThread(
  store: DataStore,
  organizationId: string,
  id: string,
): Promise<Result<LiveThread>> {
  const now = new Date();
  const all = await demoConversations(store, organizationId, now);
  const found = all.find((c) => c.row.id === id.toLowerCase());
  if (found) return ok(found.full());
  // The emails behind the demo's Follow-ups and routine snapshots, which a
  // link from those pages opens here.
  const fixture = demoFollowUpThread(id, now) ?? demoSourceThread(id, now);
  return fixture
    ? ok(toLiveThread(fixture, new Map(), DEMO_USER.email))
    : err('not_found', 'That conversation no longer exists.');
}

/**
 * A demo thread that woke from a snooze comes back unread, as in Gmail: its
 * newest message is marked unread. Best-effort; never throws.
 */
async function markDemoThreadsUnread(
  store: DataStore,
  organizationId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  try {
    const { threads, byThread } = await demoData(store, organizationId);
    for (const thread of threads) {
      if (!ids.includes(demoId(thread))) continue;
      const last = byThread.get(thread.id)?.at(-1);
      if (last && !last.is_unread) {
        await store.update('email_messages', organizationId, last.id, { is_unread: true });
      }
    }
    for (const id of ids) {
      const held = demoState.system.get(id);
      if (held) demoState.system.set(id, [...new Set([...held, 'INBOX', 'UNREAD'])]);
    }
  } catch {
    // The thread is back either way; only its unread dot is missing.
  }
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

/**
 * Archive, delete, spam, star, read state and important in demo mode: kept
 * on the demo mailbox (this process) alone, the way Gmail keeps them as
 * labels. Nothing reaches Gmail.
 */
export async function setDemoSystemLabels(
  store: DataStore,
  organizationId: string,
  id: string,
  change: { add?: readonly string[]; remove?: readonly string[] },
): Promise<Result<true>> {
  if (!THREAD_ID.test(id)) return err('invalid_input', 'Bad thread id.');
  const all = await demoConversations(store, organizationId, new Date());
  const found = all.find((c) => c.row.id === id.toLowerCase());
  if (!found) return err('not_found', 'That conversation no longer exists.');
  const next = new Set(found.system);
  for (const l of change.remove ?? []) next.delete(l);
  for (const l of change.add ?? []) next.add(l);
  demoState.system.set(found.row.id, [...next]);
  return ok(true);
}

/* --------------------------------------------------------- demo drafts */

/** One demo draft whole, to open in the compose window. */
export function readDemoDraft(draftId: string, now: Date = new Date()): DemoDraft | null {
  return demoDraftList(now).find((d) => d.draftId === draftId) ?? null;
}

/** Save the demo compose window to the demo's Drafts (this process alone). */
export function saveDemoDraft(
  input: Omit<DemoDraft, 'draftId' | 'threadId' | 'at'> & { draftId?: string | null },
  now: Date = new Date(),
): DemoDraft {
  const list = demoDraftList(now);
  const existing = input.draftId ? list.find((d) => d.draftId === input.draftId) : undefined;
  if (existing) {
    Object.assign(existing, { ...input, draftId: existing.draftId, at: now.toISOString() });
    return existing;
  }
  const n = list.length + 1 + Math.floor(now.getTime() % 100000);
  const draft: DemoDraft = {
    ...input,
    draftId: `r-demo-draft-${n}`,
    threadId: `d0e0d${String(n).padStart(11, '0')}`.slice(0, 16),
    at: now.toISOString(),
  };
  list.push(draft);
  return draft;
}

/** Take a demo draft out of Drafts (discard, or sent from the demo's compose window). */
export function removeDemoDraft(draftId: string, now: Date = new Date()): DemoDraft | null {
  const list = demoDraftList(now);
  const at = list.findIndex((d) => d.draftId === draftId);
  if (at < 0) return null;
  return list.splice(at, 1)[0] ?? null;
}

/** Put a discarded demo draft back (Undo). */
export function restoreDemoDraft(draft: DemoDraft, now: Date = new Date()): void {
  const list = demoDraftList(now);
  if (!list.some((d) => d.draftId === draft.draftId)) list.push(draft);
}
