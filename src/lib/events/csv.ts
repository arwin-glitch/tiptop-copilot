import Papa from 'papaparse';
import { toCsv } from '@/lib/crm/saved-views';
import type {
  EventGuest,
  EventGuestSession,
  EventGuestStatus,
  EventSession,
} from '@/lib/types/domain';
import { answerText, DIETARY_NOTE_SUFFIX, type RegistrationQuestion } from './registration';

/**
 * Guest list CSV (D-075): the export (one row per guest and one per
 * plus-one, every answer, per-session status and check-in), the caterer's
 * headcount, and the import's parsing (email column detection, header →
 * field/question mapping, a preview before anything is written).
 *
 * Cells go through the CRM exporter's csvCell (RFC 4180 quoting, and a
 * leading apostrophe on anything a spreadsheet would run as a formula),
 * with a BOM so Excel reads UTF-8 names. Pure: no I/O.
 */

export const STATUS_LABELS: Record<EventGuestStatus, string> = {
  invited: 'Invited',
  pending: 'Pending',
  going: 'Going',
  maybe: 'Maybe',
  waitlist: 'Waitlist',
  declined: 'Declined',
  not_going: 'Not going',
};

function fullName(g: Pick<EventGuest, 'first_name' | 'last_name'>): string {
  return [g.first_name, g.last_name].filter(Boolean).join(' ').trim();
}

export interface ExportInput {
  guests: readonly EventGuest[];
  rows: readonly EventGuestSession[];
  sessions: readonly EventSession[];
  /** Every question ever asked, removed ones included ("(removed) Label"). */
  questions: readonly RegistrationQuestion[];
  timeZone: string;
}

function localStamp(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`;
}

/** The export's header row and data rows (hosts first, each followed by their plus-ones). */
export function guestExportRows(input: ExportInput): string[][] {
  const sessions = [...input.sessions].sort((a, b) => a.position - b.position);
  const questions = [...input.questions].sort((a, b) => a.position - b.position);
  const byGuest = new Map<string, Map<string, EventGuestSession>>();
  for (const r of input.rows) {
    const m = byGuest.get(r.guest_id) ?? new Map<string, EventGuestSession>();
    m.set(r.session_id, r);
    byGuest.set(r.guest_id, m);
  }
  const header = [
    'First name',
    'Last name',
    'Email',
    'Company',
    'Title',
    'Phone',
    'Tags',
    ...sessions.map((s) => `Status: ${s.name}`),
    'Plus-one of',
    ...questions.map((q) => (q.removed_at ? `(removed) ${q.label}` : q.label)),
    'Source',
    'Referral',
    'Registered',
    'Decided',
    ...sessions.map((s) => `Checked in: ${s.name}`),
  ];
  const guestsById = new Map(input.guests.map((g) => [g.id, g]));
  const hosts = input.guests
    .filter((g) => !g.parent_guest_id)
    .sort(
      (a, b) => fullName(a).localeCompare(fullName(b)) || a.created_at.localeCompare(b.created_at),
    );
  const ordered: EventGuest[] = [];
  for (const host of hosts) {
    ordered.push(host);
    for (const child of input.guests.filter((g) => g.parent_guest_id === host.id))
      ordered.push(child);
  }
  // Plus-ones whose host is not in this export (a filtered export) still appear.
  for (const g of input.guests) if (!ordered.includes(g)) ordered.push(g);

  const out: string[][] = [header];
  for (const g of ordered) {
    const rows = byGuest.get(g.id) ?? new Map<string, EventGuestSession>();
    const decided = [...rows.values()]
      .map((r) => r.decided_at)
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1);
    const parent = g.parent_guest_id ? guestsById.get(g.parent_guest_id) : undefined;
    out.push([
      g.first_name ?? '',
      g.last_name ?? '',
      g.email ?? '',
      g.company ?? '',
      g.title ?? '',
      g.phone ?? '',
      g.tags.join('; '),
      ...sessions.map((s) => {
        const status = rows.get(s.id)?.status;
        return status ? STATUS_LABELS[status] : '';
      }),
      parent ? fullName(parent) || parent.email || 'Guest' : '',
      ...questions.map((q) => {
        const base = answerText(g.answers[q.id]);
        const note = g.answers[`${q.id}${DIETARY_NOTE_SUFFIX}`];
        return typeof note === 'string' && note ? `${base}${base ? ' – ' : ''}${note}` : base;
      }),
      g.source,
      g.referral_code ?? '',
      localStamp(g.registered_at, input.timeZone),
      localStamp(decided ?? null, input.timeZone),
      ...sessions.map((s) => localStamp(rows.get(s.id)?.checked_in_at ?? null, input.timeZone)),
    ]);
  }
  return out;
}

export function guestExportCsv(input: ExportInput): string {
  return toCsv(guestExportRows(input));
}

/* ------------------------------------------------------------- headcount */

export interface SessionHeadcount {
  sessionId: string;
  name: string;
  going: number;
  plusOnes: number;
  checkedIn: number;
  pending: number;
  waitlist: number;
  capacity: number | null;
  /** Dietary answers among Going guests: "Vegetarian" → 4. */
  dietary: Record<string, number>;
}

/** The caterer's summary: Going per session (plus-ones included) and dietary counts. */
export function headcounts(input: ExportInput): SessionHeadcount[] {
  const guests = new Map(input.guests.map((g) => [g.id, g]));
  const dietaryQuestions = input.questions.filter((q) => q.type === 'dietary');
  return [...input.sessions]
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      const rows = input.rows.filter((r) => r.session_id === s.id);
      const going = rows.filter((r) => r.status === 'going');
      const dietary: Record<string, number> = {};
      // A dietary question asked for one session (the Reception's dinner)
      // counts only in that session's numbers.
      const dietaryIds = dietaryQuestions
        .filter((q) => !q.session_id || q.session_id === s.id)
        .map((q) => q.id);
      for (const r of going) {
        const g = guests.get(r.guest_id);
        if (!g) continue;
        for (const id of dietaryIds) {
          const value = g.answers[id];
          const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
          for (const item of list)
            if (typeof item === 'string') dietary[item] = (dietary[item] ?? 0) + 1;
        }
      }
      return {
        sessionId: s.id,
        name: s.name,
        going: going.length,
        plusOnes: going.filter((r) => guests.get(r.guest_id)?.parent_guest_id).length,
        checkedIn: rows.filter((r) => r.checked_in_at).length,
        pending: rows.filter((r) => r.status === 'pending').length,
        waitlist: rows.filter((r) => r.status === 'waitlist').length,
        capacity: s.capacity,
        dietary,
      };
    });
}

export function headcountCsv(counts: readonly SessionHeadcount[]): string {
  const kinds = [...new Set(counts.flatMap((c) => Object.keys(c.dietary)))].sort();
  return toCsv([
    [
      'Session',
      'Going (incl. plus-ones)',
      'Plus-ones',
      'Checked in',
      'Pending',
      'Waitlist',
      'Capacity',
      ...kinds,
    ],
    ...counts.map((c) => [
      c.name,
      String(c.going),
      String(c.plusOnes),
      String(c.checkedIn),
      String(c.pending),
      String(c.waitlist),
      c.capacity === null ? '' : String(c.capacity),
      ...kinds.map((k) => String(c.dietary[k] ?? 0)),
    ]),
  ]);
}

/* ---------------------------------------------------------------- import */

export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_MAX_BYTES = 1_000_000;

export type ImportTarget =
  | 'email'
  | 'first_name'
  | 'last_name'
  | 'full_name'
  | 'company'
  | 'title'
  | 'phone'
  | 'tags'
  | `question:${string}`
  | 'ignore';

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  warnings: string[];
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

export function looksLikeEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim().toLowerCase());
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1] as const);
  const [best] = [...counts].sort((a, b) => b[1] - a[1]);
  return best && best[1] > 0 ? best[0] : ',';
}

/** Parse a guest CSV: BOM-safe, quoted cells, blank rows dropped, capped. */
export function parseGuestCsv(text: string): ParsedCsv {
  const source = text.replace(/^﻿/, '');
  const result = Papa.parse<Record<string, string | undefined>>(source, {
    header: true,
    delimiter: detectDelimiter(source),
    skipEmptyLines: true,
    transformHeader: (h, i) => h.replace(/^﻿/, '').trim() || `Column ${i + 1}`,
  });
  const headers = (result.meta.fields ?? []).slice(0, 60);
  const warnings: string[] = [];
  const rows: Record<string, string>[] = [];
  for (const raw of result.data) {
    if (rows.length >= IMPORT_MAX_ROWS) {
      warnings.push(`Only the first ${IMPORT_MAX_ROWS} rows are read.`);
      break;
    }
    const cells: Record<string, string> = {};
    let blank = true;
    for (const h of headers) {
      const v = typeof raw[h] === 'string' ? (raw[h] as string).trim().slice(0, 500) : '';
      cells[h] = v;
      if (v) blank = false;
    }
    if (!blank) rows.push(cells);
  }
  if (result.errors.length)
    warnings.push(`${result.errors.length} line(s) could not be read cleanly.`);
  return { headers, rows, warnings };
}

const HEADER_GUESSES: [RegExp, ImportTarget][] = [
  [/^(e-?mail|email address|work email)$/i, 'email'],
  [/^(first|first name|given name|firstname)$/i, 'first_name'],
  [/^(last|last name|surname|family name|lastname)$/i, 'last_name'],
  [/^(name|full name|guest|attendee)$/i, 'full_name'],
  [/^(company|organization|organisation|firm|fund)$/i, 'company'],
  [/^(title|job title|role|position)$/i, 'title'],
  [/^(phone|mobile|cell|phone number)$/i, 'phone'],
  [/^(tags?|labels?|groups?)$/i, 'tags'],
];

/**
 * A first guess at what each column holds: known headers, question labels,
 * and whichever column is mostly email addresses when no header says so.
 */
export function guessMapping(
  csv: ParsedCsv,
  questions: readonly Pick<RegistrationQuestion, 'id' | 'label' | 'removed_at'>[],
): Record<string, ImportTarget> {
  const mapping: Record<string, ImportTarget> = {};
  for (const h of csv.headers) {
    const known = HEADER_GUESSES.find(([re]) => re.test(h));
    if (known) {
      mapping[h] = known[1];
      continue;
    }
    const q = questions.find(
      (q) => !q.removed_at && q.label.trim().toLowerCase() === h.toLowerCase(),
    );
    mapping[h] = q ? `question:${q.id}` : 'ignore';
  }
  if (!Object.values(mapping).includes('email')) {
    let best: { header: string; share: number } | null = null;
    for (const h of csv.headers) {
      const sample = csv.rows
        .slice(0, 50)
        .map((r) => r[h] ?? '')
        .filter(Boolean);
      if (!sample.length) continue;
      const share = sample.filter(looksLikeEmail).length / sample.length;
      if (share >= 0.6 && (!best || share > best.share)) best = { header: h, share };
    }
    if (best) mapping[best.header] = 'email';
  }
  // Only one column may be the email.
  let seenEmail = false;
  for (const h of csv.headers) {
    if (mapping[h] !== 'email') continue;
    if (seenEmail) mapping[h] = 'ignore';
    seenEmail = true;
  }
  return mapping;
}

export interface ImportPerson {
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
  phone: string | null;
  tags: string[];
  answers: Record<string, string>;
}

export interface ImportPreview {
  people: ImportPerson[];
  /** Rows without a usable email (line numbers as a spreadsheet shows them). */
  invalidLines: number[];
  /** The same email twice in the file: later rows dropped. */
  duplicateInFile: number;
}

function splitName(full: string): { first: string | null; last: string | null } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: null, last: null };
  return { first: parts[0]!.slice(0, 100), last: parts.slice(1).join(' ').slice(0, 100) || null };
}

const TAG_OK = /^[\p{L}\p{N}][\p{L}\p{N} &'._-]{0,39}$/u;

/** Turn mapped rows into people, deduplicated on email within the file. */
export function previewImport(
  csv: ParsedCsv,
  mapping: Record<string, ImportTarget>,
): ImportPreview {
  const people: ImportPerson[] = [];
  const invalidLines: number[] = [];
  const seen = new Set<string>();
  let duplicateInFile = 0;
  csv.rows.forEach((row, i) => {
    const person: ImportPerson = {
      email: '',
      first_name: null,
      last_name: null,
      company: null,
      title: null,
      phone: null,
      tags: [],
      answers: {},
    };
    for (const [header, target] of Object.entries(mapping)) {
      const value = (row[header] ?? '').trim();
      if (!value || target === 'ignore') continue;
      if (target === 'email') person.email = value.toLowerCase();
      else if (target === 'first_name') person.first_name = value.slice(0, 100);
      else if (target === 'last_name') person.last_name = value.slice(0, 100);
      else if (target === 'full_name') {
        const { first, last } = splitName(value);
        person.first_name ??= first;
        person.last_name ??= last;
      } else if (target === 'company') person.company = value.slice(0, 200);
      else if (target === 'title') person.title = value.slice(0, 200);
      else if (target === 'phone') person.phone = value.slice(0, 40);
      else if (target === 'tags') {
        for (const t of value
          .split(/[;,|]/)
          .map((x) => x.trim())
          .filter(Boolean)) {
          if (TAG_OK.test(t) && !person.tags.includes(t) && person.tags.length < 20)
            person.tags.push(t);
        }
      } else if (target.startsWith('question:')) {
        person.answers[target.slice('question:'.length)] = value.slice(0, 2000);
      }
    }
    if (!looksLikeEmail(person.email) || person.email.length > 320) {
      invalidLines.push(i + 2);
      return;
    }
    if (seen.has(person.email)) {
      duplicateInFile++;
      return;
    }
    seen.add(person.email);
    people.push(person);
  });
  return { people, invalidLines, duplicateInFile };
}

/** Pasted emails ("a@x.com, b@y.com\nC <c@z.com>") → unique, lowercased addresses. */
export function parsePastedEmails(text: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const piece of text.split(/[\s,;]+/)) {
    const cleaned = piece
      .replace(/^[<("']+|[>)"']+$/g, '')
      .trim()
      .toLowerCase();
    if (!cleaned) continue;
    if (!cleaned.includes('@')) continue;
    if (looksLikeEmail(cleaned)) {
      if (!emails.includes(cleaned)) emails.push(cleaned);
    } else invalid.push(piece.slice(0, 80));
  }
  return { emails: emails.slice(0, IMPORT_MAX_ROWS), invalid };
}
