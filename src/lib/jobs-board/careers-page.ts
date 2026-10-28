import { normalizeJobTitle } from '@/lib/portfolio/job-taxonomy';
import type { AtsBoard, AtsPosting } from './ats';
import { formatPayRange, normalizeEmploymentType, remoteFromPlace } from './fields';
import { htmlToStructuredText } from './sanitize';

/**
 * A company's own careers page that is not on a supported job board, read for
 * the roles it publishes as schema.org JobPosting structured data (the
 * `<script type="application/ld+json">` blocks Google asks job pages to
 * carry). Pure: the fetching (timeouts, robots.txt, redirects, size caps,
 * private addresses) is `lib/services/jobs-board-sync.ts`, the same path the
 * job board check uses.
 *
 * Only what the page itself publishes for search engines is read: title,
 * places and remote, employment type, dates, pay when the page states it, the
 * description (sanitised into structured text, never HTML) and the role's own
 * http/https link. A role whose validThrough has passed is left out. Roles
 * read here are stored as board roles (source `ats`) with a `page:` source
 * key, so they follow the company's auto-publish switch like any board role.
 * Pure and client-safe.
 */

/** Most roles read from one careers page in one sync. */
export const MAX_PAGE_ROLES = 100;
/** JSON-LD blocks read from one page, and the largest one read. */
const MAX_BLOCKS = 40;
const MAX_BLOCK_CHARS = 400_000;
/** Nodes visited per page while looking for JobPostings (nested @graph, lists). */
const MAX_NODES = 5_000;
const MAX_DEPTH = 8;

/** The `source_key` prefix of a role read from a careers page's JSON-LD. */
export const PAGE_SOURCE_PREFIX = 'page:';

/** Whether a stored role came from a careers page's structured data (not a job board API). */
export function isCareersPageRole(posting: { source: string; source_key: string }): boolean {
  return posting.source === 'ats' && posting.source_key.startsWith(PAGE_SOURCE_PREFIX);
}

/**
 * What a careers address leads to: a supported job board, or the page's own
 * structured-data roles (how many were readable), or neither.
 */
export interface CareersSource {
  board: AtsBoard | null;
  /** JobPostings the page publishes (0 when none, or when a board was found first). */
  pageRoles: number;
}

export interface PageParse {
  postings: AtsPosting[];
  /** JobPostings left out: no title, a bad link, another company's role. */
  skipped: number;
  /** JobPostings left out because their validThrough has passed. */
  expired: number;
  /** Whether the page had any JSON-LD block at all. */
  hasJsonLd: boolean;
}

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null;
}

function many(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function str(value: unknown, max: number): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\s*\d[\d,]*(\.\d+)?\s*$/.test(value)) {
    const n = Number(value.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 60) return null;
  const t = Date.parse(value.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** An http/https address, resolved against the page; null for anything else. */
function link(value: unknown, base: string | null): string | null {
  const raw = typeof value === 'string' ? value : str(obj(value)?.url, 800);
  if (!raw || raw.length > 800) return null;
  try {
    const url = base ? new URL(raw.trim(), base) : new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    const out = url.toString();
    return out.length <= 800 ? out : null;
  } catch {
    return null;
  }
}

/**
 * A short stable id for a role with no identifier of its own (cyrb53, 16 hex
 * characters). Not for security: only so the same role keeps one key across
 * syncs. Pure JavaScript, so this file stays client-safe.
 */
function stableHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

function isJobPosting(node: Obj): boolean {
  return many(node['@type']).some(
    (t) => typeof t === 'string' && t.replace(/^.*[/:#]/, '').toLowerCase() === 'jobposting',
  );
}

/**
 * The text of every `<script type="application/ld+json">` block, found with
 * plain index scans (never a regular expression over the whole page, which a
 * hostile page could make backtrack).
 */
export function jsonLdBlocks(html: string): string[] {
  const lower = html.toLowerCase();
  const blocks: string[] = [];
  let from = 0;
  while (blocks.length < MAX_BLOCKS) {
    const open = lower.indexOf('<script', from);
    if (open < 0) break;
    const tagEnd = lower.indexOf('>', open);
    if (tagEnd < 0) break;
    const close = lower.indexOf('</script', tagEnd);
    if (close < 0) break;
    from = close + 8;
    const tag = lower.slice(open, Math.min(tagEnd, open + 400));
    if (!/\btype\s*=\s*["']?application\/ld\+json/.test(tag)) continue;
    if (close - tagEnd - 1 > MAX_BLOCK_CHARS) continue;
    blocks.push(html.slice(tagEnd + 1, close));
  }
  return blocks;
}

function parseBlock(text: string): unknown {
  const body = text
    .trim()
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .replace(/^\/\/\s*<!\[CDATA\[/, '')
    .replace(/\/\/\s*\]\]>$/, '')
    .trim();
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Every JobPosting node in a parsed block: top level, arrays, @graph, item lists. */
function collectPostings(root: unknown, out: Obj[]): void {
  let visited = 0;
  const walk = (value: unknown, depth: number) => {
    if (depth > MAX_DEPTH || visited > MAX_NODES) return;
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    const node = obj(value);
    if (!node) return;
    visited++;
    if (isJobPosting(node)) {
      out.push(node);
      return;
    }
    for (const key of ['@graph', 'itemListElement', 'item', 'mainEntity', 'hasPart']) {
      if (key in node) walk(node[key], depth + 1);
    }
  };
  walk(root, 0);
}

function placeOf(value: unknown): string | null {
  if (typeof value === 'string') return str(value, 120);
  const place = obj(value);
  if (!place) return null;
  const address = place.address;
  if (typeof address === 'string') return str(address, 120);
  const a = obj(address);
  if (!a) return str(place.name, 120);
  const country =
    typeof a.addressCountry === 'string' ? a.addressCountry : obj(a.addressCountry)?.name;
  const parts = [a.addressLocality, a.addressRegion, country]
    .map((p) => str(p, 60))
    .filter((p): p is string => Boolean(p));
  return parts.length > 0 ? str(parts.join(', '), 120) : str(place.name, 120);
}

function places(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const p = placeOf(v);
    if (p && !out.some((o) => o.toLowerCase() === p.toLowerCase())) out.push(p);
    if (out.length >= 10) break;
  }
  return out;
}

function payOf(value: unknown): string | null {
  const amount = obj(value);
  if (!amount) return null;
  const v = obj(amount.value);
  const min = num(v?.minValue) ?? num(v?.value) ?? num(amount.value);
  const max = num(v?.maxValue);
  if (min === null && max === null) return null;
  const pay = formatPayRange({
    min: min ?? undefined,
    max: max ?? undefined,
    currency: amount.currency,
    interval: v?.unitText ?? amount.unitText,
  });
  return pay ? str(pay, 160) : null;
}

const LEGAL_SUFFIX =
  /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|sa|ag|bv|pbc|labs?|technologies|technology|hq)\b/g;

function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(LEGAL_SUFFIX, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/**
 * Words two unrelated companies often share ("The Acme Co" and "The Other
 * Corp", "Acme AI" and "Beta AI"): never enough on their own to say a
 * posting's hiringOrganization is the company.
 */
const COMMON_NAME_WORDS = new Set([
  'the',
  'and',
  'of',
  'for',
  'by',
  'on',
  'in',
  'at',
  'to',
  'an',
  'my',
  'our',
  'we',
  'ai',
  'ml',
  'bio',
  'health',
  'healthcare',
  'medical',
  'robotics',
  'capital',
  'group',
  'holdings',
  'ventures',
  'partners',
  'systems',
  'solutions',
  'software',
  'tech',
  'data',
  'analytics',
  'cloud',
  'digital',
  'energy',
  'global',
  'international',
  'network',
  'networks',
  'security',
  'therapeutics',
  'studio',
  'studios',
  'works',
  'ops',
  'app',
  'apps',
  'io',
  'hq',
  'usa',
  'us',
  'america',
  'americas',
  'services',
  'industries',
  'financial',
  'finance',
  'fintech',
  'media',
  'foods',
  'bank',
  'pay',
]);

/** A name's distinctive words; all its words when every one is common ("AI Health"). */
function distinctiveWords(name: string): string[] {
  const words = nameWords(name);
  const rare = words.filter((w) => !COMMON_NAME_WORDS.has(w));
  return rare.length > 0 ? rare : words;
}

/** The hiringOrganization a JobPosting names, if any. */
function hiringOrgName(node: Obj): string | null {
  const org = many(node.hiringOrganization)[0];
  return typeof org === 'string' ? str(org, 200) : str(obj(org)?.name, 200);
}

/**
 * Whether a JobPosting's hiringOrganization can be the company: true when it
 * names none, or when the two names share their distinctive words ("Acme
 * Robotics, Inc." and "Acme"): at least half the shorter name's, including
 * one name's leading word. Stop words and common industry words never count
 * ("The Acme Co" is not "The Other Corp"; "Acme AI" is not "Beta AI"). A
 * careers address that points at a page listing other companies' roles (an
 * aggregator) never puts those roles under this company.
 */
export function hiringOrgMatches(node: Obj, companyName: string | null): boolean {
  if (!companyName) return true;
  const name = hiringOrgName(node);
  if (!name) return true;
  const theirs = distinctiveWords(name);
  const ours = distinctiveWords(companyName);
  if (theirs.length === 0 || ours.length === 0) return true;
  const theirSet = new Set(theirs);
  const ourSet = new Set(ours);
  const shared = [...ourSet].filter((w) => theirSet.has(w)).length;
  const needed = Math.ceil(Math.min(ourSet.size, theirSet.size) / 2);
  return shared >= needed && (theirSet.has(ours[0]!) || ourSet.has(theirs[0]!));
}

/**
 * A role link with what changes from load to load taken off (the query, with
 * its tracking and session parameters, the fragment, a trailing slash, the
 * host's case), so it can name the same role across syncs.
 */
function stableLink(applyUrl: string | null): string {
  if (!applyUrl) return '';
  try {
    const url = new URL(applyUrl);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.hostname.toLowerCase().replace(/^www\./, '')}${path}`;
  } catch {
    return '';
  }
}

function postingOf(node: Obj, pageUrl: string | null): AtsPosting | null {
  const title = str(node.title, 200) ?? str(node.name, 200);
  if (!title) return null;
  const rawUrl = node.url ?? node.sameAs;
  const applyUrl = rawUrl === undefined ? null : link(rawUrl, pageUrl);
  // A link that is there but not a web address (javascript:, data:) is a
  // broken or hostile entry: left out rather than shown without it.
  if (rawUrl !== undefined && !applyUrl) return null;
  const identifier = many(node.identifier)[0];
  const idValue = str(obj(identifier)?.value ?? identifier, 100);
  const stableId =
    idValue && /^[A-Za-z0-9._:-]{1,100}$/.test(idValue)
      ? idValue
      : stableHash(`${stableLink(applyUrl)}|${normalizeJobTitle(title)}`);
  const telecommute = many(node.jobLocationType).some(
    (t) => typeof t === 'string' && t.toUpperCase() === 'TELECOMMUTE',
  );
  const located = places(many(node.jobLocation));
  const required = telecommute ? places(many(node.applicantLocationRequirements)) : [];
  const locations = located.length > 0 ? located : required.map((r) => `Remote (${r})`);
  const employmentType =
    many(node.employmentType)
      .map((t) => normalizeEmploymentType(t))
      .find((t) => t !== null) ?? null;
  const description =
    typeof node.description === 'string' ? htmlToStructuredText(node.description) : '';
  const posted = iso(node.datePosted);
  return {
    externalId: stableId,
    title,
    team: null,
    locations,
    remote: telecommute ? 'remote' : remoteFromPlace(locations.join(' ')),
    employmentType,
    comp: payOf(node.baseSalary),
    description,
    applyUrl,
    postedAt: posted,
    updatedAt: posted,
  };
}

/**
 * A careers page's HTML -> the JobPostings it publishes. `pageUrl` resolves
 * relative role links; `companyName` leaves out roles another company is
 * named as hiring for; `now` decides which validThrough dates have passed.
 * At most MAX_PAGE_ROLES, one per id.
 */
export function parseCareersPageJobs(
  html: string | null | undefined,
  options: { pageUrl?: string | null; companyName?: string | null; now?: Date } = {},
): PageParse {
  const out: PageParse = { postings: [], skipped: 0, expired: 0, hasJsonLd: false };
  if (!html || typeof html !== 'string') return out;
  const now = (options.now ?? new Date()).getTime();
  const pageUrl = options.pageUrl ? link(options.pageUrl, null) : null;
  const nodes: Obj[] = [];
  for (const block of jsonLdBlocks(html)) {
    out.hasJsonLd = true;
    collectPostings(parseBlock(block), nodes);
    if (nodes.length >= MAX_PAGE_ROLES * 3) break;
  }
  // A page whose roles name other companies as hiring (two or more of them,
  // or more of theirs than ours) is a list of many companies' roles: there,
  // a role that names no one is not taken as ours.
  const companyName = options.companyName ?? null;
  const foreign = new Set<string>();
  let foreignRoles = 0;
  let ownRoles = 0;
  if (companyName) {
    for (const node of nodes) {
      const org = hiringOrgName(node);
      if (!org) continue;
      if (hiringOrgMatches(node, companyName)) {
        ownRoles++;
      } else {
        foreignRoles++;
        foreign.add(org.toLowerCase());
      }
    }
  }
  const aggregator = foreign.size >= 2 || foreignRoles > ownRoles;
  const seen = new Set<string>();
  for (const node of nodes) {
    const until = iso(node.validThrough);
    if (until && Date.parse(until) <= now) {
      out.expired++;
      continue;
    }
    if (!hiringOrgMatches(node, companyName) || (aggregator && hiringOrgName(node) === null)) {
      out.skipped++;
      continue;
    }
    const posting = postingOf(node, pageUrl);
    if (!posting || seen.has(posting.externalId)) {
      out.skipped++;
      continue;
    }
    seen.add(posting.externalId);
    out.postings.push(posting);
    if (out.postings.length >= MAX_PAGE_ROLES) break;
  }
  return out;
}

/**
 * A careers page role's stable key: `page:<host>:<id>`. Pass the company's
 * saved careers address, not where its redirects landed, so a page that
 * moves hosts behind a redirect keeps its roles' keys.
 */
export function pageSourceKey(pageUrl: string, posting: Pick<AtsPosting, 'externalId'>): string {
  let host = 'page';
  try {
    host = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    // Kept as "page".
  }
  return `${PAGE_SOURCE_PREFIX}${host}:${posting.externalId}`.slice(0, 200);
}
