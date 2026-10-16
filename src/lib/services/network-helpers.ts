import 'server-only';
import { CRM_DESTINATION_INFO, type CrmDestination } from '@/lib/crm/destinations';
import { companyNamesOf, roleOf } from '@/lib/crm/founders';
import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { evidenceFor } from '@/lib/network/evidence';
import {
  candidateFromContact,
  mergeCandidates,
  suggestHelpers,
  MAX_HELPERS,
  type HelperCandidate,
  type HelperKind,
  type HelperSource,
} from '@/lib/network/helpers';
import { companyDomain } from '@/lib/portfolio/contacts';
import { log } from '@/lib/security/redact';
import type {
  CrmField,
  CrmRecord,
  CrmValue,
  NetworkContact,
  PortfolioCompany,
  PortfolioUpdate,
} from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { crmGuard, isCrmNotSetUp } from './crm';
import { readDestinationRows, DESTINATION_ROWS_CAP } from './crm-pages';
import { listsFor, type CrmDestinationList } from './crm-destinations';
import { getRelationshipIndex } from './relationships';
import type { AffinityAtTarget } from './warm-paths';
import { ok } from '@/lib/util/result';

/**
 * The network that "who could help" draws on (`lib/network/helpers.ts` has
 * the rules): the contacts imported by hand, plus the people Affinity carried
 * over on the lists that feed Network (investors, service providers,
 * operators, events) and the portfolio founder lists. Service-provider firms
 * count too, as firms. Fund II's LP lists never do: they are not a pool of
 * helpers, and nothing about an LP is shown here.
 *
 * Read when a page asks and cached per organization for ten minutes: the
 * lists can hold thousands of rows. Never fails: a source that cannot be
 * read is left out (logged), so suggestions shrink rather than break.
 */

export const HELPER_DESTINATIONS: readonly CrmDestination[] = [
  'investors',
  'providers',
  'operators',
  'events',
  'portfolio_people',
];

const TTL_MS = 10 * 60_000;
/** After Affinity could not be read, the pool (imported contacts only) is kept this long. */
const FAULT_TTL_MS = 60_000;

const cache = processWide(
  'network-helpers',
  () => new Map<string, { at: number; candidates: HelperCandidate[] }>(),
);
/** The read running per organization: a page and a badge asking at once share one. */
const loading = processWide(
  'network-helpers-loading',
  () => new Map<string, Promise<HelperCandidate[]>>(),
);

/** Test hook. */
export function resetHelperCandidates(): void {
  cache.clear();
  loading.clear();
}

const SKIP_DETAIL_TYPES = new Set<CrmField['type']>(['money', 'number', 'date', 'email', 'url']);
const SKIP_RECORD_FIELD = /e-?mail|phone|url|linkedin|website|address|amount|commit|size|\$/i;
const RELATIONSHIP_FIELD = /relationship|warmth|strength|connection|closeness/i;

function textValues(value: CrmValue | undefined): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter(Boolean);
  return [];
}

function recordTitle(record: CrmRecord | undefined): string | null {
  for (const key of ['Job Title', 'Title', 'Role', 'Position']) {
    const v = record?.fields[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function recordOrganization(record: CrmRecord | undefined): string | null {
  for (const key of ['Organization', 'Organizations', 'Company', 'Current Organization']) {
    const [first] = textValues(record?.fields[key]);
    if (first) return first;
  }
  return null;
}

/** One entry of a helper list as a candidate; null for rows that are neither people nor provider firms. */
export function candidateFromEntry(
  entry: { id: string; title: string; values: Record<string, CrmValue> },
  list: Pick<CrmDestinationList, 'name' | 'entity_type' | 'fields'> & {
    destination: CrmDestination;
  },
  record: CrmRecord | undefined,
): HelperCandidate | null {
  const isPerson = record ? record.kind === 'person' : list.entity_type === 'person';
  const kind: HelperKind | null = isPerson
    ? 'person'
    : list.destination === 'providers' && (record?.kind ?? list.entity_type) === 'company'
      ? 'firm'
      : null;
  if (!kind) return null;
  const details: string[] = [];
  let relationship: string | null = null;
  for (const field of list.fields) {
    if (SKIP_DETAIL_TYPES.has(field.type)) continue;
    const values = textValues(entry.values[field.key]);
    if (!values.length) continue;
    if (!relationship && RELATIONSHIP_FIELD.test(field.name)) relationship = values[0] ?? null;
    details.push(...values);
  }
  for (const [key, value] of Object.entries(record?.fields ?? {})) {
    if (SKIP_RECORD_FIELD.test(key)) continue;
    details.push(...textValues(value));
  }
  return {
    key: record ? `record:${record.id}` : `entry:${entry.id}`,
    source: 'affinity',
    kind,
    name: record?.name ?? entry.title,
    email: record?.primary_email?.trim().toLowerCase() || null,
    title: kind === 'person' ? (recordTitle(record) ?? roleOf(list.fields, entry.values)) : null,
    company:
      kind === 'person'
        ? (companyNamesOf(list.fields, entry.values)[0] ?? recordOrganization(record))
        : null,
    recordId: record?.id ?? null,
    contactId: null,
    lists: [{ name: list.name, destination: list.destination }],
    relationship,
    expertise: [],
    details,
  };
}

/** Every candidate helper in the organization's network, cached for ten minutes. Never throws. */
export async function loadHelperCandidates(
  store: DataStore,
  organizationId: string,
  options: { now?: Date; force?: boolean } = {},
): Promise<HelperCandidate[]> {
  const now = (options.now ?? new Date()).getTime();
  const hit = cache.get(organizationId);
  if (!options.force && hit && now - hit.at >= 0 && now - hit.at < TTL_MS) return hit.candidates;
  const running = loading.get(organizationId);
  if (running) return running;
  const run = readHelperCandidates(store, organizationId, now).finally(() => {
    loading.delete(organizationId);
  });
  loading.set(organizationId, run);
  return run;
}

async function readHelperCandidates(
  store: DataStore,
  organizationId: string,
  now: number,
): Promise<HelperCandidate[]> {
  const [imported, read] = await Promise.all([
    (
      listAllPages(store, 'network_contacts', organizationId, {}, [
        { field: 'full_name', direction: 'asc' },
      ]) as Promise<NetworkContact[]>
    ).catch((error: unknown) => {
      log.warn('Network contacts could not be read', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return [] as NetworkContact[];
    }),
    readDestinationRows(store, organizationId, HELPER_DESTINATIONS, { cap: DESTINATION_ROWS_CAP }),
  ]);
  const affinity: HelperCandidate[] = [];
  if (read.ok) {
    const listById = new Map(read.value.lists.map((l) => [l.id, l]));
    for (const { entry, list } of read.value.entries) {
      const full = listById.get(list.id);
      if (!full) continue;
      const record = entry.record_id ? read.value.records[entry.record_id] : undefined;
      const candidate = candidateFromEntry(
        entry,
        { ...full, destination: full.destination.destination },
        record,
      );
      if (candidate) affinity.push(candidate);
    }
  }
  const fault = !read.ok && !isCrmNotSetUp(read);
  if (!read.ok && fault) {
    log.warn('Affinity people for introductions could not be read', {
      reason: read.error.message,
    });
  }
  const candidates = mergeCandidates(imported.map(candidateFromContact), affinity);
  // A fault is tried again in a minute rather than ten.
  cache.set(organizationId, { at: fault ? now - (TTL_MS - FAULT_TTL_MS) : now, candidates });
  if (cache.size > 50) cache.delete(cache.keys().next().value as string);
  return candidates;
}

/** Someone who could help with one request, as the card shows them. */
export interface RequestHelper {
  key: string;
  name: string;
  title: string | null;
  company: string | null;
  source: HelperSource;
  kind: HelperKind;
  /** Their Affinity profile, for a link. */
  recordId: string | null;
  /** Why, each from the data. */
  reasons: string[];
  lastContactAt: string | null;
  /** Chosen when the request was classified (from the imported contacts), not matched now. */
  stored: boolean;
}

/**
 * Who could help with each request, by request id, at most three each: the
 * contacts chosen when a request was classified first, as before, then the
 * people the rules find across the whole network. Never throws.
 */
export async function helpersForRequests(
  store: DataStore,
  organizationId: string,
  requests: readonly PortfolioUpdate[],
  companies: readonly PortfolioCompany[],
  options: { now?: Date } = {},
): Promise<Record<string, RequestHelper[]>> {
  if (requests.length === 0) return {};
  const now = options.now ?? new Date();
  const [candidates, indexed] = await Promise.all([
    loadHelperCandidates(store, organizationId, { now }),
    getRelationshipIndex(store, organizationId, { ownAddresses: [], now }).catch(() => null),
  ]);
  const index = indexed?.ok ? indexed.value : null;
  const seen = new Map<string, string | null>();
  const lastContact = (c: HelperCandidate): string | null => {
    if (!index || !c.email) return null;
    if (!seen.has(c.email)) {
      seen.set(c.email, evidenceFor(index, [c.email], now).evidence.lastContactAt);
    }
    return seen.get(c.email) ?? null;
  };
  const byContact = new Map(
    candidates.filter((c) => c.contactId).map((c) => [c.contactId as string, c]),
  );

  const out: Record<string, RequestHelper[]> = {};
  for (const request of requests) {
    const stored: RequestHelper[] = [];
    for (const id of request.suggested_network_contact_ids) {
      const c = byContact.get(id);
      if (!c || stored.some((s) => s.key === c.key)) continue;
      stored.push({
        key: c.key,
        name: c.name,
        title: c.title,
        company: c.company,
        source: c.source,
        kind: c.kind,
        recordId: c.recordId,
        reasons: [
          [c.relationship, c.title, c.company].filter(Boolean).join(', ') ||
            'In the contacts you imported',
        ],
        lastContactAt: lastContact(c),
        stored: true,
      });
    }
    const company = companies.find((c) => c.id === request.portfolio_company_id) ?? null;
    const matched = suggestHelpers(
      {
        requestType: request.request_type,
        text: [request.summary, request.request_detail].filter(Boolean).join('\n'),
        company: company ? { name: company.name, domain: companyDomain(company) } : null,
      },
      candidates,
      {
        now,
        lastContact,
        exclude: new Set(stored.map((s) => s.key)),
        max: Math.max(0, MAX_HELPERS - stored.length),
      },
    );
    out[request.id] = [
      ...stored.slice(0, MAX_HELPERS),
      ...matched.map((m): RequestHelper => ({
        key: m.candidate.key,
        name: m.candidate.name,
        title: m.candidate.title,
        company: m.candidate.company,
        source: m.candidate.source,
        kind: m.candidate.kind,
        recordId: m.candidate.recordId,
        reasons: m.reasons,
        lastContactAt: m.lastContactAt,
        stored: false,
      })),
    ];
  }
  return out;
}

/* ------------------------------------------------------------- summary */

export interface NetworkSummary {
  /** Contacts imported by hand; null when they cannot be counted. */
  imported: number | null;
  /**
   * People from Affinity that "who could help" draws on (matching `query`
   * when given): each person once, on the lists that feed introductions, and
   * not already an imported contact. Never the LP, deal or sourcing lists.
   */
  affinityPeople: number;
  /** Service-provider firms from Affinity in the same pool (matching `query`). */
  affinityFirms: number;
  /** Rows on the lists that feed introductions, per destination, in display order. */
  destinations: { destination: CrmDestination; label: string; href: string; count: number }[];
}

/** The pool's Affinity people and firms, matching `query` (name, role, company or address) when given. */
function affinityPool(
  candidates: readonly HelperCandidate[],
  query: string | null,
): { people: number; firms: number } {
  const q = query?.trim().toLowerCase() ?? '';
  let people = 0;
  let firms = 0;
  for (const c of candidates) {
    if (c.source !== 'affinity') continue;
    if (q && ![c.name, c.title, c.company, c.email].some((v) => v?.toLowerCase().includes(q))) {
      continue;
    }
    if (c.kind === 'firm') firms += 1;
    else people += 1;
  }
  return { people, firms };
}

/**
 * How many people from Affinity the introductions pool holds, when it was
 * read in the last ten minutes; null when it was not (nothing is read here).
 * For a tab badge, which must not wait on a read of thousands of rows.
 */
export function cachedAffinityPoolSize(
  organizationId: string,
  now: Date = new Date(),
): number | null {
  const hit = cache.get(organizationId);
  const age = now.getTime() - (hit?.at ?? Number.NEGATIVE_INFINITY);
  if (!hit || age < 0 || age >= TTL_MS) return null;
  return affinityPool(hit.candidates, null).people;
}

/**
 * What Knowledge > Contacts counts: both halves of the network introductions
 * draw on, counted from the same pool "who could help" reads (so the number
 * never includes an LP list), and where each list lives.
 */
export async function networkSummary(
  store: DataStore,
  organizationId: string,
  options: { query?: string | null; now?: Date } = {},
): Promise<NetworkSummary> {
  const query = options.query?.trim() || null;
  const [imported, candidates, lists] = await Promise.all([
    store.count('network_contacts', organizationId).catch(() => null),
    loadHelperCandidates(store, organizationId, { now: options.now }),
    listsFor(store, organizationId, HELPER_DESTINATIONS),
  ]);
  const counts = new Map<CrmDestination, number>();
  for (const list of lists.ok ? lists.value : []) {
    const d = list.destination.destination;
    counts.set(d, (counts.get(d) ?? 0) + list.entry_count);
  }
  const pool = affinityPool(candidates, query);
  return {
    imported,
    affinityPeople: pool.people,
    affinityFirms: pool.firms,
    destinations: HELPER_DESTINATIONS.filter((d) => (counts.get(d) ?? 0) > 0).map((d) => ({
      destination: d,
      label: CRM_DESTINATION_INFO[d].label,
      href: CRM_DESTINATION_INFO[d].href,
      count: counts.get(d) ?? 0,
    })),
  };
}

/* ----------------------------------------------------------- warm paths */

const AT_TARGET_MAX = 5;

/**
 * The people Affinity holds at a "Who can intro?" target, with the lists they
 * are on: person records whose address is at one of its domains (or is one
 * of its exact addresses). Names and lists only, never an amount. Never
 * throws: none on a fault or when the CRM is not set up.
 */
export async function affinityPeopleAt(
  store: DataStore,
  organizationId: string,
  target: { domains: readonly string[]; addresses: readonly string[] },
): Promise<AffinityAtTarget[]> {
  const result = await crmGuard('read', 'read Affinity people at a firm', async () => {
    const found = new Map<string, CrmRecord>();
    for (const domain of target.domains.slice(0, 3)) {
      const host = domain.trim().toLowerCase();
      if (!host) continue;
      const rows = await store.list(
        'crm_records',
        organizationId,
        { eq: { kind: 'person' }, textSearch: { columns: ['primary_email'], query: `@${host}` } },
        { orderBy: [{ field: 'name', direction: 'asc' }], limit: AT_TARGET_MAX * 2 },
      );
      for (const r of rows) {
        const at = r.primary_email?.toLowerCase().split('@')[1] ?? '';
        if (at === host || at.endsWith(`.${host}`)) found.set(r.id, r);
      }
    }
    const addresses = target.addresses.map((a) => a.trim().toLowerCase()).filter(Boolean);
    for (const group of chunk(addresses, 50)) {
      for (const r of await store.list('crm_records', organizationId, {
        eq: { kind: 'person' },
        arrayOverlaps: { emails: group },
      })) {
        found.set(r.id, r);
      }
    }
    const people = [...found.values()].slice(0, AT_TARGET_MAX);
    if (people.length === 0) return ok([] as AffinityAtTarget[]);
    const entries = await store.list(
      'crm_list_entries',
      organizationId,
      { in: { record_id: people.map((p) => p.id) } },
      { limit: 200 },
    );
    const lists = entries.length
      ? await store.list('crm_lists', organizationId, {
          in: { id: [...new Set(entries.map((e) => e.list_id))] },
        })
      : [];
    const listName = new Map(lists.filter((l) => !l.archived).map((l) => [l.id, l.name]));
    return ok(
      people.map((p) => ({
        recordId: p.id,
        name: p.name,
        title: recordTitle(p),
        lists: [
          ...new Set(
            entries
              .filter((e) => e.record_id === p.id)
              .map((e) => listName.get(e.list_id))
              .filter((n): n is string => Boolean(n)),
          ),
        ],
      })),
    );
  });
  if (!result.ok) {
    if (!isCrmNotSetUp(result)) {
      log.warn('Affinity people at a firm could not be read', { reason: result.error.message });
    }
    return [];
  }
  return result.value;
}
