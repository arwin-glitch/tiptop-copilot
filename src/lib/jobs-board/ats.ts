import { normalizeJobRemote, type JobRemote } from '@/lib/portfolio/job-taxonomy';
import type { JobAts, JobEmploymentType } from '@/lib/types/domain';
import { formatPayRange, normalizeEmploymentType, remoteFromPlace } from './fields';
import { htmlToStructuredText, plainToStructuredText } from './sanitize';

/**
 * Companies' own public job boards (ATS: applicant tracking systems) and how
 * to read one. Pure: what board a careers address points at, the public API
 * address for it, and each board's answer read into one shape. The fetching
 * (timeouts, robots.txt, rate limits) is `lib/services/jobs-board-sync.ts`.
 *
 * Only these boards' documented public, unauthenticated job-listing APIs are
 * used, the same lists their own careers pages show:
 *   - Greenhouse: boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true
 *   - Lever:      api.lever.co/v0/postings/<site>?mode=json
 *   - Ashby:      api.ashbyhq.com/posting-api/job-board/<name>?includeCompensation=true
 *   - Workable:   apply.workable.com/api/v1/widget/accounts/<account>?details=true
 *   - Recruitee:  <company>.recruitee.com/api/offers/
 *
 * A board's token is checked against a strict pattern before it is ever put
 * into an address, and API addresses are rebuilt from it: nothing a careers
 * page or a person typed is fetched as it stands.
 */

export const ATS_LIST = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'recruitee',
] as const satisfies readonly JobAts[];

export const ATS_LABELS: Record<JobAts, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workable: 'Workable',
  recruitee: 'Recruitee',
};

export interface AtsBoard {
  ats: JobAts;
  token: string;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Recruitee's token is a subdomain, so a DNS label. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function isAts(value: unknown): value is JobAts {
  return typeof value === 'string' && (ATS_LIST as readonly string[]).includes(value);
}

export function isValidAtsToken(ats: JobAts, token: string | null | undefined): token is string {
  if (!token || !TOKEN.test(token)) return false;
  return ats === 'recruitee' ? DNS_LABEL.test(token) : true;
}

function board(ats: JobAts, token: string | null | undefined): AtsBoard | null {
  return isValidAtsToken(ats, token) ? { ats, token } : null;
}

/** A typed address, with or without its scheme, as a URL; null when it is not one. */
export function parseCareersUrl(raw: string | null | undefined): URL | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 500 || /\s/.test(trimmed)) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    if (!url.hostname.includes('.')) return null;
    return url;
  } catch {
    return null;
  }
}

const NOT_WORKABLE_ACCOUNTS = new Set(['www', 'apply', 'api', 'help', 'resources', 'j', 'jobs']);
const NOT_RECRUITEE_COMPANIES = new Set([
  'www',
  'app',
  'api',
  'docs',
  'support',
  'blog',
  'careers',
]);

/**
 * The job board a careers address is on, read from the address alone:
 * `boards.greenhouse.io/acme`, `jobs.lever.co/acme`, `jobs.ashbyhq.com/acme`,
 * `apply.workable.com/acme`, `acme.recruitee.com`, a board's own API address,
 * or Greenhouse's embed (`…/embed/job_board?for=acme`). Null for a company's
 * own careers page; `detectAtsInHtml` reads that page's markup instead.
 */
export function detectAtsFromUrl(raw: string | null | undefined): AtsBoard | null {
  const url = parseCareersUrl(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname
    .split('/')
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    if (path[0] === 'embed') return board('greenhouse', url.searchParams.get('for'));
    return board('greenhouse', path[0]);
  }
  if (host === 'boards-api.greenhouse.io') {
    return path[0] === 'v1' && path[1] === 'boards' ? board('greenhouse', path[2]) : null;
  }
  if (host === 'jobs.lever.co') return board('lever', path[0]);
  if (host === 'api.lever.co') {
    return path[0] === 'v0' && path[1] === 'postings' ? board('lever', path[2]) : null;
  }
  if (host === 'jobs.ashbyhq.com') return board('ashby', path[0]);
  if (host === 'api.ashbyhq.com') {
    return path[0] === 'posting-api' && path[1] === 'job-board' ? board('ashby', path[2]) : null;
  }
  if (host === 'apply.workable.com') {
    if (path[0] === 'api') {
      const i = path.indexOf('accounts');
      return i >= 0 ? board('workable', path[i + 1]) : null;
    }
    return path[0] && !NOT_WORKABLE_ACCOUNTS.has(path[0]) ? board('workable', path[0]) : null;
  }
  if (host.endsWith('.workable.com')) {
    const account = host.slice(0, -'.workable.com'.length);
    return !account.includes('.') && !NOT_WORKABLE_ACCOUNTS.has(account)
      ? board('workable', account)
      : null;
  }
  if (host.endsWith('.recruitee.com')) {
    const company = host.slice(0, -'.recruitee.com'.length);
    return !company.includes('.') && !NOT_RECRUITEE_COMPANIES.has(company)
      ? board('recruitee', company)
      : null;
  }
  return null;
}

const HTML_PATTERNS: [JobAts, RegExp][] = [
  [
    'greenhouse',
    // The query before `for=` is bounded: an unbounded run here rescans the
    // rest of the page for each embed address, which a hostile careers page
    // can repeat thousands of times.
    /boards\.greenhouse\.io\/embed\/job_board(?:\/js)?\?(?:[^"'\s<>]{0,500}&(?:amp;)?)?for=([A-Za-z0-9._-]+)/i,
  ],
  ['greenhouse', /(?:job-)?boards(?:-api)?\.greenhouse\.io\/(?:v1\/boards\/)?([A-Za-z0-9._-]+)/i],
  ['lever', /jobs\.lever\.co\/([A-Za-z0-9._-]+)/i],
  ['ashby', /jobs\.ashbyhq\.com\/([A-Za-z0-9._-]+)/i],
  ['workable', /apply\.workable\.com\/([A-Za-z0-9._-]+)/i],
  ['recruitee', /\/\/([a-z0-9-]+)\.recruitee\.com/i],
];

/**
 * The job board a company's own careers page uses, from its markup: an
 * embedded Greenhouse board, links to Lever or Ashby postings, a Workable or
 * Recruitee widget. The first board found, in that order; null when the page
 * names none of them.
 */
export function detectAtsInHtml(html: string | null | undefined): AtsBoard | null {
  if (!html || typeof html !== 'string') return null;
  const text = html.length > 2_000_000 ? html.slice(0, 2_000_000) : html;
  for (const [ats, pattern] of HTML_PATTERNS) {
    const global = new RegExp(pattern.source, 'gi');
    for (const match of text.matchAll(global)) {
      const token = match[1];
      if (!token) continue;
      const lower = token.toLowerCase();
      if (ats === 'greenhouse' && (lower === 'embed' || lower === 'v1')) continue;
      if (ats === 'workable' && NOT_WORKABLE_ACCOUNTS.has(lower)) continue;
      if (ats === 'recruitee' && NOT_RECRUITEE_COMPANIES.has(lower)) continue;
      // An Ashby embed script is `jobs.ashbyhq.com/<name>/embed`: the name is still first.
      const found = board(ats, token);
      if (found) return found;
    }
  }
  return null;
}

/** The board's public job-list API, rebuilt from its checked token. */
export function atsApiUrl(b: AtsBoard): string {
  const token = encodeURIComponent(b.token);
  switch (b.ats) {
    case 'greenhouse':
      return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`;
    case 'lever':
      return `https://api.lever.co/v0/postings/${token}?mode=json`;
    case 'ashby':
      return `https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`;
    case 'workable':
      return `https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`;
    case 'recruitee':
      return `https://${b.token.toLowerCase()}.recruitee.com/api/offers/`;
  }
}

/** The board's own careers page, for people. */
export function atsBoardUrl(b: AtsBoard): string {
  const token = encodeURIComponent(b.token);
  switch (b.ats) {
    case 'greenhouse':
      return `https://job-boards.greenhouse.io/${token}`;
    case 'lever':
      return `https://jobs.lever.co/${token}`;
    case 'ashby':
      return `https://jobs.ashbyhq.com/${token}`;
    case 'workable':
      return `https://apply.workable.com/${token}/`;
    case 'recruitee':
      return `https://${b.token.toLowerCase()}.recruitee.com/`;
  }
}

/* ------------------------------------------------------------- answers -- */

/** One role as a board lists it, read into the board's shape. */
export interface AtsPosting {
  /** The posting's id on its board. */
  externalId: string;
  title: string;
  team: string | null;
  locations: string[];
  remote: JobRemote | null;
  employmentType: JobEmploymentType | null;
  /** Pay, only when the board publishes it. */
  comp: string | null;
  /** Structured text (see sanitize.ts), never HTML. */
  description: string;
  applyUrl: string | null;
  postedAt: string | null;
  updatedAt: string | null;
}

export interface AtsParse {
  postings: AtsPosting[];
  /** Entries left out because they had no id or title. */
  skipped: number;
}

/** Most roles read from one board in one sync. */
export const MAX_POSTINGS_PER_BOARD = 500;

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null;
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function id(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(value.trim()))
    return value.trim();
  return null;
}

function link(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 800) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function iso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value > 1e11 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

function places(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const place = str(v, 120);
    if (!place) continue;
    for (const part of place.split(/\s*;\s*|\s+\|\s+/)) {
      const p = part.trim();
      if (p && !out.some((o) => o.toLowerCase() === p.toLowerCase())) out.push(p);
    }
  }
  return out.slice(0, 10);
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function list(body: unknown, key: string | null): unknown[] | null {
  if (key === null) return Array.isArray(body) ? body : null;
  const value = obj(body)?.[key];
  return Array.isArray(value) ? value : null;
}

/**
 * A board's answer -> its postings. Null when the answer is not the shape the
 * board documents (a changed API, an error page), so a sync never reads an
 * unexpected answer as "every role closed".
 */
export function parseAtsJobs(ats: JobAts, body: unknown): AtsParse | null {
  const read = READERS[ats];
  const entries = list(body, read.key);
  if (!entries) return null;
  const postings: AtsPosting[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const entry of entries.slice(0, MAX_POSTINGS_PER_BOARD * 2)) {
    const e = obj(entry);
    const posting = e ? read.posting(e) : null;
    if (posting === 'unlisted') continue;
    if (!posting || seen.has(posting.externalId)) {
      skipped++;
      continue;
    }
    seen.add(posting.externalId);
    postings.push(posting);
    if (postings.length >= MAX_POSTINGS_PER_BOARD) break;
  }
  return { postings, skipped };
}

interface Reader {
  /** Where the list sits: a key of the answer, or null for a bare array. */
  key: string | null;
  posting: (e: Obj) => AtsPosting | 'unlisted' | null;
}

const READERS: Record<JobAts, Reader> = {
  greenhouse: {
    key: 'jobs',
    posting: (e) => {
      const externalId = id(e.id);
      const title = str(e.title, 200);
      if (!externalId || !title) return null;
      const location = obj(e.location);
      const departments = Array.isArray(e.departments) ? e.departments : [];
      const metadata = Array.isArray(e.metadata) ? e.metadata : [];
      const typeField = metadata
        .map(obj)
        .find((m) => typeof m?.name === 'string' && /employment|job type|commitment/i.test(m.name));
      const locations = places([location?.name]);
      return {
        externalId,
        title,
        team: str(obj(departments[0])?.name, 120),
        locations,
        remote: remoteFromPlace(locations.join(' ')),
        employmentType: normalizeEmploymentType(typeField?.value),
        comp: null,
        description: htmlToStructuredText(typeof e.content === 'string' ? e.content : ''),
        applyUrl: link(e.absolute_url),
        postedAt: iso(e.first_published) ?? iso(e.updated_at),
        updatedAt: iso(e.updated_at),
      };
    },
  },
  lever: {
    key: null,
    posting: (e) => {
      const externalId = id(e.id);
      const title = str(e.text, 200);
      if (!externalId || !title) return null;
      const categories = obj(e.categories) ?? {};
      const all = Array.isArray(categories.allLocations) ? categories.allLocations : [];
      const locations = places(all.length > 0 ? all : [categories.location]);
      const sections = (Array.isArray(e.lists) ? e.lists : [])
        .map(obj)
        .filter((l): l is Obj => Boolean(l))
        .map((l) => {
          const heading = typeof l.text === 'string' ? `<h3>${escapeText(l.text)}</h3>` : '';
          const content = typeof l.content === 'string' ? `<ul>${l.content}</ul>` : '';
          return heading + content;
        })
        .join('');
      const html = [e.opening, e.description, sections, e.additional]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join('');
      const description = html
        ? htmlToStructuredText(html)
        : plainToStructuredText(typeof e.descriptionPlain === 'string' ? e.descriptionPlain : '');
      const salary = obj(e.salaryRange);
      return {
        externalId,
        title,
        team: str(categories.team, 120) ?? str(categories.department, 120),
        locations,
        remote: normalizeJobRemote(e.workplaceType) ?? remoteFromPlace(locations.join(' ')),
        employmentType: normalizeEmploymentType(categories.commitment),
        comp: salary ? formatPayRange(salary) : null,
        description,
        applyUrl: link(e.hostedUrl) ?? link(e.applyUrl),
        postedAt: iso(e.createdAt),
        updatedAt: iso(e.updatedAt) ?? iso(e.createdAt),
      };
    },
  },
  ashby: {
    key: 'jobs',
    posting: (e) => {
      // Unlisted roles are meant to be reached only by their own link.
      if (e.isListed === false) return 'unlisted';
      const url = link(e.jobUrl);
      const fromUrl = url?.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      )?.[0];
      const externalId = id(e.id) ?? (fromUrl ? fromUrl.toLowerCase() : null);
      const title = str(e.title, 200);
      if (!externalId || !title) return null;
      const secondary = (Array.isArray(e.secondaryLocations) ? e.secondaryLocations : []).map(
        (s) => obj(s)?.location,
      );
      const locations = places([e.location, ...secondary]);
      const compensation = obj(e.compensation) ?? e;
      const comp =
        str(compensation.scrapeableCompensationSalarySummary, 160) ??
        str(compensation.compensationTierSummary, 160);
      return {
        externalId,
        title,
        team: str(e.team, 120) ?? str(e.department, 120),
        locations,
        remote:
          normalizeJobRemote(e.workplaceType) ??
          (e.isRemote === true ? 'remote' : remoteFromPlace(locations.join(' '))),
        employmentType: normalizeEmploymentType(e.employmentType),
        comp,
        description:
          typeof e.descriptionHtml === 'string' && e.descriptionHtml
            ? htmlToStructuredText(e.descriptionHtml)
            : plainToStructuredText(
                typeof e.descriptionPlain === 'string' ? e.descriptionPlain : '',
              ),
        applyUrl: url ?? link(e.applyUrl),
        postedAt: iso(e.publishedAt),
        updatedAt: iso(e.updatedAt) ?? iso(e.publishedAt),
      };
    },
  },
  workable: {
    key: 'jobs',
    posting: (e) => {
      const externalId = id(e.shortcode) ?? id(e.id);
      const title = str(e.title, 200);
      if (!externalId || !title) return null;
      const many = (Array.isArray(e.locations) ? e.locations : []).map((l) => {
        const o = obj(l);
        return o
          ? [o.city, o.region ?? o.state, o.country]
              .filter((x) => typeof x === 'string' && x)
              .join(', ')
          : null;
      });
      const single = [e.city, e.state, e.country]
        .filter((x) => typeof x === 'string' && x)
        .join(', ');
      const locations = places(many.length > 0 ? many : [single]);
      const html = [e.description, e.requirements, e.benefits]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join('');
      return {
        externalId,
        title,
        team: str(e.department, 120),
        locations,
        remote:
          e.telecommuting === true
            ? 'remote'
            : (normalizeJobRemote(e.workplace_type) ?? remoteFromPlace(locations.join(' '))),
        employmentType: normalizeEmploymentType(e.employment_type),
        comp: null,
        description: htmlToStructuredText(html),
        applyUrl: link(e.url) ?? link(e.shortlink) ?? link(e.application_url),
        postedAt: iso(e.published_on) ?? iso(e.created_at),
        updatedAt: iso(e.updated_at) ?? iso(e.published_on),
      };
    },
  },
  recruitee: {
    key: 'offers',
    posting: (e) => {
      if (typeof e.status === 'string' && e.status !== 'published') return 'unlisted';
      const externalId = id(e.id) ?? id(e.slug);
      const title = str(e.title, 200);
      if (!externalId || !title) return null;
      const many = (Array.isArray(e.locations) ? e.locations : []).map((l) => {
        const o = obj(l);
        return o
          ? [o.city, o.state, o.country].filter((x) => typeof x === 'string' && x).join(', ')
          : null;
      });
      const locations = places(many.length > 0 ? many : [e.location]);
      const requirements =
        typeof e.requirements === 'string' && e.requirements
          ? `<h3>Requirements</h3>${e.requirements}`
          : '';
      const salary = obj(e.salary);
      return {
        externalId,
        title,
        team: str(e.department, 120),
        locations,
        remote:
          e.remote === true
            ? 'remote'
            : e.hybrid === true
              ? 'hybrid'
              : e.on_site === true
                ? 'onsite'
                : remoteFromPlace(locations.join(' ')),
        employmentType: normalizeEmploymentType(e.employment_type_code),
        comp: salary
          ? formatPayRange({
              min: typeof salary.min === 'string' ? Number(salary.min) : salary.min,
              max: typeof salary.max === 'string' ? Number(salary.max) : salary.max,
              currency: salary.currency,
              interval: salary.period,
            })
          : null,
        description: htmlToStructuredText(
          `${typeof e.description === 'string' ? e.description : ''}${requirements}`,
        ),
        applyUrl: link(e.careers_url) ?? link(e.careers_apply_url),
        postedAt: iso(e.published_at) ?? iso(e.created_at),
        updatedAt: iso(e.updated_at) ?? iso(e.published_at),
      };
    },
  },
};
