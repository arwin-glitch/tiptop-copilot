import { strictDomain, websiteHref } from '@/lib/deals/links';
import {
  normalizeJobFunction,
  normalizeJobTitle,
  type JobFunction,
  type JobRemote,
} from '@/lib/portfolio/job-taxonomy';
import type {
  JobBoardSettings,
  JobCompany,
  JobEmploymentType,
  JobPosting,
  JobSeniority,
  PortfolioCompany,
} from '@/lib/types/domain';
import { isEmploymentType, isSeniority } from './fields';

/**
 * What the public board shows, and the one rule for whether a role may be on
 * it. Pure and client-safe: the service reads the rows and hands them here;
 * the public pages, Kraken's preview and the tests all go through
 * `postingPublicState`, so there is exactly one gate.
 *
 * Only the fields named in PublicJob and PublicCompany ever leave the server
 * for a public page. A role's source email, the people to send candidates
 * to, the founder's notes, who approved it, and every other column stay in
 * Kraken.
 */

export const DEFAULT_BOARD_TITLE = 'Jobs at TipTop portfolio companies';
export const DEFAULT_BOARD_ACCENT = '#0FC382';
export const ACCENT = /^#[0-9A-Fa-f]{6}$/;

export interface PublicCompany {
  slug: string;
  name: string;
  /** `https://<domain>`, only a plain hostname. */
  website: string | null;
  domain: string | null;
  /** The careers page a person gave the company (http/https only). */
  careersUrl: string | null;
  logoUrl: string | null;
  /**
   * Only what a person typed as the company's public "about". Never Kraken's
   * own portfolio description or sector: those are internal notes nobody
   * chose to publish.
   */
  about: string | null;
  openRoles: number;
}

export interface PublicJob {
  /** `<company slug>/<role slug>`: unique on the board. */
  key: string;
  slug: string;
  companySlug: string;
  companyName: string;
  title: string;
  team: string | null;
  fn: JobFunction;
  locations: string[];
  remote: JobRemote | null;
  employmentType: JobEmploymentType | null;
  seniority: JobSeniority | null;
  comp: string | null;
  applyUrl: string;
  postedAt: string | null;
  /**
   * When a role nobody re-checks stops counting as open: emailed and
   * hand-added roles, 60 days after a person or a founder's email last
   * confirmed them. Null for roles read from a company's own job board,
   * which close themselves when the board drops them.
   */
  validThrough: string | null;
  featured: boolean;
  /** Structured text; left out of lists, which never show it. */
  description: string | null;
}

export interface PublicBoard {
  title: string;
  intro: string | null;
  accent: string;
  /** Companies with open public roles, plus any a person listed. */
  companies: PublicCompany[];
  /** Featured first, then newest. */
  jobs: PublicJob[];
}

/** Whether a role may be public, and when not, why (for Kraken's preview). */
export type PublicState =
  | 'public'
  | 'closed'
  | 'hidden'
  | 'needs_approval'
  | 'not_published'
  | 'auto_publish_off'
  | 'stale'
  | 'no_apply_link'
  | 'company_gone';

export const PUBLIC_STATE_LABELS: Record<PublicState, string> = {
  public: 'Public',
  closed: 'Closed',
  hidden: 'Hidden',
  needs_approval: 'Waiting for approval',
  not_published: 'Not public',
  auto_publish_off: 'Not public: auto-publish is off',
  stale: 'Not public: still open? Re-confirm it',
  no_apply_link: 'Not public: no apply link',
  company_gone: 'Not public: company archived',
};

/**
 * How long an emailed or hand-added role stays public after a person (or a
 * founder's email) last confirmed it. Nothing closes these roles on its own,
 * and a board showing filled roles is the quickest way to lose trust (Google
 * also asks for expired postings to come down).
 */
export const UNCONFIRMED_ROLE_DAYS = 60;
const DAY_MS = 86_400_000;

/** When an emailed or hand-added role was last confirmed: approved, or mentioned again. */
export function lastConfirmedAt(
  posting: Pick<JobPosting, 'approved_at' | 'last_seen_at'>,
): number | null {
  const times = [posting.approved_at, posting.last_seen_at]
    .map((t) => (t ? Date.parse(t) : Number.NaN))
    .filter((t) => Number.isFinite(t));
  return times.length > 0 ? Math.max(...times) : null;
}

/** The end of a role's public life (see UNCONFIRMED_ROLE_DAYS); null for board roles. */
export function validThroughOf(
  posting: Pick<JobPosting, 'source' | 'approved_at' | 'last_seen_at'>,
): string | null {
  if (posting.source === 'ats') return null;
  const confirmed = lastConfirmedAt(posting);
  return confirmed === null
    ? null
    : new Date(confirmed + UNCONFIRMED_ROLE_DAYS * DAY_MS).toISOString();
}

/** The apply link a role offers: its own, else its company's careers page. */
export function applyLinkFor(
  posting: Pick<JobPosting, 'apply_url'>,
  company: Pick<JobCompany, 'careers_url'> | null,
): string | null {
  return httpLink(posting.apply_url) ?? httpLink(company?.careers_url ?? null);
}

function httpLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The gate. A role is public only when all of these hold (the board itself
 * being on is checked once, by the caller):
 *   - its portfolio company exists and is not archived;
 *   - it is active (a board sync or the founder's word has not closed it);
 *   - no person hid it;
 *   - it is published, and
 *       - an emailed or hand-added role was approved by a person, and
 *       - a board-synced role a person never approved individually is public
 *         only while its company's auto-publish switch is on;
 *   - an emailed or hand-added role was confirmed (approved, or mentioned
 *     again by the founder) within UNCONFIRMED_ROLE_DAYS;
 *   - it has somewhere to apply.
 */
export function postingPublicState(
  posting: Pick<
    JobPosting,
    'status' | 'hidden_at' | 'published' | 'source' | 'approved_at' | 'apply_url' | 'last_seen_at'
  >,
  company: Pick<JobCompany, 'auto_publish' | 'careers_url'> | null,
  portfolio: Pick<PortfolioCompany, 'is_archived'> | null,
  now: Date = new Date(),
): PublicState {
  if (!portfolio || portfolio.is_archived) return 'company_gone';
  if (posting.status !== 'active') return 'closed';
  if (posting.hidden_at) return 'hidden';
  if (posting.source !== 'ats' && !posting.approved_at) return 'needs_approval';
  if (!posting.published) return 'not_published';
  if (posting.source === 'ats' && !posting.approved_at && !company?.auto_publish) {
    return 'auto_publish_off';
  }
  if (posting.source !== 'ats') {
    const until = validThroughOf(posting);
    if (until && Date.parse(until) <= now.getTime()) return 'stale';
  }
  if (!applyLinkFor(posting, company)) return 'no_apply_link';
  return 'public';
}

export interface BoardRows {
  settings: Pick<JobBoardSettings, 'title' | 'intro' | 'accent'> | null;
  portfolio: readonly PortfolioCompany[];
  jobCompanies: readonly JobCompany[];
  postings: readonly JobPosting[];
}

/**
 * Rows -> the public board: only roles that pass the gate, only the public
 * fields, and one role per company and title (a role a company lists on its
 * own board wins over the same role from an email). Descriptions only when
 * asked for (a role's own page), so lists stay small.
 */
export function buildPublicBoard(
  rows: BoardRows,
  options: { descriptions?: boolean; now?: Date } = {},
): PublicBoard {
  const now = options.now ?? new Date();
  const portfolioById = new Map(rows.portfolio.map((p) => [p.id, p]));
  const companyByPortfolio = new Map(rows.jobCompanies.map((c) => [c.portfolio_company_id, c]));

  const chosen = new Map<string, { posting: JobPosting; company: JobCompany }>();
  for (const posting of rows.postings) {
    const portfolio = portfolioById.get(posting.portfolio_company_id) ?? null;
    const company = companyByPortfolio.get(posting.portfolio_company_id) ?? null;
    if (!company) continue;
    if (postingPublicState(posting, company, portfolio, now) !== 'public') continue;
    const key = `${posting.portfolio_company_id}|${normalizeJobTitle(posting.title)}`;
    const seen = chosen.get(key);
    if (!seen || rank(posting) > rank(seen.posting)) chosen.set(key, { posting, company });
  }

  const jobs: PublicJob[] = [...chosen.values()].map(({ posting, company }) => {
    const portfolio = portfolioById.get(posting.portfolio_company_id)!;
    return {
      key: `${company.slug}/${posting.slug}`,
      slug: posting.slug,
      companySlug: company.slug,
      companyName: portfolio.name,
      title: posting.title,
      team: posting.team,
      fn: normalizeJobFunction(posting.job_function),
      ...placesAndRemote(posting.locations, posting.remote),
      employmentType: isEmploymentType(posting.employment_type) ? posting.employment_type : null,
      seniority: isSeniority(posting.seniority) ? posting.seniority : null,
      comp: posting.comp,
      applyUrl: applyLinkFor(posting, company)!,
      // An emailed role's own date is the founder's first mention, which can
      // be months old: the board dates it from the approval instead.
      postedAt:
        posting.source === 'email'
          ? (posting.approved_at ?? posting.first_seen_at)
          : (posting.posted_at ?? posting.approved_at ?? posting.first_seen_at),
      validThrough: validThroughOf(posting),
      featured: posting.featured,
      description: options.descriptions ? posting.description : null,
    };
  });
  jobs.sort(compareJobs);

  const counts = new Map<string, number>();
  for (const job of jobs) counts.set(job.companySlug, (counts.get(job.companySlug) ?? 0) + 1);

  const companies: PublicCompany[] = [];
  for (const company of rows.jobCompanies) {
    const portfolio = portfolioById.get(company.portfolio_company_id);
    if (!portfolio || portfolio.is_archived) continue;
    const openRoles = counts.get(company.slug) ?? 0;
    if (openRoles === 0 && !company.listed) continue;
    const domain = strictDomain(portfolio.website ?? portfolio.domain);
    companies.push({
      slug: company.slug,
      name: portfolio.name,
      website: websiteHref(portfolio.website ?? portfolio.domain),
      domain,
      careersUrl: httpLink(company.careers_url),
      logoUrl: company.logo_url && /^https:\/\//i.test(company.logo_url) ? company.logo_url : null,
      about: company.about?.trim() || null,
      openRoles,
    });
  }
  companies.sort((a, b) => b.openRoles - a.openRoles || a.name.localeCompare(b.name));

  const accent =
    rows.settings?.accent && ACCENT.test(rows.settings.accent)
      ? rows.settings.accent
      : DEFAULT_BOARD_ACCENT;
  return {
    title: rows.settings?.title?.trim() || DEFAULT_BOARD_TITLE,
    intro: rows.settings?.intro?.trim() || null,
    accent,
    companies,
    jobs,
  };
}

const SETUP_SUFFIX = /\s*[([]\s*(hybrid|remote|on-?site|in[- ]office)\s*[)\]]\s*$/i;
const SETUP_OF: Record<string, JobRemote> = {
  hybrid: 'hybrid',
  remote: 'remote',
  onsite: 'onsite',
  'on-site': 'onsite',
  'in-office': 'onsite',
  'in office': 'onsite',
};

/**
 * A role's places as the board lists them: a trailing "(Hybrid)" or
 * "(Remote)" moves into the work setup when that is empty, spaces are
 * tidied, and the same place twice is kept once. So "Chicago, IL (Hybrid)"
 * and "Chicago, IL" are one location filter, not two.
 */
export function placesAndRemote(
  locations: readonly string[],
  remote: JobRemote | null,
): { locations: string[]; remote: JobRemote | null } {
  let setup = remote;
  const out: string[] = [];
  for (const raw of locations) {
    let place = raw.replace(/\s+/g, ' ').trim();
    const suffix = SETUP_SUFFIX.exec(place);
    if (suffix) {
      setup ??= SETUP_OF[suffix[1]!.toLowerCase()] ?? null;
      place = place.slice(0, suffix.index).trim();
    }
    if (!place || out.some((p) => p.toLowerCase() === place.toLowerCase())) continue;
    out.push(place);
    if (out.length >= 10) break;
  }
  return { locations: out, remote: setup };
}

/** Which of two copies of one role the board shows: the company's own board, then the newest. */
function rank(p: JobPosting): number {
  const source = p.source === 'ats' ? 2 : p.source === 'manual' ? 1 : 0;
  return source * 1e13 + Date.parse(p.posted_at ?? p.first_seen_at);
}

export function compareJobs(a: PublicJob, b: PublicJob): number {
  if (a.featured !== b.featured) return a.featured ? -1 : 1;
  const at = a.postedAt ? Date.parse(a.postedAt) : 0;
  const bt = b.postedAt ? Date.parse(b.postedAt) : 0;
  return bt - at || a.companyName.localeCompare(b.companyName) || a.title.localeCompare(b.title);
}

/* ------------------------------------------------------------- filters -- */

export interface BoardFilters {
  q: string;
  company: string | null;
  fn: JobFunction | null;
  remote: JobRemote | null;
  seniority: JobSeniority | null;
  type: JobEmploymentType | null;
  location: string | null;
}

export const EMPTY_FILTERS: BoardFilters = {
  q: '',
  company: null,
  fn: null,
  remote: null,
  seniority: null,
  type: null,
  location: null,
};

const FILTER_KEYS = ['q', 'company', 'fn', 'remote', 'seniority', 'type', 'location'] as const;

/** A board URL's query -> filters; anything unknown reads as no filter. */
export function parseBoardFilters(search: URLSearchParams | string): BoardFilters {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const get = (k: string) => params.get(k)?.trim().slice(0, 120) || null;
  const fn = get('fn');
  const remote = get('remote');
  const seniority = get('seniority');
  const type = get('type');
  return {
    // Kept as typed (a space mid-word is fine); the filter splits on spaces.
    q: (params.get('q') ?? '').slice(0, 120),
    company: get('company'),
    fn: fn && normalizeJobFunction(fn) === fn ? (fn as JobFunction) : null,
    remote: remote === 'remote' || remote === 'hybrid' || remote === 'onsite' ? remote : null,
    seniority: isSeniority(seniority) ? seniority : null,
    type: isEmploymentType(type) ? type : null,
    location: get('location'),
  };
}

/** Filters -> a query string ("" when none), for a shareable board URL. */
export function boardFiltersToSearch(filters: BoardFilters): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value && value.trim()) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function hasFilters(filters: BoardFilters): boolean {
  return FILTER_KEYS.some((k) => Boolean(filters[k]?.trim()));
}

function haystack(job: PublicJob): string {
  return [job.title, job.companyName, job.team, ...job.locations, job.comp]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** The roles a set of filters shows; `ignore` leaves one filter out (for its own counts). */
export function filterBoardJobs(
  jobs: readonly PublicJob[],
  filters: BoardFilters,
  ignore?: keyof BoardFilters,
): PublicJob[] {
  const words = filters.q.toLowerCase().split(/\s+/).filter(Boolean);
  const location = filters.location?.toLowerCase() ?? null;
  return jobs.filter((job) => {
    if (ignore !== 'company' && filters.company && job.companySlug !== filters.company)
      return false;
    if (ignore !== 'fn' && filters.fn && job.fn !== filters.fn) return false;
    if (ignore !== 'remote' && filters.remote && job.remote !== filters.remote) return false;
    if (ignore !== 'seniority' && filters.seniority && job.seniority !== filters.seniority)
      return false;
    if (ignore !== 'type' && filters.type && job.employmentType !== filters.type) return false;
    if (
      ignore !== 'location' &&
      location &&
      !job.locations.some((l) => l.toLowerCase() === location)
    ) {
      return false;
    }
    if (ignore !== 'q' && words.length > 0) {
      const hay = haystack(job);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

export interface Facet<T extends string = string> {
  value: T;
  label: string;
  count: number;
}

/** Each value of one field with how many roles (other filters applied) carry it. */
export function facetCounts<T extends string>(
  jobs: readonly PublicJob[],
  read: (job: PublicJob) => readonly (T | null)[],
  label: (value: T) => string,
  limit = 30,
): Facet<T>[] {
  const counts = new Map<string, { value: T; count: number }>();
  for (const job of jobs) {
    const seen = new Set<string>();
    for (const value of read(job)) {
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { value, count: 1 });
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || label(a.value).localeCompare(label(b.value)))
    .slice(0, limit)
    .map(({ value, count }) => ({ value, label: label(value), count }));
}

/** A role's page on the board. */
export function jobPath(base: string, job: Pick<PublicJob, 'companySlug' | 'slug'>): string {
  return `${base}/${job.companySlug}/${job.slug}`;
}

export function companyPath(base: string, slug: string): string {
  return `${base}/${slug}`;
}

/** The board's home: `/jobs` on Kraken, `/` on the board's own host. */
export function homePath(base: string): string {
  return base || '/';
}
