import { z } from 'zod';
import { single } from '@/lib/util/page-tabs';
import {
  DAY,
  GMAIL_ID,
  RELAY_ENVELOPE,
  clippedText,
  enumKey,
  keyText,
  optionalDay,
  optionalText,
} from './relay-fields';

/**
 * Students and interns, from the students routine's `STUDENTS_V1` snapshot
 * in #deal-relay: students Nick mentors through a school or program, schools
 * and programs inviting TipTop to take part (fellowships, PE/VC labs, alumni
 * mentor programs, university venture events), and students or early-career
 * people asking to intern at TipTop or for advice. A cloud routine reads the
 * mail twice a week (Monday and Thursday) and posts one deduplicated list;
 * the Portfolio page's "Students & interns" tab reads it back.
 *
 * Pure: the post's shape, the dedupe key, the filters and the display rules.
 * The Slack read is `src/lib/services/portfolio-students.ts`. Every value is
 * rendered as plain text, and a source is only ever a Gmail id with its date
 * and subject: the tab links to the email (in Copilot or in Gmail) and never
 * carries any of its text.
 */

export const STUDENTS_MARKER = 'STUDENTS_V1';
/** The routine runs Mondays and Thursdays: never more than four days apart. */
export const STUDENTS_CADENCE_LABEL = 'every Monday and Thursday';
/** A scan older than this is overdue: one run missed, with a day's grace. */
export const STUDENTS_STALE_AFTER_DAYS = 5;
/** A deadline this close (or past, on an open item) is highlighted. */
export const STUDENTS_DEADLINE_SOON_DAYS = 14;

export const STUDENT_KINDS = ['mentoring', 'program', 'intern_request'] as const;
export type StudentKind = (typeof STUDENT_KINDS)[number];

/** One item's kind, on its badge. */
export const STUDENT_KIND_LABELS: Record<StudentKind, string> = {
  mentoring: 'Mentoring',
  program: 'Program',
  intern_request: 'Intern request',
};

/** The kind filter's chips. */
export const STUDENT_KIND_FILTER_LABELS: Record<StudentKind, string> = {
  mentoring: 'Mentoring',
  program: 'Programs',
  intern_request: 'Intern requests',
};

/** Words a routine might use for a kind, mapped to the list above. */
const KIND_ALIASES: Record<string, StudentKind> = {
  mentor: 'mentoring',
  mentorship: 'mentoring',
  mentee: 'mentoring',
  programs: 'program',
  programme: 'program',
  fellowship: 'program',
  invitation: 'program',
  invite: 'program',
  event: 'program',
  intern: 'intern_request',
  internship: 'intern_request',
  intern_requests: 'intern_request',
  internship_request: 'intern_request',
  advice: 'intern_request',
  coffee: 'intern_request',
};

export const STUDENT_STATUSES = [
  'new',
  'awaiting_nick',
  'nick_agreed',
  'nick_declined',
  'replied',
  'scheduled',
  'done',
  'expired',
] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const STUDENT_STATUS_LABELS: Record<StudentStatus, string> = {
  new: 'New',
  awaiting_nick: 'Waiting on Nick',
  nick_agreed: 'Nick agreed',
  nick_declined: 'Nick declined',
  replied: 'Replied',
  scheduled: 'Scheduled',
  done: 'Done',
  expired: 'Expired',
};

/** Statuses with nothing left to do: hidden behind their own chips. */
export const CLOSED_STUDENT_STATUSES: readonly StudentStatus[] = [
  'done',
  'nick_declined',
  'expired',
];

export const STUDENT_OWNERS = ['nick', 'arwin'] as const;
export type StudentOwner = (typeof STUDENT_OWNERS)[number];
export const STUDENT_OWNER_LABELS: Record<StudentOwner, string> = { nick: 'Nick', arwin: 'Arwin' };

/** Any casing or spacing of a kind or its aliases; anything else is not a kind. */
export function normalizeStudentKind(raw: unknown): StudentKind | null {
  const key = enumKey(raw);
  if ((STUDENT_KINDS as readonly string[]).includes(key)) return key as StudentKind;
  return KIND_ALIASES[key] ?? null;
}

/** "Awaiting Nick", "nick-agreed" -> a status; anything else is not one. */
export function normalizeStudentStatus(raw: unknown): StudentStatus | null {
  const key = enumKey(raw);
  if ((STUDENT_STATUSES as readonly string[]).includes(key)) return key as StudentStatus;
  if (key === 'waiting_on_nick' || key === 'waiting_nick') return 'awaiting_nick';
  if (key === 'declined') return 'nick_declined';
  if (key === 'agreed' || key === 'accepted') return 'nick_agreed';
  return null;
}

/** "Arwin", "NICK" -> who the next step is on; anything else (or nobody) is null. */
export function normalizeStudentOwner(raw: unknown): StudentOwner | null {
  const key = enumKey(raw);
  return (STUDENT_OWNERS as readonly string[]).includes(key) ? (key as StudentOwner) : null;
}

/**
 * What an item's id hashes: its kind, who it is about (the person, else the
 * school or org) and the program, each lowercased with punctuation gone. The
 * service hashes it (`sha256`, server-side); the routine dedupes by the same
 * rule, so an item posted twice in one snapshot is still one item here.
 */
export function studentKey(kind: StudentKind, who: string, program: string | null): string {
  return `${kind}|${keyText(who)}|${keyText(program)}`;
}

/* ------------------------------- the post ------------------------------ */

export const STUDENT_SOURCE_SCHEMA = z
  .object({
    /** The Gmail thread id, hex: what the two links open. */
    thread_id: GMAIL_ID.nullish(),
    /** The Gmail message id, hex: used when there is no thread id. */
    message_id: GMAIL_ID.nullish(),
    date: DAY,
    subject: clippedText(300),
  })
  .refine((s) => Boolean(s.thread_id || s.message_id), { message: 'A source needs a Gmail id' });
export type StudentSource = z.infer<typeof STUDENT_SOURCE_SCHEMA>;

/** The id a source's links open: its thread, else its message. */
export function sourceEmailId(source: StudentSource): string {
  return (source.thread_id ?? source.message_id)!.toLowerCase();
}

/** What makes two sources one: the message, else the thread. */
function sourceKey(source: StudentSource): string {
  return (source.message_id ?? source.thread_id)!.toLowerCase();
}

/** Most sources an item keeps; the routine sends the newest first. */
export const MAX_STUDENT_SOURCES = 10;

export const STUDENT_ITEM_SCHEMA = z
  .object({
    /** The routine's own id, if it sends one. Ignored: the app hashes its own. */
    id: z.string().max(100).nullish(),
    kind: z.preprocess(normalizeStudentKind, z.enum(STUDENT_KINDS)),
    /** The student or early-career person; null for a school's or program's own invitation. */
    person: optionalText(120),
    school_or_org: optionalText(160),
    program: optionalText(160),
    /** What they want, short. */
    ask: clippedText(300),
    /** What Nick agreed to ("two 30-min meetings, Nov-Dec"). */
    commitment: optionalText(200),
    status: z.preprocess(normalizeStudentStatus, z.enum(STUDENT_STATUSES)),
    nick_replied: z.boolean().default(false),
    last_reply_date: optionalDay,
    /** A date that matters to them: a registration or application deadline. */
    deadline: optionalDay,
    next_step: optionalText(200),
    next_owner: z.preprocess(normalizeStudentOwner, z.enum(STUDENT_OWNERS).nullable()),
    first_seen: DAY,
    last_seen: DAY,
    /** Each source checked on its own: a bad one is left out, never the whole item. */
    sources: z
      .array(z.unknown())
      .max(40)
      .default([])
      .transform((list) =>
        list
          .flatMap((s) => {
            const source = STUDENT_SOURCE_SCHEMA.safeParse(s);
            return source.success ? [source.data] : [];
          })
          .slice(0, MAX_STUDENT_SOURCES),
      ),
  })
  .refine((item) => Boolean(item.person || item.school_or_org), {
    message: 'An item needs a person or a school',
  });
export type StudentItemInput = z.infer<typeof STUDENT_ITEM_SCHEMA>;

/** One item as the app holds it: the post's fields plus the app's own id. */
export type StudentItem = Omit<StudentItemInput, 'id'> & { id: string };

/**
 * One post. The items are checked one by one (see the service): a single bad
 * row is dropped and counted, never the whole snapshot.
 */
export const STUDENTS_POST_SCHEMA = z.object({
  // run_at, part/parts, scanned_since (the first run reads ~180 days), emails_scanned.
  ...RELAY_ENVELOPE,
  items: z.array(z.unknown()).max(80).default([]),
});
export type StudentsPost = z.infer<typeof STUDENTS_POST_SCHEMA>;

export interface StudentsSnapshot {
  runAt: string;
  /** When the newest part of that run reached Slack. */
  postedAt: string;
  scannedSince: string | null;
  emailsScanned: number | null;
  items: StudentItem[];
  /** The run's parts are not all there (still posting, or one went missing). */
  partial: boolean;
  /** Rows in the posts that did not validate and were left out. */
  dropped: number;
}

/** Who an item is about, as its card's title: the person, else the school or org. */
export function studentWho(item: Pick<StudentItem, 'person' | 'school_or_org'>): string {
  return item.person ?? item.school_or_org ?? '';
}

/**
 * Two rows of one item (the same id) as one: every source once (newest
 * first), the widest seen range, a reply once seen kept, and the rest from
 * the row seen most recently.
 */
export function mergeStudentItems(a: StudentItem, b: StudentItem): StudentItem {
  const [newer, older] = b.last_seen > a.last_seen ? [b, a] : [a, b];
  const sources = new Map<string, StudentSource>();
  for (const s of [...newer.sources, ...older.sources]) {
    if (!sources.has(sourceKey(s))) sources.set(sourceKey(s), s);
  }
  const replies = [newer.last_reply_date, older.last_reply_date].filter((d): d is string =>
    Boolean(d),
  );
  return {
    ...older,
    ...newer,
    person: newer.person ?? older.person,
    school_or_org: newer.school_or_org ?? older.school_or_org,
    program: newer.program ?? older.program,
    commitment: newer.commitment ?? older.commitment,
    deadline: newer.deadline ?? older.deadline,
    nick_replied: newer.nick_replied || older.nick_replied,
    last_reply_date: replies.sort().at(-1) ?? null,
    first_seen: newer.first_seen < older.first_seen ? newer.first_seen : older.first_seen,
    sources: [...sources.values()]
      .sort((x, y) => y.date.localeCompare(x.date))
      .slice(0, MAX_STUDENT_SOURCES),
  };
}

/** Items in a list, one per id, in the order each id first appears. */
export function dedupeStudentItems(items: readonly StudentItem[]): StudentItem[] {
  const byId = new Map<string, StudentItem>();
  for (const item of items) {
    const seen = byId.get(item.id);
    byId.set(item.id, seen ? mergeStudentItems(seen, item) : item);
  }
  return [...byId.values()];
}

export function isOpenStudentItem(item: Pick<StudentItem, 'status'>): boolean {
  return !CLOSED_STUDENT_STATUSES.includes(item.status);
}

/* ------------------------------- deadlines ----------------------------- */

const DAY_MS = 86_400_000;

/**
 * Whole days until an item's deadline: 0 for today, negative once past.
 * A bare day is held at noon UTC, so "today" reads as today in any US
 * timezone. Null without a deadline.
 */
export function daysUntilDeadline(item: Pick<StudentItem, 'deadline'>, now: Date): number | null {
  if (!item.deadline) return null;
  // `|| 0` folds -0 (a deadline earlier today) into today.
  return Math.ceil((Date.parse(item.deadline) - now.getTime()) / DAY_MS) || 0;
}

/**
 * How an item's deadline reads: `soon` within 14 days, `passed` once gone
 * (only an open item says so: a done one does not need the alarm), `later`
 * beyond that, null without one.
 */
export function deadlineState(
  item: Pick<StudentItem, 'deadline' | 'status'>,
  now: Date,
): 'passed' | 'soon' | 'later' | null {
  const days = daysUntilDeadline(item, now);
  if (days === null) return null;
  if (days < 0) return isOpenStudentItem(item) ? 'passed' : 'later';
  return days <= STUDENTS_DEADLINE_SOON_DAYS ? 'soon' : 'later';
}

/** "today", "tomorrow", "in 9 days", "2 days ago". */
export function deadlineDistance(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/**
 * The order the tab shows: open before closed; among the open, a deadline
 * that is close or past first (soonest first), then the most recently seen;
 * closed ones by most recently seen.
 */
export function sortStudentItems(items: readonly StudentItem[], now: Date): StudentItem[] {
  const urgency = (item: StudentItem) => {
    const state = deadlineState(item, now);
    return isOpenStudentItem(item) && (state === 'soon' || state === 'passed')
      ? (daysUntilDeadline(item, now) ?? 0)
      : Number.POSITIVE_INFINITY;
  };
  return [...items].sort(
    (a, b) =>
      Number(!isOpenStudentItem(a)) - Number(!isOpenStudentItem(b)) ||
      urgency(a) - urgency(b) ||
      b.last_seen.localeCompare(a.last_seen) ||
      studentWho(a).localeCompare(studentWho(b)),
  );
}

/* ------------------------------- filters ------------------------------- */

export const STUDENT_STATUS_FILTERS = ['open', ...STUDENT_STATUSES, 'all'] as const;
export type StudentStatusFilter = (typeof STUDENT_STATUS_FILTERS)[number];
export const DEFAULT_STUDENT_STATUS: StudentStatusFilter = 'open';

export const STUDENT_STATUS_FILTER_LABELS: Record<StudentStatusFilter, string> = {
  open: 'Open',
  ...STUDENT_STATUS_LABELS,
  all: 'All',
};

export interface StudentFilters {
  kind: StudentKind | null;
  status: StudentStatusFilter;
  /** Whose the next step is. */
  owner: StudentOwner | null;
  q: string;
}

type Params = Record<string, string | string[] | undefined>;

/** The filters a Students URL holds. Anything unknown reads as the default. */
export function parseStudentFilters(params: Params): StudentFilters {
  const kind = single(params.kind);
  const status = single(params.status);
  const owner = single(params.owner);
  return {
    kind: (STUDENT_KINDS as readonly string[]).includes(kind ?? '') ? (kind as StudentKind) : null,
    status: (STUDENT_STATUS_FILTERS as readonly string[]).includes(status ?? '')
      ? (status as StudentStatusFilter)
      : DEFAULT_STUDENT_STATUS,
    owner: (STUDENT_OWNERS as readonly string[]).includes(owner ?? '')
      ? (owner as StudentOwner)
      : null,
    q: (single(params.q) ?? '').trim().slice(0, 200),
  };
}

/** The URL params for a set of filters: defaults left out, so the plain tab link is the default. */
export function studentFilterParams(filters: StudentFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.kind) out.kind = filters.kind;
  if (filters.status !== DEFAULT_STUDENT_STATUS) out.status = filters.status;
  if (filters.owner) out.owner = filters.owner;
  if (filters.q) out.q = filters.q;
  return out;
}

function searchText(item: StudentItem): string {
  return [
    item.person,
    item.school_or_org,
    item.program,
    item.ask,
    item.commitment,
    item.next_step,
    STUDENT_KIND_LABELS[item.kind],
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function statusMatches(item: StudentItem, status: StudentStatusFilter): boolean {
  if (status === 'all') return true;
  if (status === 'open') return isOpenStudentItem(item);
  return item.status === status;
}

/**
 * The items a set of filters shows. `ignore` leaves one filter out, for the
 * counts on that filter's own chips.
 */
export function filterStudentItems(
  items: readonly StudentItem[],
  filters: StudentFilters,
  ignore?: 'kind' | 'status' | 'owner',
): StudentItem[] {
  const words = filters.q.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (ignore !== 'status' && !statusMatches(item, filters.status)) return false;
    if (ignore !== 'kind' && filters.kind && item.kind !== filters.kind) return false;
    if (ignore !== 'owner' && filters.owner && item.next_owner !== filters.owner) return false;
    if (words.length > 0) {
      const hay = searchText(item);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

/** Open items whose next step is on Arwin: what the tab calls out first. */
export function onArwin(items: readonly StudentItem[]): StudentItem[] {
  return items.filter((item) => isOpenStudentItem(item) && item.next_owner === 'arwin');
}

/** How old a scan is, and whether it is overdue for a twice-weekly routine. */
export function studentsFreshness(runAt: string, now: Date): { days: number; stale: boolean } {
  const age = now.getTime() - Date.parse(runAt);
  return {
    days: Math.max(0, Math.floor(age / DAY_MS)),
    stale: age > STUDENTS_STALE_AFTER_DAYS * DAY_MS,
  };
}
