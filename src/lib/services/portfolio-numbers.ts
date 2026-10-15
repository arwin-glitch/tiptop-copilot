import 'server-only';
import {
  classifyUpdateSubject,
  isAutomatedSender,
  isOwnOrStaff,
  matchPortfolio,
  nameInSubject,
  parseSender,
  STAFF_DOMAINS,
  type CandidateMessage,
  type CompanyLike,
} from '@/lib/company-updates/classify';
import { looksLikeHtml, withoutQuotedReply } from '@/lib/company-updates/asks';
import {
  buildCompanyNumbers,
  extractMetrics,
  type CompanyNumbers,
  type UpdateReport,
} from '@/lib/company-updates/metrics';
import { z } from 'zod';
import { isDemoMode } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { gmailFailCode, type GmailFailCode, type GmailReadOptions } from '@/lib/google/gmail-get';
import { listMessageIds, readThreadFull, type FullThread } from '@/lib/google/gmail-inbox';
import { log } from '@/lib/security/redact';
import type { AuditEvent, Integration } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import type { Result } from '@/lib/util/result';
import { headAndTail, htmlToPlainText, normalizeCompanyName } from '@/lib/util/text';
import { processWide } from '@/lib/util/process-state';
import { settlesWithin } from '@/lib/util/settle';
import { ownAddresses, readMetas } from './company-updates';
import { getPrimaryIntegration } from './inbox';

/**
 * Numbers each portfolio company reported in its own update emails over the
 * last year: ARR or MRR, cash, runway, raising status and YoY growth. Read
 * live from Gmail (read scope) and parsed by rules, never by a model, so
 * every figure is a sentence the company wrote. Message bodies are kept in
 * memory by message id. The page shows the last read from the database and a
 * background refresh replaces it; see "stored" below.
 */

const LOOKBACK = '365d';
const MAX_IDS_PER_COMPANY = 60;
const MAX_BODIES_PER_COMPANY = 12;
const LIST_TTL_MS = 30 * 60_000;
const PARTIAL_TTL_MS = 60_000;
const DEADLINE_MS = 20_000;
const COMPANY_CONCURRENCY = 4;
const BODY_CONCURRENCY = 4;
const BODY_CACHE_MAX = 4_000;
/** A message's text is kept to this many characters: its start, and its last TAIL_TEXT. */
const MAX_TEXT = 20_000;
/** An update's asks come last, so the end of a long one is kept too (`headAndTail`). */
const TAIL_TEXT = 6_000;

export type PortfolioNumbersState = 'ok' | 'not_connected' | 'error';

export interface PortfolioNumbersResult {
  state: PortfolioNumbersState;
  companies: CompanyNumbers[];
  /** Companies whose mail was searched. */
  checked: number;
  /** The time budget ran out before every company was read. */
  partial: boolean;
  checkedAt: string;
}

const cache = processWide('portfolio-numbers', () => ({
  /** Plain-text body by message id. A sent message never changes. */
  bodies: new Map<string, string>(),
  lists: new Map<
    string,
    { at: number; ttl: number; key: string; result: PortfolioNumbersResult }
  >(),
}));

/** Test hook. */
export function resetPortfolioNumbersCache(): void {
  cache.bodies.clear();
  cache.lists.clear();
}

function searchable(text: string): string {
  return text
    .replace(/["(){}:\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The Gmail search for one company's mail in the last year; the classifier decides after. */
export function companySearchQuery(company: CompanyLike): string | null {
  const name = searchable(company.name);
  if (name.length < 2) return null;
  const key = normalizeCompanyName(company.name);
  const compact = key.replace(/\s+/g, '');
  const terms = [`subject:"${name}"`];
  if (key && key !== name.toLowerCase()) terms.push(`subject:"${key}"`);
  const domain = (company.domain ?? company.website ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
  if (domain && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) terms.push(`from:${domain}`);
  if (compact.length >= 4 && /^[a-z0-9]+$/.test(compact)) terms.push(`from:${compact}`);
  const skip = STAFF_DOMAINS.map((d) => `-from:${d}`).join(' ');
  return `newer_than:${LOOKBACK} -in:sent -in:chats ${skip} (${terms.join(' OR ')})`;
}

/** Is this message an update from this company: an update subject, and it is about this company and no other. */
export function screenForCompany(
  message: CandidateMessage,
  company: CompanyLike,
  companies: readonly CompanyLike[],
  own: readonly string[],
): boolean {
  const sender = parseSender(message.from);
  if (!sender || isOwnOrStaff(sender.address, own) || isAutomatedSender(sender)) return false;
  if (message.labelIds.some((l) => l === 'SPAM' || l === 'TRASH' || l === 'DRAFT')) return false;
  const verdict = classifyUpdateSubject(message.subject);
  if (!verdict) return false;
  const match = matchPortfolio(sender, message.subject, companies);
  if (!match || match.company.id !== company.id) return false;
  // A subject-only match is weak: the name must lead the subject, and a list
  // mail that names the company is never its own update, whatever the kind.
  if (match.by === 'subject') {
    if (message.bulk || nameInSubject(message.subject, company.name) !== 'lead') return false;
  }
  return true;
}

/** One message's text, or why it could not be read, as a safe code (`gmailFailCode`). */
export type UpdateBodyRead = { ok: true; text: string } | { ok: false; code: GmailFailCode };

/**
 * A message's text as it is kept. Within MAX_TEXT it is left exactly as it
 * is. A longer one is cut to the sender's own words first (the quoted
 * history under a reply, by the asks reader's rules, read as text when it is
 * HTML), so the end kept is the company's latest update and not an older one
 * it quotes; then, still too long, its start and its last TAIL_TEXT
 * (`headAndTail`).
 */
export function keptText(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  return headAndTail(
    withoutQuotedReply(looksLikeHtml(text) ? htmlToPlainText(text) : text),
    MAX_TEXT,
    TAIL_TEXT,
  );
}

/**
 * The text of one message, from memory or from its thread, or why it could
 * not be read. Shared with the asks read (`portfolio-asks.ts`), so an
 * update's body is fetched once for both. Every message of the thread is
 * kept (`keptText`). `options.retry` is for background reads only.
 */
export async function readUpdateBodyWithReason(
  store: DataStore,
  integration: Integration,
  messageId: string,
  threadId: string,
  options: GmailReadOptions = {},
): Promise<UpdateBodyRead> {
  const hit = cache.bodies.get(messageId);
  if (hit !== undefined) return { ok: true, text: hit };
  let thread: Result<FullThread>;
  try {
    thread = await readThreadFull(store, integration, threadId, options);
  } catch {
    return { ok: false, code: 'provider_unavailable' };
  }
  if (!thread.ok) return { ok: false, code: gmailFailCode(thread.error) };
  for (const m of thread.value.messages) {
    if (cache.bodies.size >= BODY_CACHE_MAX) {
      const oldest = cache.bodies.keys().next().value;
      if (oldest !== undefined) cache.bodies.delete(oldest);
    }
    cache.bodies.set(m.id, keptText(m.text));
  }
  const text = cache.bodies.get(messageId);
  // The thread was read but the message is not in it (deleted, or a draft).
  return text === undefined ? { ok: false, code: 'not_found' } : { ok: true, text };
}

/** The text of one message, or null when it could not be read (`readUpdateBodyWithReason`). */
export async function readUpdateBody(
  store: DataStore,
  integration: Integration,
  messageId: string,
  threadId: string,
  options: GmailReadOptions = {},
): Promise<string | null> {
  const read = await readUpdateBodyWithReason(store, integration, messageId, threadId, options);
  return read.ok ? read.text : null;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

interface CompanyRead {
  numbers: CompanyNumbers | null;
  complete: boolean;
}

async function readCompany(
  store: DataStore,
  integration: Integration,
  company: CompanyLike,
  companies: readonly CompanyLike[],
  own: readonly string[],
  deadline: number,
  gmail: GmailReadOptions,
): Promise<CompanyRead> {
  const q = companySearchQuery(company);
  if (!q) return { numbers: null, complete: true };
  if (Date.now() > deadline) return { numbers: null, complete: false };
  const ids = await listMessageIds(store, integration, q, MAX_IDS_PER_COMPANY, gmail).catch(
    () => null,
  );
  if (!ids?.ok) return { numbers: null, complete: false };
  const metas = await readMetas(store, integration, ids.value, deadline, gmail);
  const seenThreads = new Set<string>();
  const updates = metas
    .filter((m) => m.date && screenForCompany(m, company, companies, own))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .filter((m) => {
      if (seenThreads.has(m.threadId)) return false;
      seenThreads.add(m.threadId);
      return true;
    })
    .slice(0, MAX_BODIES_PER_COMPANY);
  let complete = metas.length === ids.value.length;
  const reports = await mapLimit(updates, BODY_CONCURRENCY, async (m) => {
    if (!cache.bodies.has(m.id) && Date.now() > deadline) {
      complete = false;
      return null;
    }
    const body = await readUpdateBody(store, integration, m.id, m.threadId, gmail);
    if (body === null) {
      complete = false;
      return null;
    }
    const report: UpdateReport = {
      messageId: m.id,
      threadId: m.threadId,
      subject: m.subject,
      date: m.date!,
      metrics: extractMetrics(`${m.subject}\n\n${body}`, { company: company.name }),
    };
    return report;
  });
  const found = reports.filter((r): r is UpdateReport => r !== null);
  return { numbers: buildCompanyNumbers(company, found), complete };
}

/* -------------------------------------------------------------- demo */

/** Fictional update emails for demo mode, parsed by the real extractor. */
const DEMO_UPDATES: Record<string, { daysAgo: number; subject: string; body: string }[]> = {
  ledgerly: [
    {
      daysAgo: 186,
      subject: 'Ledgerly April update',
      body: 'ARR ended April at $520K. Cash is $2.9M, which gives us 20 months of runway.',
    },
    {
      daysAgo: 125,
      subject: 'Ledgerly June update',
      body: 'ARR: $610K, up from $520K in April. We added 11 accounting firms.',
    },
    {
      daysAgo: 64,
      subject: 'Ledgerly August update',
      body: 'ARR is now $700K, +96% YoY. Cash is $2.4M.',
    },
    {
      daysAgo: 1,
      subject: 'Ledgerly October update: $780K ARR, Series A prep',
      body: [
        'Hi all,',
        'ARR reached $780K, up from $700K in August, and NRR is 121%.',
        'Cash is $2.1M and we have 14 months of runway.',
        'We are preparing to launch our Series A in about eight weeks.',
      ].join('\n'),
    },
  ],
  'stonebridge ops': [
    {
      daysAgo: 100,
      subject: "Stonebridge Ops Q2'26 investor update",
      body: 'We finished Q2 at $182K ARR. We have $1.4M in the bank.',
    },
    {
      daysAgo: 12,
      subject: "Stonebridge Ops Q3'26 investor update",
      body: '$215K ARR, up 18% on the quarter. Runway extends into March 2028.',
    },
  ],
};

function demoNumbers(companies: readonly CompanyLike[], now: Date): CompanyNumbers[] {
  const out: CompanyNumbers[] = [];
  for (const company of companies) {
    const mails = DEMO_UPDATES[normalizeCompanyName(company.name)];
    if (!mails) continue;
    const reports = mails.map((m, i): UpdateReport => {
      const id = `de5ad${company.id.replace(/[^0-9a-f]/gi, '').slice(0, 6)}${i}`.padEnd(16, '0');
      return {
        messageId: id,
        threadId: id,
        subject: m.subject,
        date: new Date(now.getTime() - m.daysAgo * 86_400_000).toISOString(),
        metrics: extractMetrics(`${m.subject}\n\n${m.body}`, { company: company.name }),
      };
    });
    const numbers = buildCompanyNumbers(company, reports);
    if (numbers) out.push(numbers);
  }
  return out;
}

/* --------------------------------------------------------------- read */

function companiesKey(companies: readonly CompanyLike[]): string {
  return companies
    .map((c) => `${c.id}:${c.name}:${c.domain ?? ''}`)
    .sort()
    .join('|');
}

const byName = (a: CompanyNumbers, b: CompanyNumbers) => a.name.localeCompare(b.name);

/** One company's read: its numbers, and whether every mail it needed was read in time. */
export interface CompanyReadResult {
  companyId: string;
  numbers: CompanyNumbers | null;
  complete: boolean;
}

export interface NumbersComputation {
  state: PortfolioNumbersState;
  reads: CompanyReadResult[];
}

/**
 * Read every company's update mail within the time budget; never throws. A
 * `background` read (the stored numbers' refresh, which nobody waits on)
 * tries a rate-limited or failing Gmail read again within the deadline,
 * paced with the mailbox's other background reads; a read a page waits on
 * (the live read, and the first read with nothing stored) fails fast.
 */
async function computeReads(
  store: DataStore,
  organizationId: string,
  companies: readonly CompanyLike[],
  now: Date,
  deadlineMs: number,
  options: { background?: boolean } = {},
): Promise<NumbersComputation> {
  try {
    if (isDemoMode()) {
      const numbers = demoNumbers(companies, now);
      return {
        state: 'ok',
        reads: companies.map((c) => ({
          companyId: c.id,
          numbers: numbers.find((n) => n.companyId === c.id) ?? null,
          complete: true,
        })),
      };
    }
    const integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
    if (!integration || integration.status === 'disconnected') {
      return { state: 'not_connected', reads: [] };
    }
    const own = ownAddresses(integration);
    const deadline = Date.now() + deadlineMs;
    const gmail: GmailReadOptions = options.background ? { retry: { deadline } } : {};
    const reads = await mapLimit(companies, COMPANY_CONCURRENCY, async (c) => {
      const read = await readCompany(store, integration, c, companies, own, deadline, gmail).catch(
        (): CompanyRead => ({ numbers: null, complete: false }),
      );
      return { companyId: c.id, ...read };
    });
    const failedAll = companies.length > 0 && reads.every((r) => !r.complete && !r.numbers);
    return { state: failedAll ? 'error' : 'ok', reads };
  } catch {
    return { state: 'error', reads: [] };
  }
}

/** Company-reported numbers read live from Gmail, cached in memory for 30 minutes; never throws. */
export async function readPortfolioNumbers(
  store: DataStore,
  organizationId: string,
  companies: readonly CompanyLike[],
  options: { now?: Date; force?: boolean } = {},
): Promise<PortfolioNumbersResult> {
  const now = options.now ?? new Date();
  const checkedAt = now.toISOString();
  const empty = (state: PortfolioNumbersState): PortfolioNumbersResult => ({
    state,
    companies: [],
    checked: 0,
    partial: false,
    checkedAt,
  });
  try {
    if (isDemoMode()) {
      return {
        state: 'ok',
        companies: demoNumbers(companies, now),
        checked: companies.length,
        partial: false,
        checkedAt,
      };
    }
    const key = companiesKey(companies);
    const cached = cache.lists.get(organizationId);
    if (!options.force && cached && cached.key === key && now.getTime() - cached.at < cached.ttl) {
      return cached.result;
    }

    const computed = await computeReads(store, organizationId, companies, now, DEADLINE_MS);
    if (computed.state === 'not_connected') return empty('not_connected');
    if (computed.state === 'error') return cached?.result ?? empty('error');

    const partial = computed.reads.some((r) => !r.complete);
    const result: PortfolioNumbersResult = {
      state: 'ok',
      companies: computed.reads
        .map((r) => r.numbers)
        .filter((n): n is CompanyNumbers => n !== null)
        .sort(byName),
      checked: companies.length,
      partial,
      checkedAt,
    };
    cache.lists.set(organizationId, {
      at: now.getTime(),
      ttl: partial ? PARTIAL_TTL_MS : LIST_TTL_MS,
      key,
      result,
    });
    return result;
  } catch {
    return cache.lists.get(organizationId)?.result ?? empty('error');
  }
}

/* ------------------------------------------------------------- stored */

/**
 * The numbers are kept in the database so the Portfolio page shows them at
 * once, right after a restart or deploy too, and a background refresh (on a
 * view of stale numbers, and from the scheduled job) replaces them. One
 * audit_events row per organization holds the latest snapshot, the way the
 * push-alert ledger keeps its state: no table of its own, so no migration.
 */
export const NUMBERS_SNAPSHOT_ACTION = 'portfolio.numbers_snapshot';

/**
 * Bump whenever a rule in company-updates/metrics.ts changes what a figure
 * would be, above all when a fix stops a wrong number: a snapshot stored under
 * older rules is then never shown, and the page reads afresh instead.
 */
export const NUMBERS_RULES_VERSION = 1;

/** Stored numbers older than this are still shown, and refreshed in the background. */
const STORED_FRESH_MS = 30 * 60_000;
/** A snapshot that ran out of time before reading every company is refreshed sooner. */
const STORED_PARTIAL_FRESH_MS = 2 * 60_000;
/** Nobody waits on a background refresh, so it may read for longer than a page view could. */
const REFRESH_DEADLINE_MS = 120_000;
/** After a refresh that could not read Gmail, views wait this long before starting another. */
const REFRESH_RETRY_MS = 5 * 60_000;
/** With nothing stored yet, the page waits this long for the first read. */
const FIRST_READ_BUDGET_MS = DEADLINE_MS;

const sourced = <T extends z.ZodType>(value: T) =>
  z.object({ value, asOf: z.string(), messageId: z.string(), threadId: z.string() });
const COMPANY_NUMBERS = z.object({
  companyId: z.string(),
  name: z.string(),
  revenue: sourced(
    z.object({
      amount: z.number(),
      display: z.string(),
      kind: z.enum(['ARR', 'MRR']),
      evidence: z.string(),
    }),
  ).nullable(),
  growth: sourced(z.object({ label: z.string(), evidence: z.string() })).nullable(),
  cash: sourced(
    z.object({ amount: z.number(), display: z.string(), evidence: z.string() }),
  ).nullable(),
  runway: sourced(
    z.object({ label: z.string(), months: z.number().nullable(), evidence: z.string() }),
  ).nullable(),
  raising: sourced(z.object({ label: z.string(), evidence: z.string() })).nullable(),
  history: z.array(z.object({ date: z.string(), amount: z.number() })),
  updatesRead: z.number(),
  latestUpdateAt: z.string().nullable(),
});
const SNAPSHOT = z.object({
  rules: z.number(),
  /** The company list it was read for; a change means a refresh. */
  key: z.string(),
  checked: z.number(),
  partial: z.boolean(),
  checkedAt: z.string(),
  companies: z.array(COMPANY_NUMBERS),
});

export interface NumbersSnapshot {
  rules: number;
  key: string;
  checked: number;
  partial: boolean;
  checkedAt: string;
  companies: CompanyNumbers[];
}

/** The stored snapshot for this organization, or null when there is none it may show. */
export async function readNumbersSnapshot(
  store: DataStore,
  organizationId: string,
): Promise<NumbersSnapshot | null> {
  const rows = (await store.list(
    'audit_events',
    organizationId,
    { eq: { action: NUMBERS_SNAPSHOT_ACTION } },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
  )) as AuditEvent[];
  const parsed = SNAPSHOT.safeParse(rows[0]?.metadata);
  if (!parsed.success || parsed.data.rules !== NUMBERS_RULES_VERSION) return null;
  const companies: CompanyNumbers[] = parsed.data.companies;
  return { ...parsed.data, companies };
}

/** Store a snapshot as the only one for this organization. */
async function writeNumbersSnapshot(
  store: DataStore,
  organizationId: string,
  snapshot: NumbersSnapshot,
): Promise<void> {
  const id = newId();
  const row: AuditEvent = {
    id,
    organization_id: organizationId,
    user_id: null,
    action: NUMBERS_SNAPSHOT_ACTION,
    entity_type: 'portfolio',
    entity_id: 'numbers',
    // Written directly, not through recordAudit: these are the companies' own
    // sentences and must come back exactly as they were read.
    metadata: { ...snapshot },
    ip_hash: null,
    created_at: snapshot.checkedAt,
  };
  await store.insert('audit_events', row);
  await store.removeWhere('audit_events', organizationId, {
    eq: { action: NUMBERS_SNAPSHOT_ACTION },
    neq: { id },
  });
}

/**
 * The next snapshot from a fresh read. A company read in full takes its new
 * numbers, none included. A company the read ran out of time on keeps what was
 * stored for it before rather than figures from part of its mail; with nothing
 * stored it takes the partial read, as a live read would. Companies no longer
 * in the portfolio drop out.
 */
export function mergeSnapshot(
  previous: NumbersSnapshot | null,
  computed: NumbersComputation,
  companies: readonly CompanyLike[],
  now: Date,
): NumbersSnapshot {
  const before = new Map((previous?.companies ?? []).map((c) => [c.companyId, c]));
  const reads = new Map(computed.reads.map((r) => [r.companyId, r]));
  const out: CompanyNumbers[] = [];
  let partial = false;
  for (const company of companies) {
    const read = reads.get(company.id);
    if (!read?.complete) partial = true;
    const numbers = read?.complete
      ? read.numbers
      : (before.get(company.id) ?? read?.numbers ?? null);
    if (numbers) out.push({ ...numbers, name: company.name });
  }
  return {
    rules: NUMBERS_RULES_VERSION,
    key: companiesKey(companies),
    checked: companies.length,
    partial,
    checkedAt: now.toISOString(),
    companies: out.sort(byName),
  };
}

export interface NumbersRefresh {
  state: PortfolioNumbersState;
  snapshot: NumbersSnapshot | null;
  /**
   * The next pass, when this one ran out of time and is being carried on in
   * the background; null when the refresh is done. See `refreshSettled`.
   */
  next: Promise<NumbersRefresh> | null;
}

export type NumbersReader = (
  store: DataStore,
  organizationId: string,
  companies: readonly CompanyLike[],
  now: Date,
) => Promise<NumbersComputation>;

const gmailReader: NumbersReader = (store, organizationId, companies, now) =>
  computeReads(store, organizationId, companies, now, REFRESH_DEADLINE_MS, { background: true });

/**
 * The first read, the one the page waits on while nothing is stored: like a
 * page's own read it fails fast instead of waiting out Gmail's rate limit, so
 * the page shows what it could read within its budget. What it missed leaves
 * the snapshot partial, and the passes after it read the rest with
 * `gmailReader`.
 */
const gmailFirstReader: NumbersReader = (store, organizationId, companies, now) =>
  computeReads(store, organizationId, companies, now, REFRESH_DEADLINE_MS);

/**
 * A pass that runs out of time is followed by another, so a partial read
 * finishes on its own instead of waiting for the next page view or the daily
 * job. Each pass reads less than the one before (bodies and headers are kept
 * in memory), and each one is stored as it ends. It stops once every company
 * is read, after this many passes, or when a pass reads no company in full
 * that no earlier pass had, so it cannot spin.
 */
const MAX_PASSES = 6;
/** Between passes, to give Gmail's quota a moment to refill. */
const PASS_PAUSE_MS = 15_000;

const refreshState = processWide('portfolio-numbers-refresh', () => ({
  /** The pass running now (or about to, after its pause), by organization. */
  inFlight: new Map<string, Promise<NumbersRefresh>>(),
  retryAt: new Map<string, number>(),
}));

/** Test hook. */
export function resetPortfolioNumbersRefresh(): void {
  refreshState.inFlight.clear();
  refreshState.retryAt.clear();
}

export interface RefreshOptions {
  now?: () => Date;
  read?: NumbersReader;
  /**
   * The first pass's reader, when it is not `read`: the page's first read
   * fails fast (`gmailFirstReader`), and the passes after it read in the
   * background.
   */
  firstRead?: NumbersReader;
  /** Test hooks: how many passes at most, and the pause between them. */
  maxPasses?: number;
  pauseMs?: number;
}

/**
 * Read every company's mail afresh and store the result. One refresh per
 * organization at a time: a second call while one runs gets the pass that is
 * running. When Gmail cannot be read the stored snapshot is left as it was.
 * The promise settles when this pass ends; a partial pass starts the next one
 * in the background (`next`). Never throws.
 */
export function refreshPortfolioNumbers(
  store: DataStore,
  organizationId: string,
  companies: readonly CompanyLike[],
  options: RefreshOptions = {},
): Promise<NumbersRefresh> {
  const running = refreshState.inFlight.get(organizationId);
  if (running) return running;
  return startPass(store, organizationId, companies, options, 1, new Set(), 0);
}

function startPass(
  store: DataStore,
  organizationId: string,
  companies: readonly CompanyLike[],
  options: RefreshOptions,
  pass: number,
  /** Companies some earlier pass of this refresh read in full. */
  readInFull: ReadonlySet<string>,
  pauseMs: number,
): Promise<NumbersRefresh> {
  const clock = options.now ?? (() => new Date());
  const read = (pass === 1 ? options.firstRead : undefined) ?? options.read ?? gmailReader;
  const maxPasses = options.maxPasses ?? MAX_PASSES;
  const run = (async (): Promise<NumbersRefresh> => {
    let previous: NumbersSnapshot | null = null;
    try {
      if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
      previous = await readNumbersSnapshot(store, organizationId).catch(() => null);
      const computed = await read(store, organizationId, companies, clock());
      if (computed.state !== 'ok') {
        refreshState.retryAt.set(organizationId, clock().getTime() + REFRESH_RETRY_MS);
        return { state: computed.state, snapshot: previous, next: null };
      }
      const done = new Set(readInFull);
      for (const r of computed.reads) if (r.complete) done.add(r.companyId);
      const progressed = pass === 1 || done.size > readInFull.size;
      const snapshot = mergeSnapshot(previous, computed, companies, clock());
      await writeNumbersSnapshot(store, organizationId, snapshot);
      refreshState.retryAt.delete(organizationId);
      const carryOn = snapshot.partial && pass < maxPasses && progressed;
      // Registered before this pass settles, so nobody sees a gap between passes.
      const next = carryOn
        ? startPass(
            store,
            organizationId,
            companies,
            options,
            pass + 1,
            done,
            options.pauseMs ?? PASS_PAUSE_MS,
          )
        : null;
      if (snapshot.partial) {
        log.info('Portfolio numbers pass ended partial', {
          pass,
          readInFull: done.size,
          companies: companies.length,
          carryOn,
        });
      }
      return { state: 'ok', snapshot, next };
    } catch (error) {
      log.warn('Portfolio numbers refresh failed', { reason: (error as Error)?.message });
      refreshState.retryAt.set(organizationId, clock().getTime() + REFRESH_RETRY_MS);
      return { state: 'error', snapshot: previous, next: null };
    }
  })();
  refreshState.inFlight.set(organizationId, run);
  // Runs before anyone awaiting `run` resumes. A pass that started the next
  // one has already handed it the slot, so this leaves it alone.
  void run.then(() => {
    if (refreshState.inFlight.get(organizationId) === run) {
      refreshState.inFlight.delete(organizationId);
    }
  });
  return run;
}

/** The last pass of a refresh: follows `next` until the refresh is done. Never throws. */
export async function refreshSettled(first: Promise<NumbersRefresh>): Promise<NumbersRefresh> {
  let outcome = await first;
  while (outcome.next) outcome = await outcome.next;
  return outcome;
}

/** Whether stored numbers should be read again: old, partial, or read for another company list. */
export function snapshotIsStale(
  snapshot: NumbersSnapshot,
  companies: readonly CompanyLike[],
  now: Date,
): boolean {
  const age = now.getTime() - Date.parse(snapshot.checkedAt);
  if (!Number.isFinite(age)) return true;
  if (snapshot.key !== companiesKey(companies)) return true;
  return age >= (snapshot.partial ? STORED_PARTIAL_FRESH_MS : STORED_FRESH_MS);
}

/** What the page shows for a snapshot: only current companies, under their current names. */
export function snapshotView(
  snapshot: NumbersSnapshot,
  companies: readonly CompanyLike[],
): PortfolioNumbersResult {
  const names = new Map(companies.map((c) => [c.id, c.name]));
  return {
    state: 'ok',
    companies: snapshot.companies
      .filter((c) => names.has(c.companyId))
      .map((c) => ({ ...c, name: names.get(c.companyId)! }))
      .sort(byName),
    checked: snapshot.checked,
    partial: snapshot.partial,
    checkedAt: snapshot.checkedAt,
  };
}

export interface StoredNumbers {
  /**
   * What to show: stored numbers (`ok`), `pending` while the very first read
   * is still going, or why there is nothing (Gmail not connected, or failing).
   */
  result: PortfolioNumbersResult | { state: 'pending' };
  /** A refresh is running, so the numbers shown may change on the next view. */
  refreshing: boolean;
  /** That refresh, for the caller to keep alive past the response. */
  pending: Promise<NumbersRefresh> | null;
}

/**
 * The Portfolio page's numbers, from the database. Stored numbers come back at
 * once, with a background refresh started when they are stale. With nothing
 * stored yet, the first read is waited on for up to the old live-read budget,
 * and fails fast as a page's read does (`gmailFirstReader`). Never throws.
 */
export async function loadPortfolioNumbers(
  store: DataStore,
  organizationId: string,
  companies: readonly CompanyLike[],
  options: {
    now?: Date;
    read?: NumbersReader;
    budgetMs?: number;
    maxPasses?: number;
    pauseMs?: number;
  } = {},
): Promise<StoredNumbers> {
  const now = options.now ?? new Date();
  const start = (firstRead?: NumbersReader) =>
    refreshPortfolioNumbers(store, organizationId, companies, {
      read: options.read,
      firstRead: options.read ?? firstRead,
      now: options.now ? () => now : undefined,
      maxPasses: options.maxPasses,
      pauseMs: options.pauseMs,
    });
  const stored = await readNumbersSnapshot(store, organizationId).catch(() => null);

  if (stored) {
    const coolingDown = (refreshState.retryAt.get(organizationId) ?? 0) > now.getTime();
    const running = refreshState.inFlight.get(organizationId) ?? null;
    const pending =
      running ?? (snapshotIsStale(stored, companies, now) && !coolingDown ? start() : null);
    return { result: snapshotView(stored, companies), refreshing: pending !== null, pending };
  }

  const run = start(gmailFirstReader);
  if (await settlesWithin(run, options.budgetMs ?? FIRST_READ_BUDGET_MS)) {
    const done = await run;
    const result: PortfolioNumbersResult = done.snapshot
      ? snapshotView(done.snapshot, companies)
      : {
          state: done.state === 'ok' ? 'error' : done.state,
          companies: [],
          checked: 0,
          partial: false,
          checkedAt: now.toISOString(),
        };
    // A first read that ran out of time carries on in the background.
    return { result, refreshing: done.next !== null, pending: done.next };
  }
  return { result: { state: 'pending' }, refreshing: true, pending: run };
}
