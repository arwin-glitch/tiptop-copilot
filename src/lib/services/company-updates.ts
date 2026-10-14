import 'server-only';
import { NICK_ALIASES } from '@/lib/calendar/meetings';
import {
  decideUpdate,
  historyQuery,
  newestPerThread,
  screenCandidate,
  STAFF_DOMAINS,
  type CompanyLike,
  type CompanyUpdate,
  type Screened,
} from '@/lib/company-updates/classify';
import { isDemoMode } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { listMessageIds } from '@/lib/google/gmail-inbox';
import { readMessageMeta, type MessageMeta } from '@/lib/google/gmail-metadata';
import type { Integration, PortfolioCompany } from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { getPrimaryIntegration } from './inbox';

/**
 * Founder and investor updates that landed in Nick's mailbox in the last 30
 * days, read live from Gmail with the read scope. The Slack digest runs twice
 * a week; this fills the gap between runs. Nothing is stored: headers are
 * kept in memory by message id, the list for ten minutes.
 */

const LOOKBACK_DAYS = 30;
const MAX_MESSAGES = 300;
const LIST_TTL_MS = 10 * 60_000;
const PARTIAL_TTL_MS = 60_000;
const DEADLINE_MS = 15_000;
const HISTORY_TTL_MS = 6 * 3_600_000;
const FETCH_BATCH = 10;
const HISTORY_BATCH = 5;
const MAX_HISTORY_LOOKUPS = 150;
const META_CACHE_MAX = 5_000;

export type CompanyUpdatesState = 'ok' | 'not_connected' | 'error';

export interface CompanyUpdatesResult {
  state: CompanyUpdatesState;
  updates: CompanyUpdate[];
  checkedAt: string;
  /** The first read hit its time limit: some mail is still to be read. */
  partial?: boolean;
}

const cache = processWide('company-updates', () => ({
  lists: new Map<string, { at: number; ttl: number; result: CompanyUpdatesResult }>(),
  history: new Map<string, { at: number; emailed: boolean }>(),
}));

/** Headers by message id, shared with the portfolio numbers. A message's headers never change. */
const metaCache = processWide('gmail-message-meta', () => new Map<string, MessageMeta>());

/** Test hook. */
export function resetCompanyUpdatesCache(): void {
  cache.lists.clear();
  cache.history.clear();
  metaCache.clear();
}

export function ownAddresses(integration: Pick<Integration, 'account_email'> | null): string[] {
  const own = new Set(NICK_ALIASES.map((a) => a.toLowerCase()));
  const account = integration?.account_email?.trim().toLowerCase();
  if (account) own.add(account);
  return [...own];
}

/** Headers for these ids, from memory where possible; a failed read is retried next time. */
export async function readMetas(
  store: DataStore,
  integration: Integration,
  ids: readonly string[],
  deadline = Number.POSITIVE_INFINITY,
): Promise<MessageMeta[]> {
  const missing = ids.filter((id) => !metaCache.has(id));
  for (let i = 0; i < missing.length; i += FETCH_BATCH) {
    if (Date.now() > deadline) break;
    const batch = missing.slice(i, i + FETCH_BATCH);
    const metas = await Promise.all(
      batch.map((id) => readMessageMeta(store, integration, id).catch(() => null)),
    );
    for (const m of metas) {
      if (!m?.ok) continue;
      if (metaCache.size >= META_CACHE_MAX) {
        const oldest = metaCache.keys().next().value;
        if (oldest !== undefined) metaCache.delete(oldest);
      }
      metaCache.set(m.value.id, m.value);
    }
  }
  return ids.map((id) => metaCache.get(id)).filter((m): m is MessageMeta => Boolean(m));
}

/** Keeps a name or domain safe inside a Gmail query. */
function quoted(text: string): string | null {
  const clean = text
    .replace(/["(){}:\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length >= 2 ? `"${clean}"` : null;
}

function plainDomain(domain: string | null | undefined): string | null {
  const d = (domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
  return d && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

/**
 * The Gmail search: update-like subjects outside Promotions and Forums, plus
 * anything that names a portfolio company or comes from its domain. Sent mail,
 * TipTop staff, DocSend, newsletter hosts and calendar invites are left out
 * before anything is read. The classifier makes the real decision.
 */
export function buildUpdatesQuery(companies: readonly CompanyLike[]): string {
  const subjectTerms =
    'subject:(update OR updates OR Q1 OR Q2 OR Q3 OR Q4 OR ARR OR MRR OR fundraise OR fundraising OR newsletter OR "investor letter" OR "shareholder letter" OR "seed round")';
  const names = companies
    .map((c) => quoted(c.name))
    .filter((n): n is string => Boolean(n))
    .slice(0, 80);
  const domains = [
    ...new Set(
      companies
        .map((c) => plainDomain(c.domain) ?? plainDomain(c.website))
        .filter((d): d is string => Boolean(d)),
    ),
  ].slice(0, 80);
  const parts = [`(${subjectTerms} -category:promotions -category:forums)`];
  if (names.length > 0) parts.push(`subject:(${names.join(' OR ')})`);
  if (domains.length > 0) parts.push(`from:(${domains.join(' OR ')})`);
  const skip = [
    ...STAFF_DOMAINS.map((d) => `-from:${d}`),
    '-from:docsend.com',
    '-from:substack.com',
    '-from:beehiiv.com',
    '-from:calendar-notification@google.com',
    '-subject:"updated invitation"',
  ];
  return `newer_than:${LOOKBACK_DAYS}d -in:sent -in:chats ${skip.join(' ')} (${parts.join(' OR ')})`;
}

async function emailedBefore(
  store: DataStore,
  integration: Integration,
  key: string,
  now: number,
): Promise<boolean | null> {
  const hit = cache.history.get(key);
  if (hit && now - hit.at < HISTORY_TTL_MS) return hit.emailed;
  const q = historyQuery(key);
  if (!q) return false;
  const res = await listMessageIds(store, integration, q, 1).catch(() => null);
  if (!res?.ok) return null;
  const emailed = res.value.length > 0;
  cache.history.set(key, { at: now, emailed });
  return emailed;
}

async function portfolioCompanies(
  store: DataStore,
  organizationId: string,
): Promise<PortfolioCompany[]> {
  return (await store
    .list('portfolio_companies', organizationId, { eq: { is_archived: false } })
    .catch(() => [])) as PortfolioCompany[];
}

/** Screen, look up Sent mail for senders that need it, then keep the trusted ones. */
async function classify(
  metas: readonly MessageMeta[],
  companies: readonly CompanyLike[],
  own: readonly string[],
  lookup: (key: string) => Promise<boolean | null>,
): Promise<{ updates: CompanyUpdate[]; incomplete: boolean }> {
  const screened = metas
    .map((m) => screenCandidate(m, { own, companies }))
    .filter((s): s is Screened => s !== null)
    // Newest first, so if the lookup cap is reached it is old mail that waits.
    .sort((a, b) => (b.message.date ?? '').localeCompare(a.message.date ?? ''));
  const allKeys = [
    ...new Set(screened.map((s) => s.historyKey).filter((k): k is string => Boolean(k))),
  ];
  const keys = allKeys.slice(0, MAX_HISTORY_LOOKUPS);
  const emailed = new Map<string, boolean>();
  let failed = 0;
  for (let i = 0; i < keys.length; i += HISTORY_BATCH) {
    const batch = keys.slice(i, i + HISTORY_BATCH);
    const results = await Promise.all(batch.map((k) => lookup(k)));
    batch.forEach((k, j) => {
      if (results[j] === null) failed += 1;
      else emailed.set(k, results[j] === true);
    });
  }
  const updates = screened
    .map((s) => decideUpdate(s, s.historyKey ? (emailed.get(s.historyKey) ?? false) : false))
    .filter((u): u is CompanyUpdate => u !== null);
  // A lookup that failed or never ran is unknown, not "never emailed": say the
  // list is still loading so the next view tries again soon.
  return {
    updates: newestPerThread(updates),
    incomplete: failed > 0 || allKeys.length > keys.length,
  };
}

/* -------------------------------------------------------------- demo */

const DEMO_EMAILED = new Set(['cobaltorchard.example', 'quillfeather.demo']);

/** Fictional mail for demo mode. Runs through the real classifier; two are dropped by it. */
function demoMetas(now: Date): MessageMeta[] {
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const base = { to: 'nick@tiptop.vc', cc: '', labelIds: ['INBOX'], bulk: false };
  return [
    {
      ...base,
      id: 'c0de0a0000000001',
      threadId: 'c0de0a0000000001',
      from: 'Maya Chen <maya@ledgerly.demo>',
      subject: 'Ledgerly October update: $780K ARR, Series A prep',
      date: ago(5),
      snippet:
        'Hi all - ARR reached $780K, up from $700K in August. We are preparing our Series A.',
      to: 'investors@ledgerly.demo',
    },
    {
      ...base,
      id: 'c0de0a0000000002',
      threadId: 'c0de0a0000000002',
      from: 'Jonas Reyes <jonas@stonebridgeops.demo>',
      subject: "Stonebridge Ops Q3'26 investor update",
      date: ago(30),
      snippet: '$215K ARR, up 18% on the quarter. Still looking for a founding engineer.',
    },
    {
      ...base,
      id: '0f00000000000003',
      threadId: '0f00000000000003',
      from: 'Mara Quist <ceo@cobaltorchard.example>',
      subject: 'Cobalt Orchard weekly investor update',
      date: ago(50),
      snippet: 'Wholesale orders up 14% week over week, and the next close moves to month end.',
    },
    {
      ...base,
      id: 'c0de0a0000000004',
      threadId: 'c0de0a0000000004',
      from: 'Priya Natarajan <priya@quillfeather.demo>',
      subject: 'Quillfeather seed round update - Day 4',
      date: ago(76),
      snippet: '$1.1M of $2M committed. Two funds in diligence this week.',
      to: 'undisclosed-recipients:;',
    },
    {
      ...base,
      id: 'c0de0a0000000005',
      threadId: 'c0de0a0000000005',
      from: 'DocSend <no-reply@docsend.com>',
      subject: 'priya@harborlp.demo viewed the document Northwind Fund I Deck',
      date: ago(8),
      snippet: 'Someone viewed your document.',
    },
    {
      ...base,
      id: 'c0de0a0000000006',
      threadId: 'c0de0a0000000006',
      from: 'Sam Okafor <sam@tidewell.demo>',
      subject: 'Tidewell investor update - raising our seed',
      date: ago(20),
      snippet: 'A cold note from someone Nick has never emailed.',
    },
  ];
}

async function demoUpdates(
  store: DataStore,
  organizationId: string,
  now: Date,
): Promise<CompanyUpdate[]> {
  const companies = await portfolioCompanies(store, organizationId);
  const { updates } = await classify(demoMetas(now), companies, ownAddresses(null), async (key) =>
    DEMO_EMAILED.has(key),
  );
  return updates;
}

/* --------------------------------------------------------------- read */

/** Fresh company updates from Gmail, cached for ten minutes; never throws. */
export async function readCompanyUpdates(
  store: DataStore,
  organizationId: string,
  options: { now?: Date; force?: boolean } = {},
): Promise<CompanyUpdatesResult> {
  const now = options.now ?? new Date();
  const checkedAt = now.toISOString();
  try {
    if (isDemoMode()) {
      return { state: 'ok', updates: await demoUpdates(store, organizationId, now), checkedAt };
    }
    const cached = cache.lists.get(organizationId);
    if (!options.force && cached && now.getTime() - cached.at < cached.ttl) return cached.result;

    const integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
    if (!integration || integration.status === 'disconnected') {
      return { state: 'not_connected', updates: [], checkedAt };
    }
    const companies = await portfolioCompanies(store, organizationId);
    const ids = await listMessageIds(
      store,
      integration,
      buildUpdatesQuery(companies),
      MAX_MESSAGES,
    );
    if (!ids.ok) return cached?.result ?? { state: 'error', updates: [], checkedAt };

    // The first read of a cold process fetches every header; cap the wait and
    // come back for the rest sooner rather than hold the page.
    const metas = await readMetas(store, integration, ids.value, Date.now() + DEADLINE_MS);
    const at = now.getTime();
    const { updates, incomplete } = await classify(
      metas,
      companies,
      ownAddresses(integration),
      (key) => emailedBefore(store, integration, key, at),
    );
    const partial = metas.length < ids.value.length || incomplete;
    const result: CompanyUpdatesResult = { state: 'ok', updates, checkedAt, partial };
    const ttl = partial ? PARTIAL_TTL_MS : LIST_TTL_MS;
    cache.lists.set(organizationId, { at, ttl, result });
    return result;
  } catch {
    return cache.lists.get(organizationId)?.result ?? { state: 'error', updates: [], checkedAt };
  }
}

/* ------------------------------------------------------------ explain */

/**
 * Why one message is or isn't in Fresh company updates, step by step. For
 * diagnosing a missed update against the real portfolio list and mailbox.
 */
export async function explainUpdate(
  store: DataStore,
  organizationId: string,
  messageId: string,
): Promise<Record<string, unknown>> {
  const integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
  if (!integration) return { step: 'no mailbox connected' };
  const meta = await readMessageMeta(store, integration, messageId);
  if (!meta.ok) return { step: 'could not read the message', error: meta.error.message };
  const companies = await portfolioCompanies(store, organizationId);
  const own = ownAddresses(integration);
  const header = {
    from: meta.value.from,
    replyTo: meta.value.replyTo ?? '',
    subject: meta.value.subject,
    labels: meta.value.labelIds,
    bulk: meta.value.bulk,
    date: meta.value.date,
  };
  const ids = await listMessageIds(store, integration, buildUpdatesQuery(companies), MAX_MESSAGES);
  const position = ids.ok ? ids.value.indexOf(messageId) : null;
  const search = ids.ok
    ? { found: position !== -1, position, of: ids.value.length }
    : { error: ids.error.message };
  const screened = screenCandidate(meta.value, { own, companies });
  if (!screened) return { step: 'dropped at screening (headers)', header, search };
  const emailed = screened.historyKey
    ? await emailedBefore(store, integration, screened.historyKey, Date.now())
    : null;
  const decided = decideUpdate(screened, emailed === true);
  return {
    step: decided ? 'kept' : 'dropped at trust (not portfolio, not emailed)',
    header,
    search,
    verdict: screened.verdict,
    portfolioMatch: screened.match
      ? { name: screened.match.company.name, by: screened.match.by }
      : null,
    historyKey: screened.historyKey,
    emailedBefore: emailed,
    decided,
  };
}
