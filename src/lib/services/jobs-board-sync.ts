import 'server-only';
import { env, type AppEnv } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { demoAtsFetch } from '@/lib/demo/jobs-board-fixtures';
import {
  atsApiUrl,
  detectAtsFromUrl,
  detectAtsInHtml,
  isValidAtsToken,
  parseAtsJobs,
  parseCareersUrl,
  type AtsBoard,
  type AtsPosting,
} from '@/lib/jobs-board/ats';
import { guessFunction, guessSeniority } from '@/lib/jobs-board/fields';
import { robotsAllows, robotsCrawlDelaySeconds, SYNC_USER_AGENT } from '@/lib/jobs-board/robots';
import { roleSlug } from '@/lib/jobs-board/slug';
import { normalizeJobTitle } from '@/lib/portfolio/job-taxonomy';
import { companyForRole, type JobRole } from '@/lib/portfolio/jobs';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type { JobCompany, JobPosting, PortfolioCompany } from '@/lib/types/domain';
import { newId, shortHash } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { readJobsBoard, revalidatePublicBoard } from './jobs-board';

/**
 * Filling the public job board from two places, never publishing anything a
 * person has not allowed:
 *
 *   1. Companies' own public job boards (Greenhouse, Lever, Ashby, Workable,
 *      Recruitee). For each company a person gave a careers page and left
 *      the sync on, the board's public job list is read (the daily job, and
 *      "Refresh now"): new roles are added, changed ones updated, and roles
 *      the board no longer lists are closed. New roles go public on their own
 *      only when a person turned that company's auto-publish on; a role a
 *      person hid stays hidden.
 *   2. Roles founders emailed Nick (the jobs scan's JOBS_V1 snapshot), at
 *      portfolio companies only, as unpublished drafts that wait for a person
 *      to approve each one. Only the role's title, team, place, level and job
 *      link are copied: never the people to send candidates to, the
 *      founder's notes, pay from an email, or the source emails. A role the
 *      company already lists on its own board is not imported twice.
 *
 * Being a good guest: one host at a time per company group, at least half a
 * second apart (more when robots.txt asks for a crawl delay), robots.txt
 * read and obeyed for every host, an 8 second timeout per call, a size cap
 * on every answer, a pause on a host that says "too many requests", and one
 * company's failure never touches another's. Demo mode never calls out: it
 * reads fictional fixtures.
 */

const CALL_TIMEOUT_MS = 8_000;
const PAGE_TIMEOUT_MS = 6_000;
const ROBOTS_TIMEOUT_MS = 4_000;
const MAX_API_CHARS = 6_000_000;
const MAX_PAGE_CHARS = 1_500_000;
const ROBOTS_TTL_MS = 24 * 60 * 60_000;
const MIN_HOST_GAP_MS = 500;
const MAX_HOST_GAP_MS = 10_000;
/** "Refresh now" reads one company at most this often. */
const MANUAL_MIN_INTERVAL_MS = 60_000;
const CONCURRENT_HOSTS = 3;
const MAX_BACKOFF_MS = 60 * 60_000;
/** The view-time email import runs at most this often per organization. */
const IMPORT_ON_VIEW_MS = 5 * 60_000;

interface RobotsEntry {
  at: number;
  text: string | null;
}

const state = processWide('jobs-board-sync', () => ({
  robots: new Map<string, RobotsEntry>(),
  lastCall: new Map<string, number>(),
  backoffUntil: new Map<string, number>(),
  running: new Map<string, Promise<SyncSummary>>(),
  importedAt: new Map<string, number>(),
}));

/** Test hook. */
export function resetJobsBoardSyncState(): void {
  state.robots.clear();
  state.lastCall.clear();
  state.backoffUntil.clear();
  state.running.clear();
  state.importedAt.clear();
}

export interface SyncOptions {
  fetchImpl?: typeof fetch;
  e?: AppEnv;
  now?: Date;
  /** Only these portfolio companies. */
  companyIds?: readonly string[];
  trigger?: 'daily' | 'manual';
  /** Waits between calls to one host; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** A host name's addresses, for the careers-page check; tests pass a fake. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  userId?: string | null;
}

export interface CompanySyncResult {
  portfolioCompanyId: string;
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  message: string;
  added: number;
  updated: number;
  closed: number;
  total: number;
}

export interface SyncSummary {
  state: 'ok' | 'not_configured';
  companies: number;
  ok: number;
  failed: number;
  skipped: number;
  added: number;
  closed: number;
  results: CompanySyncResult[];
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Hosts a careers page may be fetched from: a public name with a dot, never
 * an address literal, localhost or an internal name. The board APIs are
 * fixed hosts; this guards the careers-page check, whose address a person
 * typed.
 */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.')) return false;
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return false;
  return !/(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example)$/.test(
    host,
  );
}

type Fetched =
  | {
      kind: 'ok';
      status: number;
      text: string;
      finalUrl: string;
      retryAfter: number | null;
      location: string | null;
    }
  | { kind: 'robots_blocked' }
  | { kind: 'robots_unreachable' }
  | { kind: 'backoff' }
  | { kind: 'too_large' }
  | { kind: 'network' };

async function readCapped(response: Response, max: number): Promise<string | null> {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > max * 2) return null;
  const text = await response.text();
  return text.length > max ? null : text;
}

async function robotsFor(
  origin: string,
  fetchImpl: typeof fetch,
  now: number,
): Promise<RobotsEntry | 'unreachable'> {
  const cached = state.robots.get(origin);
  if (cached && now - cached.at < ROBOTS_TTL_MS) return cached;
  try {
    const response = await fetchImpl(`${origin}/robots.txt`, {
      headers: { 'User-Agent': SYNC_USER_AGENT, Accept: 'text/plain' },
      cache: 'no-store',
      // Never followed: a redirect could lead anywhere. It reads as no file.
      redirect: 'manual',
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
    });
    let entry: RobotsEntry;
    if (response.status >= 200 && response.status < 300) {
      entry = { at: now, text: (await readCapped(response, 500_000)) ?? '' };
    } else if (response.status >= 300 && response.status < 500) {
      // No robots.txt (or none for the public): everything is allowed.
      entry = { at: now, text: null };
    } else {
      return 'unreachable';
    }
    state.robots.set(origin, entry);
    return entry;
  } catch {
    return 'unreachable';
  }
}

/**
 * One polite GET: robots.txt first, the host's pause respected, a timeout
 * and a size cap, our own user agent. Never throws.
 */
async function politeGet(
  url: string,
  options: {
    fetchImpl: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    timeoutMs: number;
    maxChars: number;
    accept: string;
    /** 'manual' hands a redirect back (with its Location) instead of following it. */
    redirect?: 'follow' | 'manual';
  },
): Promise<Fetched> {
  const target = new URL(url);
  const host = target.host.toLowerCase();
  const now = Date.now();
  if ((state.backoffUntil.get(host) ?? 0) > now) return { kind: 'backoff' };

  const robots = await robotsFor(target.origin, options.fetchImpl, now);
  if (robots === 'unreachable') return { kind: 'robots_unreachable' };
  if (!robotsAllows(robots.text, `${target.pathname}${target.search}`))
    return { kind: 'robots_blocked' };

  const gap = Math.min(
    MAX_HOST_GAP_MS,
    Math.max(MIN_HOST_GAP_MS, robotsCrawlDelaySeconds(robots.text) * 1000),
  );
  const last = state.lastCall.get(host);
  if (last !== undefined) {
    const due = last + gap - Date.now();
    if (due > 0) await options.sleep(due);
  }
  state.lastCall.set(host, Date.now());

  try {
    const response = await options.fetchImpl(target.toString(), {
      headers: { 'User-Agent': SYNC_USER_AGENT, Accept: options.accept },
      cache: 'no-store',
      redirect: options.redirect ?? 'follow',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const retryHeader = response.headers.get('retry-after');
    const retryAfter = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : null;
    if (response.status === 429) {
      state.backoffUntil.set(
        host,
        Date.now() + Math.min(MAX_BACKOFF_MS, (retryAfter ?? 600) * 1000),
      );
    }
    const text = response.status === 200 ? await readCapped(response, options.maxChars) : '';
    if (text === null) return { kind: 'too_large' };
    return {
      kind: 'ok',
      status: response.status,
      text,
      finalUrl: response.url || target.toString(),
      retryAfter,
      location: response.headers.get('location'),
    };
  } catch {
    return { kind: 'network' };
  }
}

function fetchFor(options: SyncOptions): typeof fetch {
  const e = options.e ?? env();
  return e.demoMode ? demoAtsFetch : (options.fetchImpl ?? fetch);
}

/** Most redirects the careers-page check follows, each one checked. */
const MAX_PAGE_HOPS = 3;

/**
 * Whether an address is private, loopback, link-local or otherwise not on the
 * public internet (so never fetched from a careers address a person typed).
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.replace(/^::ffff:/i, ''));
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
}

async function lookupAddresses(hostname: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  const found = await lookup(hostname, { all: true });
  return found.map((a) => a.address);
}

/** A careers host may be fetched: a public name whose every address is public. */
async function hostIsPublic(hostname: string, options: SyncOptions): Promise<boolean> {
  if (!isPublicHostname(hostname)) return false;
  // Demo mode never calls out (its fetch is the fixtures), so no lookup either.
  if ((options.e ?? env()).demoMode) return true;
  try {
    const addresses = await (options.resolveHost ?? lookupAddresses)(hostname);
    return addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a));
  } catch {
    return false;
  }
}

/**
 * The job board behind a company's own careers page: a redirect that lands
 * on a board's address (a careers link often goes to jobs.lever.co), else the
 * boards the page's markup embeds or links to. Every hop is checked before it
 * is fetched (a public host name whose addresses are all public, robots.txt)
 * and redirects are followed by hand, at most three. Null when the page names
 * no board, or cannot be read.
 */
export async function detectCareersBoard(
  careersUrl: string,
  options: SyncOptions = {},
): Promise<AtsBoard | null> {
  let url = parseCareersUrl(careersUrl);
  for (let hop = 0; url && hop <= MAX_PAGE_HOPS; hop++) {
    const direct = detectAtsFromUrl(url.toString());
    if (direct) return direct;
    if (!(await hostIsPublic(url.hostname, options))) return null;
    const page = await politeGet(url.toString(), {
      fetchImpl: fetchFor(options),
      sleep: options.sleep ?? wait,
      timeoutMs: PAGE_TIMEOUT_MS,
      maxChars: MAX_PAGE_CHARS,
      accept: 'text/html,application/xhtml+xml',
      redirect: 'manual',
    });
    if (page.kind !== 'ok') return null;
    if (page.status >= 300 && page.status < 400) {
      if (!page.location) return null;
      try {
        url = parseCareersUrl(new URL(page.location, url).toString());
      } catch {
        return null;
      }
      continue;
    }
    if (page.status !== 200) return null;
    return detectAtsInHtml(page.text);
  }
  return null;
}

/* ------------------------------------------------------------ the sync -- */

function sourceKey(board: AtsBoard, posting: AtsPosting): string {
  return `${board.ats}:${board.token.toLowerCase()}:${posting.externalId}`.slice(0, 200);
}

function sameTitle(a: string, b: string): boolean {
  return normalizeJobTitle(a) === normalizeJobTitle(b);
}

/**
 * A board's current list -> the company's rows: new roles added (public on
 * their own only under auto-publish), listed ones refreshed and reopened,
 * the ones no longer listed closed. A role a person hid is never published
 * here; one a person approved stays approved. An emailed draft of the same
 * role is closed as covered, and an emailed role a person had approved hands
 * its approval to the board's copy.
 */
async function applyBoardPostings(
  store: DataStore,
  organizationId: string,
  company: JobCompany,
  board: AtsBoard,
  postings: readonly AtsPosting[],
  now: string,
): Promise<{ added: number; updated: number; closed: number }> {
  const rows = await store.list('job_postings', organizationId, {
    eq: { portfolio_company_id: company.portfolio_company_id },
  });
  const boardRows = new Map(rows.filter((r) => r.source === 'ats').map((r) => [r.source_key, r]));
  const emailed = rows.filter((r) => r.source === 'email' && r.status === 'active');
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;
  let closed = 0;

  for (const p of postings) {
    const key = sourceKey(board, p);
    if (seen.has(key)) continue;
    seen.add(key);
    const fields = {
      title: p.title,
      team: p.team,
      job_function: guessFunction(p.title, p.team),
      locations: p.locations,
      remote: p.remote,
      employment_type: p.employmentType,
      seniority: guessSeniority(p.title),
      comp: p.comp,
      description: p.description || null,
      apply_url: p.applyUrl,
      posted_at: p.postedAt,
      source_updated_at: p.updatedAt,
      status: 'active' as const,
      closed_at: null,
      last_seen_at: now,
    };
    const existing = boardRows.get(key);
    if (existing) {
      // Hidden stays hidden; a person's own approval stands; otherwise the
      // company's auto-publish switch decides.
      const published = existing.hidden_at
        ? false
        : existing.approved_at
          ? existing.published
          : company.auto_publish;
      await store.update('job_postings', organizationId, existing.id, {
        ...fields,
        published,
        updated_at: now,
      });
      updated++;
      continue;
    }

    // The same role from the founders' emails: this copy replaces it.
    const twin = emailed.find((r) => sameTitle(r.title, p.title));
    const approvedTwin = twin?.published && twin.approved_at ? twin : null;
    const row: JobPosting = {
      id: newId(),
      organization_id: organizationId,
      portfolio_company_id: company.portfolio_company_id,
      source: 'ats',
      source_key: key,
      slug: roleSlug(p.title, shortHash(key, 6)),
      ...fields,
      published: Boolean(approvedTwin) || company.auto_publish,
      featured: Boolean(approvedTwin?.featured),
      approved_by: approvedTwin?.approved_by ?? null,
      approved_at: approvedTwin?.approved_at ?? null,
      hidden_by: null,
      hidden_at: null,
      first_seen_at: now,
      created_at: now,
      updated_at: now,
    };
    await store.insert('job_postings', row);
    added++;
    if (twin) {
      await store.update('job_postings', organizationId, twin.id, {
        status: 'closed',
        published: false,
        featured: false,
        closed_at: now,
        updated_at: now,
      });
      emailed.splice(emailed.indexOf(twin), 1);
    }
  }

  // Every open board role this list no longer has: closed (from this board
  // or from one the company's careers page used to point at).
  for (const row of boardRows.values()) {
    if (seen.has(row.source_key) || row.status !== 'active') continue;
    await store.update('job_postings', organizationId, row.id, {
      status: 'closed',
      closed_at: now,
      updated_at: now,
    });
    closed++;
  }
  return { added, updated, closed };
}

function result(
  company: JobCompany,
  portfolio: PortfolioCompany,
  status: CompanySyncResult['status'],
  message: string,
  counts: Partial<Pick<CompanySyncResult, 'added' | 'updated' | 'closed' | 'total'>> = {},
): CompanySyncResult {
  return {
    portfolioCompanyId: company.portfolio_company_id,
    name: portfolio.name,
    status,
    message,
    added: counts.added ?? 0,
    updated: counts.updated ?? 0,
    closed: counts.closed ?? 0,
    total: counts.total ?? 0,
  };
}

/** Read one company's board and apply it. Never throws; the outcome is saved on the company. */
export async function syncCompanyBoard(
  store: DataStore,
  organizationId: string,
  company: JobCompany,
  portfolio: PortfolioCompany,
  options: SyncOptions = {},
): Promise<CompanySyncResult> {
  const now = (options.now ?? new Date()).toISOString();
  let outcome: CompanySyncResult;
  if (!company.ats || !isValidAtsToken(company.ats, company.ats_token)) {
    outcome = result(company, portfolio, 'skipped', 'No supported job board on the careers page.');
  } else {
    const board: AtsBoard = { ats: company.ats, token: company.ats_token };
    try {
      outcome = await readAndApply(store, organizationId, company, portfolio, board, now, options);
    } catch (error) {
      log.warn('Job board sync failed for one company', {
        ats: company.ats,
        reason: (error as Error)?.message?.slice(0, 120),
      });
      outcome = result(
        company,
        portfolio,
        'failed',
        'Something went wrong saving the roles; the next run tries again.',
      );
    }
  }
  try {
    await store.update('job_companies', organizationId, company.id, {
      last_sync_at: now,
      last_sync_status: outcome.status,
      last_sync_message: outcome.message.slice(0, 300),
      last_sync_count: outcome.status === 'ok' ? outcome.total : company.last_sync_count,
      updated_at: now,
    });
  } catch {
    // The outcome still reaches the caller.
  }
  return outcome;
}

async function readAndApply(
  store: DataStore,
  organizationId: string,
  company: JobCompany,
  portfolio: PortfolioCompany,
  board: AtsBoard,
  now: string,
  options: SyncOptions,
): Promise<CompanySyncResult> {
  const answer = await politeGet(atsApiUrl(board), {
    fetchImpl: fetchFor(options),
    sleep: options.sleep ?? wait,
    timeoutMs: CALL_TIMEOUT_MS,
    maxChars: MAX_API_CHARS,
    accept: 'application/json',
  });
  const fail = (message: string) => result(company, portfolio, 'failed', message);
  const skip = (message: string) => result(company, portfolio, 'skipped', message);
  switch (answer.kind) {
    case 'robots_blocked':
      return fail("The job board's robots.txt asks not to be read, so it is left alone.");
    case 'robots_unreachable':
      return skip("The job board's robots.txt did not answer; the next run tries again.");
    case 'backoff':
      return skip('The job board asked for a pause; the next run tries again.');
    case 'too_large':
      return fail('The job board sent more than Copilot reads at once.');
    case 'network':
      return fail('The job board did not answer in time; the next run tries again.');
  }
  if (answer.status === 404) {
    return fail('The job board was not found. Check the careers page address.');
  }
  if (answer.status === 429)
    return skip('The job board asked for a pause; the next run tries again.');
  if (answer.status !== 200)
    return fail(`The job board answered ${answer.status}; the next run tries again.`);
  const finalHost = (() => {
    try {
      return new URL(answer.finalUrl).hostname;
    } catch {
      return '';
    }
  })();
  if (finalHost && finalHost !== new URL(atsApiUrl(board)).hostname) {
    return fail('The job board sent Copilot somewhere else, so nothing was read.');
  }
  let body: unknown;
  try {
    body = JSON.parse(answer.text);
  } catch {
    return fail('The job board sent an answer Copilot cannot read.');
  }
  const parsed = parseAtsJobs(board.ats, body);
  if (!parsed) return fail('The job board sent an answer Copilot cannot read.');
  const counts = await applyBoardPostings(
    store,
    organizationId,
    company,
    board,
    parsed.postings,
    now,
  );
  const total = parsed.postings.length;
  const parts = [`${total} open ${total === 1 ? 'role' : 'roles'}`];
  if (counts.added) parts.push(`${counts.added} new`);
  if (counts.closed) parts.push(`${counts.closed} closed`);
  if (parsed.skipped) parts.push(`${parsed.skipped} unreadable left out`);
  return result(company, portfolio, 'ok', parts.join(', '), { ...counts, total });
}

async function runLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await work(next);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Read every company's board that has the sync on (or just `companyIds`).
 * Companies on one board host run one after another, a few hosts at once.
 * Never throws. One run per organization at a time: a second caller shares
 * the first run.
 */
export function syncJobBoards(
  store: DataStore,
  organizationId: string,
  options: SyncOptions = {},
): Promise<SyncSummary> {
  const key = `${organizationId}|${(options.companyIds ?? []).join(',')}`;
  const running = state.running.get(key);
  if (running) return running;
  const run = runSync(store, organizationId, options).finally(() => state.running.delete(key));
  state.running.set(key, run);
  return run;
}

async function runSync(
  store: DataStore,
  organizationId: string,
  options: SyncOptions,
): Promise<SyncSummary> {
  const summary: SyncSummary = {
    state: 'ok',
    companies: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    added: 0,
    closed: 0,
    results: [],
  };
  const data = await readJobsBoard(store, organizationId);
  if (!data.available) return { ...summary, state: 'not_configured' };
  const portfolioById = new Map(data.portfolio.map((p) => [p.id, p]));
  const now = options.now ?? new Date();
  const wanted = options.companyIds ? new Set(options.companyIds) : null;
  const companies = data.companies.filter(
    (c) =>
      c.sync_enabled &&
      c.ats &&
      portfolioById.has(c.portfolio_company_id) &&
      (!wanted || wanted.has(c.portfolio_company_id)),
  );

  const groups = new Map<string, JobCompany[]>();
  for (const company of companies) {
    const host =
      company.ats && company.ats_token && isValidAtsToken(company.ats, company.ats_token)
        ? new URL(atsApiUrl({ ats: company.ats, token: company.ats_token })).host
        : 'none';
    groups.set(host, [...(groups.get(host) ?? []), company]);
  }

  await runLimited([...groups.values()], CONCURRENT_HOSTS, async (group) => {
    for (const company of group) {
      const portfolio = portfolioById.get(company.portfolio_company_id)!;
      const last = company.last_sync_at ? Date.parse(company.last_sync_at) : 0;
      if (options.trigger === 'manual' && now.getTime() - last < MANUAL_MIN_INTERVAL_MS) {
        summary.results.push(
          result(
            company,
            portfolio,
            'skipped',
            'Read less than a minute ago; showing that result.',
            {
              total: company.last_sync_count ?? 0,
            },
          ),
        );
        continue;
      }
      summary.results.push(
        await syncCompanyBoard(store, organizationId, company, portfolio, options),
      );
    }
  });

  for (const r of summary.results) {
    summary.companies++;
    summary[r.status]++;
    summary.added += r.added;
    summary.closed += r.closed;
  }
  if (summary.results.length > 0) {
    await recordAudit(store, {
      organizationId,
      userId: options.userId ?? null,
      action: 'jobs.synced',
      entityType: 'job_board',
      entityId: null,
      metadata: {
        trigger: options.trigger ?? 'daily',
        companies: summary.companies,
        ok: summary.ok,
        failed: summary.failed,
        skipped: summary.skipped,
        added: summary.added,
        closed: summary.closed,
      },
    });
  }
  if (summary.added || summary.closed || summary.ok) revalidatePublicBoard();
  return summary;
}

/** Counts only, for the daily job's response (it lands in a public Actions log). */
export function formatJobsCronStatus(summary: SyncSummary, imported: EmailImport | null): string {
  if (summary.state === 'not_configured') return 'skipped: not_configured';
  const parts = [
    `ok: ${summary.ok} of ${summary.companies} boards`,
    `${summary.added} new`,
    `${summary.closed} closed`,
  ];
  if (summary.failed) parts.push(`${summary.failed} failed`);
  if (imported) parts.push(`${imported.added} emailed drafts`);
  return parts.join(', ');
}

/* ------------------------------------------------------- emailed roles -- */

export interface EmailImport {
  added: number;
  closed: number;
  /** Roles at a portfolio company the company already lists on its own board. */
  covered: number;
  /** Roles not at a portfolio company, or not open. */
  skipped: number;
}

/**
 * The jobs scan's roles -> drafts on the board, unpublished, for a person to
 * approve. Portfolio companies only. A role already imported is never
 * re-created or edited (a person may have edited it); one the founder now
 * calls filled or closed is closed. Null when the board's tables are not
 * there.
 */
export async function importEmailedRoles(
  store: DataStore,
  organizationId: string,
  roles: readonly JobRole[],
  options: { now?: Date } = {},
): Promise<EmailImport | null> {
  const data = await readJobsBoard(store, organizationId);
  if (!data.available) return null;
  const now = (options.now ?? new Date()).toISOString();
  const out: EmailImport = { added: 0, closed: 0, covered: 0, skipped: 0 };
  const postings = [...data.postings];

  for (const role of roles) {
    const company = companyForRole(role, data.portfolio);
    if (!company) {
      out.skipped++;
      continue;
    }
    const open = role.status === 'active';
    const existing = postings.find((p) => p.source === 'email' && p.source_key === role.id);
    if (existing) {
      if (!open && existing.status === 'active') {
        await store.update('job_postings', organizationId, existing.id, {
          status: 'closed',
          closed_at: now,
          last_seen_at: now,
          updated_at: now,
        });
        out.closed++;
      }
      continue;
    }
    if (!open) {
      out.skipped++;
      continue;
    }
    const covered = postings.some(
      (p) =>
        p.portfolio_company_id === company.id &&
        p.source !== 'email' &&
        p.status === 'active' &&
        sameTitle(p.title, role.title),
    );
    if (covered) {
      out.covered++;
      continue;
    }
    const posted = Date.parse(role.first_seen);
    const row: JobPosting = {
      id: newId(),
      organization_id: organizationId,
      portfolio_company_id: company.id,
      source: 'email',
      source_key: role.id,
      slug: roleSlug(role.title, shortHash(`email:${role.id}`, 6)),
      title: role.title,
      team: null,
      job_function: role.function,
      locations: role.location ? [role.location] : [],
      remote: role.remote,
      employment_type: null,
      seniority: guessSeniority(role.title, role.seniority),
      // Never pay from an email, never the founder's words: a person adds them.
      comp: null,
      description: null,
      apply_url: role.link,
      posted_at: Number.isNaN(posted) ? now : new Date(posted).toISOString(),
      source_updated_at: null,
      status: 'active',
      published: false,
      featured: false,
      approved_by: null,
      approved_at: null,
      hidden_by: null,
      hidden_at: null,
      first_seen_at: now,
      last_seen_at: now,
      closed_at: null,
      created_at: now,
      updated_at: now,
    };
    await store.insert('job_postings', row);
    postings.push(row);
    out.added++;
  }
  return out;
}

/**
 * importEmailedRoles from the Jobs tab, at most every five minutes per
 * organization (the snapshot changes weekly). Never throws.
 */
export async function importEmailedRolesOnView(
  store: DataStore,
  organizationId: string,
  roles: readonly JobRole[],
  now: Date = new Date(),
): Promise<EmailImport | null> {
  const last = state.importedAt.get(organizationId) ?? 0;
  if (now.getTime() - last < IMPORT_ON_VIEW_MS) return null;
  state.importedAt.set(organizationId, now.getTime());
  try {
    return await importEmailedRoles(store, organizationId, roles, { now });
  } catch (error) {
    log.warn('Importing emailed roles failed', {
      reason: (error as Error)?.message?.slice(0, 120),
    });
    return null;
  }
}
