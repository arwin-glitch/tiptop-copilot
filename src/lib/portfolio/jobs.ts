import { z } from 'zod';
import { httpUrl, strictDomain } from '@/lib/deals/links';
import { normalizeCompanyName } from '@/lib/util/text';
import { single } from '@/lib/util/page-tabs';
import { DAY, GMAIL_ID, RELAY_ENVELOPE, clippedText, optionalText, text } from './relay-fields';

/**
 * Open roles at portfolio companies, from the jobs routine's `JOBS_V1`
 * snapshot in #deal-relay. Founders list their open roles in monthly investor
 * updates ("Hiring:" with a role, how far along it is, when they want someone)
 * and in "we're hiring, know anyone?" emails, and the same roles come back
 * month after month. A weekly cloud routine reads that mail and posts one
 * deduplicated list; the Portfolio page's Jobs tab reads it back.
 *
 * Pure: the post's shape, the dedupe key, the filters and the copy blurb. The
 * Slack read is `src/lib/services/portfolio-jobs.ts`. Every value is rendered
 * as plain text; the one link a post supplies (a role's job page) is used
 * only as plain http(s), and Gmail links are rebuilt from validated ids.
 */

export const JOBS_MARKER = 'JOBS_V1';
/** The routine runs weekly. */
export const JOBS_CADENCE_DAYS = 7;
/** A scan older than this is overdue: one weekly run missed, with a few days' grace. */
export const JOBS_STALE_AFTER_DAYS = 10;

export const JOB_STATUSES = ['active', 'probably_filled', 'filled', 'closed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  active: 'Active',
  probably_filled: 'Probably filled',
  filled: 'Filled',
  closed: 'Closed',
};

export const JOB_FUNCTIONS = [
  'engineering',
  'product',
  'design',
  'data',
  'sales',
  'marketing',
  'customer_success',
  'operations',
  'finance',
  'people',
  'legal',
  'leadership',
  'other',
] as const;
export type JobFunction = (typeof JOB_FUNCTIONS)[number];

export const JOB_FUNCTION_LABELS: Record<JobFunction, string> = {
  engineering: 'Engineering',
  product: 'Product',
  design: 'Design',
  data: 'Data & ML',
  sales: 'Sales',
  marketing: 'Marketing',
  customer_success: 'Customer success',
  operations: 'Operations',
  finance: 'Finance',
  people: 'People & recruiting',
  legal: 'Legal',
  leadership: 'Leadership',
  other: 'Other',
};

/** Words a routine might use for a function, mapped to the list above. */
const FUNCTION_ALIASES: Record<string, JobFunction> = {
  eng: 'engineering',
  engineer: 'engineering',
  software: 'engineering',
  devops: 'engineering',
  hardware: 'engineering',
  pm: 'product',
  ux: 'design',
  ml: 'data',
  ai: 'data',
  data_science: 'data',
  machine_learning: 'data',
  gtm: 'sales',
  business_development: 'sales',
  bd: 'sales',
  growth: 'marketing',
  cs: 'customer_success',
  support: 'customer_success',
  customer_support: 'customer_success',
  ops: 'operations',
  accounting: 'finance',
  hr: 'people',
  recruiting: 'people',
  talent: 'people',
  executive: 'leadership',
  exec: 'leadership',
  c_level: 'leadership',
};

export const JOB_REMOTE = ['remote', 'hybrid', 'onsite'] as const;
export type JobRemote = (typeof JOB_REMOTE)[number];
export const JOB_REMOTE_LABELS: Record<JobRemote, string> = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
};

/** Any casing or spacing of a function, its aliases, or anything else as "other". */
export function normalizeJobFunction(raw: unknown): JobFunction {
  if (typeof raw !== 'string') return 'other';
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if ((JOB_FUNCTIONS as readonly string[]).includes(key)) return key as JobFunction;
  return FUNCTION_ALIASES[key] ?? FUNCTION_ALIASES[key.split('_')[0] ?? ''] ?? 'other';
}

/** "Remote", "on-site", "In office", true/false -> one of JOB_REMOTE, or null when unsaid. */
export function normalizeJobRemote(raw: unknown): JobRemote | null {
  if (raw === true) return 'remote';
  if (raw === false) return 'onsite';
  if (typeof raw !== 'string') return null;
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z]+/g, '');
  if (key.startsWith('remote')) return 'remote';
  if (key.startsWith('hybrid')) return 'hybrid';
  if (['onsite', 'inoffice', 'office', 'inperson', 'onprem'].includes(key)) return 'onsite';
  return null;
}

/**
 * The title as the dedupe key reads it: lowercase, a parenthetical dropped
 * ("(Remote)", "(NYC)"), common abbreviations spelled out, punctuation gone.
 * "Sr. Backend Eng (Remote)" and "Senior Backend Engineer" are one role.
 */
export function normalizeJobTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => TITLE_WORDS[word] ?? word)
    .join(' ');
}

const TITLE_WORDS: Record<string, string> = {
  sr: 'senior',
  snr: 'senior',
  jr: 'junior',
  eng: 'engineer',
  engr: 'engineer',
  mgr: 'manager',
  dir: 'director',
  swe: 'software engineer',
};

/**
 * What a role's id hashes: the company and the title, both normalized. The
 * service hashes it (`sha256`, server-side); the routine dedupes by the same
 * rule, so a role posted twice in one snapshot is still one role here.
 */
export function jobKey(company: string, title: string): string {
  const who = normalizeCompanyName(company) || company.trim().toLowerCase();
  return `${who}|${normalizeJobTitle(title)}`;
}

/* ------------------------------- the post ------------------------------ */

// The field rules (ids, text, days, run times) are shared with the other
// routine snapshots: relay-fields.ts.

export const JOB_SOURCE_SCHEMA = z.object({
  /** The Gmail message (or thread) id, hex; links are rebuilt from it. */
  message_id: GMAIL_ID,
  date: DAY,
  /** Display only, so a long one is cut short rather than costing the role. */
  subject: clippedText(300),
});
export type JobSource = z.infer<typeof JOB_SOURCE_SCHEMA>;

/** Most sources a role keeps; the routine sends the newest first. */
export const MAX_JOB_SOURCES = 10;

export const JOB_ROLE_SCHEMA = z.object({
  /** The routine's own id, if it sends one. Ignored: the app hashes its own. */
  id: z.string().max(100).nullish(),
  // Company and title stay strict: the role's id is a hash of the two (jobKey).
  company: text(120),
  company_domain: z.preprocess(
    (v) => (typeof v === 'string' ? strictDomain(v) : null),
    z.string().nullable(),
  ),
  is_portfolio: z.boolean().default(true),
  title: text(160),
  function: z.preprocess(normalizeJobFunction, z.enum(JOB_FUNCTIONS)),
  seniority: optionalText(40),
  location: optionalText(120),
  remote: z.preprocess(normalizeJobRemote, z.enum(JOB_REMOTE).nullable()),
  comp: optionalText(120),
  /** A job page. Only plain http(s) is kept; anything else (or too long) reads as no link. */
  link: z.preprocess(
    (v) => (typeof v === 'string' ? httpUrl(v.trim()) : null),
    z.string().max(600).nullable().catch(null),
  ),
  contact_name: optionalText(120),
  contact_email: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null),
    z.email().max(200).nullable().catch(null),
  ),
  status: z.enum(JOB_STATUSES),
  /** The founder's own words, short: "late-stage interviews", "hired, starts Nov 3". */
  status_note: optionalText(200),
  first_seen: DAY,
  last_seen: DAY,
  times_mentioned: z.number().int().min(1).max(1000).default(1),
  sources: z
    .array(JOB_SOURCE_SCHEMA)
    .max(40)
    .default([])
    .transform((list) => list.slice(0, MAX_JOB_SOURCES)),
});
export type JobRoleInput = z.infer<typeof JOB_ROLE_SCHEMA>;

/** One role as the app holds it: the post's fields plus the app's own id. */
export type JobRole = Omit<JobRoleInput, 'id'> & { id: string };

/**
 * One post. The roles are checked one by one (see the service): a single bad
 * row is dropped and counted, never the whole snapshot.
 */
export const JOBS_POST_SCHEMA = z.object({
  // run_at, part/parts, scanned_since (the first run reads ~120 days), emails_scanned.
  ...RELAY_ENVELOPE,
  roles: z.array(z.unknown()).max(80).default([]),
});
export type JobsPost = z.infer<typeof JOBS_POST_SCHEMA>;

export interface JobsSnapshot {
  runAt: string;
  /** When the newest part of that run reached Slack. */
  postedAt: string;
  scannedSince: string | null;
  emailsScanned: number | null;
  roles: JobRole[];
  /** The run's parts are not all there (still posting, or one went missing). */
  partial: boolean;
  /** Rows in the posts that did not validate and were left out. */
  dropped: number;
}

/**
 * Two rows of one role (the same id) as one: every source once (newest
 * first), the widest seen range, the highest count, and the status and note
 * of the row seen most recently.
 */
export function mergeJobRoles(a: JobRole, b: JobRole): JobRole {
  const [newer, older] = b.last_seen > a.last_seen ? [b, a] : [a, b];
  const sources = new Map<string, JobSource>();
  for (const s of [...newer.sources, ...older.sources]) {
    if (!sources.has(s.message_id)) sources.set(s.message_id, s);
  }
  return {
    ...older,
    ...newer,
    company_domain: newer.company_domain ?? older.company_domain,
    function: newer.function !== 'other' ? newer.function : older.function,
    seniority: newer.seniority ?? older.seniority,
    location: newer.location ?? older.location,
    remote: newer.remote ?? older.remote,
    comp: newer.comp ?? older.comp,
    link: newer.link ?? older.link,
    contact_name: newer.contact_name ?? older.contact_name,
    contact_email: newer.contact_email ?? older.contact_email,
    is_portfolio: newer.is_portfolio || older.is_portfolio,
    first_seen: newer.first_seen < older.first_seen ? newer.first_seen : older.first_seen,
    times_mentioned: Math.max(newer.times_mentioned, older.times_mentioned),
    sources: [...sources.values()]
      .sort((x, y) => y.date.localeCompare(x.date))
      .slice(0, MAX_JOB_SOURCES),
  };
}

/** Roles in a list, one per id, in the order each id first appears. */
export function dedupeJobRoles(roles: readonly JobRole[]): JobRole[] {
  const byId = new Map<string, JobRole>();
  for (const role of roles) {
    const seen = byId.get(role.id);
    byId.set(role.id, seen ? mergeJobRoles(seen, role) : role);
  }
  return [...byId.values()];
}

const STATUS_ORDER: Record<JobStatus, number> = {
  active: 0,
  probably_filled: 1,
  filled: 2,
  closed: 3,
};

/** Active first, then most recently mentioned, then company and title. */
export function sortJobRoles(roles: readonly JobRole[]): JobRole[] {
  return [...roles].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      b.last_seen.localeCompare(a.last_seen) ||
      a.company.localeCompare(b.company) ||
      a.title.localeCompare(b.title),
  );
}

/* ------------------------------- filters ------------------------------- */

export const JOB_STATUS_FILTERS = [...JOB_STATUSES, 'all'] as const;
export type JobStatusFilter = (typeof JOB_STATUS_FILTERS)[number];
export const DEFAULT_JOB_STATUS: JobStatusFilter = 'active';

export interface JobFilters {
  status: JobStatusFilter;
  /** A company name as the snapshot writes it; matched by normalized name. */
  company: string | null;
  fn: JobFunction | null;
  q: string;
}

type Params = Record<string, string | string[] | undefined>;

/** The filters a Jobs URL holds. Anything unknown reads as the default. */
export function parseJobFilters(params: Params): JobFilters {
  const status = single(params.status);
  const fn = single(params.fn);
  const company = single(params.company)?.trim().slice(0, 120);
  return {
    status: (JOB_STATUS_FILTERS as readonly string[]).includes(status ?? '')
      ? (status as JobStatusFilter)
      : DEFAULT_JOB_STATUS,
    company: company ? company : null,
    fn: (JOB_FUNCTIONS as readonly string[]).includes(fn ?? '') ? (fn as JobFunction) : null,
    q: (single(params.q) ?? '').trim().slice(0, 200),
  };
}

/** The URL params for a set of filters: defaults left out, so the plain tab link is the default. */
export function jobFilterParams(filters: JobFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.status !== DEFAULT_JOB_STATUS) out.status = filters.status;
  if (filters.company) out.company = filters.company;
  if (filters.fn) out.fn = filters.fn;
  if (filters.q) out.q = filters.q;
  return out;
}

export function sameJobCompany(a: string, b: string): boolean {
  const x = normalizeCompanyName(a) || a.trim().toLowerCase();
  const y = normalizeCompanyName(b) || b.trim().toLowerCase();
  return x === y;
}

function searchText(role: JobRole): string {
  return [
    role.title,
    role.company,
    role.location,
    role.seniority,
    JOB_FUNCTION_LABELS[role.function],
    role.status_note,
    role.contact_name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * The roles a set of filters shows. `ignore` leaves one filter out, for the
 * counts on that filter's own chips.
 */
export function filterJobRoles(
  roles: readonly JobRole[],
  filters: JobFilters,
  ignore?: 'status' | 'company' | 'fn',
): JobRole[] {
  const words = filters.q.toLowerCase().split(/\s+/).filter(Boolean);
  return roles.filter((role) => {
    if (ignore !== 'status' && filters.status !== 'all' && role.status !== filters.status) {
      return false;
    }
    if (ignore !== 'company' && filters.company && !sameJobCompany(role.company, filters.company)) {
      return false;
    }
    if (ignore !== 'fn' && filters.fn && role.function !== filters.fn) return false;
    if (words.length > 0) {
      const hay = searchText(role);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

/* ------------------------------- display ------------------------------- */

/** "Austin, TX · Hybrid", "Remote", or null when neither is known. */
export function jobPlace(role: Pick<JobRole, 'location' | 'remote'>): string | null {
  const parts = [role.location, role.remote ? JOB_REMOTE_LABELS[role.remote] : null].filter(
    (p): p is string => Boolean(p),
  );
  // "Remote · Remote" when the location already says it.
  if (parts.length === 2 && parts[0]!.toLowerCase() === parts[1]!.toLowerCase()) return parts[0]!;
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The text "Copy blurb" puts on the clipboard, for sharing a role in a
 * message or a post: title and company, where, and the job page.
 */
export function jobBlurb(
  role: Pick<JobRole, 'title' | 'company' | 'location' | 'remote' | 'link'>,
) {
  return [`${role.title} at ${role.company}`, jobPlace(role), role.link]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

/** A portfolio company as matching needs it. */
export interface JobCompanyLike {
  name: string;
  domain?: string | null;
  website?: string | null;
}

/** Whether a role is at this company: the same domain, or the same normalized name. */
export function roleIsAtCompany(role: JobRole, company: JobCompanyLike): boolean {
  const domain = strictDomain(company.domain ?? company.website ?? null);
  if (domain && role.company_domain && role.company_domain === domain) return true;
  return sameJobCompany(role.company, company.name);
}

/** The portfolio company a role is at, if any. */
export function companyForRole<C extends JobCompanyLike>(
  role: JobRole,
  companies: readonly C[],
): C | null {
  return companies.find((c) => roleIsAtCompany(role, c)) ?? null;
}

/** How old a scan is, and whether it is overdue for a weekly routine. */
export function jobsFreshness(runAt: string, now: Date): { days: number; stale: boolean } {
  const days = Math.max(0, Math.floor((now.getTime() - Date.parse(runAt)) / 86_400_000));
  return { days, stale: days > JOBS_STALE_AFTER_DAYS };
}

/* ------------------------------- liveness ------------------------------ */

/** A job board's answer about one posting, from `src/lib/services/job-liveness.ts`. */
export interface JobLinkVerdict {
  gone: boolean;
  board: string;
  checkedAt: string;
}

/**
 * Roles with a board's verdict folded in: a posting the board says is gone
 * closes a role the founder had not yet called filled or closed. The
 * founder's own word always wins, so a filled role stays filled.
 */
export function applyJobLiveness(
  roles: readonly JobRole[],
  verdicts: ReadonlyMap<string, JobLinkVerdict>,
): JobRole[] {
  return roles.map((role) => {
    const verdict = verdicts.get(role.id);
    if (!verdict?.gone || (role.status !== 'active' && role.status !== 'probably_filled')) {
      return role;
    }
    return {
      ...role,
      status: 'closed',
      status_note: `The posting is no longer on ${verdict.board}`,
    };
  });
}
