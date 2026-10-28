import Papa from 'papaparse';
import {
  AFFINITY_IMPORT_LIMITS,
  AFFINITY_INTRODUCTIONS_TITLE,
  affinityDomain,
  affinityHash,
  parseAffinityDate,
  type AffinityChunkOptions,
  type AffinityCounts,
  type AffinityCsv,
  type AffinityCsvRow,
  type AffinityImportPlan,
  type AffinityRowProblem,
} from '@/lib/crm/affinity-csv';
import { crmNameKey } from '@/lib/crm/fields';

/**
 * Affinity's "Export all introductions in view", read into introductions.
 *
 * Unlike the list and notes exports this is not one table. It is a run of
 * sections, each a title line, a header line and rows, separated by blank
 * lines:
 *
 *   Introductions Made By:                      the person introduced someone
 *   Introductions Made To:                      the person was introduced
 *   Source of Introduction for (People):        the person brought in a person
 *   Source of Introduction for (Organizations): ... or an organization
 *
 * Each row names the list's own person (and, from an organization list, the
 * organization they were exported under), the other people in the
 * introduction, a date and the email or chat it was seen in. None of it is
 * documented, so each section is read by its title and its headers together,
 * forgivingly about case and spacing. A section whose title or columns are
 * not ones described here is reported as not recognised and left out —
 * never guessed at — and a file with nothing recognisable imports nothing.
 *
 * Pure, like affinity-csv.ts: it runs in the browser where the file is read,
 * and in tests. The page sends what it reads to /api/crm/import.
 */

export type IntroductionSection = 'made_by' | 'made_to' | 'source_people' | 'source_orgs';

export const SECTION_LABELS: Record<IntroductionSection, string> = {
  made_by: 'Made by',
  made_to: 'Made to',
  source_people: 'Source for a person',
  source_orgs: 'Source for an organization',
};

/** Someone (or some organization) in an introduction, as the export names them. */
export interface IntroParty {
  kind: 'person' | 'company';
  name?: string | null;
  /** People only, lower case. */
  email?: string | null;
  /** Organizations only, a bare domain. */
  domain?: string | null;
  /** The organization a person was exported under, in an organization list's export. */
  organization?: { name?: string | null; domain?: string | null } | null;
}

/** One introduction: who made it, who was introduced, when, and where it was seen. */
export interface AffinityIntroductionPayload {
  /** Stable across files and re-imports: the date and the people, not the section. */
  externalId: string;
  section: IntroductionSection;
  introducer: IntroParty;
  /**
   * The people (or organization) introduced: the one brought in first, then
   * whoever they were introduced to, when the export says.
   */
  introduced: IntroParty[];
  /** YYYY-MM-DD, or null when the export has none (a hand-set source). */
  date?: string | null;
  evidence?: 'email' | 'chat' | null;
}

/** A section as read, for the page to show what was and was not understood. */
export interface IntroSectionSummary {
  title: string;
  /** The spreadsheet row of the title. */
  line: number;
  section: IntroductionSection | null;
  rows: number;
  /** Why it was left out, when it was. */
  unrecognised: string | null;
}

export interface AffinityIntroductionsMapping {
  kind: 'introductions';
  introductions: AffinityIntroductionPayload[];
  /** `lines[i]` is the spreadsheet row introductions[i] came from. */
  lines: number[];
  sections: IntroSectionSummary[];
  /** Rows left out, with why. */
  skipped: AffinityRowProblem[];
  /** Rows read with a caveat (a date that could not be read). */
  notices: AffinityRowProblem[];
  /** Why nothing could be read, when nothing could; null otherwise. */
  unrecognised: string | null;
}

export interface AffinityIntroductionsRequest {
  kind: 'introductions';
  introductions: AffinityIntroductionPayload[];
}

/** What /api/crm/import answers for one introductions request. `row` indexes its introductions. */
export interface AffinityIntroductionsImportResult {
  introductions: AffinityCounts;
  /** Introductions naming at least one company or person already in Kraken. */
  linked: number;
  problems: { row: number; message: string }[];
}

/* ---------------------------------------------------------------- reading */

const norm = (cell: string) => cell.trim().toLowerCase().replace(/\s+/g, ' ');

const SECTION_TITLES: { section: IntroductionSection; re: RegExp }[] = [
  { section: 'made_by', re: /^introductions? made by:?$/ },
  { section: 'made_to', re: /^introductions? made to:?$/ },
  { section: 'source_people', re: /^source of introductions? for \(?(people|persons)\)?:?$/ },
  {
    section: 'source_orgs',
    re: /^source of introductions? for \(?(organi[sz]ations|companies)\)?:?$/,
  },
];

/** A row with one filled cell, in the first column, that reads like a section title. */
function titleOf(cells: readonly string[]): string | null {
  const first = (cells[0] ?? '').trim();
  if (!first || first.includes('@') || cells.slice(1).some((c) => c.trim())) return null;
  return AFFINITY_INTRODUCTIONS_TITLE.test(first) || /:$/.test(first) ? first : null;
}

/** True when the file opens with an introductions section title rather than a header row. */
export function isAffinityIntroductionsText(text: string): boolean {
  const source = text.replace(/^﻿/, '');
  const firstLine = source.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const cells = firstLine.split(/[,;\t]/).map((c) => c.replace(/^"|"$/g, ''));
  const first = (cells[0] ?? '').trim();
  return (
    AFFINITY_INTRODUCTIONS_TITLE.test(first) &&
    !first.includes('@') &&
    cells.slice(1).every((c) => !c.trim())
  );
}

/** The delimiter, from the first line that has one: the title line has none. */
function detectDelimiter(text: string): string {
  for (const line of text.split(/\r?\n/).slice(0, 10)) {
    const counts = [',', ';', '\t'].map((d) => [d, line.split(d).length - 1] as const);
    const [best] = [...counts].sort((a, b) => b[1] - a[1]);
    if (best && best[1] > 0) return best[0];
  }
  return ',';
}

type Role =
  | 'orgName'
  | 'orgDomain'
  | 'name'
  | 'email'
  | 'internalName'
  | 'internalEmail'
  | 'externalName'
  | 'externalEmail'
  | 'introducerName'
  | 'introducerEmail'
  | 'introduceeName'
  | 'introduceeEmail'
  | 'personIntroducedName'
  | 'personIntroducedEmail'
  | 'orgIntroducedName'
  | 'orgIntroducedDomain';

const ORG = '(organi[sz]ation|company)';
const ROLE_PATTERNS: [Role, RegExp][] = [
  ['orgName', new RegExp(`^${ORG}( name)?$`)],
  ['orgDomain', new RegExp(`^${ORG} (domain|website|url)$`)],
  ['name', /^(person name|name|full name|person)$/],
  ['email', /^(person email|email|primary email|person email address|email address)$/],
  ['internalName', /^internal (person )?name$/],
  ['internalEmail', /^internal (person )?email( address)?$/],
  ['externalName', /^external (person )?name$/],
  ['externalEmail', /^external (person )?email( address)?$/],
  ['introducerName', /^introducer( name)?$/],
  ['introducerEmail', /^introducer email( address)?$/],
  ['introduceeName', /^introducee( name)?$/],
  ['introduceeEmail', /^introducee email( address)?$/],
  ['personIntroducedName', /^(person introduced|introduced person)( name)?$/],
  ['personIntroducedEmail', /^(person introduced|introduced person) email( address)?$/],
  ['orgIntroducedName', new RegExp(`^(${ORG} introduced|introduced ${ORG})( name)?$`)],
  ['orgIntroducedDomain', new RegExp(`^(${ORG} introduced|introduced ${ORG}) (domain|website)$`)],
];

/** Which columns the section needs before any of its rows can be read: [one of these] each. */
const REQUIRED: Record<IntroductionSection, Role[][]> = {
  made_by: [
    ['name', 'email'],
    ['externalName', 'externalEmail'],
  ],
  made_to: [
    ['name', 'email'],
    ['introducerName', 'introducerEmail'],
  ],
  source_people: [
    ['name', 'email'],
    ['personIntroducedName', 'personIntroducedEmail'],
  ],
  source_orgs: [
    ['name', 'email'],
    ['orgIntroducedName', 'orgIntroducedDomain'],
  ],
};

interface Layout {
  roles: Partial<Record<Role, number>>;
  /** Date columns, each with the kind of the id column after it (email or chat), if any. */
  dates: { index: number; evidence: 'email' | 'chat' | null }[];
  /** Id columns by kind, for evidence when there is no date. */
  ids: { index: number; evidence: 'email' | 'chat' }[];
}

function readLayout(header: readonly string[]): Layout {
  const roles: Partial<Record<Role, number>> = {};
  const dates: Layout['dates'] = [];
  const ids: Layout['ids'] = [];
  const idKind = (cell: string | undefined): 'email' | 'chat' | null => {
    const h = norm(cell ?? '');
    if (/^(email|e-mail|message) id$/.test(h)) return 'email';
    if (/^(chat|chat message|slack message) id$/.test(h)) return 'chat';
    return null;
  };
  header.forEach((cell, index) => {
    const h = norm(cell);
    if (!h) return;
    if (/^(date|introduction date|date introduced|intro date)$/.test(h)) {
      dates.push({ index, evidence: idKind(header[index + 1]) });
      return;
    }
    const kind = idKind(cell);
    if (kind) {
      ids.push({ index, evidence: kind });
      return;
    }
    for (const [role, re] of ROLE_PATTERNS) {
      if (roles[role] === undefined && re.test(h)) {
        roles[role] = index;
        return;
      }
    }
  });
  return { roles, dates, ids };
}

function missingFor(section: IntroductionSection, layout: Layout): boolean {
  return REQUIRED[section].some((group) => group.every((r) => layout.roles[r] === undefined));
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

function cellAt(cells: readonly string[], index: number | undefined): string {
  return index === undefined ? '' : (cells[index] ?? '').trim();
}

function person(
  cells: readonly string[],
  layout: Layout,
  nameRole: Role,
  emailRole: Role,
  withOrganization = false,
): IntroParty | null {
  const name = clip(cellAt(cells, layout.roles[nameRole]), 500);
  const rawEmail = cellAt(cells, layout.roles[emailRole]).toLowerCase();
  const email = EMAIL_RE.test(rawEmail) ? clip(rawEmail, 320) : null;
  if (!name && !email) return null;
  const party: IntroParty = { kind: 'person', name: name || null, email };
  if (withOrganization) {
    const orgName = clip(cellAt(cells, layout.roles.orgName), 500);
    const orgDomain = affinityDomain(cellAt(cells, layout.roles.orgDomain));
    if (orgName || orgDomain) party.organization = { name: orgName || null, domain: orgDomain };
  }
  return party;
}

function company(cells: readonly string[], layout: Layout): IntroParty | null {
  const name = clip(cellAt(cells, layout.roles.orgIntroducedName), 500);
  const domain = affinityDomain(cellAt(cells, layout.roles.orgIntroducedDomain));
  if (!name && !domain) return null;
  return { kind: 'company', name: name || null, domain };
}

/** The party's identity: an email or domain when there is one, else its name. */
export function partyKey(party: IntroParty): string | null {
  if (party.kind === 'person') {
    if (party.email) return `email:${party.email.toLowerCase()}`;
    return party.name ? `person:${crmNameKey(party.name)}` : null;
  }
  if (party.domain) return `domain:${party.domain.toLowerCase()}`;
  return party.name ? `company:${crmNameKey(party.name)}` : null;
}

/**
 * The keys a party is found by on a profile: its own identity, and for a
 * person exported under an organization, that organization's — so a
 * company's profile shows the introductions its people made or received.
 */
export function partyKeys(party: IntroParty): string[] {
  const keys: string[] = [];
  const own = partyKey(party);
  if (own) keys.push(own);
  const org = party.organization;
  if (org) {
    const key = org.domain
      ? `domain:${org.domain.toLowerCase()}`
      : org.name
        ? `company:${crmNameKey(org.name)}`
        : null;
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** The keys a company or person record is found under: the same shapes as partyKeys. */
export function recordIntroKeys(record: {
  kind: 'company' | 'person';
  name: string;
  emails: readonly string[];
  domain: string | null;
}): string[] {
  if (record.kind === 'company') {
    return [
      ...(record.domain ? [`domain:${record.domain.toLowerCase()}`] : []),
      `company:${crmNameKey(record.name)}`,
    ];
  }
  return [
    ...new Set(record.emails.map((e) => `email:${e.toLowerCase()}`)),
    `person:${crmNameKey(record.name)}`,
  ];
}

/**
 * An introduction's identity: its date and the people in it, not the section
 * or the file. One introduction email comes out of a person list as "made by"
 * the introducer and out of another list as "made to" each person introduced;
 * keyed like this, both rows are the one introduction.
 */
export function introductionId(
  intro: Pick<AffinityIntroductionPayload, 'introducer' | 'introduced' | 'date'>,
): string {
  const parties = [...new Set(intro.introduced.map(partyKey).filter(Boolean))].sort();
  const key = JSON.stringify([intro.date ?? '', partyKey(intro.introducer), parties]);
  return `affinity-intro:${affinityHash(key)}`;
}

/** "Name (Organization)", else the email or domain. */
export function partyLabel(party: IntroParty): string {
  const base = party.name || party.email || party.domain || 'Unknown';
  const org = party.organization?.name || party.organization?.domain;
  return org ? `${base} (${org})` : base;
}

const PREVIEW_HEADERS = ['Section', 'Introduced by', 'Introduced', 'With', 'Date'];

/**
 * Read an introductions export: null when the file is not one (it does not
 * open with an introductions section title), so the page reads it as a list
 * or notes export instead. `csv` is a preview table of what was understood,
 * one row per introduction, for the page's usual preview.
 */
export function readAffinityIntroductions(
  text: string,
): { csv: AffinityCsv; mapping: AffinityIntroductionsMapping } | null {
  const source = text.replace(/^﻿/, '');
  if (!isAffinityIntroductionsText(source)) return null;
  const parsed = Papa.parse<string[]>(source, {
    header: false,
    delimiter: detectDelimiter(source),
    skipEmptyLines: false,
  });
  const grid = parsed.data.map((row) => (Array.isArray(row) ? row.map((c) => c ?? '') : []));

  const mapping: AffinityIntroductionsMapping = {
    kind: 'introductions',
    introductions: [],
    lines: [],
    sections: [],
    skipped: [],
    notices: [],
    unrecognised: null,
  };
  const previewRows: AffinityCsvRow[] = [];

  let i = 0;
  while (i < grid.length) {
    const cells = grid[i] as string[];
    const title = titleOf(cells);
    if (!title) {
      i++;
      continue;
    }
    const summary: IntroSectionSummary = {
      title,
      line: i + 1,
      section: SECTION_TITLES.find((s) => s.re.test(norm(title)))?.section ?? null,
      rows: 0,
      unrecognised: null,
    };
    mapping.sections.push(summary);
    // The header: the next filled row, unless it is already the next title.
    let h = i + 1;
    while (h < grid.length && !(grid[h] as string[]).some((c) => c.trim())) h++;
    const header = h < grid.length && !titleOf(grid[h] as string[]) ? (grid[h] as string[]) : null;
    // The rows: up to the next title.
    let end = header ? h + 1 : h;
    while (end < grid.length && !titleOf(grid[end] as string[])) end++;
    const firstRow = header ? h + 1 : end;

    const layout = header ? readLayout(header) : null;
    if (!summary.section) {
      summary.unrecognised = `“${title}” is not a section Kraken knows how to read.`;
    } else if (!layout || missingFor(summary.section, layout)) {
      summary.unrecognised = `The columns under “${title}” are not the ones Kraken knows how to read.`;
    }
    for (let r = firstRow; r < end; r++) {
      const row = grid[r] as string[];
      if (!row.some((c) => c.trim())) continue;
      summary.rows++;
      if (summary.unrecognised || !summary.section || !layout) continue;
      const read = readRow(summary.section, row, layout, r + 1, mapping);
      if (!read) continue;
      mapping.introductions.push(read);
      mapping.lines.push(r + 1);
      previewRows.push({
        line: r + 1,
        cells: {
          Section: SECTION_LABELS[read.section],
          'Introduced by': partyLabel(read.introducer),
          Introduced: read.introduced[0] ? partyLabel(read.introduced[0]) : '',
          With: read.introduced
            .slice(1)
            .map((p) => partyLabel(p))
            .join('; '),
          Date: read.date ?? '',
        },
      });
    }
    i = end;
  }

  if (!mapping.introductions.length) {
    const reasons = mapping.sections
      .map((s) => s.unrecognised)
      .filter((r): r is string => Boolean(r));
    mapping.unrecognised = reasons.length
      ? `This looks like an Affinity introductions export, but Kraken does not recognise its layout, so nothing will be imported from it. ${reasons.slice(0, 4).join(' ')}`
      : 'This introductions export has no introductions in it.';
  }

  return {
    csv: { headers: PREVIEW_HEADERS, rows: previewRows, warnings: [] },
    mapping,
  };
}

function readRow(
  section: IntroductionSection,
  cells: readonly string[],
  layout: Layout,
  line: number,
  mapping: AffinityIntroductionsMapping,
): AffinityIntroductionPayload | null {
  const subject = person(cells, layout, 'name', 'email', true);
  let introducer: IntroParty | null = null;
  let introduced: (IntroParty | null)[] = [];
  if (section === 'made_by') {
    introducer = subject;
    introduced = [
      person(cells, layout, 'externalName', 'externalEmail'),
      person(cells, layout, 'internalName', 'internalEmail'),
    ];
  } else if (section === 'made_to') {
    introducer = person(cells, layout, 'introducerName', 'introducerEmail');
    introduced = [subject, person(cells, layout, 'introduceeName', 'introduceeEmail')];
  } else if (section === 'source_people') {
    introducer = subject;
    introduced = [person(cells, layout, 'personIntroducedName', 'personIntroducedEmail')];
  } else {
    introducer = subject;
    introduced = [company(cells, layout)];
  }
  const parties = introduced.filter((p): p is IntroParty => p !== null);
  if (!introducer || !introduced[0] || !parties.length) {
    mapping.skipped.push({
      line,
      message: !introducer
        ? 'No name or email for who made the introduction, so the row was skipped.'
        : 'No name or email for who was introduced, so the row was skipped.',
    });
    return null;
  }

  // The first date the row has, the email's before the chat's.
  let date: string | null = null;
  let evidence: 'email' | 'chat' | null = null;
  const dated = [...layout.dates].sort(
    (a, b) => Number(a.evidence === 'chat') - Number(b.evidence === 'chat'),
  );
  for (const d of dated) {
    const raw = cellAt(cells, d.index);
    if (!raw) continue;
    const value = parseAffinityDate(raw);
    if (!value) {
      mapping.notices.push({
        line,
        message: `The date “${clip(raw, 60)}” could not be read, so the introduction was imported without one.`,
      });
      evidence = d.evidence;
      break;
    }
    date = value.value.slice(0, 10);
    evidence = d.evidence;
    break;
  }
  if (!evidence) evidence = layout.ids.find((id) => cellAt(cells, id.index))?.evidence ?? null;

  const intro = { section, introducer, introduced: parties, date, evidence };
  return { externalId: introductionId(intro), ...intro };
}

/* ---------------------------------------------------------------- payloads */

/** The requests that import an introductions export, in chunks by count. */
export function buildIntroductionsImport(
  mapping: AffinityIntroductionsMapping,
  options: AffinityChunkOptions = {},
): AffinityImportPlan<AffinityIntroductionsRequest> {
  const rowsPerChunk = Math.min(
    options.rowsPerChunk ?? AFFINITY_IMPORT_LIMITS.rowsPerChunk,
    AFFINITY_IMPORT_LIMITS.rowsPerRequest,
  );
  const plan: AffinityImportPlan<AffinityIntroductionsRequest> = {
    requests: [],
    lines: [],
    skipped: [...mapping.skipped],
    notices: [...mapping.notices],
    rowCount: 0,
  };
  for (let start = 0; start < mapping.introductions.length; start += rowsPerChunk) {
    plan.requests.push({
      kind: 'introductions',
      introductions: mapping.introductions.slice(start, start + rowsPerChunk),
    });
    plan.lines.push(mapping.lines.slice(start, start + rowsPerChunk));
  }
  plan.rowCount = mapping.introductions.length;
  return plan;
}
