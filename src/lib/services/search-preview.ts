import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import { resolveCrmListDestination } from '@/lib/crm/destinations';
import { statusFieldOf } from '@/lib/crm/fields';
import { isMoneyField } from '@/lib/crm/stage-map';
import { formatCrmValue } from '@/lib/crm/view';
import { harmonicDetail, type HarmonicDetail } from '@/lib/integrations/harmonic-mcp';
import {
  CONTACT_STATUS_LABELS,
  contactStatus,
  type ContactStatus,
} from '@/lib/network/contact-status';
import { evidenceFor, nameFor } from '@/lib/network/evidence';
import { personPagePath } from '@/lib/network/person-path';
import type { CrmRecord, CrmValue } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';
import { getRecord } from './crm';
import { readDestinationOverrides } from './crm-destinations';
import { getPrimaryIntegration } from './inbox';
import { readCadences } from './keep-in-touch';
import {
  contactSummaries,
  getRelationshipIndex,
  recordAddresses,
  relationshipScope,
  type ContactSummary,
} from './relationships';
import { isPersonalDomain } from './warm-paths';

/**
 * The quick search's right-hand preview for a company or person, Affinity's
 * shape: where they sit (pipeline or list, its status, owner and amount), the
 * relationship status tag, counts of notes, connections and reminders, and
 * the last contact in words. One request per highlighted row (the palette
 * debounces and caches), all from the database and the cached relationship
 * index — never a Gmail call.
 *
 * An LP list's amounts stay off, as everywhere on Fund II (lib/crm/lp-rule).
 */

export interface SearchPreviewList {
  name: string;
  kind: 'deal' | 'company' | 'person';
  statusName: string | null;
  status: string | null;
}

export interface SearchPreview {
  id: string;
  kind: CrmRecord['kind'];
  name: string;
  /** Domain for a company, primary email for a person. */
  sub: string | null;
  industry: string | null;
  title: string | null;
  href: string;
  /** Deal lists first, then the rest; at most four. */
  lists: SearchPreviewList[];
  listCount: number;
  owner: string | null;
  stage: string | null;
  amount: string | null;
  counts: { notes: number; notesCapped: boolean; connections: number; reminders: number };
  contact: {
    status: ContactStatus;
    lastContactAt: string | null;
    lastTouchText: string | null;
    connections: string[];
  } | null;
}

const NOTE_CAP = 200;
const OWNER = /\b(owner|owners|deal lead|lead partner|point person|relationship owner)\b/i;

function textOf(value: CrmValue | undefined): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length) return value.join(', ');
  return null;
}

/** A record's first filled field among these labels. */
export function recordField(record: Pick<CrmRecord, 'fields'>, labels: readonly string[]) {
  for (const label of labels) {
    const v = textOf(record.fields[label]);
    if (v) return v;
  }
  return null;
}

export const INDUSTRY_LABELS = ['Industry', 'Industries', 'Sector', 'Type'] as const;
export const TITLE_LABELS = ['Job Title', 'Title', 'Role', 'Position'] as const;

export async function searchPreview(
  store: DataStore,
  auth: AuthContext,
  recordId: string,
): Promise<Result<SearchPreview>> {
  const org = auth.organizationId;
  const found = await getRecord(store, org, recordId, { noteLimit: NOTE_CAP });
  if (!found.ok) return found;
  const { record, memberships, notes, related } = found.value;
  const timezone = auth.profile.timezone;

  const [overrides, integration, cadences] = await Promise.all([
    readDestinationOverrides(store, org).catch(() => ({}) as Record<string, never>),
    getPrimaryIntegration(store, org).catch(() => null),
    readCadences(store, org, [record.id]),
  ]);
  const summaries = await contactSummaries(
    store,
    org,
    [{ ...record, related }],
    relationshipScope(auth.profile.email, integration),
  );
  const summary = summaries.ok ? (summaries.value[record.id] ?? null) : null;

  const ordered = [...memberships].sort(
    (a, b) =>
      Number(b.list.entity_type === 'deal') - Number(a.list.entity_type === 'deal') ||
      Number(a.list.archived) - Number(b.list.archived),
  );
  let owner: string | null = null;
  let stage: string | null = null;
  let amount: string | null = null;
  const lists: SearchPreviewList[] = [];
  for (const { entry, list } of ordered) {
    const status = statusFieldOf(list);
    const statusValue = status ? entry.values[status.key] : undefined;
    const statusText =
      status && statusValue !== undefined ? formatCrmValue(status, statusValue, timezone) : null;
    if (lists.length < 4) {
      lists.push({
        name: list.name,
        kind: list.entity_type,
        statusName: status?.name ?? null,
        status: statusText || null,
      });
    }
    stage ??= statusText || null;
    const { destination } = resolveCrmListDestination(list, overrides[list.id]);
    const lp = destination === 'lps' || destination === 'lp_lists';
    for (const field of list.fields) {
      const value = entry.values[field.key];
      if (value === undefined || value === null || value === '') continue;
      if (!owner && OWNER.test(field.name)) owner = formatCrmValue(field, value, timezone) || null;
      if (!amount && !lp && isMoneyField(field) && field.key !== status?.key) {
        amount = formatCrmValue(field, value, timezone) || null;
      }
    }
  }

  return ok({
    id: record.id,
    kind: record.kind,
    name: record.name,
    sub: record.kind === 'company' ? record.domain : record.primary_email,
    industry: recordField(record, INDUSTRY_LABELS),
    title: record.kind === 'person' ? recordField(record, TITLE_LABELS) : null,
    href: `/lists/records/${record.id}`,
    lists,
    listCount: memberships.length,
    owner,
    stage,
    amount,
    counts: {
      notes: notes.length,
      notesCapped: notes.length >= NOTE_CAP,
      connections: summary?.connections.length ?? 0,
      reminders: cadences.get(record.id) ? 1 : 0,
    },
    contact: summary
      ? {
          status: summary.status,
          lastContactAt: summary.lastContactAt,
          lastTouchText: summary.lastTouchText,
          connections: summary.connections.map((c) => c.name),
        }
      : null,
  });
}

/* ------------------------------------------------------------ preview card */

/**
 * One shape for every Ctrl+K result's hover preview, Affinity-style: a CRM
 * record, a mail-only person, a portfolio company, a deal, a network contact,
 * or a Harmonic person or company. Plain data for the client component.
 */
export interface PreviewCard {
  /** Echo of the request kind. */
  kind: string;
  title: string;
  /** Domain, email, or role line. */
  subtitle: string | null;
  /** Company domain for a logo, else null. */
  logoDomain: string | null;
  /** Initials fallback. */
  avatarText: string;
  status: { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' } | null;
  /** At most 280 characters. */
  description: string | null;
  counts: { label: string; value: number }[];
  lastContact: { at: string; text: string } | null;
  facts: { label: string; value: string }[];
  /** Only http(s) or in-app '/' hrefs. */
  links: { label: string; href: string; external: boolean }[];
  /** Where Enter / the open arrow goes. */
  openHref: string;
  source: 'kraken' | 'affinity' | 'mail' | 'harmonic';
}

export const PREVIEW_KINDS = [
  'crm',
  'mail',
  'portfolio',
  'deal',
  'network',
  'harmonic_person',
  'harmonic_company',
] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];

export interface PreviewRequest {
  kind: PreviewKind;
  key: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const DIGITS = /^\d{1,20}$/;
const DOMAIN =
  /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * `?kind=<k>&key=<v>`, or the older `?id=<recordId>` (a CRM record). Strict:
 * a uuid for crm, portfolio, deal and network; an email address for mail;
 * digits for Harmonic. Anything else is invalid_input (a 400).
 */
export function parsePreviewRequest(params: URLSearchParams): Result<PreviewRequest> {
  const rawKind = params.get('kind');
  const legacyId = params.get('id');
  const kind = (rawKind ?? (legacyId !== null ? 'crm' : '')).trim();
  const key = ((rawKind ? params.get('key') : legacyId) ?? '').trim();
  if (!(PREVIEW_KINDS as readonly string[]).includes(kind)) {
    return err('invalid_input', 'Unknown preview kind.');
  }
  if (!key || key.length > 254) return err('invalid_input', 'Missing or overlong preview key.');
  const k = kind as PreviewKind;
  if (k === 'mail') {
    if (!EMAIL.test(key)) return err('invalid_input', 'That is not an email address.');
    return ok({ kind: k, key: key.toLowerCase() });
  }
  if (k === 'harmonic_person' || k === 'harmonic_company') {
    if (!DIGITS.test(key)) return err('invalid_input', 'That is not a Harmonic id.');
    return ok({ kind: k, key });
  }
  if (!UUID.test(key)) return err('invalid_input', 'That is not a valid id.');
  return ok({ kind: k, key: key.toLowerCase() });
}

/* ----------------------------------------------------------------- helpers */

export function initialsOf(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s@.-]/gu, ' ')
    .split(/[\s@.]+/)
    .filter(Boolean);
  const picked = words.length > 1 ? [words[0], words[1]] : [words[0] ?? '?'];
  return (
    picked
      .map((w) => (w ?? '').charAt(0))
      .join('')
      .toUpperCase() || '?'
  );
}

function clip(value: string | null | undefined, max = 280): string | null {
  if (!value) return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function cleanDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const host = (
    raw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split(/[/?#]/)[0] ?? ''
  ).trim();
  return DOMAIN.test(host) ? host : null;
}

type PreviewLink = PreviewCard['links'][number];

/** Only http(s) and in-app paths; anything else is dropped. */
export function safeLink(label: string, href: string | null | undefined): PreviewLink | null {
  if (!href) return null;
  if (href.startsWith('/')) {
    if (href.startsWith('//') || href.startsWith('/\\')) return null;
    return { label, href, external: false };
  }
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { label, href: url.toString(), external: true };
  } catch {
    return null;
  }
}

function links(...items: (PreviewLink | null)[]): PreviewLink[] {
  const seen = new Set<string>();
  return items.filter((l): l is PreviewLink => {
    if (!l || seen.has(l.href)) return false;
    seen.add(l.href);
    return true;
  });
}

function facts(...pairs: [string, string | null | undefined][]): PreviewCard['facts'] {
  const out: PreviewCard['facts'] = [];
  for (const [label, raw] of pairs) {
    const value = clip(raw, 120);
    if (value) out.push({ label, value });
  }
  return out;
}

const TONE: Record<ContactStatus, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  recent: 'ok',
  losing: 'warn',
  lost: 'bad',
  never: 'neutral',
};

export function statusTag(status: ContactStatus): NonNullable<PreviewCard['status']> {
  return { label: CONTACT_STATUS_LABELS[status], tone: TONE[status] };
}

function dateText(at: string, timezone: string | null | undefined): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return at;
  try {
    return new Date(t).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: timezone || 'UTC',
    });
  } catch {
    return new Date(t).toISOString().slice(0, 10);
  }
}

function lastContactOf(
  at: string | null,
  text: string | null,
  timezone: string | null | undefined,
): PreviewCard['lastContact'] {
  if (!at) return null;
  return { at, text: text?.trim() || `Last contact ${dateText(at, timezone)}` };
}

interface Relationship {
  summary: ContactSummary | null;
  emails: number;
  meetings: number;
}

const NO_RELATIONSHIP: Relationship = { summary: null, emails: 0, meetings: 0 };

interface RelationshipTarget {
  id: string;
  kind: 'person' | 'company';
  name: string;
  domain: string | null;
  emails: string[];
}

/**
 * Status, last contact, connections and email / meeting counts for a person
 * (by addresses) or company (by domain and its people), from the cached
 * relationship index only — never a Gmail call.
 */
async function relationshipOf(
  store: DataStore,
  auth: AuthContext,
  target: RelationshipTarget,
): Promise<Relationship> {
  if (!target.emails.length && !target.domain) return NO_RELATIONSHIP;
  const org = auth.organizationId;
  const integration = await getPrimaryIntegration(store, org).catch(() => null);
  const scope = relationshipScope(auth.profile.email, integration);
  const related = target.emails.map((e) => ({ primary_email: e }));
  const summaries = await contactSummaries(
    store,
    org,
    [{ ...target, related: target.kind === 'company' ? related : [] }],
    scope,
  ).catch(() => null);
  const summary = summaries?.ok ? (summaries.value[target.id] ?? null) : null;
  const index = await getRelationshipIndex(store, org, scope).catch(() => null);
  if (!index?.ok) return { ...NO_RELATIONSHIP, summary };
  const { addresses } = recordAddresses(
    index.value,
    target,
    target.kind === 'company' ? related : [],
  );
  const { evidence } = evidenceFor(index.value, addresses, scope.now ?? new Date());
  return {
    summary,
    emails: evidence.emailsIn + evidence.emailsOut,
    meetings: evidence.meetingsHeld,
  };
}

function relationshipParts(rel: Relationship, timezone: string | null | undefined) {
  return {
    status: rel.summary ? statusTag(rel.summary.status) : null,
    lastContact: rel.summary
      ? lastContactOf(rel.summary.lastContactAt, rel.summary.lastTouchText, timezone)
      : null,
    counts: [
      { label: 'Emails', value: rel.emails },
      { label: 'Meetings', value: rel.meetings },
      { label: 'Connections', value: rel.summary?.connections.length ?? 0 },
    ],
  };
}

function website(raw: string | null | undefined, domain: string | null): string | null {
  return raw ?? (domain ? `https://${domain}` : null);
}

/* ------------------------------------------------------------------- kinds */

/** The CRM preview as a card. Amounts are already LP-safe in `searchPreview`. */
export function cardFromSearchPreview(p: SearchPreview, timezone?: string | null): PreviewCard {
  const domain = p.kind === 'company' ? cleanDomain(p.sub) : null;
  const listNames = p.lists.map((l) => (l.status ? `${l.name} (${l.status})` : l.name));
  return {
    kind: 'crm',
    title: p.name,
    subtitle: p.sub,
    logoDomain: domain,
    avatarText: initialsOf(p.name),
    status: p.contact ? statusTag(p.contact.status) : null,
    description: null,
    counts: [
      { label: 'Lists', value: p.listCount },
      { label: 'Notes', value: p.counts.notes },
      { label: 'Connections', value: p.counts.connections },
      { label: 'Reminders', value: p.counts.reminders },
    ],
    lastContact: p.contact
      ? lastContactOf(p.contact.lastContactAt, p.contact.lastTouchText, timezone)
      : null,
    facts: facts(
      ['Title', p.title],
      ['Industry', p.industry],
      ['Stage', p.stage],
      ['Owner', p.owner],
      ['Amount', p.amount],
      ['Lists', listNames.join(', ') || null],
    ),
    links: links(safeLink('Open profile', p.href), safeLink('Website', website(null, domain))),
    openHref: p.href,
    source: 'affinity',
  };
}

async function mailCard(
  store: DataStore,
  auth: AuthContext,
  email: string,
): Promise<Result<PreviewCard>> {
  const org = auth.organizationId;
  const integration = await getPrimaryIntegration(store, org).catch(() => null);
  const scope = relationshipScope(auth.profile.email, integration);
  const index = await getRelationshipIndex(store, org, scope);
  if (!index.ok) return index;
  const name = nameFor(index.value, email);
  const host = email.slice(email.lastIndexOf('@') + 1);
  const domain = isPersonalDomain(host) ? null : cleanDomain(host);
  const rel = await relationshipOf(store, auth, {
    id: `mail:${email}`,
    kind: 'person',
    name: name ?? email,
    domain: null,
    emails: [email],
  });
  const parts = relationshipParts(rel, auth.profile.timezone);
  const href = personPagePath(email);
  const next = rel.summary?.nextMeetingAt ?? null;
  return ok({
    kind: 'mail',
    title: name ?? email,
    subtitle: email,
    logoDomain: domain,
    avatarText: initialsOf(name ?? email),
    status: parts.status ?? statusTag(contactStatus(null)),
    description: null,
    counts: parts.counts,
    lastContact: parts.lastContact,
    facts: facts(
      ['Company', domain],
      ['Next meeting', next ? dateText(next, auth.profile.timezone) : null],
    ),
    links: links(safeLink('Open profile', href), safeLink('Website', website(null, domain))),
    openHref: href,
    source: 'mail',
  });
}

async function portfolioCard(
  store: DataStore,
  auth: AuthContext,
  id: string,
): Promise<Result<PreviewCard>> {
  const org = auth.organizationId;
  const company = await store.get('portfolio_companies', org, id);
  if (!company) return err('not_found', 'That portfolio company was not found.');
  const contacts = await store
    .list('portfolio_contacts', org, { eq: { portfolio_company_id: id } })
    .catch(() => []);
  const domain = cleanDomain(company.domain ?? company.website);
  const rel = await relationshipOf(store, auth, {
    id: company.id,
    kind: 'company',
    name: company.name,
    domain,
    emails: contacts.map((c) => c.email).filter((e): e is string => !!e),
  });
  const parts = relationshipParts(rel, auth.profile.timezone);
  // The portfolio row's own last contact stands in when mail has none.
  const stored = company.last_contact_at;
  const lastContact = parts.lastContact ?? lastContactOf(stored, null, auth.profile.timezone);
  const status =
    parts.status && rel.summary?.lastContactAt ? parts.status : statusTag(contactStatus(stored));

  const founders = contacts.filter((c) => c.is_founder).map((c) => c.name);
  const href = `/portfolio/${company.id}`;
  return ok({
    kind: 'portfolio',
    title: company.name,
    subtitle: domain,
    logoDomain: domain,
    avatarText: initialsOf(company.name),
    status,
    description: clip(company.description ?? null),
    counts: [{ label: 'Contacts', value: contacts.length }, ...parts.counts],
    lastContact,
    facts: facts(
      ['Stage', company.current_stage],
      ['Sector', company.sector ?? null],
      ['Location', company.geography ?? null],
      ['Latest round', company.latest_round],
      ['Founders', founders.join(', ') || null],
    ),
    links: links(
      safeLink('Open company', href),
      safeLink('Website', website(company.website, domain)),
    ),
    openHref: href,
    source: 'kraken',
  });
}

async function dealCard(
  store: DataStore,
  auth: AuthContext,
  id: string,
): Promise<Result<PreviewCard>> {
  const org = auth.organizationId;
  const deal = await store.get('deals', org, id);
  if (!deal) return err('not_found', 'That deal was not found.');
  const people = await store.list('deal_people', org, { eq: { deal_id: id } }).catch(() => []);
  const domain = cleanDomain(deal.domain ?? deal.website);
  const rel = await relationshipOf(store, auth, {
    id: deal.id,
    kind: 'company',
    name: deal.company_name,
    domain,
    emails: people.map((p) => p.email).filter((e): e is string => !!e),
  });
  const parts = relationshipParts(rel, auth.profile.timezone);
  const href = `/deals/${deal.id}`;
  return ok({
    kind: 'deal',
    title: deal.company_name,
    subtitle: domain,
    logoDomain: domain,
    avatarText: initialsOf(deal.company_name),
    status: parts.status,
    description: clip(deal.product_summary ?? deal.solution ?? null),
    counts: [{ label: 'People', value: people.length }, ...parts.counts],
    lastContact: parts.lastContact,
    facts: facts(
      ['Stage', deal.stage],
      ['Industry', deal.industry ?? deal.vertical],
      ['Round', deal.funding_stage],
      ['Location', deal.geography],
      ['Source', deal.referral_source],
      ['Received', deal.received_at ? dateText(deal.received_at, auth.profile.timezone) : null],
    ),
    links: links(safeLink('Open deal', href), safeLink('Website', website(deal.website, domain))),
    openHref: href,
    source: 'kraken',
  });
}

async function networkCard(
  store: DataStore,
  auth: AuthContext,
  id: string,
): Promise<Result<PreviewCard>> {
  const contact = await store.get('network_contacts', auth.organizationId, id);
  if (!contact) return err('not_found', 'That contact was not found.');
  const email = contact.email?.trim().toLowerCase() || null;
  const host = email ? email.slice(email.lastIndexOf('@') + 1) : null;
  const domain = host && !isPersonalDomain(host) ? cleanDomain(host) : null;
  const rel = email
    ? await relationshipOf(store, auth, {
        id: contact.id,
        kind: 'person',
        name: contact.full_name,
        domain: null,
        emails: [email],
      })
    : NO_RELATIONSHIP;
  const parts = relationshipParts(rel, auth.profile.timezone);
  const href = `/network?q=${encodeURIComponent(contact.full_name)}`;
  const role = [contact.title, contact.company].filter(Boolean).join(' at ') || null;
  return ok({
    kind: 'network',
    title: contact.full_name,
    subtitle: role ?? email,
    logoDomain: domain,
    avatarText: initialsOf(contact.full_name),
    status: email ? (parts.status ?? statusTag('never')) : null,
    description: clip(contact.notes),
    counts: parts.counts,
    lastContact: parts.lastContact,
    facts: facts(
      ['Title', contact.title],
      ['Company', contact.company],
      ['Email', email],
      ['Relationship', contact.relationship],
      ['Location', contact.geography],
      ['Expertise', (contact.expertise ?? []).join(', ') || null],
    ),
    links: links(safeLink('Open in Network', href)),
    openHref: href,
    source: 'kraken',
  });
}

/** A Harmonic detail as a card. Pure, for the route and the tests. */
export function cardFromHarmonic(
  detail: HarmonicDetail,
  requestKind: 'harmonic_person' | 'harmonic_company',
): PreviewCard {
  const href = `/network/harmonic?kind=${detail.kind}&id=${encodeURIComponent(detail.id)}`;
  const title = detail.name ?? (detail.kind === 'person' ? 'Harmonic person' : 'Harmonic company');
  const domain = detail.kind === 'company' ? cleanDomain(detail.domain ?? detail.website) : null;
  const headcount = detail.headcount !== null ? detail.headcount.toLocaleString('en-US') : null;
  return {
    kind: requestKind,
    title,
    subtitle: detail.kind === 'person' ? detail.headline : (domain ?? detail.headline),
    logoDomain: domain,
    avatarText: initialsOf(title),
    status: null,
    description: clip(detail.description ?? (detail.kind === 'company' ? detail.headline : null)),
    counts: [],
    lastContact: null,
    facts:
      detail.kind === 'person'
        ? facts(['Title', detail.title], ['Company', detail.company], ['Location', detail.location])
        : facts(
            ['Stage', detail.stage],
            ['Headcount', headcount],
            ['Total raised', detail.fundingTotal],
            ['Last funding', detail.lastFundingAt],
            ['Founded', detail.foundedYear],
            ['Location', detail.location],
          ),
    links: links(
      safeLink('Open in Kraken', href),
      safeLink('Website', detail.website),
      safeLink('LinkedIn', detail.linkedin),
      safeLink('X / Twitter', detail.twitter),
    ),
    openHref: href,
    source: 'harmonic',
  };
}

/**
 * The hover preview for any Ctrl+K result. Org-scoped by `auth`; reads the
 * database and the cached relationship index, plus one Harmonic call (cached
 * a day, quota-guarded) for the Harmonic kinds. `preview` is the older CRM
 * shape, kept for callers that still read it.
 */
export async function previewCard(
  store: DataStore,
  auth: AuthContext,
  request: PreviewRequest,
): Promise<Result<{ card: PreviewCard; preview?: SearchPreview }>> {
  const wrap = (r: Result<PreviewCard>): Result<{ card: PreviewCard }> =>
    r.ok ? ok({ card: r.value }) : r;
  switch (request.kind) {
    case 'crm': {
      const preview = await searchPreview(store, auth, request.key);
      if (!preview.ok) return preview;
      return ok({
        card: cardFromSearchPreview(preview.value, auth.profile.timezone),
        preview: preview.value,
      });
    }
    case 'mail':
      return wrap(await mailCard(store, auth, request.key));
    case 'portfolio':
      return wrap(await portfolioCard(store, auth, request.key));
    case 'deal':
      return wrap(await dealCard(store, auth, request.key));
    case 'network':
      return wrap(await networkCard(store, auth, request.key));
    case 'harmonic_person':
    case 'harmonic_company': {
      const detail = await harmonicDetail(
        store,
        auth.organizationId,
        request.kind === 'harmonic_person' ? 'person' : 'company',
        request.key,
      );
      if (!detail.ok) return detail;
      return ok({ card: cardFromHarmonic(detail.value, request.kind) });
    }
    default:
      return err('invalid_input', 'Unknown preview kind.');
  }
}
