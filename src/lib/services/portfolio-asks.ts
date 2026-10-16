import 'server-only';
import { askRequestType, extractAsks, normalizeAskText } from '@/lib/company-updates/asks';
import { decideUpdate, screenCandidate, type CompanyUpdate } from '@/lib/company-updates/classify';
import { isDemoMode } from '@/lib/config/env';
import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { gmailThreadUrl } from '@/lib/deals/links';
import { listMessageIds } from '@/lib/google/gmail-inbox';
import { recordAudit } from '@/lib/security/audit';
import { scanForInjection } from '@/lib/security/injection';
import { AUTO_ASK_VERSION, isAutoAsk } from '@/lib/portfolio/requests';
import { log } from '@/lib/security/redact';
import type { Citation, PortfolioCompany, PortfolioUpdate } from '@/lib/types/domain';
import { sha256 } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { buildUpdatesQuery, ownAddresses, readCompanyUpdates, readMetas } from './company-updates';
import { getPrimaryIntegration } from './inbox';
import { readUpdateBody } from './portfolio-numbers';
import { DEFAULT_MAILBOX } from './task-close';

/**
 * Portfolio requests read from the companies' own update emails.
 *
 * The same mail Reports > Fresh updates lists (the same Gmail search and the
 * same classifier, `services/company-updates.ts`), kept to updates from a
 * portfolio company itself over the last 45 days. Each one's body is read
 * (shared with the numbers, `portfolio-numbers.ts`) and only its explicit asks
 * are taken: the bullet lines under an "Asks" / "How you can help" heading
 * (`lib/company-updates/asks.ts`). No model, nothing guessed from prose.
 *
 * Where they go, and why there: each ask is one `portfolio_updates` row, the
 * table a hand classification writes (`classifyPortfolioEmail`), so it is an
 * open request on Portfolio > Requests with the same Handled / Dismiss /
 * Draft reply buttons, in the morning brief and the assistant's tools.
 *  - Marked as read automatically: `prompt_version` is `auto-asks/1` and
 *    `model` is null, so a page can say "Read from their update" and link
 *    the email (the citation carries the Gmail link and the heading).
 *  - Deduped by its id: a uuid fixed by the organization, the Gmail message
 *    id and the ask's normalized text. A re-run computes the same ids, reads
 *    which already exist (in any status) and inserts only the rest. A row
 *    that exists is never written again, so a request someone marked handled
 *    or dismissed is never reopened.
 *  - Deduped by what it asks too: the same ask from the same company in a
 *    later update (founders repeat their asks month to month) is the request
 *    already there, in any status, so a dismissed ask never comes back as a
 *    new card. Within one read the newest update's copy is the one kept.
 *  - An email a person already classified in the Inbox is left alone: its
 *    request (open, handled or dismissed) is theirs, and its asks are not
 *    added again beside it.
 *  - No migration: every column it uses has been there since the first one.
 *
 * Runs from the daily job and, throttled, when Portfolio > Requests is
 * viewed; never blocks the page. Gmail is only read (read scope).
 */

export { AUTO_ASK_VERSION, isAutoAsk };

const LOOKBACK_DAYS = 45;
const MAX_MESSAGES = 300;
/** Updates whose bodies one read takes, newest first. */
const MAX_BODIES = 60;
const BODY_BATCH = 4;
/** Nobody waits on the read (the page shows what is stored), so it may take its time. */
const READ_DEADLINE_MS = 120_000;
/** A view starts a read at most this often per organization. */
const VIEW_THROTTLE_MS = 30 * 60_000;
/** After a read that could not reach Gmail, views wait this long. */
const RETRY_MS = 5 * 60_000;

/** What an ask is, for dedupe across updates: the company and the ask's words. */
function askKey(companyId: string, askText: string): string {
  return `${companyId}|${normalizeAskText(askText)}`;
}

/** The ask's row id: a uuid fixed by the organization, the message and the ask, so it is written once. */
export function autoAskId(organizationId: string, messageId: string, askText: string): string {
  const h = sha256(`${organizationId}|auto-ask|${messageId}|${normalizeAskText(askText)}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** One portfolio company's update email, with its body. */
export interface AskSource {
  messageId: string;
  threadId: string;
  companyId: string;
  subject: string;
  /** The sender as the update showed them. */
  sender: string;
  receivedAt: string;
  body: string;
}

/**
 * The open requests one update's asks become (none when it has no asks
 * section). An ask that reads as an instruction to a model rather than to a
 * person (`scanForInjection`, high severity) is left out: it would reach the
 * morning brief as text from the mailbox.
 */
export function autoAskRows(
  organizationId: string,
  source: AskSource,
  options: { emailMessageId?: string | null; accountEmail?: string | null; now?: Date } = {},
): PortfolioUpdate[] {
  const at = options.now ?? new Date();
  const now = at.toISOString();
  const url = gmailThreadUrl(source.threadId, options.accountEmail ?? null);
  const asks = extractAsks(source.body).filter(
    (ask) => scanForInjection(ask.text).highestSeverity !== 'high',
  );
  return asks.map((ask, i): PortfolioUpdate => {
    // A millisecond apart, so the asks of one update keep their order on the page.
    const created = new Date(at.getTime() + i).toISOString();
    const citation: Citation = {
      id: `email:${source.messageId}`,
      kind: 'email',
      // The synced copy when there is one, so the Inbox link opens it.
      ref_id: options.emailMessageId ?? source.messageId,
      label: source.subject,
      page: null,
      section: ask.heading,
      url,
      occurred_at: source.receivedAt,
      retrieved_at: now,
      publisher: source.sender,
      excerpt: ask.text,
    };
    return {
      id: autoAskId(organizationId, source.messageId, ask.text),
      organization_id: organizationId,
      portfolio_company_id: source.companyId,
      email_message_id: options.emailMessageId ?? null,
      summary: ask.text,
      request_type: askRequestType(ask.text),
      request_detail: null,
      urgency: null,
      suggested_action: null,
      suggested_network_contact_ids: [],
      status: 'open',
      occurred_at: source.receivedAt,
      citations: [citation],
      model: null,
      prompt_version: AUTO_ASK_VERSION,
      created_at: created,
      updated_at: created,
    };
  });
}

export interface AsksRecorded {
  /** Updates read. */
  updates: number;
  /** Asks found in them. */
  asks: number;
  /** New open requests; the rest already existed (in any status). */
  added: number;
}

/**
 * Record the asks in these updates as open requests, each once. Rows that
 * exist are left exactly as they are, whatever their status; an ask the
 * company already made in an earlier update, and every ask of an email a
 * person classified by hand, is not added again.
 */
export async function recordAutoAsks(
  store: DataStore,
  organizationId: string,
  sources: readonly AskSource[],
  options: { accountEmail?: string | null; now?: Date } = {},
): Promise<AsksRecorded> {
  const now = options.now ?? new Date();
  // The synced copy of each message, so the request links to it and a reply
  // can be drafted in its thread. It is also how an email a person already
  // classified is recognised (their request carries the synced id), so a
  // fault here stops the read rather than adding asks beside their request.
  const synced = new Map<string, string>();
  for (const group of chunk([...new Set(sources.map((s) => s.messageId))], 100)) {
    for (const row of await store.list('email_messages', organizationId, {
      in: { provider_message_id: group },
    })) {
      synced.set(row.provider_message_id, row.id);
    }
  }

  // What the companies' requests already are, in any status: the ids and asks
  // already written, and the emails a person classified by hand. A fault here
  // stops the read rather than writing blind.
  const existingIds = new Set<string>();
  const existingAsks = new Set<string>();
  const classified = new Set<string>();
  for (const group of chunk([...new Set(sources.map((s) => s.companyId))], 100)) {
    const stored = (await listAllPages(
      store,
      'portfolio_updates',
      organizationId,
      { in: { portfolio_company_id: group } },
      [{ field: 'occurred_at', direction: 'desc' }],
    )) as PortfolioUpdate[];
    for (const row of stored) {
      existingIds.add(row.id);
      if (isAutoAsk(row)) existingAsks.add(askKey(row.portfolio_company_id, row.summary));
      else if (row.email_message_id) classified.add(row.email_message_id);
    }
  }
  // An email classified by hand under another company is still theirs.
  for (const group of chunk([...new Set(synced.values())], 100)) {
    for (const row of (await store.list('portfolio_updates', organizationId, {
      in: { email_message_id: group },
    })) as PortfolioUpdate[]) {
      if (!isAutoAsk(row) && row.email_message_id) classified.add(row.email_message_id);
    }
  }

  // Newest update first, so an ask repeated across updates keeps its latest email.
  const newestFirst = [...sources].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const rows = new Map<string, PortfolioUpdate>();
  const asked = new Set<string>();
  for (const source of newestFirst) {
    const emailMessageId = synced.get(source.messageId) ?? null;
    if (emailMessageId && classified.has(emailMessageId)) continue;
    for (const row of autoAskRows(organizationId, source, {
      emailMessageId,
      accountEmail: options.accountEmail,
      now,
    })) {
      const key = askKey(row.portfolio_company_id, row.summary);
      if (rows.has(row.id) || asked.has(key)) continue;
      asked.add(key);
      rows.set(row.id, row);
    }
  }

  const fresh = [...rows.values()].filter(
    (r) => !existingIds.has(r.id) && !existingAsks.has(askKey(r.portfolio_company_id, r.summary)),
  );
  let added = 0;
  for (const group of chunk(fresh, 100)) {
    try {
      await store.insertMany('portfolio_updates', group);
      added += group.length;
    } catch {
      // Another read inserted some meanwhile: one at a time, skipping those.
      for (const row of group) {
        try {
          await store.insert('portfolio_updates', row);
          added += 1;
        } catch {
          // Already there.
        }
      }
    }
  }
  if (added > 0) {
    await recordAudit(store, {
      organizationId,
      userId: null,
      action: 'portfolio.asks_read',
      entityType: 'portfolio_update',
      entityId: null,
      metadata: { added, asks: rows.size, updates: sources.length },
    });
  }
  return { updates: sources.length, asks: rows.size, added };
}

/* ------------------------------------------------------------- sources */

export type AsksReadState = 'ok' | 'not_connected' | 'error';

export interface AskSourcesRead {
  state: AsksReadState;
  sources: AskSource[];
  /** The mailbox account, for the Gmail links. */
  accountEmail: string | null;
}

export type AskSourceReader = (
  store: DataStore,
  organizationId: string,
  now: Date,
) => Promise<AskSourcesRead>;

async function portfolioCompanies(
  store: DataStore,
  organizationId: string,
): Promise<PortfolioCompany[]> {
  return (await store.list('portfolio_companies', organizationId, {
    eq: { is_archived: false },
  })) as PortfolioCompany[];
}

/** Updates from portfolio companies themselves: the classifier's own "portfolio" verdict. */
function fromPortfolio(updates: readonly (CompanyUpdate | null)[], since: number): CompanyUpdate[] {
  return updates
    .filter((u): u is CompanyUpdate => u !== null && u.companyId !== null)
    .filter((u) => Date.parse(u.receivedAt) >= since)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

const gmailSources: AskSourceReader = async (store, organizationId, now) => {
  const integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
  if (!integration || integration.status === 'disconnected') {
    return { state: 'not_connected', sources: [], accountEmail: null };
  }
  const accountEmail = integration.account_email ?? null;
  const companies = await portfolioCompanies(store, organizationId);
  if (companies.length === 0) return { state: 'ok', sources: [], accountEmail };
  const ids = await listMessageIds(
    store,
    integration,
    buildUpdatesQuery(companies, { lookbackDays: LOOKBACK_DAYS }),
    MAX_MESSAGES,
  );
  if (!ids.ok) return { state: 'error', sources: [], accountEmail };
  const deadline = Date.now() + READ_DEADLINE_MS;
  const metas = await readMetas(store, integration, ids.value, deadline);
  const own = ownAddresses(integration);
  const since = now.getTime() - LOOKBACK_DAYS * 86_400_000;
  // No Sent-mail lookups: only a solid portfolio match counts here.
  const updates = fromPortfolio(
    metas.map((m) => {
      const screened = screenCandidate(m, { own, companies });
      return screened ? decideUpdate(screened, false) : null;
    }),
    since,
  ).slice(0, MAX_BODIES);

  const sources: AskSource[] = [];
  for (const group of chunk(updates, BODY_BATCH)) {
    if (Date.now() > deadline) break;
    const bodies = await Promise.all(
      group.map((u) =>
        readUpdateBody(store, integration, u.messageId, u.threadId).catch(() => null),
      ),
    );
    group.forEach((u, i) => {
      const body = bodies[i];
      if (body) sources.push(toSource(u, body));
    });
  }
  return { state: 'ok', sources, accountEmail };
};

function toSource(u: CompanyUpdate, body: string): AskSource {
  return {
    messageId: u.messageId,
    threadId: u.threadId,
    companyId: u.companyId as string,
    subject: u.subject,
    sender: u.sender,
    receivedAt: u.receivedAt,
    body,
  };
}

/* -------------------------------------------------------------- demo */

/**
 * Bodies for demo mode's fictional updates (company-updates.ts), by message
 * id. Every name is invented. Ledgerly's has highlights (not asks) and an
 * "Asks" section; Stonebridge's a numbered "How you can help:" and a
 * signature; Quillfeather's asks are never read, as it is not a portfolio
 * company.
 */
const DEMO_BODIES: Record<string, string> = {
  c0de0a0000000001: [
    'Hi all,',
    '',
    'ARR reached $780K, up from $700K in August, and NRR is 121%. We are preparing our Series A and would love your help as we get closer.',
    '',
    'Highlights',
    '- Signed 6 new accounting firms, 94 in total',
    '- Shipped the month-end close assistant',
    '',
    'Asks',
    '- Intros to Series A leads who know vertical AI in professional services',
    '- A VP Sales candidate who has sold into accounting firms',
    '',
    'Thanks for the support,',
    'Maya',
  ].join('\n'),
  c0de0a0000000002: [
    'Hi everyone,',
    '',
    '$215K ARR, up 18% on the quarter. Still looking for a founding engineer.',
    '',
    'How you can help:',
    '',
    '1. Referrals for a founding engineer with Rust and logistics experience',
    '2. Warm intros to heads of operations at regional 3PLs',
    '',
    '-- ',
    'Jonas Reyes',
    'COO, Stonebridge Ops',
  ].join('\n'),
  c0de0a0000000004: ['Our asks:', '- Intros to two more seed funds'].join('\n'),
};

const demoSources: AskSourceReader = async (store, organizationId, now) => {
  const read = await readCompanyUpdates(store, organizationId, { now });
  const since = now.getTime() - LOOKBACK_DAYS * 86_400_000;
  const sources = fromPortfolio(read.updates, since)
    .filter((u) => DEMO_BODIES[u.messageId])
    .map((u) => toSource(u, DEMO_BODIES[u.messageId] as string));
  return { state: read.state, sources, accountEmail: DEFAULT_MAILBOX };
};

/* ------------------------------------------------------------ refresh */

export interface AsksRefresh extends AsksRecorded {
  state: AsksReadState;
  checkedAt: string;
}

const refreshState = processWide('portfolio-asks', () => ({
  inFlight: new Map<string, Promise<AsksRefresh>>(),
  /** When a view last started a read, per organization. */
  viewedAt: new Map<string, number>(),
  retryAt: new Map<string, number>(),
}));

/** Test hook. */
export function resetPortfolioAsks(): void {
  refreshState.inFlight.clear();
  refreshState.viewedAt.clear();
  refreshState.retryAt.clear();
}

/**
 * Read the portfolio's update emails and record their asks. One read per
 * organization at a time: a second call while one runs gets the same
 * promise. Never throws.
 */
export function refreshPortfolioAsks(
  store: DataStore,
  organizationId: string,
  options: { now?: () => Date; read?: AskSourceReader } = {},
): Promise<AsksRefresh> {
  const running = refreshState.inFlight.get(organizationId);
  if (running) return running;
  const clock = options.now ?? (() => new Date());
  const read = options.read ?? (isDemoMode() ? demoSources : gmailSources);
  // After a failed read a view may try again in five minutes, not thirty.
  const failed = () => {
    refreshState.retryAt.set(organizationId, clock().getTime() + RETRY_MS);
    refreshState.viewedAt.delete(organizationId);
  };
  const run = (async (): Promise<AsksRefresh> => {
    const at = clock();
    const none = { updates: 0, asks: 0, added: 0, checkedAt: at.toISOString() };
    try {
      const sources = await read(store, organizationId, at);
      if (sources.state !== 'ok') {
        failed();
        return { state: sources.state, ...none };
      }
      const recorded = await recordAutoAsks(store, organizationId, sources.sources, {
        accountEmail: sources.accountEmail,
        now: at,
      });
      refreshState.retryAt.delete(organizationId);
      return { state: 'ok', ...recorded, checkedAt: at.toISOString() };
    } catch (error) {
      log.warn('Portfolio asks read failed', { reason: (error as Error)?.message });
      failed();
      return { state: 'error', ...none };
    } finally {
      refreshState.inFlight.delete(organizationId);
    }
  })();
  refreshState.inFlight.set(organizationId, run);
  return run;
}

/** How long a view may wait on a demo read it started, which comes from memory. */
const DEMO_VIEW_WAIT_MS = 1_500;

export interface AsksViewRead {
  run: Promise<AsksRefresh>;
  /**
   * How long the view may wait on it before rendering. Zero for a Gmail read,
   * which never finishes in a moment (the next view shows what it found), and
   * for a read already running (the daily job's, or another view's).
   */
  waitMs: number;
}

/**
 * The read a view of Portfolio > Requests starts: at most one every 30
 * minutes per organization (5 after a failure), and the running one if there
 * is one. Null when it is not time. The caller keeps it alive past the
 * response (`after`) and waits on it only for `waitMs`.
 */
export function refreshPortfolioAsksOnView(
  store: DataStore,
  organizationId: string,
  options: { now?: Date; read?: AskSourceReader } = {},
): AsksViewRead | null {
  const running = refreshState.inFlight.get(organizationId);
  if (running) return { run: running, waitMs: 0 };
  const now = (options.now ?? new Date()).getTime();
  if ((refreshState.retryAt.get(organizationId) ?? 0) > now) return null;
  const last = refreshState.viewedAt.get(organizationId);
  if (last !== undefined && now - last < VIEW_THROTTLE_MS) return null;
  refreshState.viewedAt.set(organizationId, now);
  const run = refreshPortfolioAsks(store, organizationId, {
    read: options.read,
    now: options.now ? () => options.now as Date : undefined,
  });
  return { run, waitMs: !options.read && isDemoMode() ? DEMO_VIEW_WAIT_MS : 0 };
}
