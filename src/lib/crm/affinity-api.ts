import { affinityDomain } from '@/lib/crm/affinity-csv';
import { CRM_OPTION_FIELD_TYPES, crmFieldKey, crmNameKey, isCopilotField } from '@/lib/crm/fields';
import type { CrmEntityType, CrmField, CrmFieldType } from '@/lib/types/domain';
import { localClock } from '@/lib/util/time';

/**
 * Affinity's public API (v2), as the daily sync reads it: the response shapes
 * it relies on and the pure mapping from them onto the CRM's rows.
 *
 * Pure and dependency-free, so it is tested without a network or a store. The
 * HTTP side is `lib/services/affinity-client.ts`; the orchestration (state,
 * chunks, upserts) is `lib/services/affinity-sync.ts`.
 *
 * The keys are the ones the CSV import already wrote, so the sync updates what
 * a person imported rather than adding a second copy of it:
 *
 *   - a list is `crm_lists.external_id` = the Affinity list id. The CSV import
 *     never knew it, so the first sync adopts the list of the same name.
 *   - a company or person is `crm_records.external_id` = the Affinity
 *     organization or person id — the export's "Organization Id" / "Person Id".
 *   - a row is `crm_list_entries.external_id` = the Affinity list entry id —
 *     the export's "Affinity Row ID". A row the CSV keyed by entity id
 *     (`entity:<id>`) is adopted and re-keyed by `upsertEntries`.
 *   - a note is `crm_notes.external_id` = the Affinity note id.
 *
 * Shapes are typed loosely on purpose (every field optional, every array
 * nullable): Affinity documents that an empty array comes back as `null`, and
 * a field the sync does not understand must degrade to "not stored", never to
 * an exception halfway through a page.
 */

/* ------------------------------------------------------------------ shapes */

export type AffinityListType = 'company' | 'person' | 'opportunity';

export interface AffinityApiPage<T> {
  data?: T[] | null;
  pagination?: { nextUrl?: string | null; prevUrl?: string | null } | null;
}

export interface AffinityApiList {
  id: number;
  name: string;
  type: AffinityListType | string;
}

export interface AffinityApiFieldMeta {
  /** `field-1234` for a custom field; `affinity-data-…`, `companies`, `persons`… for built-in ones. */
  id: string;
  name: string;
  /** `list`, `global`, `enriched` or `relationship-intelligence`. */
  type?: string | null;
  /** `text`, `number`, `datetime`, `dropdown`, `ranked-dropdown`, `person-multi`… */
  valueType?: string | null;
  enrichmentSource?: string | null;
}

export interface AffinityApiValue {
  type?: string | null;
  data?: unknown;
}

export interface AffinityApiField {
  id: string;
  name?: string | null;
  type?: string | null;
  value?: AffinityApiValue | null;
}

export interface AffinityApiPersonData {
  id: number;
  firstName?: string | null;
  lastName?: string | null;
  primaryEmailAddress?: string | null;
  /** `internal` (a teammate), `external` or `collaborator`. */
  type?: string | null;
}

export interface AffinityApiCompanyData {
  id: number;
  name?: string | null;
  domain?: string | null;
}

export interface AffinityApiCompany extends AffinityApiCompanyData {
  domains?: string[] | null;
  fields?: AffinityApiField[] | null;
}

export interface AffinityApiPerson extends AffinityApiPersonData {
  emailAddresses?: string[] | null;
  fields?: AffinityApiField[] | null;
}

export interface AffinityApiOpportunity {
  id: number;
  name?: string | null;
  listId?: number | null;
  fields?: AffinityApiField[] | null;
}

export interface AffinityApiListEntry {
  /** The list entry id: the CSV export's "Affinity Row ID". */
  id: number;
  type?: AffinityListType | string | null;
  listId?: number | null;
  createdAt?: string | null;
  entity?: AffinityApiCompany | AffinityApiPerson | AffinityApiOpportunity | null;
}

export interface AffinityApiOpportunityPreview {
  id: number;
  name?: string | null;
  listId?: number | null;
  listName?: string | null;
}

export interface AffinityApiNote {
  id: number;
  /** `entities`, `interaction`, `ai-notetaker`, `user-reply`, `ai-notetaker-reply`. */
  type?: string | null;
  content?: { html?: string | null } | null;
  creator?: AffinityApiPersonData | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  parent?: { id: number } | null;
  companiesPreview?: { data?: AffinityApiCompanyData[] | null } | null;
  personsPreview?: { data?: AffinityApiPersonData[] | null } | null;
  opportunitiesPreview?: { data?: AffinityApiOpportunityPreview[] | null } | null;
}

/* ----------------------------------------------------------------- basics */

/** Affinity's list type as the CRM's entity type; null for one the CRM does not hold. */
export function affinityEntityType(type: string | null | undefined): CrmEntityType | null {
  if (type === 'company' || type === 'person') return type;
  if (type === 'opportunity') return 'deal';
  return null;
}

/** "First Last", else the primary address, else ''. */
export function affinityPersonName(person: AffinityApiPersonData | null | undefined): string {
  if (!person) return '';
  const name = [person.firstName, person.lastName]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .join(' ');
  return name || (person.primaryEmailAddress ?? '').trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  bull: '•',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * A note's HTML as plain text: paragraphs and line breaks become newlines,
 * list items become "- " lines, every other tag is dropped and entities are
 * decoded. Notes are stored and shown as text (PlainText never renders
 * markup), so nothing of the HTML survives to be interpreted.
 */
export function affinityHtmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return (
    decodeEntities(
      html
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        // HTML whitespace is insignificant; the tags below decide the breaks.
        .replace(/\s+/g, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '\n- ')
        .replace(/<\/(p|div|h[1-6]|ul|ol|blockquote|tr|pre)>/gi, '\n')
        .replace(/<[^>]*>/g, ''),
    )
      .split('\n')
      .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
      .join('\n')
      // A list sits straight under its paragraph; at most one blank line anywhere.
      .replace(/\n{2,}(?=- )/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * An Affinity date as the CRM stores dates. Date fields are whole days stored
 * as an instant: midnight Pacific since 2026, midnight UTC before. Either way
 * the calendar day is what was meant, so it is kept as `YYYY-MM-DD`; any other
 * instant stays an ISO date-time.
 */
export function affinityDate(value: string): string {
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value;
  const date = new Date(t);
  const iso = date.toISOString();
  if (iso.endsWith('T00:00:00.000Z')) return iso.slice(0, 10);
  const pacific = localClock(date, 'America/Los_Angeles');
  if (pacific.hour === 0 && pacific.minute === 0 && date.getUTCSeconds() === 0) {
    return pacific.dateKey;
  }
  return iso;
}

/* ----------------------------------------------------------------- values */

type Plain = string | number | string[] | null;

function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function many<T>(data: unknown, each: (item: T) => string | null): string[] | null {
  if (!Array.isArray(data)) return null;
  const out: string[] = [];
  for (const item of data as T[]) {
    const v = each(item);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.length ? out : null;
}

function location(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const l = data as Record<string, unknown>;
  const parts = [l.streetAddress, l.city, l.state, l.country]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function optionText(data: unknown): string | null {
  return data && typeof data === 'object' ? text((data as { text?: unknown }).text) : null;
}

function companyName(data: unknown): string | null {
  return data && typeof data === 'object' ? text((data as AffinityApiCompanyData).name) : null;
}

function personName(data: unknown): string | null {
  return data && typeof data === 'object'
    ? affinityPersonName(data as AffinityApiPersonData) || null
    : null;
}

/** When an interaction happened: an email's sentAt, a meeting's or call's startTime. */
function interactionAt(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const i = data as { sentAt?: unknown; startTime?: unknown };
  const at = text(i.sentAt) ?? text(i.startTime);
  return at && !Number.isNaN(Date.parse(at)) ? new Date(Date.parse(at)).toISOString() : null;
}

/**
 * A field value as plain data: text, a number, an ISO date, or a list of
 * names — the shapes `normalizeCrmValue` takes. People and companies become
 * their names, dropdowns their option text, places "City, State, Country",
 * an interaction the moment it happened. An empty value is null, which clears
 * the stored one; a value of a type the sync does not know is null too.
 */
export function affinityPlainValue(value: AffinityApiValue | null | undefined): Plain {
  if (!value) return null;
  const { type, data } = value;
  if (data === null || data === undefined) return null;
  switch (type) {
    case 'text':
    case 'filterable-text':
      return text(data);
    case 'number':
      return typeof data === 'number' && Number.isFinite(data) ? data : text(data);
    case 'formula-number': {
      const n = (data as { calculatedValue?: unknown }).calculatedValue;
      return typeof n === 'number' && Number.isFinite(n) ? n : null;
    }
    case 'datetime':
      return typeof data === 'string' ? affinityDate(data) : null;
    case 'location':
      return location(data);
    case 'dropdown':
    case 'ranked-dropdown':
      return optionText(data);
    case 'person':
      return personName(data);
    case 'company':
      return companyName(data);
    case 'interaction':
      return interactionAt(data);
    case 'number-multi':
    case 'filterable-text-multi':
    case 'text-multi':
      return many<unknown>(data, text);
    case 'location-multi':
      return many<unknown>(data, location);
    case 'dropdown-multi':
      return many<unknown>(data, optionText);
    case 'person-multi':
      return many<unknown>(data, personName);
    case 'company-multi':
      return many<unknown>(data, companyName);
    default:
      return typeof data === 'string' || typeof data === 'number' ? text(data) : null;
  }
}

/** The options a dropdown value names, with their rank when Affinity ranks them. */
function valueOptions(
  value: AffinityApiValue | null | undefined,
): { text: string; rank: number }[] {
  if (!value || value.data === null || value.data === undefined) return [];
  const one = (d: unknown) => {
    const t = optionText(d);
    const rank = (d as { rank?: unknown }).rank;
    return t ? [{ text: t, rank: typeof rank === 'number' ? rank : Number.MAX_SAFE_INTEGER }] : [];
  };
  if (value.type === 'dropdown' || value.type === 'ranked-dropdown') return one(value.data);
  if (value.type === 'dropdown-multi' && Array.isArray(value.data)) return value.data.flatMap(one);
  return [];
}

/* ----------------------------------------------------------------- fields */

/** System fields with nothing to keep, and one that changes every day by itself. */
const SKIPPED_FIELD_IDS = new Set(['notes', 'lists', 'reminders', 'time-in-current-status']);

const STATUS_NAME = /^(status|stage|(deal|pipeline|lp|investment|fundraising) (status|stage))$/;
const MONEY_NAME =
  /amount|valuation|check size|round size|raise|investment|commitment|revenue|\barr\b|\bmrr\b|\bprice\b|\bcost\b|fund size|\bcap\b|\$/;
const URL_NAME = /url|website|linkedin|twitter|crunchbase|angellist|homepage|\blink\b/;
const EMAIL_NAME = /e-?mail/;

/** The column type for a new Affinity field: its value type, refined by its name. */
export function affinityFieldType(meta: Pick<AffinityApiFieldMeta, 'name' | 'valueType'>) {
  const name = crmNameKey(meta.name ?? '');
  switch (meta.valueType) {
    case 'number':
    case 'formula-number':
      return MONEY_NAME.test(name) ? 'money' : 'number';
    case 'datetime':
    case 'interaction':
      return 'date';
    case 'dropdown':
    case 'ranked-dropdown':
      return 'status';
    case 'dropdown-multi':
    case 'filterable-text-multi':
      return 'multi';
    case 'person':
    case 'person-multi':
      return 'person';
    case 'company':
    case 'company-multi':
      return 'company';
    case 'text':
    case 'filterable-text':
      return URL_NAME.test(name) ? 'url' : EMAIL_NAME.test(name) ? 'email' : 'text';
    default:
      return 'text';
  }
}

/** An Affinity field stored as a column of the list. */
export interface AffinityColumn {
  fieldId: string;
  /** The list's field key the values go under. */
  key: string;
  name: string;
  type: CrmFieldType;
}

/** How a list's Affinity fields land in Copilot. */
export interface AffinityListPlan {
  /** The columns, as fields to merge into the list (existing ones exactly as stored). */
  fields: CrmField[];
  columns: AffinityColumn[];
  /** Affinity fields kept on the company or person record instead, by label. */
  recordFields: { fieldId: string; name: string }[];
}

/**
 * Which of a list's Affinity fields become columns of the list and which are
 * kept on the record.
 *
 * A column is a field of the list itself (`list`), a deal's Organizations and
 * People, or any field the list already has a column for — a CSV export
 * carries whichever global and enriched columns its view showed, and those
 * stay columns so the sync keeps them current. Every other global, enriched
 * and relationship field (Industry, Description, Last Email…) belongs to the
 * company or person, not to one list, so it goes on the record: a list keeps
 * the handful of columns it is about instead of forty that scroll.
 *
 * An existing column is sent back exactly as stored — key, label, type — so a
 * re-sync never retypes a column the CSV import typed more precisely (money,
 * url) and an unchanged list writes nothing. A new column gets its key from
 * its label; the pipeline field (a dropdown named Status or Stage) is keyed
 * `status`, as the CSV import keys it.
 *
 * A column someone added in Copilot is the team's, never Affinity's: no
 * Affinity field is matched to it, so a global field with the same label
 * stays on the record and a list field becomes a column of its own.
 */
export function planAffinityColumns(
  metas: readonly AffinityApiFieldMeta[],
  existing: readonly CrmField[],
  entityType: CrmEntityType,
): AffinityListPlan {
  const taken = new Set(existing.map((f) => f.key));
  const fields: CrmField[] = [];
  const columns: AffinityColumn[] = [];
  const recordFields: { fieldId: string; name: string }[] = [];
  const used = new Set<string>();

  for (const meta of metas) {
    const name = (meta.name ?? '').trim();
    if (!meta.id || !name || SKIPPED_FIELD_IDS.has(meta.id)) continue;
    const label = crmNameKey(name);
    const match = existing.find(
      (f) => !isCopilotField(f) && crmNameKey(f.name) === label && !used.has(f.key),
    );
    const dealLink = entityType === 'deal' && (meta.id === 'companies' || meta.id === 'persons');
    if (!match && meta.type !== 'list' && !dealLink) {
      recordFields.push({ fieldId: meta.id, name: name.slice(0, 100) });
      continue;
    }
    if (match) {
      used.add(match.key);
      fields.push({ ...match, options: match.options ? [...match.options] : undefined });
      columns.push({ fieldId: meta.id, key: match.key, name: match.name, type: match.type });
      continue;
    }
    const type = affinityFieldType(meta);
    const pipeline = type === 'status' && STATUS_NAME.test(label) && !taken.has('status');
    const key = pipeline ? 'status' : crmFieldKey(name, taken);
    taken.add(key);
    used.add(key);
    const field: CrmField = { key, name: name.slice(0, 200), type };
    if (CRM_OPTION_FIELD_TYPES.has(type)) field.options = [];
    fields.push(field);
    columns.push({ fieldId: meta.id, key, name: field.name, type });
  }
  return {
    fields: fields.map((f) => {
      if (f.options === undefined) delete f.options;
      return f;
    }),
    columns,
    recordFields,
  };
}

/* ---------------------------------------------------------------- entries */

/** A company or person for `upsertRecords` (the shape of its `CrmRecordRow`). */
export interface AffinityRecordRow {
  externalId: string;
  name: string | null;
  domain?: string | null;
  emails?: string[];
  primaryEmail?: string | null;
  fields?: Record<string, string | number | string[]>;
}

export interface AffinityEntryRow {
  /** The Affinity list entry id. */
  externalId: string;
  title: string | null;
  /** Index into the page's `records`, or null for a deal with no company. */
  record: number | null;
  /** By the plan's column keys; null clears a value Affinity no longer has. */
  values: Record<string, Plain>;
}

export interface AffinityEntriesPage {
  records: AffinityRecordRow[];
  entries: AffinityEntryRow[];
  /** The options the page's dropdown values name, by column key, in Affinity's rank order. */
  options: Record<string, string[]>;
}

function fieldsById(fields: readonly AffinityApiField[] | null | undefined) {
  const out = new Map<string, AffinityApiField>();
  for (const f of fields ?? []) if (f && typeof f.id === 'string') out.set(f.id, f);
  return out;
}

function companyRow(
  company: AffinityApiCompanyData & { domains?: string[] | null },
): AffinityRecordRow {
  return {
    externalId: String(company.id),
    name: (company.name ?? '').trim() || null,
    domain: affinityDomain(company.domain ?? company.domains?.[0] ?? null),
  };
}

function personRow(person: AffinityApiPerson): AffinityRecordRow {
  const emails = [person.primaryEmailAddress, ...(person.emailAddresses ?? [])].filter(
    (e): e is string => typeof e === 'string' && e.includes('@'),
  );
  return {
    externalId: String(person.id),
    name: affinityPersonName(person) || null,
    emails: [...new Set(emails.map((e) => e.trim().toLowerCase()))],
    primaryEmail: person.primaryEmailAddress?.trim().toLowerCase() || null,
  };
}

/** The company a deal is with: the first of its Organizations. */
function dealCompany(fields: Map<string, AffinityApiField>): AffinityApiCompanyData | null {
  const candidates = [
    fields.get('companies'),
    ...[...fields.values()].filter(
      (f) =>
        (f.value?.type === 'company-multi' || f.value?.type === 'company') &&
        /organi[sz]ation|compan/i.test(f.name ?? ''),
    ),
  ];
  for (const field of candidates) {
    const data = field?.value?.data;
    const first = Array.isArray(data) ? data[0] : data;
    if (first && typeof first === 'object' && typeof (first as { id?: unknown }).id === 'number') {
      return first as AffinityApiCompanyData;
    }
  }
  return null;
}

/**
 * One page of list entries as the rows to upsert: the companies or people
 * they are about (a deal's company), and the rows with their column values.
 * A record that several rows share is sent once.
 */
export function mapAffinityEntries(
  entityType: CrmEntityType,
  entries: readonly AffinityApiListEntry[],
  plan: AffinityListPlan,
): AffinityEntriesPage {
  const records: AffinityRecordRow[] = [];
  const recordIndex = new Map<string, number>();
  const ranked = new Map<string, Map<string, number>>();
  const out: AffinityEntryRow[] = [];

  const addRecord = (row: AffinityRecordRow): number => {
    const seen = recordIndex.get(row.externalId);
    if (seen !== undefined) return seen;
    records.push(row);
    recordIndex.set(row.externalId, records.length - 1);
    return records.length - 1;
  };

  for (const entry of entries) {
    const entity = entry?.entity;
    if (!entry || typeof entry.id !== 'number' || !entity || typeof entity.id !== 'number') {
      continue;
    }
    const fields = fieldsById(entity.fields);

    let title: string | null;
    let record: number | null = null;
    if (entityType === 'deal') {
      title = ((entity as AffinityApiOpportunity).name ?? '').trim() || null;
      const company = dealCompany(fields);
      if (company) record = addRecord(companyRow(company));
    } else {
      const row =
        entityType === 'company'
          ? companyRow(entity as AffinityApiCompany)
          : personRow(entity as AffinityApiPerson);
      const kept: Record<string, string | number | string[]> = {};
      for (const { fieldId, name } of plan.recordFields) {
        const value = affinityPlainValue(fields.get(fieldId)?.value);
        if (value !== null) kept[name] = value;
      }
      if (Object.keys(kept).length) row.fields = kept;
      title = row.name;
      record = addRecord(row);
    }

    const values: Record<string, Plain> = {};
    for (const column of plan.columns) {
      const field = fields.get(column.fieldId);
      // A field the response left out is left alone; one it sent empty is cleared.
      if (!field) continue;
      values[column.key] = affinityPlainValue(field.value);
      if (CRM_OPTION_FIELD_TYPES.has(column.type)) {
        const seen = ranked.get(column.key) ?? new Map<string, number>();
        for (const o of valueOptions(field.value)) {
          seen.set(o.text, Math.min(seen.get(o.text) ?? o.rank, o.rank));
        }
        ranked.set(column.key, seen);
      }
    }
    out.push({ externalId: String(entry.id), title, record, values });
  }

  const options: Record<string, string[]> = {};
  for (const [key, seen] of ranked) {
    // Stable: equal ranks (unranked dropdowns) keep the order they were met in.
    options[key] = [...seen.entries()]
      .map(([option, rank], i) => ({ option, rank, i }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((o) => o.option);
  }
  return { records, entries: out, options };
}

/** The plan's fields with the options a page's values name added to their own. */
export function withSeenOptions(
  fields: readonly CrmField[],
  options: Readonly<Record<string, readonly string[]>>,
): CrmField[] {
  return fields.map((f) => {
    const seen = options[f.key];
    if (!seen?.length || !CRM_OPTION_FIELD_TYPES.has(f.type)) return f;
    const have = new Set((f.options ?? []).map((o) => o.toLowerCase()));
    const added = seen.filter((o) => !have.has(o.toLowerCase()));
    return added.length ? { ...f, options: [...(f.options ?? []), ...added] } : f;
  });
}

/* ------------------------------------------------------------------ notes */

export interface AffinityNoteRow {
  externalId: string;
  content: string;
  title: string | null;
  author: string | null;
  occurredAt: string | null;
  /** The note this one replies to, by Affinity id. */
  parentId: string | null;
  companies: AffinityApiCompanyData[];
  /** People the note is about; teammates (`internal`) are left out. */
  persons: AffinityApiPersonData[];
  opportunities: AffinityApiOpportunityPreview[];
  /** Everything it is attached to, by name: companies, people, deals. */
  entityNames: string[];
}

function previewData<T>(preview: { data?: T[] | null } | null | undefined): T[] {
  return Array.isArray(preview?.data) ? (preview.data as T[]) : [];
}

/** A note as a row to upsert, or null when it has no text to keep. */
export function mapAffinityNote(note: AffinityApiNote): AffinityNoteRow | null {
  if (!note || typeof note.id !== 'number') return null;
  const content = affinityHtmlToText(note.content?.html);
  if (!content) return null;
  const companies = previewData(note.companiesPreview).filter((c) => c && typeof c.id === 'number');
  const persons = previewData(note.personsPreview).filter(
    (p) => p && typeof p.id === 'number' && p.type !== 'internal',
  );
  const opportunities = previewData(note.opportunitiesPreview).filter(
    (o) => o && typeof o.id === 'number',
  );
  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of [
    ...companies.map((c) => (c.name ?? '').trim()),
    ...persons.map((p) => affinityPersonName(p)),
    ...opportunities.map((o) => (o.name ?? '').trim()),
  ]) {
    const key = crmNameKey(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  const created =
    note.createdAt && !Number.isNaN(Date.parse(note.createdAt)) ? note.createdAt : null;
  const parentId =
    note.parent && typeof note.parent.id === 'number' ? String(note.parent.id) : null;
  return {
    externalId: String(note.id),
    content,
    title: parentId ? 'Reply' : null,
    author: affinityPersonName(note.creator) || null,
    occurredAt: created ? new Date(Date.parse(created)).toISOString() : null,
    parentId,
    companies,
    persons,
    opportunities,
    entityNames: names,
  };
}

/**
 * What a note's text is, for recognising the same note imported from a CSV
 * export: letters and digits only, lowercased. The export's plain text and
 * the API's HTML differ in spacing, bullets and punctuation, never in words.
 */
export function noteFingerprint(content: string): string {
  return content.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
