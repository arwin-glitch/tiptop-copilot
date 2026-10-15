import { z } from 'zod';
import type { Task } from '@/lib/types/domain';
import { formatMonthDay, localDateKey } from '@/lib/util/time';
import { isOpenNow } from './tasks-view';

/**
 * Today's "At a glance" cards: Do now, Intros owed and Coming up, one short
 * line per task.
 *
 * Every line is a task row. Its short label and bucket live beside the task in
 * `task.glance_set` audit rows (no migration): a row with no user is the
 * routine's suggestion, a row with a user is a person's choice, and a person's
 * choice beats the routine's field by field. When the routine gave no label, a
 * deterministic shortener here writes one; there is no model in this path.
 *
 * Pure, so the server page, the ingest and the tests share one reading.
 */

export const GLANCE_BUCKETS = ['now', 'intro', 'upcoming'] as const;
export type GlanceBucket = (typeof GLANCE_BUCKETS)[number];

export const DUE_PRECISIONS = ['day', 'week'] as const;
export type DuePrecision = (typeof DUE_PRECISIONS)[number];

export type GlanceBy = 'routine' | 'person';

/** A short label's limits: one glance, one line on a phone. */
export const GLANCE_SHORT_MAX = 40;
export const GLANCE_SHORT_WORDS = 6;
/** Rows each card shows before "+N more". */
export const GLANCE_PER_CARD = 4;
/** Due today, tomorrow or the day after (local days) is Do now. */
export const GLANCE_NOW_DAYS = 2;
/** Further out than this many local days is not shown at all. */
export const GLANCE_HORIZON_DAYS = 30;

/** Words, not symbols: "Chris → Ivy + Sam P." is four. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/** A label as the routine or a person may set it. */
export const GLANCE_SHORT_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(GLANCE_SHORT_MAX)
  .refine((s) => !/[`\r\n]/.test(s), 'No backticks or line breaks.')
  .refine((s) => countWords(s) <= GLANCE_SHORT_WORDS, 'At most six words.');

/**
 * One `task.glance_set` row's metadata. Lenient per field: an odd field is
 * dropped and the rest kept. A row without `v: 1` is not a glance row.
 */
export const GLANCE_META_SCHEMA = z.object({
  v: z.literal(1),
  by: z.enum(['routine', 'person']).optional().catch(undefined),
  source: z.string().max(100).optional().catch(undefined),
  short: GLANCE_SHORT_SCHEMA.optional().catch(undefined),
  bucket: z.enum(GLANCE_BUCKETS).optional().catch(undefined),
  due_precision: z.enum(DUE_PRECISIONS).optional().catch(undefined),
});

export type GlanceMeta = z.infer<typeof GLANCE_META_SCHEMA>;

/** The audit-row fields the fold reads. */
export interface GlanceRow {
  user_id: string | null;
  created_at: string;
  metadata: unknown;
}

/** What a task's glance rows add up to. */
export interface FoldedGlance {
  short?: string;
  bucket?: GlanceBucket;
  /** Who chose the bucket: a person's choice is final, the routine's mostly a hint. */
  bucketBy?: GlanceBy;
  due_precision?: DuePrecision;
}

const FOLDED_FIELDS = ['short', 'bucket', 'due_precision'] as const;

/**
 * Field by field, the newest person's value, else the newest routine value.
 * Who wrote a row is its user id, never what its metadata claims. Rows that
 * do not parse are ignored.
 */
export function foldGlanceMeta(rows: readonly GlanceRow[]): FoldedGlance {
  const ordered = rows
    .map((row, index) => {
      const at = Date.parse(row.created_at);
      return { row, index, at: Number.isNaN(at) ? -Infinity : at };
    })
    .sort((a, b) => a.at - b.at || a.index - b.index);

  const latest: Record<GlanceBy, Partial<Record<(typeof FOLDED_FIELDS)[number], string>>> = {
    routine: {},
    person: {},
  };
  for (const { row } of ordered) {
    const parsed = GLANCE_META_SCHEMA.safeParse(row.metadata);
    if (!parsed.success) continue;
    const by: GlanceBy = row.user_id ? 'person' : 'routine';
    for (const field of FOLDED_FIELDS) {
      const value = parsed.data[field];
      if (value !== undefined) latest[by][field] = value;
    }
  }

  const out: FoldedGlance = {};
  const short = latest.person.short ?? latest.routine.short;
  if (short) out.short = short;
  if (latest.person.bucket) {
    out.bucket = latest.person.bucket as GlanceBucket;
    out.bucketBy = 'person';
  } else if (latest.routine.bucket) {
    out.bucket = latest.routine.bucket as GlanceBucket;
    out.bucketBy = 'routine';
  }
  const precision = latest.person.due_precision ?? latest.routine.due_precision;
  if (precision) out.due_precision = precision as DuePrecision;
  return out;
}

/* ----------------------------------------------------------------- buckets */

const ARROW_RE = /→|->|\s<>\s|↔/;
const INTRO_START_RE = /^(make |send )?(an |the )?(intro|introduce|introduction|connect)\b/i;
const SEND_INTROS_RE = /\bsend\b.*\bintros\b/i;
const INTRO_CALL_RE = /\bintro call\b/i;

/** A title that reads as an intro Nick owes. An "intro call" is a meeting, not an intro. */
export function isIntroTitle(title: string): boolean {
  const text = title.trim();
  if (INTRO_CALL_RE.test(text)) return false;
  return ARROW_RE.test(text) || INTRO_START_RE.test(text) || SEND_INTROS_RE.test(text);
}

function keyToUtcMs(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** Calendar days from `now` to `at` in `timeZone`: 0 is today, -1 yesterday. */
export function localDayDiff(at: Date | number, now: Date, timeZone: string): number {
  const when = typeof at === 'number' ? new Date(at) : at;
  return Math.round(
    (keyToUtcMs(localDateKey(when, timeZone)) - keyToUtcMs(localDateKey(now, timeZone))) /
      86_400_000,
  );
}

export interface GlanceClock {
  now: Date;
  timeZone: string;
}

/**
 * Which card a task belongs on, or null for none.
 *
 * 1. A person's bucket always wins.
 * 2. The routine's `intro` sticks; its `now` and `upcoming` are hints that a
 *    due date overrules.
 * 3. A title that reads as an intro is an intro.
 * 4. By local day: no date, overdue, or due within two days is Do now; three
 *    to thirty days out is Coming up; further out is not shown.
 */
export function classifyGlance(
  task: Pick<Task, 'title' | 'due_at'>,
  meta: FoldedGlance | undefined,
  { now, timeZone }: GlanceClock,
): GlanceBucket | null {
  if (meta?.bucket && meta.bucketBy === 'person') return meta.bucket;
  if (meta?.bucket === 'intro') return 'intro';
  if (isIntroTitle(task.title)) return 'intro';
  const due = task.due_at ? Date.parse(task.due_at) : Number.NaN;
  if (Number.isNaN(due)) return meta?.bucket ?? 'now';
  const days = localDayDiff(due, now, timeZone);
  if (days <= GLANCE_NOW_DAYS) return 'now';
  if (days <= GLANCE_HORIZON_DAYS) return 'upcoming';
  return null;
}

/* ------------------------------------------------------------- short label */

const ARTICLES = new Set(['a', 'an', 'the']);
/** Verbs that say nothing on a one-line label ("Send LoomStack pass note" is a pass note). */
const GENERIC_VERBS = new Set([
  'send',
  'do',
  'make',
  'get',
  'handle',
  'check',
  'follow',
  'up',
  'review',
  'read',
  'run',
  'finish',
  'complete',
  'take',
  'look',
  'sort',
  'work',
]);

/** ->, => and <> read as one arrow. */
export function displayLabel(label: string): string {
  return label
    .replace(/\s*(?:->|=>|<>)\s*/g, ' → ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** At most `max` characters, cut at a word where one is close, with an ellipsis. */
export function clipLabel(text: string, max = GLANCE_SHORT_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const room = clean.slice(0, max - 1);
  const space = room.lastIndexOf(' ');
  const cut = space >= max / 2 ? room.slice(0, space) : room;
  return `${cut.replace(/[\s,;:.–—-]+$/, '')}…`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The name a person goes by on a label: "Priya Raman" is Priya. A group that
 * is not a name ("a founding-engineer recruiter") keeps up to three words.
 */
function firstName(group: string): string {
  const words = group
    .replace(/^[\s,:;–—-]+|[\s,:;.–—-]+$/g, '')
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && ARTICLES.has(words[0]!.toLowerCase())) words.shift();
  const first = words[0] ?? '';
  if (/^\p{Lu}/u.test(first)) return first.replace(/['’]s$/, '').replace(/[,.;:]+$/, '');
  return words.slice(0, 3).join(' ');
}

const INTRO_PAIR_RE =
  /^(?:make |send )?(?:an |the )?intro(?:duce)?\s*:?\s+(.+?)\s+(?:to|with|<>|->|→)\s+(.+)$/i;
const REPLY_TO_RE = /^reply to\s+(.+)$/i;
const REPLY_STOP_RE = /\s+(?:about|re|on|regarding|this|today|tomorrow|by|for)\b.*$|[:—–(].*$/i;

function introLabel(title: string): string | null {
  const match = INTRO_PAIR_RE.exec(title);
  if (!match?.[1] || !match[2]) return null;
  const giver = firstName(match[1]);
  const receivers = match[2]
    .split(/\s+(?:and|&)\s+|,\s*/i)
    .map((group) => firstName(group))
    .filter(Boolean);
  if (!giver || receivers.length === 0) return null;
  return `${giver} → ${receivers.join(' + ')}`;
}

function replyLabel(title: string): string | null {
  const match = REPLY_TO_RE.exec(title);
  if (!match?.[1]) return null;
  const who = match[1].replace(REPLY_STOP_RE, '').trim().split(/\s+/).slice(0, 3).join(' ');
  return who ? `${who}: reply` : null;
}

/** The known company a title names, longest name first. */
function knownCompanyIn(title: string, known: readonly string[]): string | null {
  for (const name of [...known].sort((a, b) => b.length - a.length)) {
    const clean = name.trim();
    if (clean.length < 3) continue;
    if (companyRegExp(clean).test(title)) return clean;
  }
  return null;
}

function companyRegExp(company: string): RegExp {
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegExp(company)}(?:['’]s)?(?=$|[^\\p{L}\\p{N}])`,
    'iu',
  );
}

/**
 * "Company: three words" from the rest of the title. The company need not be
 * in the title: a task linked to a deal is about that company either way.
 */
function companyLabel(title: string, company: string): string | null {
  const match = companyRegExp(company).exec(title);
  const lead = match ? (match[1] ?? '') : '';
  // Whether what is left still opens with the title's own first word.
  const opensTitle = !match || match.index + lead.length > 0;
  const rest = match
    ? `${title.slice(0, match.index)}${lead} ${title.slice(match.index + match[0].length)}`
    : title;
  const tokens = rest
    .replace(/[:—–]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[,;.()-]+|[,;.()-]+$/g, ''))
    .filter(Boolean)
    // "A" mid-title is a name ("Series A"); only a sentence opens with it.
    .filter((w, i) => !ARTICLES.has(i === 0 ? w.toLowerCase() : w))
    .filter((w) => !GENERIC_VERBS.has(w.toLowerCase()))
    .map((w) => (/^(?:and|&)$/i.test(w) ? '+' : w));
  const picked: string[] = [];
  let words = 0;
  for (const token of tokens) {
    if (words === 3) break;
    if (token === '+' && (picked.length === 0 || picked.at(-1) === '+')) continue;
    picked.push(token);
    if (token !== '+') words++;
  }
  while (picked.at(-1) === '+') picked.pop();
  if (picked.length === 0) return null;
  // The title's own first word is capitalised for the sentence, not as a name.
  if (
    opensTitle &&
    /^\p{Lu}\p{Ll}+$/u.test(picked[0]!) &&
    rest.trimStart().startsWith(picked[0]!)
  ) {
    picked[0] = picked[0]!.toLowerCase();
  }
  return `${company}: ${picked.join(' ')}`;
}

/**
 * A short label for a task, without a model:
 * - a trailing "(…)" is dropped;
 * - "Intro A to B and C" is "A → B + C" (first names);
 * - "Reply to X …" is "X: reply";
 * - a linked or known company is "Company: three words", without articles
 *   and generic verbs;
 * - otherwise the first five words and "…".
 * Never longer than 40 characters.
 */
export function shortLabel(
  title: string,
  company: string | null = null,
  known: readonly string[] = [],
): string {
  const base = title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*\([^()]*\)\s*$/, '')
    .trim();
  if (!base) return clipLabel(title);

  const intro = introLabel(base);
  if (intro) return clipLabel(displayLabel(intro));

  const reply = replyLabel(base);
  if (reply) return clipLabel(reply);

  const name = company?.trim() || knownCompanyIn(base, known);
  const byCompany = name ? companyLabel(base, name) : null;
  if (byCompany) return clipLabel(byCompany);

  const words = base.split(' ');
  const head = words.slice(0, 5).join(' ');
  return clipLabel(words.length > 5 ? `${head.replace(/[,;:.–—-]+$/, '')}…` : head);
}

/** "Oct 19", or "Oct 19 wk" for a week-level deadline. */
export function glanceDueLabel(
  dueAt: string | Date,
  precision: DuePrecision | undefined,
  timeZone: string,
): string {
  return `${formatMonthDay(dueAt, timeZone)}${precision === 'week' ? ' wk' : ''}`;
}

/* ------------------------------------------------------------------- build */

export interface GlanceItem {
  id: string;
  label: string;
  fullTitle: string;
  /** "Today", "Tomorrow", "Oct 19", "Oct 19 wk"; null when undated. */
  when: string | null;
  overdue: boolean;
}

export interface GlanceCard {
  items: GlanceItem[];
  total: number;
}

export interface Glance {
  now: GlanceCard;
  intro: GlanceCard;
  upcoming: GlanceCard;
}

export interface BuildGlanceOptions extends GlanceClock {
  /** Deal and portfolio company names by id, for labels. Every name also counts as known. */
  companyNames?: ReadonlyMap<string, string>;
  /** Rows per card; the rest are counted. */
  limit?: number;
}

type GlanceTask = Pick<
  Task,
  | 'id'
  | 'title'
  | 'status'
  | 'due_at'
  | 'snoozed_until'
  | 'deal_id'
  | 'portfolio_company_id'
  | 'created_at'
>;

/** True when nothing would show: the block is left out. */
export function glanceIsEmpty(glance: Glance): boolean {
  return glance.now.total + glance.intro.total + glance.upcoming.total === 0;
}

/**
 * The cards Today shows, in order; none when the row is left out.
 *
 * Today's Top priorities list, when it is showing, is the page's to-do list,
 * so Do now steps aside (`hideNow`, from `todayLead`) rather than list the
 * same work a second way; Intros owed and Coming up stay. Without a list for
 * today all three show, so Today always has a to-do list. The row is left out
 * when every card it would show is empty; otherwise an empty card says
 * "Clear", as before.
 */
export function todayGlanceCards(
  glance: Glance | null,
  { hideNow = false }: { hideNow?: boolean } = {},
): GlanceBucket[] {
  if (!glance) return [];
  const cards = GLANCE_BUCKETS.filter((bucket) => !(hideNow && bucket === 'now'));
  return cards.some((bucket) => glance[bucket].total > 0) ? cards : [];
}

/** Open (or awake) tasks -> the three cards, each sorted, capped and counted. */
export function buildGlance(
  tasks: readonly GlanceTask[],
  meta: ReadonlyMap<string, FoldedGlance>,
  { now, timeZone, companyNames = new Map(), limit = GLANCE_PER_CARD }: BuildGlanceOptions,
): Glance {
  const known = [...new Set(companyNames.values())];
  const buckets: Record<GlanceBucket, { task: GlanceTask; due: number; item: GlanceItem }[]> = {
    now: [],
    intro: [],
    upcoming: [],
  };

  for (const task of tasks) {
    if (!isOpenNow(task, now)) continue;
    const folded = meta.get(task.id);
    const bucket = classifyGlance(task, folded, { now, timeZone });
    if (!bucket) continue;
    const due = task.due_at ? Date.parse(task.due_at) : Number.NaN;
    const company =
      (task.deal_id ? companyNames.get(task.deal_id) : undefined) ??
      (task.portfolio_company_id ? companyNames.get(task.portfolio_company_id) : undefined) ??
      null;
    const label = clipLabel(displayLabel(folded?.short ?? shortLabel(task.title, company, known)));
    buckets[bucket].push({
      task,
      due,
      item: {
        id: task.id,
        label,
        fullTitle: task.title,
        when: whenLabel(due, bucket, folded?.due_precision, now, timeZone),
        overdue: !Number.isNaN(due) && due < now.getTime(),
      },
    });
  }

  const created = (task: GlanceTask) => {
    const ms = Date.parse(task.created_at);
    return Number.isNaN(ms) ? 0 : ms;
  };
  const dated = (a: number, b: number) => {
    const aNaN = Number.isNaN(a);
    const bNaN = Number.isNaN(b);
    if (aNaN || bNaN) return aNaN === bNaN ? 0 : aNaN ? 1 : -1;
    return a - b;
  };

  // Do now: overdue oldest first, then soonest due, then undated newest first.
  buckets.now.sort(
    (a, b) =>
      dated(a.due, b.due) ||
      (Number.isNaN(a.due) ? created(b.task) - created(a.task) : 0) ||
      a.task.id.localeCompare(b.task.id),
  );
  // Intros: the one owed longest first.
  buckets.intro.sort(
    (a, b) => created(a.task) - created(b.task) || a.task.id.localeCompare(b.task.id),
  );
  // Coming up: soonest first; an undated hint last.
  buckets.upcoming.sort(
    (a, b) =>
      dated(a.due, b.due) ||
      created(a.task) - created(b.task) ||
      a.task.id.localeCompare(b.task.id),
  );

  const card = (rows: { item: GlanceItem }[]): GlanceCard => ({
    items: rows.slice(0, limit).map((row) => row.item),
    total: rows.length,
  });
  return { now: card(buckets.now), intro: card(buckets.intro), upcoming: card(buckets.upcoming) };
}

function whenLabel(
  due: number,
  bucket: GlanceBucket,
  precision: DuePrecision | undefined,
  now: Date,
  timeZone: string,
): string | null {
  if (Number.isNaN(due)) return null;
  if (bucket === 'now' && precision !== 'week') {
    const days = localDayDiff(due, now, timeZone);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
  }
  return glanceDueLabel(new Date(due), precision, timeZone);
}
