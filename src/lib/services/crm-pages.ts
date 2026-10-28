import 'server-only';
import {
  foundersByCompany,
  companyNamesOf,
  roleOf,
  type FounderInput,
  type FounderMatch,
} from '@/lib/crm/founders';
import type { PipelineEntryInput } from '@/lib/crm/pipeline-merge';
import { isRoleInbox } from '@/lib/portfolio/contacts';
import { affinityLpStage } from '@/lib/crm/stage-map';
import { crmNameKey, statusFieldOf } from '@/lib/crm/fields';
import type { CrmDestination } from '@/lib/crm/destinations';
import { chunk } from '@/lib/db/paging';
import type { DataStore, Filter, QueryOptions } from '@/lib/db/store';
import { log } from '@/lib/security/redact';
import {
  countEntriesByStatus,
  crmGuard,
  isCrmNotSetUp,
  type CrmRecordSummary,
} from '@/lib/services/crm';
import {
  listsFor,
  type CrmDestinationEntry,
  type CrmDestinationList,
} from '@/lib/services/crm-destinations';
import type { LpStage } from '@/lib/services/follow-ups';
import type { CrmField, CrmList, CrmListEntry, CrmNote, CrmRecord } from '@/lib/types/domain';
import { normalizeDomain } from '@/lib/util/text';
import { ok, type Result } from '@/lib/util/result';

/**
 * What the Records pages read from the Affinity data, beyond one page of a
 * destination's entries (`crm-destinations.ts`): the whole deal pipeline to
 * merge with Kraken's deals, founders for the portfolio cards, the LP stage
 * counts, the people directory, the notes stream, and one company's Affinity
 * side for a deal or portfolio profile.
 *
 * Same contract as the rest of the CRM services: store and organization
 * first, a Result back, nothing thrown, and a missing CRM table read as "not
 * set up" (`isCrmNotSetUp`). The helpers a profile page only decorates itself
 * with (`affinityForCompany`, `portfolioFounders`) never fail at all: on any
 * fault they return nothing and the page renders as it did before Affinity.
 */

const PAGE = 1000;

/** The most entries a whole-destination read takes: well past any pipeline Affinity holds. */
export const DESTINATION_ROWS_CAP = 5000;

const NEWEST_FIRST: NonNullable<QueryOptions['orderBy']> = [
  { field: 'updated_at', direction: 'desc' },
  { field: 'id', direction: 'asc' },
];

const RECORD_READS_AT_ONCE = 4;

async function recordsById(
  store: DataStore,
  organizationId: string,
  ids: readonly string[],
): Promise<Record<string, CrmRecord>> {
  const out: Record<string, CrmRecord> = {};
  // A few chunks at a time: a whole destination can name thousands of records.
  const groups = chunk([...new Set(ids)], 100);
  for (let i = 0; i < groups.length; i += RECORD_READS_AT_ONCE) {
    const pages = await Promise.all(
      groups
        .slice(i, i + RECORD_READS_AT_ONCE)
        .map((group) => store.list('crm_records', organizationId, { in: { id: group } })),
    );
    for (const r of pages.flat()) out[r.id] = r;
  }
  return out;
}

function summarize(record: CrmRecord): CrmRecordSummary {
  const { id, kind, name, domain, primary_email } = record;
  return { id, kind, name, domain, primary_email };
}

export interface DestinationRows {
  lists: CrmDestinationList[];
  entries: CrmDestinationEntry[];
  /** The full records the entries point at, by id. */
  records: Record<string, CrmRecord>;
  /** More entries exist than `DESTINATION_ROWS_CAP`; the newest were read. */
  truncated: boolean;
}

/**
 * Every entry of a destination's lists, newest first, with its records. For
 * the views that need the whole set at once (merging a pipeline, matching
 * founders), not for a paged table: that is `entriesFor`.
 */
export async function readDestinationRows(
  store: DataStore,
  organizationId: string,
  destination: CrmDestination | readonly CrmDestination[],
  options: { cap?: number } = {},
): Promise<Result<DestinationRows>> {
  const found = await listsFor(store, organizationId, destination);
  if (!found.ok) return found;
  return crmGuard('read', 'read a CRM destination', async () => {
    const lists = found.value;
    if (lists.length === 0) return ok({ lists, entries: [], records: {}, truncated: false });
    const cap = Math.max(1, Math.min(options.cap ?? DESTINATION_ROWS_CAP, DESTINATION_ROWS_CAP));
    const filter: Filter = { in: { list_id: lists.map((l) => l.id) } };
    const rows: CrmListEntry[] = [];
    let truncated = false;
    for (let offset = 0; ; offset += PAGE) {
      const page = await store.list('crm_list_entries', organizationId, filter, {
        orderBy: NEWEST_FIRST,
        limit: Math.min(PAGE, cap - rows.length),
        offset,
      });
      rows.push(...page);
      if (rows.length >= cap) {
        truncated = (await store.count('crm_list_entries', organizationId, filter)) > rows.length;
        break;
      }
      if (page.length < PAGE) break;
    }
    const records = await recordsById(
      store,
      organizationId,
      rows.map((e) => e.record_id).filter((id): id is string => Boolean(id)),
    );
    const listById = new Map(lists.map((l) => [l.id, l]));
    const entries: CrmDestinationEntry[] = [];
    for (const entry of rows) {
      const list = listById.get(entry.list_id);
      if (!list) continue;
      const field = statusFieldOf(list);
      const raw = field ? entry.values[field.key] : undefined;
      const record = entry.record_id ? records[entry.record_id] : undefined;
      entries.push({
        entry,
        list: { id: list.id, name: list.name, entity_type: list.entity_type },
        record: record ? summarize(record) : null,
        status: typeof raw === 'string' && raw ? raw : null,
      });
    }
    return ok({ lists, entries, records, truncated });
  });
}

/* ------------------------------------------------------------------- deals */

export interface AffinityDealRows {
  lists: CrmDestinationList[];
  entries: PipelineEntryInput[];
  truncated: boolean;
}

/** Affinity's deal-list entries in the shape the pipeline merge takes. */
export async function affinityDealRows(
  store: DataStore,
  organizationId: string,
): Promise<Result<AffinityDealRows>> {
  const read = await readDestinationRows(store, organizationId, 'deals');
  if (!read.ok) return read;
  const { lists, entries, truncated } = read.value;
  return ok({
    lists,
    truncated,
    entries: entries.map(({ entry, list, record, status }): PipelineEntryInput => ({
      entryId: entry.id,
      listId: list.id,
      listName: list.name,
      title: entry.title,
      recordId: record?.id ?? null,
      recordName: record?.name ?? null,
      domain: record?.domain ?? null,
      status,
      updatedAt: entry.updated_at,
    })),
  });
}

/* --------------------------------------------------------------- portfolio */

/** The founder-matching input for each entry of a read of founder lists. */
function founderInputs(rows: DestinationRows): FounderInput[] {
  const { lists, entries, records } = rows;
  const fieldsByList = new Map<string, CrmField[]>(lists.map((l) => [l.id, l.fields]));
  return entries.map(({ entry, list }) => {
    const fields = fieldsByList.get(list.id) ?? [];
    const record = entry.record_id ? records[entry.record_id] : undefined;
    const jobTitle = record?.fields['Job Title'];
    return {
      entryId: entry.id,
      recordId: record?.id ?? null,
      name: record?.name ?? entry.title,
      kind: record?.kind ?? (list.entity_type === 'company' ? 'company' : null),
      emails: record?.emails ?? [],
      companyNames: companyNamesOf(fields, entry.values),
      role: roleOf(fields, entry.values) ?? (typeof jobTitle === 'string' ? jobTitle : null),
    };
  });
}

/**
 * Affinity's portfolio founders per portfolio company id. Never fails: when
 * the CRM is not set up or cannot be read, the cards simply show no founders.
 */
export async function portfolioFounders(
  store: DataStore,
  organizationId: string,
  companies: readonly { id: string; name: string; domain: string | null }[],
): Promise<Record<string, FounderMatch[]>> {
  if (companies.length === 0) return {};
  const read = await readDestinationRows(store, organizationId, 'portfolio_people', {
    cap: 2000,
  });
  if (!read.ok) {
    if (!isCrmNotSetUp(read)) {
      log.warn('Portfolio founders could not be read', { reason: read.error.message });
    }
    return {};
  }
  return foundersByCompany(companies, founderInputs(read.value));
}

/** One person Affinity ties to a portfolio company. */
export interface CompanyCrmPerson {
  recordId: string | null;
  name: string;
  role: string | null;
  /** Their address at the company's domain when they have one, else their first. */
  email: string | null;
  /** On a portfolio founder list, rather than a person record found at the domain. */
  founder: boolean;
  matchedBy: 'domain' | 'name';
}

/** People records looked up per company domain, at most this many at once. */
const DOMAIN_LOOKUPS_AT_ONCE = 6;
const PEOPLE_PER_DOMAIN = 25;

/**
 * The people Affinity ties to each portfolio company, by company id: rows of
 * the lists that feed Portfolio (founder lists and the angel list) matched by
 * work email domain or the entry's company column, then any person record
 * whose email is at the company's domain. Domain first, exact normalized
 * name second, never fuzzy (`foundersByCompany`). Never fails: none on a
 * fault or when the CRM is not set up.
 */
export async function portfolioCrmPeople(
  store: DataStore,
  organizationId: string,
  companies: readonly { id: string; name: string; domain: string | null }[],
): Promise<Record<string, CompanyCrmPerson[]>> {
  if (companies.length === 0) return {};
  const out: Record<string, CompanyCrmPerson[]> = {};
  const add = (companyId: string, person: CompanyCrmPerson) => {
    const list = (out[companyId] ??= []);
    const same = list.find(
      (p) =>
        (person.recordId && p.recordId === person.recordId) ||
        (person.email && p.email === person.email),
    );
    if (same) {
      same.founder ||= person.founder;
      same.role ??= person.role;
      return;
    }
    list.push(person);
  };
  const domainOf = new Map(companies.map((c) => [c.id, normalizeDomain(c.domain)]));
  const emailAt = (emails: readonly string[], domain: string | null): string | null => {
    const lower = emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@'));
    return (domain && lower.find((e) => e.endsWith(`@${domain}`))) || lower[0] || null;
  };

  const read = await readDestinationRows(store, organizationId, ['portfolio_people', 'angel'], {
    cap: 2000,
  });
  if (!read.ok) {
    if (!isCrmNotSetUp(read)) {
      log.warn('Portfolio people could not be read', { reason: read.error.message });
    }
    return {};
  }
  const founderListIds = new Set(
    read.value.lists
      .filter((l) => l.destination.destination === 'portfolio_people')
      .map((l) => l.id),
  );
  const inputs = founderInputs(read.value);
  const entryList = new Map(read.value.entries.map((e) => [e.entry.id, e.list.id]));
  const emailsByEntry = new Map(inputs.map((i) => [i.entryId, i.emails]));
  for (const [companyId, matches] of Object.entries(foundersByCompany(companies, inputs))) {
    for (const m of matches) {
      add(companyId, {
        recordId: m.recordId,
        name: m.name,
        role: m.role,
        email: emailAt(emailsByEntry.get(m.entryId) ?? [], domainOf.get(companyId) ?? null),
        founder: founderListIds.has(entryList.get(m.entryId) ?? ''),
        matchedBy: m.matchedBy,
      });
    }
  }

  // Person records at each company's domain, the way a profile finds them.
  const withDomain = companies.filter((c) => domainOf.get(c.id));
  const looked = await crmGuard('read', 'read people at portfolio domains', async () => {
    for (const group of chunk(withDomain, DOMAIN_LOOKUPS_AT_ONCE)) {
      const found = await Promise.all(
        group.map(async (c) => {
          const domain = domainOf.get(c.id) as string;
          const rows = await store.list(
            'crm_records',
            organizationId,
            {
              eq: { kind: 'person' },
              textSearch: { columns: ['primary_email'], query: `@${domain}` },
            },
            { orderBy: [{ field: 'name', direction: 'asc' }], limit: PEOPLE_PER_DOMAIN },
          );
          return { c, domain, rows };
        }),
      );
      for (const { c, domain, rows } of found) {
        for (const r of rows) {
          if (!r.primary_email?.toLowerCase().endsWith(`@${domain}`)) continue;
          // Affinity makes a person record for every address that writes
          // ("Ledgerly Support" at support@): a role inbox is nobody.
          if (isRoleInbox(r.primary_email)) continue;
          const title = r.fields['Job Title'];
          add(c.id, {
            recordId: r.id,
            name: r.name,
            role: typeof title === 'string' && title.trim() ? title.trim() : null,
            email: emailAt(r.emails.length ? r.emails : [r.primary_email], domain),
            founder: false,
            matchedBy: 'domain',
          });
        }
      }
    }
    return ok(true);
  });
  if (!looked.ok && !isCrmNotSetUp(looked)) {
    log.warn('People at portfolio domains could not be read', { reason: looked.error.message });
  }
  return out;
}

/* --------------------------------------------------------------------- LPs */

export type LpChipKey = LpStage | 'other';

export interface LpStageCount {
  key: LpChipKey;
  count: number;
  /** The Affinity labels that read as this stage, across the lists: the status filter for it. */
  labels: string[];
}

export interface LpStageCounts {
  stages: LpStageCount[];
  /** Entries with no stage at all. */
  none: number;
  total: number;
}

const LP_CHIP_ORDER: readonly LpChipKey[] = [
  'target',
  'contacted',
  'meeting',
  'materials',
  'soft_commit',
  'committed',
  'passed',
  'other',
];

/**
 * How many Affinity LP entries sit at each of Kraken's LP stages, reading
 * each list's own stage labels (`affinityLpStage`). One count per label per
 * list, narrowed by the same title search as the table.
 */
export async function lpStageCounts(
  store: DataStore,
  organizationId: string,
  lists: readonly Pick<CrmList, 'id'>[],
  options: { query?: string | null } = {},
): Promise<Result<LpStageCounts>> {
  const byKey = new Map<LpChipKey, { count: number; labels: Set<string> }>();
  let none = 0;
  let total = 0;
  for (const list of lists) {
    const counted = await countEntriesByStatus(store, organizationId, list.id, {
      query: options.query,
    });
    if (!counted.ok) return counted;
    total += counted.value.total;
    if (!counted.value.field) {
      none += counted.value.total;
      continue;
    }
    none += counted.value.none;
    for (const [label, count] of Object.entries(counted.value.counts)) {
      const key: LpChipKey = affinityLpStage(label) ?? 'other';
      const slot = byKey.get(key) ?? { count: 0, labels: new Set<string>() };
      slot.count += count;
      slot.labels.add(label);
      byKey.set(key, slot);
    }
  }
  return ok({
    stages: LP_CHIP_ORDER.filter((k) => byKey.has(k)).map((key) => {
      const slot = byKey.get(key) as { count: number; labels: Set<string> };
      return { key, count: slot.count, labels: [...slot.labels] };
    }),
    none,
    total,
  });
}

/* ------------------------------------------------------------------ people */

export interface CrmPeoplePage {
  people: CrmRecord[];
  total: number;
}

/** People in the CRM, A to Z, optionally narrowed by name or email; one page from `offset`. */
export async function listCrmPeople(
  store: DataStore,
  organizationId: string,
  options: { query?: string | null; limit?: number; offset?: number } = {},
): Promise<Result<CrmPeoplePage>> {
  return crmGuard('read', 'list CRM people', async () => {
    const text = options.query?.trim().slice(0, 200);
    const filter: Filter = {
      eq: { kind: 'person' },
      ...(text ? { textSearch: { columns: ['name', 'primary_email'], query: text } } : {}),
    };
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const [people, total] = await Promise.all([
      store.list('crm_records', organizationId, filter, {
        orderBy: [
          { field: 'name', direction: 'asc' },
          { field: 'id', direction: 'asc' },
        ],
        limit,
        offset,
      }),
      store.count('crm_records', organizationId, filter),
    ]);
    return ok({ people, total });
  });
}

/* ------------------------------------------------------------------- notes */

export interface CrmNotesPage {
  notes: CrmNote[];
  total: number;
  /** The records each note is about, by note id, for links to their profiles. */
  about: Record<string, { id: string; name: string }[]>;
}

const NOTE_ORDER: NonNullable<QueryOptions['orderBy']> = [
  { field: 'occurred_at', direction: 'desc' },
  { field: 'created_at', direction: 'desc' },
  { field: 'id', direction: 'asc' },
];

/** Affinity's notes, newest first (undated ones last), optionally searched; one page from `offset`. */
export async function listAffinityNotes(
  store: DataStore,
  organizationId: string,
  options: { query?: string | null; limit?: number; offset?: number } = {},
): Promise<Result<CrmNotesPage>> {
  return crmGuard('read', 'list Affinity notes', async () => {
    const text = options.query?.trim().slice(0, 200);
    const filter: Filter = {
      eq: { source: 'affinity' },
      ...(text ? { textSearch: { columns: ['title', 'content', 'author'], query: text } } : {}),
    };
    const limit = Math.max(1, Math.min(options.limit ?? 25, 500));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const [notes, total] = await Promise.all([
      store.list('crm_notes', organizationId, filter, { orderBy: NOTE_ORDER, limit, offset }),
      store.count('crm_notes', organizationId, filter),
    ]);
    const records = await recordsById(
      store,
      organizationId,
      notes.flatMap((n) => n.record_ids),
    );
    const about: CrmNotesPage['about'] = {};
    for (const note of notes) {
      const subjects = note.record_ids
        .map((id) => records[id])
        .filter((r): r is CrmRecord => Boolean(r))
        .map((r) => ({ id: r.id, name: r.name }));
      if (subjects.length) about[note.id] = subjects;
    }
    return ok({ notes, total, about });
  });
}

/* ------------------------------------------------------------ one company */

export interface CompanyAffinityMembership {
  entry: CrmListEntry;
  list: Pick<CrmList, 'id' | 'name' | 'entity_type'>;
  /** The entry's stage on its list, and what that field is called. */
  status: string | null;
  statusName: string | null;
}

export interface CompanyAffinity {
  /** The company's own records (more than one when Affinity held duplicates). */
  companies: CrmRecordSummary[];
  /** Its people: records whose email is at the company's domain. */
  people: CrmRecordSummary[];
  memberships: CompanyAffinityMembership[];
  /** Notes on the company, its people or its entries, newest first. */
  notes: CrmNote[];
}

/**
 * Everything Affinity holds about one company Kraken already knows (a deal,
 * a portfolio company): its record by domain (else exact name), its people at
 * that domain, the lists it is on with its stage, and the notes. Read-only,
 * and never fails: null when there is nothing, the CRM is not set up, or it
 * cannot be read, so the profile renders as it would without Affinity.
 */
export async function affinityForCompany(
  store: DataStore,
  organizationId: string,
  company: { name: string; domain: string | null },
  options: { noteLimit?: number } = {},
): Promise<CompanyAffinity | null> {
  const result = await crmGuard('read', 'read a company from Affinity', async () => {
    const domain = normalizeDomain(company.domain);
    let companies: CrmRecord[] = [];
    if (domain) {
      companies = await store.list(
        'crm_records',
        organizationId,
        { eq: { kind: 'company', domain } },
        { limit: 5 },
      );
    }
    if (companies.length === 0) {
      const key = crmNameKey(company.name);
      if (key) {
        companies = await store.list(
          'crm_records',
          organizationId,
          { eq: { kind: 'company', name_key: key } },
          { limit: 5 },
        );
      }
    }
    const atDomain = domain ?? companies.find((c) => c.domain)?.domain ?? null;
    const people = atDomain
      ? (
          await store.list(
            'crm_records',
            organizationId,
            {
              eq: { kind: 'person' },
              textSearch: { columns: ['primary_email'], query: `@${atDomain}` },
            },
            { orderBy: [{ field: 'name', direction: 'asc' }], limit: 20 },
          )
        ).filter((p) => p.primary_email?.endsWith(`@${atDomain}`))
      : [];
    if (companies.length === 0 && people.length === 0) return ok(null);

    const companyIds = companies.map((c) => c.id);
    const entries = companyIds.length
      ? await store.list(
          'crm_list_entries',
          organizationId,
          { in: { record_id: companyIds } },
          { orderBy: NEWEST_FIRST, limit: 50 },
        )
      : [];
    const lists = entries.length
      ? await store.list('crm_lists', organizationId, {
          in: { id: [...new Set(entries.map((e) => e.list_id))] },
        })
      : [];
    const listById = new Map(lists.map((l) => [l.id, l]));
    const memberships: CompanyAffinityMembership[] = [];
    for (const entry of entries) {
      const list = listById.get(entry.list_id);
      if (!list || list.archived) continue;
      const field = statusFieldOf(list);
      const raw = field ? entry.values[field.key] : undefined;
      memberships.push({
        entry,
        list: { id: list.id, name: list.name, entity_type: list.entity_type },
        status: typeof raw === 'string' && raw ? raw : null,
        statusName: field?.name ?? null,
      });
    }

    const noteLimit = Math.max(1, Math.min(options.noteLimit ?? 10, 100));
    const noteOrder: QueryOptions = { orderBy: NOTE_ORDER, limit: noteLimit };
    const recordIds = [...companyIds, ...people.map((p) => p.id)];
    const groups = await Promise.all([
      recordIds.length
        ? store.list(
            'crm_notes',
            organizationId,
            { arrayOverlaps: { record_ids: recordIds } },
            noteOrder,
          )
        : Promise.resolve([] as CrmNote[]),
      entries.length
        ? store.list(
            'crm_notes',
            organizationId,
            { arrayOverlaps: { entry_ids: entries.map((e) => e.id) } },
            noteOrder,
          )
        : Promise.resolve([] as CrmNote[]),
    ]);
    const byId = new Map<string, CrmNote>();
    for (const note of groups.flat()) byId.set(note.id, note);
    const notes = [...byId.values()]
      .sort((a, b) => {
        const at = a.occurred_at ?? '';
        const bt = b.occurred_at ?? '';
        if (at !== bt) return at < bt ? 1 : -1;
        return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
      })
      .slice(0, noteLimit);

    return ok({
      companies: companies.map(summarize),
      people: people.map(summarize),
      memberships,
      notes,
    });
  });
  if (!result.ok) {
    if (!isCrmNotSetUp(result)) {
      log.warn('A company could not be read from Affinity', { reason: result.error.message });
    }
    return null;
  }
  return result.value;
}
