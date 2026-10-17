import 'server-only';
import { askRequestType, extractAsks, normalizeAskText } from '@/lib/company-updates/asks';
import { decideUpdate, screenCandidate, type CompanyUpdate } from '@/lib/company-updates/classify';
import { isDemoMode } from '@/lib/config/env';
import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { gmailThreadUrl } from '@/lib/deals/links';
import {
  GMAIL_FAIL_CODES,
  gmailPause,
  type GmailFailCode,
  type GmailReadOptions,
} from '@/lib/google/gmail-get';
import { listMessageIds } from '@/lib/google/gmail-inbox';
import { recordAudit } from '@/lib/security/audit';
import { scanForInjection } from '@/lib/security/injection';
import { AUTO_ASK_VERSION, isAutoAsk } from '@/lib/portfolio/requests';
import { log } from '@/lib/security/redact';
import type { Citation, PortfolioCompany, PortfolioUpdate } from '@/lib/types/domain';
import { sha256 } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { settlesWithin } from '@/lib/util/settle';
import { buildUpdatesQuery, ownAddresses, readCompanyUpdates, readMetas } from './company-updates';
import { getPrimaryIntegration } from './inbox';
import { readUpdateBodyWithReason, type UpdateBodyRead } from './portfolio-numbers';
import { DEFAULT_MAILBOX } from './task-close';

/**
 * Portfolio requests read from the companies' own update emails.
 *
 * The same mail Reports > Fresh updates lists (the same Gmail search and the
 * same classifier, `services/company-updates.ts`), kept to updates from a
 * portfolio company itself over the last 45 days. Each one's body is read
 * (shared with the numbers, `portfolio-numbers.ts`) and only its explicit asks
 * are taken: what it wrote under an "Asks" / "My ask" / "How you can help"
 * heading, as a list, title lines or asking sentences
 * (`lib/company-updates/asks.ts`). No model, nothing read outside that section.
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
 * viewed (started after the response, so it never blocks the page). Every
 * run writes one `portfolio.asks_read` audit row with its counts, found
 * nothing or failed included, and why any matched update's body was not
 * read, as safe codes. Gmail is only read (read scope), gently: nobody waits
 * on the read, so a rate-limited or failing Gmail read is tried again within
 * its deadline (`gmail-get.ts`), and bodies are read two at a time with a
 * pause between.
 */

export { AUTO_ASK_VERSION, isAutoAsk };

const LOOKBACK_DAYS = 45;
const MAX_MESSAGES = 300;
/** Updates whose bodies one read takes, newest first. */
const MAX_BODIES = 60;
/**
 * Bodies read at once, with a pause between: the header reads just before
 * used much of Gmail's per-user rate, and a full thread costs twice a header.
 */
const BODY_BATCH = 2;
const BODY_GAP_MS = 250;
/** Nobody waits on the read (the page shows what is stored), so it may take its time. */
const READ_DEADLINE_MS = 120_000;
/** The headers may take this much of it, so a rate-limited Gmail still leaves time for the bodies. */
const HEADERS_BUDGET_MS = 75_000;
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
  /** New open requests. */
  added: number;
  /** Asks already recorded (in any status), by id or by what they ask, or inserted meanwhile by another read. */
  skipped: number;
  /** Asks that could not be inserted and are not there either: a store fault, never a duplicate. */
  failed: number;
  /** Update bodies the extractor could not read; the other updates' asks are still recorded. */
  unreadable: number;
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
  let unreadable = 0;
  for (const source of newestFirst) {
    const emailMessageId = synced.get(source.messageId) ?? null;
    if (emailMessageId && classified.has(emailMessageId)) continue;
    let found: PortfolioUpdate[];
    try {
      found = autoAskRows(organizationId, source, {
        emailMessageId,
        accountEmail: options.accountEmail,
        now,
      });
    } catch (error) {
      // One body the extractor cannot read never costs the other companies their asks.
      unreadable += 1;
      log.warn('Portfolio asks: an update could not be read', {
        reason: (error as Error)?.name ?? 'Error',
      });
      continue;
    }
    for (const row of found) {
      const key = askKey(row.portfolio_company_id, row.summary);
      if (rows.has(row.id) || asked.has(key)) continue;
      asked.add(key);
      rows.set(row.id, row);
    }
  }

  const fresh = [...rows.values()].filter(
    (r) => !existingIds.has(r.id) && !existingAsks.has(askKey(r.portfolio_company_id, r.summary)),
  );
  let skipped = rows.size - fresh.length;
  let added = 0;
  let failed = 0;
  for (const group of chunk(fresh, 100)) {
    try {
      await store.insertMany('portfolio_updates', group);
      added += group.length;
    } catch {
      // Another read may have inserted some meanwhile: one at a time, and a
      // row that fails is a duplicate only when it is there now.
      for (const row of group) {
        try {
          await store.insert('portfolio_updates', row);
          added += 1;
        } catch {
          const there = await store
            .get('portfolio_updates', organizationId, row.id)
            .catch(() => null);
          if (there) skipped += 1;
          else failed += 1;
        }
      }
    }
  }
  return { updates: sources.length, asks: rows.size, added, skipped, failed, unreadable };
}

/* ------------------------------------------------------------- sources */

export type AsksReadState = 'ok' | 'not_connected' | 'error';

/**
 * Why a matched update's body was not read: Gmail's failure (`gmailFailCode`:
 * `rate_limited`, `gmail_5xx`, `gmail_4xx`, `not_found`, `timeout`,
 * `provider_unavailable`), `deadline` when the read ran out of time first,
 * or `empty` when Gmail gave the message but no text came out of it (no
 * text part found, say), so a body with nothing in it is never counted as
 * read.
 */
export const BODY_FAIL_CODES = [...GMAIL_FAIL_CODES, 'empty'] as const;
export type BodyFailCode = GmailFailCode | 'empty';

/** Every code at zero, so each audit row has the same shape. */
export function noBodyFailures(): Record<BodyFailCode, number> {
  return Object.fromEntries(BODY_FAIL_CODES.map((c) => [c, 0])) as Record<BodyFailCode, number>;
}

export interface AskSourcesRead {
  state: AsksReadState;
  sources: AskSource[];
  /** The mailbox account, for the Gmail links. */
  accountEmail: string | null;
  /** Messages the Gmail search listed, and how many were a portfolio company's own update. */
  listed?: number;
  matched?: number;
  /** Of the listed messages, how many had their headers read (the rest could not be, in time). */
  metadataRead?: number;
  /** Matched updates (up to the cap) whose bodies were not read or came back empty, and why, by code. */
  bodiesFailed?: number;
  bodyFailCodes?: Record<BodyFailCode, number>;
  /** Why the read failed, as a code from `lib/util/result.ts` ("provider_unavailable"); never a message. */
  error?: string;
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

/**
 * The portfolio's update emails from Gmail, with their bodies. Every Gmail
 * read here is a background one (`retry`, paced with the mailbox's other
 * background reads), within READ_DEADLINE_MS, the headers within
 * HEADERS_BUDGET_MS of it; each matched update whose body is still not read,
 * or came back empty, is counted by why.
 */
export const gmailAskSources: AskSourceReader = async (store, organizationId, now) => {
  const integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
  if (!integration || integration.status === 'disconnected') {
    return { state: 'not_connected', sources: [], accountEmail: null };
  }
  const accountEmail = integration.account_email ?? null;
  const companies = await portfolioCompanies(store, organizationId);
  if (companies.length === 0) return { state: 'ok', sources: [], accountEmail };
  const deadline = Date.now() + READ_DEADLINE_MS;
  const gmail: GmailReadOptions = { retry: { deadline } };
  const ids = await listMessageIds(
    store,
    integration,
    buildUpdatesQuery(companies, { lookbackDays: LOOKBACK_DAYS }),
    MAX_MESSAGES,
    gmail,
  );
  if (!ids.ok) return { state: 'error', sources: [], accountEmail, error: ids.error.code };
  const headersBy = Math.min(deadline, Date.now() + HEADERS_BUDGET_MS);
  const metas = await readMetas(store, integration, ids.value, headersBy, {
    retry: { deadline: headersBy },
  });
  const own = ownAddresses(integration);
  const since = now.getTime() - LOOKBACK_DAYS * 86_400_000;
  // No Sent-mail lookups: only a solid portfolio match counts here.
  const matched = fromPortfolio(
    metas.map((m) => {
      const screened = screenCandidate(m, { own, companies });
      return screened ? decideUpdate(screened, false) : null;
    }),
    since,
  );
  const updates = matched.slice(0, MAX_BODIES);

  const sources: AskSource[] = [];
  const failures = noBodyFailures();
  for (let i = 0; i < updates.length; i += BODY_BATCH) {
    if (i > 0) await gmailPause(BODY_GAP_MS);
    if (Date.now() > deadline) {
      failures.deadline += updates.length - i;
      break;
    }
    const group = updates.slice(i, i + BODY_BATCH);
    const reads = await Promise.all(
      group.map((u) =>
        readUpdateBodyWithReason(store, integration, u.messageId, u.threadId, gmail).catch(
          (): UpdateBodyRead => ({ ok: false, code: 'provider_unavailable' }),
        ),
      ),
    );
    group.forEach((u, k) => {
      const read = reads[k];
      if (read?.ok && read.text.trim()) sources.push(toSource(u, read.text));
      else failures[read?.ok ? 'empty' : (read?.code ?? 'provider_unavailable')] += 1;
    });
  }
  return {
    state: 'ok',
    sources,
    accountEmail,
    listed: ids.value.length,
    matched: matched.length,
    metadataRead: metas.length,
    bodiesFailed: updates.length - sources.length,
    bodyFailCodes: failures,
  };
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
  const matched = fromPortfolio(read.updates, since);
  const sources = matched
    .filter((u) => DEMO_BODIES[u.messageId])
    .map((u) => toSource(u, DEMO_BODIES[u.messageId] as string));
  return {
    state: read.state,
    sources,
    accountEmail: DEFAULT_MAILBOX,
    listed: read.updates.length,
    matched: matched.length,
  };
};

/* ------------------------------------------------------------ refresh */

/** What started a read: the daily job, or a view of Portfolio > Requests. */
export type AsksTrigger = 'daily' | 'view';

export interface AsksRefresh extends AsksRecorded {
  state: AsksReadState;
  checkedAt: string;
  /**
   * Why a read that was not `ok` stopped, as a code safe for a public log:
   * the reader's own (`not_connected`, `provider_unavailable`, …),
   * `read_failed` when reading the mail threw, `store_failed` when recording
   * the asks did, `insert_failed` when some asks could not be inserted (and
   * are not there either), the rest recorded.
   */
  error?: string;
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

/** A code from a reader, kept only when it looks like one (never free text from a provider). */
function safeCode(code: string | undefined, fallback: string): string {
  return code && /^[a-z][a-z_]{1,39}$/.test(code) ? code : fallback;
}

/**
 * Read the portfolio's update emails and record their asks. One read per
 * organization at a time: a second call while one runs gets the same
 * promise. Never throws.
 *
 * Every run, whatever it found and however it ended, writes one
 * `portfolio.asks_read` audit row with its counts (messages listed and
 * headers read, updates matched, update bodies read as `emails_scanned`,
 * asks found, inserted, skipped as already there), the matched bodies not
 * read with why (`bodies_failed`, and `body_fail_codes` by `BodyFailCode`)
 * and, when it failed, a safe error code, so a read that finds nothing is
 * told apart from one that never ran or could not read the mail.
 */
export function refreshPortfolioAsks(
  store: DataStore,
  organizationId: string,
  options: { now?: () => Date; read?: AskSourceReader; trigger?: AsksTrigger } = {},
): Promise<AsksRefresh> {
  const running = refreshState.inFlight.get(organizationId);
  if (running) return running;
  const clock = options.now ?? (() => new Date());
  const read = options.read ?? (isDemoMode() ? demoSources : gmailAskSources);
  // After a failed read a view may try again in five minutes, not thirty.
  const failed = () => {
    refreshState.retryAt.set(organizationId, clock().getTime() + RETRY_MS);
    refreshState.viewedAt.delete(organizationId);
  };
  const run = (async (): Promise<AsksRefresh> => {
    const at = clock();
    const startedAt = Date.now();
    const none = {
      updates: 0,
      asks: 0,
      added: 0,
      skipped: 0,
      failed: 0,
      unreadable: 0,
      checkedAt: at.toISOString(),
    };
    let sources: AskSourcesRead | null = null;
    let result: AsksRefresh;
    try {
      sources = await read(store, organizationId, at);
      if (sources.state !== 'ok') {
        result = { state: sources.state, ...none, error: safeCode(sources.error, sources.state) };
      } else {
        try {
          const recorded = await recordAutoAsks(store, organizationId, sources.sources, {
            accountEmail: sources.accountEmail,
            now: at,
          });
          result =
            recorded.failed > 0
              ? { state: 'error', ...recorded, checkedAt: at.toISOString(), error: 'insert_failed' }
              : { state: 'ok', ...recorded, checkedAt: at.toISOString() };
        } catch (error) {
          log.warn('Portfolio asks could not be recorded', { reason: (error as Error)?.message });
          result = {
            state: 'error',
            ...none,
            updates: sources.sources.length,
            error: 'store_failed',
          };
        }
      }
    } catch (error) {
      log.warn('Portfolio asks read failed', { reason: (error as Error)?.message });
      result = { state: 'error', ...none, error: 'read_failed' };
    }
    if (result.state === 'ok') refreshState.retryAt.delete(organizationId);
    else failed();
    try {
      await recordAudit(store, {
        organizationId,
        userId: null,
        action: 'portfolio.asks_read',
        entityType: 'portfolio_update',
        entityId: null,
        metadata: {
          trigger: options.trigger ?? 'daily',
          state: result.state,
          emails_scanned: result.updates,
          asks_found: result.asks,
          inserted: result.added,
          skipped: result.skipped,
          insert_failed: result.failed,
          bodies_unreadable: result.unreadable,
          messages_listed: sources?.listed ?? null,
          metadata_read: sources?.metadataRead ?? null,
          updates_matched: sources?.matched ?? null,
          bodies_failed: sources?.bodiesFailed ?? null,
          body_fail_codes: sources?.bodyFailCodes ?? null,
          error: result.error ?? null,
          duration_ms: Date.now() - startedAt,
        },
      });
    } catch {
      // recordAudit logs its own failures; the read's result stands.
    } finally {
      refreshState.inFlight.delete(organizationId);
    }
    return result;
  })();
  refreshState.inFlight.set(organizationId, run);
  return run;
}

/** How long a view may wait on a demo read it started, which comes from memory. */
const DEMO_VIEW_WAIT_MS = 1_500;

/** What a view did about the read. */
export type AsksViewStart =
  /** A read was handed to `schedule`, to start once the response is sent. */
  | 'scheduled'
  /** A demo read was started and waited on briefly. */
  | 'waited'
  /** A read (the daily job's, or another view's) is already running. */
  | 'running'
  /** Read too recently: every 30 minutes per organization, 5 after a failure. */
  | 'throttled';

/**
 * What a view of Portfolio > Requests does about the read: start one at most
 * every 30 minutes per organization (5 after a failure), never while one
 * runs. A Gmail read is handed to `schedule` (the page passes `after`), so it
 * starts once the response is sent and the page never waits on it; the next
 * view shows what it found. A demo read comes from memory, so the view starts
 * it and waits up to 1.5 s, handing whatever is left to `schedule`. Every
 * read started here records its own audit row (`trigger: 'view'`). Never
 * throws.
 */
export async function refreshPortfolioAsksOnView(
  store: DataStore,
  organizationId: string,
  options: {
    schedule: (task: () => Promise<unknown>) => void;
    now?: Date;
    read?: AskSourceReader;
  },
): Promise<AsksViewStart> {
  if (refreshState.inFlight.has(organizationId)) return 'running';
  const at = options.now ?? new Date();
  const now = at.getTime();
  if ((refreshState.retryAt.get(organizationId) ?? 0) > now) return 'throttled';
  const last = refreshState.viewedAt.get(organizationId);
  if (last !== undefined && now - last < VIEW_THROTTLE_MS) return 'throttled';
  refreshState.viewedAt.set(organizationId, now);
  const start = () =>
    refreshPortfolioAsks(store, organizationId, {
      read: options.read,
      now: options.now ? () => at : undefined,
      trigger: 'view',
    });

  if (options.read || !isDemoMode()) {
    try {
      options.schedule(start);
    } catch (error) {
      // No request to attach it to: start it now rather than not at all.
      log.warn('Portfolio asks read could not be scheduled', {
        reason: (error as Error)?.message,
      });
      void start();
    }
    return 'scheduled';
  }
  const run = start();
  if (!(await settlesWithin(run, DEMO_VIEW_WAIT_MS))) {
    try {
      options.schedule(() => run);
    } catch {
      // The read carries on by itself.
    }
  }
  return 'waited';
}
