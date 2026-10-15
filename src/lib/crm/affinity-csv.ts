import Papa from 'papaparse';
import { coerceCrmValue, crmFieldKey, crmNameKey, splitCrmMulti } from '@/lib/crm/fields';
import type {
  AffinityIntroductionsMapping,
  AffinityIntroductionsRequest,
} from '@/lib/crm/affinity-introductions';
import type { CrmEntityType, CrmField, CrmFieldType } from '@/lib/types/domain';
import { normalizeDomain } from '@/lib/util/text';

/**
 * Affinity's CSV exports, read into the shape the CRM import takes.
 *
 * Two exports arrive here: a list view ("Export view as CSV"), whose columns
 * are whatever the saved view shows, and a notes export ("Export all notes in
 * view"). A third, the introductions export, is sections rather than one
 * table and is read by affinity-introductions.ts; it is only recognised here.
 * None has documented headers, so everything is header-driven and
 * forgiving — case, spacing and synonyms — and every guess is a default the
 * import page shows and lets a person correct before anything is sent.
 *
 * Pure and dependency-light (papaparse and the field helpers), so it runs in
 * the browser where the files are parsed, in the route that validates what
 * the browser sends, and in tests. Nothing here talks to the store.
 *
 * The flow: parseAffinityCsv → detectAffinityMapping (the editable guesses) →
 * buildListImport / buildNotesImport (request bodies for /api/crm/import, in
 * chunks, with the spreadsheet row each payload row came from).
 */

/* ----------------------------------------------------------------- limits */

/**
 * The contract between the page and /api/crm/import. The route validates
 * against these, and the builders below clip to them, so real data never
 * fails validation — an oversized cell is shortened, not rejected with the
 * other 199 rows of its chunk.
 */
export const AFFINITY_IMPORT_LIMITS = {
  /** Rows the route accepts per request; the CRM upserts' own batch cap. */
  rowsPerRequest: 500,
  /** Rows the page sends per request: smaller, so progress moves and no request runs long. */
  rowsPerChunk: 200,
  /**
   * Bytes per request. The proxy buffers request bodies up to 10MB and
   * silently truncates past that, which would arrive as unparseable JSON.
   */
  bytesPerChunk: 2_000_000,
  /** Characters kept of one list cell. */
  cellChars: 20_000,
  /** The longest note the CRM stores (crm_notes.content). */
  noteChars: 500_000,
  /** Columns a list can bring. */
  fields: 200,
  /** Choices a status or multi field can carry. */
  options: 500,
  /** Names one note can be attached to. */
  namesPerNote: 50,
} as const;

/** A status column with more distinct values than this is free text, not a pipeline. */
const STATUS_MAX_OPTIONS = 200;
/** A multi-select keeps its choices only while there are few enough to pick from. */
const MULTI_MAX_OPTIONS = 50;

/* ---------------------------------------------------------------- parsing */

export interface AffinityCsvRow {
  /** The row number a spreadsheet shows for it: the header is row 1. */
  line: number;
  /** Cells by header, untrimmed; a missing cell is ''. */
  cells: Record<string, string>;
}

export interface AffinityCsv {
  headers: string[];
  /** Data rows, blank rows left out. */
  rows: AffinityCsvRow[];
  /** Things worth telling the person (ragged rows), at most 20. */
  warnings: string[];
}

/**
 * The delimiter, from the header line. Affinity writes commas; a file that
 * went through a European Excel may use semicolons. Papaparse's own guess
 * looks at data rows too, where `;` separates multi-value cells, so it is not
 * trusted here.
 */
function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1] as const);
  const [best] = [...counts].sort((a, b) => b[1] - a[1]);
  return best && best[1] > 0 ? best[0] : ',';
}

/** Parse a CSV export: BOM-safe, quoted multi-line cells, duplicate headers suffixed. */
export function parseAffinityCsv(text: string): AffinityCsv {
  const source = text.replace(/^﻿/, '');
  const result = Papa.parse<Record<string, string | undefined>>(source, {
    header: true,
    delimiter: detectDelimiter(source),
    // Blank lines are filtered below rather than skipped by the parser, so
    // the row numbers stay those a spreadsheet would show.
    skipEmptyLines: false,
    transformHeader: (h) => h.replace(/^﻿/, '').trim(),
  });
  const headers = (result.meta.fields ?? []).filter((h) => h !== '');
  const warnings: string[] = [];
  const rows: AffinityCsvRow[] = [];
  result.data.forEach((raw, i) => {
    const cells: Record<string, string> = {};
    let blank = true;
    for (const h of headers) {
      const v = typeof raw[h] === 'string' ? (raw[h] as string) : '';
      cells[h] = v;
      if (v.trim()) blank = false;
    }
    if (blank) return;
    rows.push({ line: i + 2, cells });
  });
  for (const e of result.errors) {
    if (e.code !== 'TooManyFields' || typeof e.row !== 'number' || warnings.length >= 20) continue;
    warnings.push(
      `Row ${e.row + 2} has more cells than there are columns; the extra cells were left out.`,
    );
  }
  return { headers, rows, warnings };
}

/* ------------------------------------------------------------- header rules */

const norm = (header: string) => header.trim().toLowerCase().replace(/\s+/g, ' ');

/** The first header matching the earliest pattern: patterns are in order of preference. */
function findHeader(
  headers: readonly string[],
  patterns: readonly RegExp[],
  exclude: ReadonlySet<string> = new Set(),
): string | null {
  for (const pattern of patterns) {
    const hit = headers.find((h) => !exclude.has(h) && pattern.test(norm(h)));
    if (hit) return hit;
  }
  return null;
}

const ROW_ID = [/^affinity row id$/, /^row id$/, /^list entry id$/, /^entry id$/];
const ENTITY_ID: Record<CrmEntityType, RegExp[]> = {
  deal: [/^opportunity id$/, /^deal id$/, /^entity id$/, /^id$/],
  person: [/^person id$/, /^affinity person id$/, /^entity id$/, /^id$/],
  company: [
    /^organization id$/,
    /^company id$/,
    /^affinity organization id$/,
    /^entity id$/,
    /^id$/,
  ],
};
const NAME: Record<CrmEntityType, RegExp[]> = {
  deal: [/^opportunity name$/, /^opportunity$/, /^deal name$/, /^deal$/, /^name$/, /^title$/],
  person: [/^full name$/, /^name$/, /^person name$/, /^person$/, /^contact name$/, /^contact$/],
  company: [/^organization name$/, /^organization$/, /^company name$/, /^company$/, /^name$/],
};
const FIRST_NAME = [/^first name$/, /^given name$/];
const LAST_NAME = [/^last name$/, /^surname$/, /^family name$/];
const DOMAIN = [
  /^website$/,
  /^domain$/,
  /^(organization|company) (website|domain|url)$/,
  /^web ?site url$/,
  /^url$/,
  /^homepage$/,
];
const EMAILS = [/^email addresses$/, /^emails$/, /^email$/, /^email address$/, /^e-mail$/];
const PRIMARY_EMAIL = [/^primary email( address)?$/];
const ORGANIZATION = [
  /^organizations?$/,
  /^compan(y|ies)$/,
  /^organization name$/,
  /^company name$/,
];
const STATUS = [
  /^status$/,
  /^stage$/,
  /^(deal|pipeline|lp|investment|fundraising) (status|stage)$/,
];

/** Columns that hold several values in Affinity, whatever their cells look like. */
const PERSON_HEADER = /^(owners?|people|persons?|contacts?|team( members)?|founders?)$/;
const COMPANY_HEADER = /^(organizations?|compan(y|ies))$/;
const MULTI_HEADER = /^(industr(y|ies)|tags?|labels?|sectors?|categor(y|ies)|themes?|verticals?)$/;
const MONEY_HEADER =
  /amount|valuation|check size|round size|raise|investment|commitment|revenue|\barr\b|\bmrr\b|\bprice\b|\bcost\b|fund size|\bcap\b|\$/;
const URL_HEADER = /url|website|linkedin|twitter|crunchbase|angellist|homepage|\blink\b/;
const ID_HEADER = /(^|\s)id$/;
/** Digits that are not quantities: a phone number parsed as a number loses its formatting. */
const LITERAL_HEADER = /phone|mobile|\btel\b|fax|zip|postal|postcode|year founded|founded/;

const NOTE_ID = [/^note id$/, /^id$/];
const NOTE_CONTENT = [
  /^(note )?content$/,
  /^note (body|text)$/,
  /^notes?$/,
  /^body$/,
  /^text$/,
  /content/,
  /body/,
  /^(?!.*\bid$).*\bnote\b/,
  /text/,
];
const NOTE_AUTHOR = [
  /^author$/,
  /^(note )?(creator|created by|author name|written by)$/,
  /author|creator|created by|written by/,
  /^(owner|user)$/,
];
const NOTE_DATE = [
  /^(date|date created|created|created at|creation date|note date|timestamp)$/,
  /^(created|creation) (date|time|on)$/,
  /^(?!.*\bby\b).*\b(date|created)\b/,
  /updated|modified/,
];
const NOTE_ENTITY = [
  /^entity name$/,
  /^entity$/,
  /^(organization|person|opportunity|company|contact) name$/,
  /^(related to|attached to|regarding)$/,
  /^name$/,
  /entity/,
  /\bname\b/,
];
const NOTE_ASSOCIATED =
  /associated|related|attached|^(organizations?|people|persons?|opportunit(y|ies)|compan(y|ies)|contacts?)$/;

/* ------------------------------------------------------------ value rules */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
/** "Fri, " before a date, as a spreadsheet's long date format writes it. */
const WEEKDAY_RE = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i;

/**
 * Zone abbreviations a time may end with, as offsets: the US zones (the
 * exports come from a US workspace) and the common European ones. An
 * abbreviation not here makes the time unreadable rather than guessed at.
 */
const ZONE_OFFSETS: Record<string, string> = {
  est: '-05:00',
  edt: '-04:00',
  cst: '-06:00',
  cdt: '-05:00',
  mst: '-07:00',
  mdt: '-06:00',
  pst: '-08:00',
  pdt: '-07:00',
  akst: '-09:00',
  akdt: '-08:00',
  hst: '-10:00',
  bst: '+01:00',
  cet: '+01:00',
  cest: '+02:00',
  eet: '+02:00',
  eest: '+03:00',
};

/** A year as written; two digits are read as Excel reads them, 00–29 as 20xx and 30–99 as 19xx. */
function fullYear(raw: string): number {
  const n = Number(raw);
  if (raw.length !== 2) return n;
  return n < 30 ? 2000 + n : 1900 + n;
}

function validDay(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A date or date-time as Affinity writes it — or as a spreadsheet rewrites it
 * when someone opens the export and saves it again — read strictly:
 * `2026-03-14`, `3/14/2026` and `3/14/26` (US order), `14.03.2026` (dotted,
 * day first), `Mar 14, 2026`, `14 Mar 2026`, `14-Mar-26`, any of those after
 * a weekday ("Sat, Mar 14, 2026") or with a time, and ISO date-times. A time
 * may end with an offset or a zone abbreviation (`CDT`); without either it is
 * read as UTC, so the browser that parses and the server that stores agree to
 * the second. Anything else is null — `Date.parse` alone would read "Q3 2026"
 * or "5" as dates.
 */
export function parseAffinityDate(
  raw: string | null | undefined,
): { kind: 'date'; value: string } | { kind: 'datetime'; value: string } | null {
  const s = (raw ?? '').trim().replace(WEEKDAY_RE, '');
  if (!s) return null;

  let y: number | null = null;
  let m = 0;
  let d = 0;
  let rest = '';
  let match: RegExpExecArray | null;
  if ((match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](.*))?$/.exec(s))) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    rest = match[4] ?? '';
  } else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2}),?(?: (.*))?$/.exec(s))) {
    [m, d, y] = [Number(match[1]), Number(match[2]), fullYear(match[3] as string)];
    rest = match[4] ?? '';
  } else if ((match = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2}),?(?: (.*))?$/.exec(s))) {
    // A dotted date is a European spreadsheet's, so the day comes first.
    [d, m, y] = [Number(match[1]), Number(match[2]), fullYear(match[3] as string)];
    rest = match[4] ?? '';
  } else if (
    (match = new RegExp(
      `^${MONTH_RE} (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4}),?(?: (.*))?$`,
      'i',
    ).exec(s))
  ) {
    m = MONTHS.indexOf((match[1] as string).toLowerCase().slice(0, 3)) + 1;
    [d, y] = [Number(match[2]), Number(match[3])];
    rest = match[4] ?? '';
  } else if (
    (match = new RegExp(`^(\\d{1,2})[ -]${MONTH_RE},?[ -](\\d{4}|\\d{2}),?(?: (.*))?$`, 'i').exec(
      s,
    ))
  ) {
    m = MONTHS.indexOf((match[2] as string).toLowerCase().slice(0, 3)) + 1;
    [d, y] = [Number(match[1]), fullYear(match[3] as string)];
    rest = match[4] ?? '';
  }
  if (y === null || !validDay(y, m, d)) return null;
  const date = `${y}-${pad(m)}-${pad(d)}`;
  if (!rest.trim()) return { kind: 'date', value: date };

  const time =
    /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?\s*(am|pm)?\s*(z|utc|gmt|[+-]\d{2}:?\d{2}|[a-z]{3,4})?$/i.exec(
      rest.trim(),
    );
  if (!time) return null;
  let hour = Number(time[1]);
  const minute = Number(time[2]);
  const second = Number(time[3] ?? 0);
  const ms = Number(((time[4] ?? '') + '000').slice(0, 3));
  const meridiem = time[5]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  let t = Date.UTC(y, m - 1, d, hour, minute, second, ms);
  let zone = time[6]?.toLowerCase();
  if (zone && /^[a-z]+$/.test(zone) && zone !== 'z' && zone !== 'utc' && zone !== 'gmt') {
    zone = ZONE_OFFSETS[zone];
    if (!zone) return null;
  }
  if (zone && /^[+-]/.test(zone)) {
    const [, sign, hh, mm] = /^([+-])(\d{2}):?(\d{2})$/.exec(zone) as RegExpExecArray;
    const offset = (Number(hh) * 60 + Number(mm)) * 60_000;
    t -= sign === '-' ? -offset : offset;
  }
  return { kind: 'datetime', value: new Date(t).toISOString() };
}

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const DOMAIN_LIKE_RE = /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;
const CURRENCY_RE = /^\s*(usd|us\$|\$|€|£)|\d\s*[kmb]\s*$|usd\s*$/i;

/** Share of `values` passing `test`; 0 for none. */
function share(values: readonly string[], test: (v: string) => boolean): number {
  if (!values.length) return 0;
  let n = 0;
  for (const v of values) if (test(v)) n++;
  return n / values.length;
}

/** Ordered the way Affinity numbers its stages: "3. First Meeting" before "10. Won / Signed". */
export function compareAffinityOptions(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

/**
 * The field type a column's values suggest. Rules in order: cells that are
 * email addresses, headers that name a kind (owners are people, an amount is
 * money), then dates, numbers and money, links, `;`-separated multi-values,
 * and short values that repeat (a status). Mostly — 90% of filled cells — is enough: a stray "TBD"
 * in a date column is kept as text by the import, not a reason to lose the
 * column's type.
 */
export function inferColumnType(header: string, values: readonly string[]): CrmFieldType {
  const h = norm(header);
  const filled = values.map((v) => v.trim()).filter(Boolean);
  const mostly = (test: (v: string) => boolean) => share(filled, test) >= 0.9;
  // "Contacts" full of addresses is an email column, whatever its header says.
  if (filled.length && mostly((v) => EMAIL_RE.test(v))) return 'email';
  if (PERSON_HEADER.test(h)) return 'person';
  if (COMPANY_HEADER.test(h)) return 'company';
  if (MULTI_HEADER.test(h)) return 'multi';
  if (!filled.length || ID_HEADER.test(h) || LITERAL_HEADER.test(h)) return 'text';

  if (mostly((v) => parseAffinityDate(v) !== null)) return 'date';
  const isNumber = (v: string) => typeof coerceCrmValue('number', v) === 'number';
  const isMoney = (v: string) => typeof coerceCrmValue('money', v) === 'number';
  if (mostly(isNumber)) return MONEY_HEADER.test(h) ? 'money' : 'number';
  if (mostly(isMoney) && filled.some((v) => CURRENCY_RE.test(v))) return 'money';
  if (
    mostly((v) => URL_RE.test(v)) ||
    (URL_HEADER.test(h) && mostly((v) => DOMAIN_LIKE_RE.test(v)))
  )
    return 'url';

  // `;` in a sentence is not a list: every part must be short, and the cells
  // must not read as prose.
  const withSemicolon = filled.filter((v) => /[^;\s]\s*;\s*[^;\s]/.test(v));
  const avgLength = filled.reduce((n, v) => n + v.length, 0) / filled.length;
  if (
    withSemicolon.length >= Math.max(1, filled.length * 0.1) &&
    avgLength <= 120 &&
    filled.every((v) => v.split(';').every((p) => p.trim().length <= 80))
  ) {
    return 'multi';
  }

  const distinct = new Set(filled).size;
  if (
    filled.length >= 3 &&
    distinct <= 15 &&
    distinct * 2 <= filled.length &&
    filled.every((v) => v.length <= 50 && !v.includes('\n'))
  ) {
    return 'status';
  }
  return 'text';
}

/** Hosts that are never a company's own domain; a website cell pointing at one is not a domain. */
const SHARED_HOSTS = new Set([
  'linkedin.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'crunchbase.com',
  'angel.co',
  'wellfound.com',
  'github.com',
  'medium.com',
  'substack.com',
  'youtube.com',
  'google.com',
  'docs.google.com',
  'drive.google.com',
  'notion.so',
  'notion.site',
  'bit.ly',
  'linktr.ee',
  'pitchbook.com',
  'affinity.co',
]);

/** A website cell as a bare domain, or null when it names no company domain. */
export function affinityDomain(raw: string | null | undefined): string | null {
  const first = splitCrmMulti(raw ?? '')[0];
  const domain = normalizeDomain(first);
  if (!domain || SHARED_HOSTS.has(domain)) return null;
  for (const host of SHARED_HOSTS) if (domain.endsWith(`.${host}`)) return null;
  return /^[a-z0-9.-]+$/.test(domain) ? domain : null;
}

/* -------------------------------------------------------------- detection */

export type AffinityFileKind = 'list' | 'notes' | 'introductions';

/** The kinds that are one header row and rows; introductions come in sections. */
export type AffinityTableKind = Exclude<AffinityFileKind, 'introductions'>;

/**
 * The first line of an introductions export ("Introductions Made By:"), or of
 * one of its other sections. Such a file opens with a section title where a
 * list or notes export has its header row.
 */
export const AFFINITY_INTRODUCTIONS_TITLE = /^(introductions?\b|source of introductions?\b)/i;

/** A list column's type in the mapping, or 'skip' to leave it out of the import. */
export type AffinityColumnType = CrmFieldType | 'skip';

/**
 * How a list export maps onto the CRM. Every column is either a role (the
 * name, the ids, the website or emails that identify the record) or a field
 * of the list with a type; `types` holds a type for every column so that a
 * column released from a role in the UI falls back to a sensible field.
 */
export interface AffinityListMapping {
  kind: 'list';
  /**
   * The existing list the rows go into, chosen on the page (or suggested by
   * suggestTargetList). Null imports into the list named `listName`, creating
   * it if there is none.
   */
  targetListId: string | null;
  listName: string;
  entityType: CrmEntityType;
  /** The entity or opportunity name. */
  nameColumn: string | null;
  /** People only, used when there is no full-name column. */
  firstNameColumn: string | null;
  lastNameColumn: string | null;
  /** "Affinity Row ID": what makes a row the same row on a re-import. */
  rowIdColumn: string | null;
  /** "Organization ID" / "Person ID" / "Opportunity ID". */
  entityIdColumn: string | null;
  /** Companies: the website, stored as a bare domain. */
  domainColumn: string | null;
  /** People: all addresses, and the primary one. */
  emailsColumn: string | null;
  primaryEmailColumn: string | null;
  /** Deals: the company the deal is with (also kept as a field). */
  organizationColumn: string | null;
  /** The pipeline column: a status field keyed `status`, first in the list. */
  statusColumn: string | null;
  types: Record<string, AffinityColumnType>;
}

export interface AffinityNotesMapping {
  kind: 'notes';
  contentColumn: string | null;
  authorColumn: string | null;
  dateColumn: string | null;
  /** The note's own entity (organization, person or opportunity name). */
  entityColumn: string | null;
  /** Other columns of names the note is attached to. */
  associatedColumns: string[];
  /** A note id, when the export has one; otherwise rows are identified by a content hash. */
  idColumn: string | null;
}

export type AffinityMapping =
  AffinityListMapping | AffinityNotesMapping | AffinityIntroductionsMapping;

/**
 * Whether a file is a list export or a notes export, from its headers (and
 * name, to break a tie) — or an introductions export, whose "header" is a
 * lone section title (the page reads those with readAffinityIntroductions).
 */
export function detectAffinityKind(filename: string, headers: readonly string[]): AffinityFileKind {
  const [first, ...rest] = headers;
  if (first && AFFINITY_INTRODUCTIONS_TITLE.test(first.trim()) && rest.every((h) => !h.trim())) {
    return 'introductions';
  }
  const has = (patterns: readonly RegExp[]) => findHeader(headers, patterns) !== null;
  let notes = 0;
  let list = 0;
  if (has([/^(note )?content$/, /^note (body|text)$/])) notes += 3;
  else if (has([/^notes?$/, /^body$/, /^text$/, /content/])) notes += 2;
  if (has(NOTE_AUTHOR.slice(0, 3))) notes += 2;
  if (has([/^(date created|created|created at|creation date|note date)$/])) notes += 1;
  if (has([/associated|related to/])) notes += 1;
  if (/note/i.test(filename)) notes += 2;
  if (has(ROW_ID)) list += 3;
  if (
    has([
      /^(organization|company|person|opportunity|deal) id$/,
      /^affinity (organization|person) id$/,
    ])
  )
    list += 3;
  if (has([/^(organization|company|opportunity|deal|full|first|last) name$/])) list += 1;
  if (has(STATUS)) list += 1;
  if (has(DOMAIN) || has(PRIMARY_EMAIL) || has([/^email addresses$/])) list += 1;
  return notes > list ? 'notes' : 'list';
}

/**
 * What a list holds, from its id and name columns, else from the file name.
 * A person list often has a company column and a company list a contact
 * column, so ids decide first, then the name columns, then emails/websites.
 */
export function detectEntityType(filename: string, headers: readonly string[]): CrmEntityType {
  const has = (re: RegExp) => headers.some((h) => re.test(norm(h)));
  if (has(/^(opportunity|deal) (id|name)$/) || has(/^opportunity$/)) return 'deal';
  const personId = has(/^(affinity )?person id$/);
  const companyId = has(/^(affinity )?(organization|company) id$/);
  if (personId !== companyId) return personId ? 'person' : 'company';
  const personName = has(/^(full|first|last|person) name$/);
  const companyName = has(/^(organization|company) name$/);
  if (personName !== companyName) return personName ? 'person' : 'company';
  if (has(/^primary email/) || has(/^email addresses$/)) return 'person';
  if (has(/^(website|domain)$/)) return 'company';
  // "LP Pipeline" is people, so the person words are checked first.
  if (/\blps?\b|people|contacts?|person|founders?/i.test(filename)) return 'person';
  if (/deal|pipeline|opportunit/i.test(filename)) return 'deal';
  return 'company';
}

/**
 * The list name a file suggests: the file name without the extension, a
 * download counter ("(1)"), trailing dates and times, and the saved-view
 * suffix Affinity appends ("- All deals").
 */
export function defaultListName(filename: string): string {
  let name = filename.replace(/^.*[\\/]/, '').replace(/\.(csv|txt)$/i, '');
  // Affinity's own download names: "<List>_<View>__export_Oct-15-2026", with
  // "__notes_export_" or "__introductions_export_" for those exports and every
  // space turned into "_". The list name is everything before the view, which
  // for the default saved view starts with "All" ("_All_deals").
  const affinity = name.match(
    /^(.*?)_{2,}(?:notes_|introductions_|people_)?export_[a-z]{3}-\d{1,2}-\d{4}(?:\s*\(\d+\))?$/i,
  );
  if (affinity) {
    const spaced = affinity[1].replace(/_+/g, ' ').trim();
    name = spaced.replace(/\s+All\b.*$/i, '').trim() || spaced;
  }
  for (let pass = 0; pass < 4; pass++) {
    const before = name;
    name = name
      .replace(/\s*\(\d+\)\s*$/, '')
      .replace(
        /[\s_-]*(19|20)\d{2}[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[T\s_-]*\d{1,2}[-_.:]?\d{2}(?:[-_.:]?\d{2})?(?:\s*[ap]m)?)?\s*$/i,
        '',
      )
      .replace(/[\s_-]*(0?[1-9]|1[0-2])[-_.](0?[1-9]|[12]\d|3[01])[-_.](\d{4}|\d{2})\s*$/, '')
      .replace(/\s+-\s+all\b[^-]*$/i, '')
      .replace(/[\s_-]*\b(export(ed)?|download|view|affinity)\s*$/i, '')
      .replace(/[\s_-]+$/, '');
    if (name === before) break;
  }
  if (!/\s/.test(name)) name = name.replace(/[_]+/g, ' ');
  name = name.replace(/\s+/g, ' ').trim();
  return name || 'Imported list';
}

/** A list already in Copilot, as the import page offers it to import into. */
export interface AffinityExistingList {
  id: string;
  name: string;
  entityType: CrmEntityType;
  archived: boolean;
  entryCount: number;
}

/**
 * The existing list a file most likely updates: one of the same entity type
 * with the suggested name, else one whose name the file name starts with
 * before " - " — Affinity names an export after the list and the saved view
 * ("Deal Pipeline - Active.csv"), so a second view of a list imported before
 * lands in that list instead of a new one beside it. The longest such name
 * wins; a live list beats an archived one.
 */
export function suggestTargetList(
  filename: string,
  listName: string,
  entityType: CrmEntityType,
  lists: readonly AffinityExistingList[],
): AffinityExistingList | null {
  const candidates = lists
    .filter((l) => l.entityType === entityType)
    .sort((a, b) => Number(a.archived) - Number(b.archived) || b.name.length - a.name.length);
  const wanted = crmNameKey(listName);
  const exact = candidates.find((l) => crmNameKey(l.name) === wanted);
  if (exact) return exact;
  const base = crmNameKey(filename.replace(/^.*[\\/]/, '').replace(/\.(csv|txt)$/i, ''));
  return (
    candidates.find((l) => {
      const key = crmNameKey(l.name);
      return Boolean(key) && (base.startsWith(`${key} - `) || wanted.startsWith(`${key} - `));
    }) ?? null
  );
}

function columnValues(csv: AffinityCsv, header: string): string[] {
  return csv.rows.map((r) => r.cells[header] ?? '');
}

/** The list mapping a file suggests. `entityType` overrides the detected one. */
export function detectListMapping(
  filename: string,
  csv: AffinityCsv,
  entityType: CrmEntityType = detectEntityType(filename, csv.headers),
): AffinityListMapping {
  const { headers } = csv;
  const used = new Set<string>();
  const take = (patterns: readonly RegExp[]) => {
    const h = findHeader(headers, patterns, used);
    if (h) used.add(h);
    return h;
  };

  const rowIdColumn = take(ROW_ID);
  const entityIdColumn = take(ENTITY_ID[entityType]);
  let nameColumn = take(NAME[entityType]);
  const firstNameColumn = entityType === 'person' ? take(FIRST_NAME) : null;
  const lastNameColumn = entityType === 'person' ? take(LAST_NAME) : null;
  if (!nameColumn && !firstNameColumn && !lastNameColumn) {
    nameColumn = take([/(?<!(first|last|user|author|owner) )\bname\b/]);
  }
  const domainColumn = entityType === 'company' ? take(DOMAIN) : null;
  const primaryEmailColumn = entityType === 'person' ? take(PRIMARY_EMAIL) : null;
  const emailsColumn = entityType === 'person' ? take(EMAILS) : null;
  const organizationColumn = entityType === 'deal' ? findHeader(headers, ORGANIZATION, used) : null;
  const statusColumn = findHeader(headers, STATUS, used);

  const types: Record<string, AffinityColumnType> = {};
  for (const header of headers) {
    const values = columnValues(csv, header);
    let type: AffinityColumnType = inferColumnType(header, values);
    // Ids mean nothing on a list and first/last names repeat the full name.
    if (ID_HEADER.test(norm(header))) type = 'skip';
    if (nameColumn && (header === firstNameColumn || header === lastNameColumn)) type = 'skip';
    if (header === statusColumn) type = 'status';
    if (header === organizationColumn) type = 'company';
    types[header] = type;
  }

  return {
    kind: 'list',
    targetListId: null,
    listName: defaultListName(filename),
    entityType,
    nameColumn,
    firstNameColumn,
    lastNameColumn,
    rowIdColumn,
    entityIdColumn,
    domainColumn,
    emailsColumn,
    primaryEmailColumn,
    organizationColumn,
    statusColumn,
    types,
  };
}

/** The notes mapping a file suggests. */
export function detectNotesMapping(csv: AffinityCsv): AffinityNotesMapping {
  const { headers } = csv;
  const used = new Set<string>();
  const take = (patterns: readonly RegExp[]) => {
    const h = findHeader(headers, patterns, used);
    if (h) used.add(h);
    return h;
  };
  const idColumn = take(NOTE_ID);
  const contentColumn = take(NOTE_CONTENT);
  const authorColumn = take(NOTE_AUTHOR);
  const dateColumn = take(NOTE_DATE);
  const entityColumn = take(NOTE_ENTITY);
  const associatedColumns = headers.filter((h) => !used.has(h) && NOTE_ASSOCIATED.test(norm(h)));
  return {
    kind: 'notes',
    contentColumn,
    authorColumn,
    dateColumn,
    entityColumn,
    associatedColumns,
    idColumn,
  };
}

/**
 * The mapping a file suggests, as a list or notes export. `kind` overrides
 * the detected one. An introductions export is not read from a table — the
 * page reads it with readAffinityIntroductions before this — so it never
 * reaches here, and a table that only looks like one is read as a list.
 */
export function detectAffinityMapping(
  filename: string,
  csv: AffinityCsv,
  kind: AffinityTableKind = detectAffinityKind(filename, csv.headers) === 'notes'
    ? 'notes'
    : 'list',
): AffinityListMapping | AffinityNotesMapping {
  return kind === 'notes' ? detectNotesMapping(csv) : detectListMapping(filename, csv);
}

/* ------------------------------------------------------------- list fields */

/** Columns that identify the record rather than being fields of the list. */
function roleColumns(mapping: AffinityListMapping): Set<string> {
  const usesFirstLast = !mapping.nameColumn;
  return new Set(
    [
      mapping.nameColumn,
      usesFirstLast ? mapping.firstNameColumn : null,
      usesFirstLast ? mapping.lastNameColumn : null,
      mapping.rowIdColumn,
      mapping.entityIdColumn,
      mapping.entityType === 'company' ? mapping.domainColumn : null,
      mapping.entityType === 'person' ? mapping.emailsColumn : null,
      mapping.entityType === 'person' ? mapping.primaryEmailColumn : null,
    ].filter((h): h is string => Boolean(h) && h !== mapping.statusColumn),
  );
}

/** The columns that become fields of the list (the status column first), skipped ones included. */
export function listFieldColumns(
  mapping: AffinityListMapping,
  headers: readonly string[],
): string[] {
  const roles = roleColumns(mapping);
  const columns = headers.filter((h) => !roles.has(h));
  const status = mapping.statusColumn;
  return status && columns.includes(status)
    ? [status, ...columns.filter((h) => h !== status)]
    : columns;
}

/** The type a field column is imported as: the status column is always the pipeline. */
function columnType(mapping: AffinityListMapping, header: string): AffinityColumnType {
  if (header === mapping.statusColumn) return 'status';
  return mapping.types[header] ?? 'text';
}

/** The distinct values of a column, split for multi-value types, in stage order. */
function optionsOf(csv: AffinityCsv, header: string, multi: boolean): string[] {
  const seen = new Map<string, string>();
  for (const row of csv.rows) {
    const cell = (row.cells[header] ?? '').trim();
    if (!cell) continue;
    for (const v of multi ? splitCrmMulti(cell) : [cell.slice(0, 500)]) {
      if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
    }
  }
  return [...seen.values()].sort(compareAffinityOptions);
}

/** A field column with the CRM field it becomes. */
export interface AffinityFieldColumn {
  header: string;
  field: CrmField;
}

/**
 * The list's fields, keyed and typed as they will be stored. The status
 * column is keyed `status` and comes first, which makes it the list's
 * pipeline (statusFieldOf); other keys are slugs of the headers, the same on
 * every import of the same columns, so a re-import lines up with the fields
 * the first one created.
 */
export function listFields(mapping: AffinityListMapping, csv: AffinityCsv): AffinityFieldColumn[] {
  const taken = new Set<string>();
  const out: AffinityFieldColumn[] = [];
  for (const header of listFieldColumns(mapping, csv.headers)) {
    let type = columnType(mapping, header);
    if (type === 'skip' || out.length >= AFFINITY_IMPORT_LIMITS.fields) continue;
    let options: string[] | undefined;
    if (type === 'status') {
      options = optionsOf(csv, header, false);
      if (options.length > STATUS_MAX_OPTIONS && header !== mapping.statusColumn) {
        type = 'text';
        options = undefined;
      } else {
        options = options.slice(0, AFFINITY_IMPORT_LIMITS.options);
      }
    } else if (type === 'multi') {
      options = optionsOf(csv, header, true);
      if (options.length > MULTI_MAX_OPTIONS) options = [];
    }
    const key =
      header === mapping.statusColumn && !taken.has('status')
        ? (taken.add('status'), 'status')
        : crmFieldKey(header, taken);
    const field: CrmField = { key, name: header.slice(0, 200), type };
    if (options) field.options = options;
    out.push({ header, field });
  }
  return out;
}

/** What stops a file from importing, in words for the person fixing it. Empty when it can go. */
export function mappingProblems(mapping: AffinityMapping, csv: AffinityCsv): string[] {
  if (mapping.kind === 'introductions') {
    return mapping.unrecognised ? [mapping.unrecognised] : [];
  }
  const problems: string[] = [];
  if (!csv.headers.length)
    problems.push('This file has no header row, so its columns cannot be read.');
  if (!csv.rows.length) problems.push('This file has no rows to import.');
  if (mapping.kind === 'notes') {
    if (!mapping.contentColumn) problems.push('Pick the column that holds the note text.');
    return problems;
  }
  if (!mapping.listName.trim()) problems.push('Give the list a name.');
  if (mapping.listName.trim().length > 300) problems.push('The list name is too long.');
  if (!mapping.nameColumn && !mapping.firstNameColumn && !mapping.lastNameColumn) {
    problems.push(
      mapping.entityType === 'deal'
        ? 'Pick the column with the deal names.'
        : mapping.entityType === 'person'
          ? 'Pick the column with the names.'
          : 'Pick the column with the company names.',
    );
  }
  return problems;
}

/** The filled cells of a column that are not dates parseAffinityDate can read, with one to show. */
function unreadableDates(csv: AffinityCsv, header: string): { count: number; example: string } {
  let count = 0;
  let example = '';
  for (const row of csv.rows) {
    const cell = (row.cells[header] ?? '').trim();
    if (!cell || parseAffinityDate(cell)) continue;
    count++;
    example ||= cell.length > 40 ? `${cell.slice(0, 40)}…` : cell;
  }
  return { count, example };
}

/**
 * What will import, but not as well as it could: dates that cannot be read
 * (a notes export saved again by a spreadsheet can rewrite every one). Shown
 * before importing, never blocking it — the import keeps an unreadable date
 * column's cells as text, and an unreadable note date leaves the note undated
 * (and says so by row), rather than guessing.
 */
export function mappingWarnings(mapping: AffinityMapping, csv: AffinityCsv): string[] {
  const warnings: string[] = [];
  if (!csv.rows.length) return warnings;
  if (mapping.kind === 'introductions') {
    const skipped = new Set(mapping.skipped.map((p) => p.line)).size;
    const unread = mapping.sections.filter((s) => s.unrecognised && s.rows > 0);
    if (unread.length) {
      warnings.push(
        `${unread.map((s) => `“${s.title}”`).join(', ')} ${unread.length === 1 ? 'is' : 'are'} not ${unread.length === 1 ? 'a section' : 'sections'} Copilot recognises, so ${unread.length === 1 ? 'its' : 'their'} rows will be left out. The other sections import as usual.`,
      );
    }
    if (skipped) {
      warnings.push(
        `${skipped.toLocaleString('en-US')} ${skipped === 1 ? 'row has' : 'rows have'} no name or email for one side of the introduction and will be left out.`,
      );
    }
    if (mapping.notices.length) {
      warnings.push(
        `${mapping.notices.length.toLocaleString('en-US')} ${mapping.notices.length === 1 ? 'date' : 'dates'} could not be read; those introductions will be imported without a date.`,
      );
    }
    return warnings;
  }
  if (mapping.kind === 'notes') {
    if (!mapping.dateColumn) {
      warnings.push('No date column is chosen, so the notes will be imported without dates.');
      return warnings;
    }
    const { count, example } = unreadableDates(csv, mapping.dateColumn);
    if (count) {
      warnings.push(
        `${count.toLocaleString('en-US')} ${count === 1 ? 'note has a date' : 'notes have dates'} Copilot cannot read, such as “${example}”, so ${count === 1 ? 'it' : 'they'} will be imported without a date. If the file was opened and saved in a spreadsheet, exporting it from Affinity again usually fixes this.`,
      );
    }
    return warnings;
  }
  for (const { header, field } of listFields(mapping, csv)) {
    if (field.type !== 'date') continue;
    const { count, example } = unreadableDates(csv, header);
    if (!count) continue;
    warnings.push(
      `${count.toLocaleString('en-US')} ${count === 1 ? 'cell' : 'cells'} in “${header}” ${count === 1 ? 'is not a date' : 'are not dates'} Copilot can read, such as “${example}”. ${count === 1 ? 'It is' : 'They are'} kept as text and will not sort as dates.`,
    );
  }
  return warnings;
}

/* ---------------------------------------------------------------- payloads */
//
// The request bodies of /api/crm/import. The route validates them against
// these shapes and hands them to the import service.

export interface AffinityRecordPayload {
  externalId?: string | null;
  name?: string | null;
  domain?: string | null;
  /** All addresses as the export writes them ("a@x.example; b@x.example"). */
  emails?: string | null;
  primaryEmail?: string | null;
}

export interface AffinityEntryPayload {
  /**
   * What makes the row the same row next time, in one of three kinds (see
   * upsertEntries): the Affinity row id as it is, `entity:<id>` for the
   * organization, person or opportunity id when the view has no row id, or
   * `name:<name>` for a deal list with neither.
   */
  externalId?: string | null;
  title?: string | null;
  /** By field key. Raw cells ('' clears a value), dates already normalized. */
  values?: Record<string, string>;
  /** Index into the request's `records` of the company/person the row is about. */
  record?: number | null;
}

export interface AffinityListRequest {
  kind: 'list';
  list: {
    /** The existing list chosen to import into; without it the list is found by name. */
    id?: string | null;
    name: string;
    entityType: CrmEntityType;
    fields: CrmField[];
    externalId?: string | null;
  };
  records: AffinityRecordPayload[];
  entries: AffinityEntryPayload[];
}

export interface AffinityNotePayload {
  externalId: string;
  content: string;
  author?: string | null;
  /** ISO date-time, or null when the export's date could not be read. */
  occurredAt?: string | null;
  /** The note's entity first, then the names it is associated with. */
  entityNames?: string[];
}

export interface AffinityNotesRequest {
  kind: 'notes';
  notes: AffinityNotePayload[];
}

export type AffinityImportRequest =
  AffinityListRequest | AffinityNotesRequest | AffinityIntroductionsRequest;

/** A row the page reports against its spreadsheet row number. */
export interface AffinityRowProblem {
  line: number;
  message: string;
}

/** Requests to send in order, and the spreadsheet row of every payload row in each. */
export interface AffinityImportPlan<R extends AffinityImportRequest> {
  requests: R[];
  /** `lines[i][j]` is the spreadsheet row of request i's j-th entry (or note). */
  lines: number[][];
  /** Rows left out before sending, with why. */
  skipped: AffinityRowProblem[];
  /** Rows sent with a caveat the person should see (a note date that could not be read). */
  notices: AffinityRowProblem[];
  /** Rows that will be sent. */
  rowCount: number;
}

export interface AffinityChunkOptions {
  rowsPerChunk?: number;
  bytesPerChunk?: number;
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);
const cellOf = (row: AffinityCsvRow, header: string | null) =>
  header ? (row.cells[header] ?? '').trim() : '';

/** A stored date value for a date column: `YYYY-MM-DD`, an ISO date-time, or the cell as written. */
function dateCell(raw: string): string {
  return parseAffinityDate(raw)?.value ?? raw;
}

/**
 * The requests that import a list export. Each request carries the list (so
 * any chunk can create it), up to `rowsPerChunk` entries, and the records
 * those entries point at; a deal's record is its company, found or created
 * by name. Rows with nothing to identify them are skipped here, with the row
 * number, rather than sent to be skipped there.
 */
export function buildListImport(
  mapping: AffinityListMapping,
  csv: AffinityCsv,
  options: AffinityChunkOptions = {},
): AffinityImportPlan<AffinityListRequest> {
  const rowsPerChunk = Math.min(
    options.rowsPerChunk ?? AFFINITY_IMPORT_LIMITS.rowsPerChunk,
    AFFINITY_IMPORT_LIMITS.rowsPerRequest,
  );
  const bytesPerChunk = options.bytesPerChunk ?? AFFINITY_IMPORT_LIMITS.bytesPerChunk;
  const fieldColumns = listFields(mapping, csv);
  const list: AffinityListRequest['list'] = {
    name: mapping.listName.trim().slice(0, 300),
    entityType: mapping.entityType,
    fields: fieldColumns.map((c) => c.field),
  };
  if (mapping.targetListId) list.id = mapping.targetListId;
  const listBytes = utf8Length(JSON.stringify(list)) + 64;
  // A deal list without ids would otherwise match rows by company, folding a
  // company's second deal into its first; its name is the steadier key.
  const synthesizeIds =
    mapping.entityType === 'deal' && !mapping.rowIdColumn && !mapping.entityIdColumn;

  const plan: AffinityImportPlan<AffinityListRequest> = {
    requests: [],
    lines: [],
    skipped: [],
    notices: [],
    rowCount: 0,
  };
  // Asserted, not initialized as `null`: assignments inside `flush` are
  // invisible to narrowing, which would otherwise pin this to `null`.
  let current = null as AffinityListRequest | null;
  let currentLines: number[] = [];
  let bytes = 0;
  let dealRecords = new Map<string, number>();

  const flush = () => {
    if (current && current.entries.length) {
      plan.requests.push(current);
      plan.lines.push(currentLines);
    }
    current = null;
    currentLines = [];
    bytes = listBytes;
    dealRecords = new Map();
  };
  flush();

  for (const row of csv.rows) {
    const name = mapping.nameColumn
      ? cellOf(row, mapping.nameColumn)
      : [cellOf(row, mapping.firstNameColumn), cellOf(row, mapping.lastNameColumn)]
          .filter(Boolean)
          .join(' ');

    const values: Record<string, string> = {};
    for (const { header, field } of fieldColumns) {
      const raw = clip(cellOf(row, header), AFFINITY_IMPORT_LIMITS.cellChars);
      values[field.key] = field.type === 'date' && raw ? dateCell(raw) : raw;
    }

    let record: AffinityRecordPayload | null = null;
    let identified = Boolean(name);
    if (mapping.entityType === 'deal') {
      const company = splitCrmMulti(cellOf(row, mapping.organizationColumn))[0];
      if (company) record = { name: clip(company, 500) };
      identified ||= Boolean(company);
    } else if (mapping.entityType === 'company') {
      const domain = affinityDomain(cellOf(row, mapping.domainColumn));
      record = {
        externalId: clip(cellOf(row, mapping.entityIdColumn), 300) || null,
        name: clip(name, 500) || null,
        domain,
      };
      identified ||= Boolean(domain);
    } else {
      const emails = clip(cellOf(row, mapping.emailsColumn), 5000);
      const primaryEmail = clip(cellOf(row, mapping.primaryEmailColumn), 320);
      record = {
        externalId: clip(cellOf(row, mapping.entityIdColumn), 300) || null,
        name: clip(name, 500) || null,
        emails: emails || null,
        primaryEmail: primaryEmail || null,
      };
      identified ||= /@/.test(emails + primaryEmail);
    }
    if (!identified) {
      plan.skipped.push({
        line: row.line,
        message: 'No name, so the row was skipped.',
      });
      continue;
    }

    const rowId = cellOf(row, mapping.rowIdColumn);
    const entityId = cellOf(row, mapping.entityIdColumn);
    const entry: AffinityEntryPayload = {
      externalId: rowId
        ? clip(rowId, 300)
        : entityId
          ? clip(`entity:${entityId}`, 300)
          : synthesizeIds && name
            ? clip(`name:${crmNameKey(name)}`, 300)
            : null,
      title: clip(name, 500) || null,
      values,
    };
    const recordKey = record ? crmNameKey(record.name ?? '') : '';
    const newRecord =
      record && !(mapping.entityType === 'deal' && dealRecords.has(recordKey)) ? record : null;
    const rowBytes =
      utf8Length(JSON.stringify(entry)) +
      (newRecord ? utf8Length(JSON.stringify(newRecord)) : 0) +
      16;

    if (current && (current.entries.length >= rowsPerChunk || bytes + rowBytes > bytesPerChunk)) {
      flush();
    }
    const request: AffinityListRequest = (current ??= {
      kind: 'list',
      list,
      records: [],
      entries: [],
    });
    if (record) {
      if (mapping.entityType === 'deal' && dealRecords.has(recordKey)) {
        entry.record = dealRecords.get(recordKey) as number;
      } else {
        entry.record = request.records.push(record) - 1;
        if (mapping.entityType === 'deal') dealRecords.set(recordKey, entry.record);
      }
    }
    request.entries.push(entry);
    currentLines.push(row.line);
    bytes += rowBytes;
    plan.rowCount++;
  }
  flush();
  return plan;
}

/* ---------------------------------------------------------------- notes */

/**
 * cyrb53 (public domain): a fast 53-bit string hash, the same in every
 * JavaScript engine because it works on UTF-16 code units with 32-bit
 * integer maths. Two seeds give 106 bits — no collision in a few thousand
 * notes, or a few million.
 */
function cyrb53(str: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** A 106-bit hex digest of `key`, the same in every engine: identities fixed by a file's content. */
export function affinityHash(key: string): string {
  return `${cyrb53(key, 1)}${cyrb53(key, 2)}`;
}

/**
 * The identity of a note without an id: its date, author and text — not the
 * entity it was exported under. One Affinity note attached to an opportunity
 * and its organization comes out of the deal pipeline's export under the
 * opportunity's name and out of the organization list's under the company's,
 * and as one row per entity when a view holds both; keyed by entity, each
 * would be stored as another copy. Keyed like this, every row of the note
 * lands on the one stored note, and the upsert adds each row's names and
 * links to it.
 *
 * The date counts to the minute when it can be read — a spreadsheet that
 * rewrote "2026-10-02 14:05:33" as "10/2/26 14:05" still names the same note —
 * and as written when it cannot. Hashed here rather than on the server so the
 * key is fixed by the file itself and does not move when the server links a
 * name to a record. A note edited in Affinity is new text, so a later export
 * of it is a new note; only an export with note ids can say otherwise.
 *
 * Without a date or an author there is too little to tell one short note
 * from another ("Sent the deck" on fifty companies), so then — and only
 * then — the names it is attached to count too.
 */
export function affinityNoteId(
  date: string,
  author: string,
  content: string,
  entityNames: readonly string[] = [],
): string {
  const parsed = parseAffinityDate(date);
  const when = parsed
    ? parsed.kind === 'date'
      ? parsed.value
      : parsed.value.slice(0, 16)
    : crmNameKey(date);
  const who = crmNameKey(author);
  const parts: unknown[] = [when, who, content.replace(/\r\n?/g, '\n').trim()];
  if (!when && !who) parts.push([...new Set(entityNames.map(crmNameKey))].sort());
  const key = JSON.stringify(parts);
  return `affinity-csv:${cyrb53(key, 1)}${cyrb53(key, 2)}`;
}

/** A note's date as an ISO date-time; a bare date is noon UTC, the same calendar day from Hawaii to Tokyo. */
export function affinityNoteDate(raw: string): string | null {
  const parsed = parseAffinityDate(raw);
  if (!parsed) return null;
  return parsed.kind === 'date' ? `${parsed.value}T12:00:00.000Z` : parsed.value;
}

/** The requests that import a notes export, in chunks by count and size. */
export function buildNotesImport(
  mapping: AffinityNotesMapping,
  csv: AffinityCsv,
  options: AffinityChunkOptions = {},
): AffinityImportPlan<AffinityNotesRequest> {
  const rowsPerChunk = Math.min(
    options.rowsPerChunk ?? AFFINITY_IMPORT_LIMITS.rowsPerChunk,
    AFFINITY_IMPORT_LIMITS.rowsPerRequest,
  );
  const bytesPerChunk = options.bytesPerChunk ?? AFFINITY_IMPORT_LIMITS.bytesPerChunk;
  const plan: AffinityImportPlan<AffinityNotesRequest> = {
    requests: [],
    lines: [],
    skipped: [],
    notices: [],
    rowCount: 0,
  };
  let current: AffinityNotePayload[] = [];
  let currentLines: number[] = [];
  let bytes = 0;
  const flush = () => {
    if (current.length) {
      plan.requests.push({ kind: 'notes', notes: current });
      plan.lines.push(currentLines);
    }
    current = [];
    currentLines = [];
    bytes = 32;
  };
  flush();

  for (const row of csv.rows) {
    // Verbatim: only the identity hash normalizes line endings and edges.
    const content = mapping.contentColumn ? (row.cells[mapping.contentColumn] ?? '') : '';
    if (!content.trim()) {
      plan.skipped.push({ line: row.line, message: 'The note has no text, so it was skipped.' });
      continue;
    }
    if (content.length > AFFINITY_IMPORT_LIMITS.noteChars) {
      plan.skipped.push({
        line: row.line,
        message: 'The note is too long to store, so it was skipped.',
      });
      continue;
    }
    const entity = cellOf(row, mapping.entityColumn);
    const names: string[] = [];
    const seen = new Set<string>();
    for (const n of [
      ...splitCrmMulti(entity),
      ...mapping.associatedColumns.flatMap((c) => splitCrmMulti(cellOf(row, c))),
    ]) {
      const key = crmNameKey(n);
      if (seen.has(key) || names.length >= AFFINITY_IMPORT_LIMITS.namesPerNote) continue;
      seen.add(key);
      names.push(clip(n, 500));
    }
    const date = cellOf(row, mapping.dateColumn);
    const author = clip(cellOf(row, mapping.authorColumn), 300);
    const id = clip(cellOf(row, mapping.idColumn), 300);
    const occurredAt = affinityNoteDate(date);
    if (date && !occurredAt) {
      plan.notices.push({
        line: row.line,
        message: `The date “${clip(date, 60)}” could not be read, so the note was imported without one.`,
      });
    }
    const note: AffinityNotePayload = {
      externalId: id || affinityNoteId(date, author, content, names),
      content,
      author: author || null,
      occurredAt,
      entityNames: names,
    };
    const noteBytes = utf8Length(JSON.stringify(note)) + 8;
    if (current.length && (current.length >= rowsPerChunk || bytes + noteBytes > bytesPerChunk)) {
      flush();
    }
    current.push(note);
    currentLines.push(row.line);
    bytes += noteBytes;
    plan.rowCount++;
  }
  flush();
  return plan;
}

/* ---------------------------------------------------------------- results */

/** How rows fared, as the CRM upserts count them. */
export interface AffinityCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: number;
}

export const NO_COUNTS: AffinityCounts = {
  inserted: 0,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  errors: 0,
};

export function addCounts(a: AffinityCounts, b: AffinityCounts): AffinityCounts {
  return {
    inserted: a.inserted + b.inserted,
    updated: a.updated + b.updated,
    unchanged: a.unchanged + b.unchanged,
    skipped: a.skipped + b.skipped,
    errors: a.errors + b.errors,
  };
}

/** What /api/crm/import answers for one list request. `row` indexes the request's entries. */
export interface AffinityListImportResult {
  list: { id: string; name: string; created: boolean; updated: boolean };
  /** The companies/people the rows are about (a deal list's companies). */
  records: AffinityCounts;
  entries: AffinityCounts;
  /**
   * Values someone changed in Copilot since the last import, kept rather than
   * overwritten by the file's; each is also in `problems`, by row.
   */
  keptEdits: number;
  problems: { row: number; message: string }[];
}

/** What /api/crm/import answers for one notes request. `row` indexes the request's notes. */
export interface AffinityNotesImportResult {
  notes: AffinityCounts;
  /** Notes attached to at least one company, person or deal. */
  linked: number;
  /** Names that matched nothing; kept on the note as text. */
  unmatchedNames: number;
  /** Names that matched more than one record, so were not linked to any. */
  ambiguousNames: number;
  problems: { row: number; message: string }[];
}
