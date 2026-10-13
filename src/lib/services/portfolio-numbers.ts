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
import {
  buildCompanyNumbers,
  extractMetrics,
  type CompanyNumbers,
  type UpdateReport,
} from '@/lib/company-updates/metrics';
import { isDemoMode } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { listMessageIds, readThreadFull } from '@/lib/google/gmail-inbox';
import type { Integration } from '@/lib/types/domain';
import { normalizeCompanyName } from '@/lib/util/text';
import { processWide } from '@/lib/util/process-state';
import { ownAddresses, readMetas } from './company-updates';
import { getPrimaryIntegration } from './inbox';

/**
 * Numbers each portfolio company reported in its own update emails over the
 * last year: ARR or MRR, cash, runway, raising status and YoY growth. Read
 * live from Gmail (read scope) and parsed by rules, never by a model, so
 * every figure is a sentence the company wrote. Message bodies are kept in
 * memory by message id; the list for 30 minutes.
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
const MAX_TEXT = 20_000;

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

/** The text of one message, from memory or from its thread. */
async function bodyOf(
  store: DataStore,
  integration: Integration,
  messageId: string,
  threadId: string,
): Promise<string | null> {
  const hit = cache.bodies.get(messageId);
  if (hit !== undefined) return hit;
  const thread = await readThreadFull(store, integration, threadId).catch(() => null);
  if (!thread?.ok) return null;
  for (const m of thread.value.messages) {
    if (cache.bodies.size >= BODY_CACHE_MAX) {
      const oldest = cache.bodies.keys().next().value;
      if (oldest !== undefined) cache.bodies.delete(oldest);
    }
    cache.bodies.set(m.id, m.text.slice(0, MAX_TEXT));
  }
  return cache.bodies.get(messageId) ?? null;
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
): Promise<CompanyRead> {
  const q = companySearchQuery(company);
  if (!q) return { numbers: null, complete: true };
  if (Date.now() > deadline) return { numbers: null, complete: false };
  const ids = await listMessageIds(store, integration, q, MAX_IDS_PER_COMPANY).catch(() => null);
  if (!ids?.ok) return { numbers: null, complete: false };
  const metas = await readMetas(store, integration, ids.value, deadline);
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
    const body = await bodyOf(store, integration, m.id, m.threadId);
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

/** Company-reported numbers for each portfolio company, cached for 30 minutes; never throws. */
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
    const key = companies
      .map((c) => `${c.id}:${c.name}:${c.domain ?? ''}`)
      .sort()
      .join('|');
    const cached = cache.lists.get(organizationId);
    if (!options.force && cached && cached.key === key && now.getTime() - cached.at < cached.ttl) {
      return cached.result;
    }

    const integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
    if (!integration || integration.status === 'disconnected') return empty('not_connected');
    const own = ownAddresses(integration);
    const deadline = Date.now() + DEADLINE_MS;
    const reads = await mapLimit(companies, COMPANY_CONCURRENCY, (c) =>
      readCompany(store, integration, c, companies, own, deadline).catch((): CompanyRead => ({
        numbers: null,
        complete: false,
      })),
    );
    const failedAll = companies.length > 0 && reads.every((r) => !r.complete && !r.numbers);
    if (failedAll) return cached?.result ?? empty('error');

    const partial = reads.some((r) => !r.complete);
    const result: PortfolioNumbersResult = {
      state: 'ok',
      companies: reads
        .map((r) => r.numbers)
        .filter((n): n is CompanyNumbers => n !== null)
        .sort((a, b) => a.name.localeCompare(b.name)),
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
