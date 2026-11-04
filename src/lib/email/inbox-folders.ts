import { formatDate, formatMonthDay, formatTime, localDateKey } from '@/lib/util/time';

/**
 * The Inbox tab's mail folders, the pure parts: which Gmail labels and query
 * each folder reads, Gmail's inbox category tabs, the advanced-search form as
 * Gmail query syntax, the row's smart date, the "1–50 of N" pager line and
 * the "Name, me 3" sender line. No I/O, so the browser draws with the same
 * rules the routes read Gmail with.
 */

/** Gmail's left-hand folders, in Gmail's order. Snoozed, Scheduled are Kraken's own lists. */
export const SYSTEM_FOLDERS = [
  'inbox',
  'starred',
  'snoozed',
  'important',
  'sent',
  'scheduled',
  'drafts',
  'all',
  'spam',
  'trash',
] as const;
export type SystemFolder = (typeof SYSTEM_FOLDERS)[number];

/** A folder: a system one, or one of the person's own labels (`label:Label_12`). */
export type FolderId = SystemFolder | `label:${string}`;

/** Gmail's inbox category tabs. */
export const CATEGORIES = ['primary', 'promotions', 'social', 'updates', 'forums'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Exclude<Category, 'primary'>, string> = {
  promotions: 'CATEGORY_PROMOTIONS',
  social: 'CATEGORY_SOCIAL',
  updates: 'CATEGORY_UPDATES',
  forums: 'CATEGORY_FORUMS',
};

export const CATEGORY_NAMES: Record<Category, string> = {
  primary: 'Primary',
  promotions: 'Promotions',
  social: 'Social',
  updates: 'Updates',
  forums: 'Forums',
};

const USER_LABEL = /^Label_[0-9A-Za-z]{1,40}$/;

/** A folder id from a URL or request, or null when it names none. */
export function parseFolder(value: string | null | undefined): FolderId | null {
  if (!value) return null;
  if ((SYSTEM_FOLDERS as readonly string[]).includes(value)) return value as SystemFolder;
  const label = /^label:(.+)$/.exec(value)?.[1];
  return label && USER_LABEL.test(label) ? (`label:${label}` as FolderId) : null;
}

export function parseCategory(value: string | null | undefined): Category {
  return (CATEGORIES as readonly string[]).includes(value ?? '') ? (value as Category) : 'primary';
}

/** The user label id a `label:` folder names, else null. */
export function folderLabelId(folder: FolderId): string | null {
  return folder.startsWith('label:') ? folder.slice('label:'.length) : null;
}

/** Folders Kraken lists itself rather than asking Gmail's thread list. */
export type OwnList = 'snoozed' | 'scheduled' | 'drafts';
export const OWN_LISTS: readonly OwnList[] = ['snoozed', 'scheduled', 'drafts'];

export interface GmailListQuery {
  labelIds: string[];
  q?: string;
  includeSpamTrash?: boolean;
}

/**
 * What Gmail's thread list is asked for a folder. Inbox reads one category
 * tab; Primary is Gmail's `category:primary`, the others are their category
 * label next to INBOX. Spam and Trash need `includeSpamTrash`. Null for the
 * lists Kraken keeps itself (Snoozed, Scheduled) and Drafts (Gmail's drafts
 * list, so a draft opens into the compose window).
 */
export function folderQuery(
  folder: FolderId,
  category: Category = 'primary',
): GmailListQuery | null {
  const label = folderLabelId(folder);
  if (label) return { labelIds: [label] };
  switch (folder) {
    case 'inbox':
      return category === 'primary'
        ? { labelIds: ['INBOX'], q: 'category:primary' }
        : { labelIds: ['INBOX', CATEGORY_LABEL[category]] };
    case 'starred':
      return { labelIds: ['STARRED'] };
    case 'important':
      return { labelIds: ['IMPORTANT'] };
    case 'sent':
      return { labelIds: ['SENT'] };
    case 'all':
      // All Mail: everything but Spam and Trash, as Gmail's own default.
      return { labelIds: [] };
    case 'spam':
      return { labelIds: ['SPAM'], includeSpamTrash: true };
    case 'trash':
      return { labelIds: ['TRASH'], includeSpamTrash: true };
    default:
      return null;
  }
}

/* ------------------------------------------------------- advanced search */

export const WITHIN_OPTIONS = [
  { id: '1d', label: '1 day', days: 1 },
  { id: '3d', label: '3 days', days: 3 },
  { id: '1w', label: '1 week', days: 7 },
  { id: '2w', label: '2 weeks', days: 14 },
  { id: '1m', label: '1 month', days: 31 },
  { id: '2m', label: '2 months', days: 62 },
  { id: '6m', label: '6 months', days: 183 },
  { id: '1y', label: '1 year', days: 365 },
] as const;
export type Within = (typeof WITHIN_OPTIONS)[number]['id'];

export interface AdvancedSearch {
  from: string;
  to: string;
  subject: string;
  hasWords: string;
  doesntHave: string;
  hasAttachment: boolean;
  /** "Date within" this of `date` (or of today, when no date is given). */
  within: Within | '';
  /** `YYYY-MM-DD`, or empty for "of today". */
  date: string;
}

export const EMPTY_SEARCH: AdvancedSearch = {
  from: '',
  to: '',
  subject: '',
  hasWords: '',
  doesntHave: '',
  hasAttachment: false,
  within: '',
  date: '',
};

/** One value for an operator: bare when it is one word, Gmail's (grouping) when it is several. */
function operand(value: string): string {
  const clean = value
    .replace(/[()"{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  return /\s/.test(clean) ? `(${clean})` : clean;
}

const ymd = (key: string) => key.replace(/-/g, '/');

function shiftKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * The advanced-search form as Gmail query syntax, the way Gmail's own form
 * writes it: `from:jane to:(sam lee) subject:(q3 update) has:attachment
 * after:2026/11/01 before:2026/11/09 budget -draft`. "Date within" a date is
 * `after:`/`before:` around it; within with no date is `newer_than:`.
 */
export function buildGmailQuery(form: AdvancedSearch): string {
  const parts: string[] = [];
  const from = operand(form.from);
  const to = operand(form.to);
  const subject = operand(form.subject);
  if (from) parts.push(`from:${from}`);
  if (to) parts.push(`to:${to}`);
  if (subject) parts.push(`subject:${subject}`);
  if (form.hasAttachment) parts.push('has:attachment');
  const within = WITHIN_OPTIONS.find((w) => w.id === form.within);
  if (within) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(form.date)) {
      parts.push(`after:${ymd(shiftKey(form.date, -within.days))}`);
      parts.push(`before:${ymd(shiftKey(form.date, within.days + 1))}`);
    } else {
      parts.push(`newer_than:${within.days}d`);
    }
  }
  const words = form.hasWords
    .replace(/[(){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (words) parts.push(words);
  for (const word of form.doesntHave.replace(/[()"{}-]/g, ' ').split(/\s+/)) {
    if (word) parts.push(`-${word}`);
  }
  return parts.join(' ');
}

/**
 * The plain operators back out of a query, to fill the form when it opens on
 * a search already typed. Anything it does not know stays in "Has the words".
 */
export function parseGmailQuery(query: string): AdvancedSearch {
  const form: AdvancedSearch = { ...EMPTY_SEARCH };
  const rest: string[] = [];
  const re = /(-?)(\w+):(\([^)]*\)|"[^"]*"|\S+)|(\S+)/g;
  for (const m of query.matchAll(re)) {
    if (m[4]) {
      if (m[4].startsWith('-') && m[4].length > 1) {
        form.doesntHave = `${form.doesntHave} ${m[4].slice(1)}`.trim();
      } else rest.push(m[4]);
      continue;
    }
    const value = (m[3] ?? '').replace(/^[("]|[)"]$/g, '');
    const key = (m[2] ?? '').toLowerCase();
    if (m[1]) {
      rest.push(m[0]);
    } else if (key === 'from') form.from = value;
    else if (key === 'to') form.to = value;
    else if (key === 'subject') form.subject = value;
    else if (key === 'has' && value === 'attachment') form.hasAttachment = true;
    else rest.push(m[0]);
  }
  form.hasWords = rest.join(' ');
  return form;
}

/* ------------------------------------------------------------- the rows */

/**
 * A row's date, as Gmail writes it: the time for today ("3:04 PM"), the day
 * earlier this year ("Nov 3"), the full date before that ("Mar 2, 2024").
 * In the reader's profile zone, never the process's own.
 */
export function smartDate(iso: string | null, timeZone: string, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = localDateKey(d, timeZone);
  const today = localDateKey(now, timeZone);
  if (day === today) return formatTime(d, timeZone);
  return day.slice(0, 4) === today.slice(0, 4)
    ? formatMonthDay(d, timeZone)
    : formatDate(d, timeZone);
}

/** The hover title on a row's date: the full day and time. */
export function fullDate(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

/** Gmail's pager line: "1–50 of 1,234"; "0 of 0" on an empty list. */
export function pageLabel(start: number, shown: number, total: number | null): string {
  const fmt = (n: number) => n.toLocaleString('en-US');
  if (shown <= 0) return total ? `0 of ${fmt(total)}` : 'No conversations';
  const end = start + shown - 1;
  const of = total !== null && total >= end ? fmt(total) : 'many';
  return `${fmt(start)}–${fmt(end)} of ${of}`;
}

export interface Sender {
  name: string;
  me: boolean;
}

/**
 * Gmail's sender line for a thread: who wrote, oldest first, "me" for the
 * mailbox, first names once there is more than one, at most three names
 * ("Ana .. Lee, me"), then the message count when there is more than one.
 */
export function senderLine(senders: readonly Sender[]): { names: string; count: number } {
  const count = senders.length;
  const distinct: Sender[] = [];
  for (const s of senders) {
    const key = s.me ? 'me' : s.name.toLowerCase();
    if (!distinct.some((d) => (d.me ? 'me' : d.name.toLowerCase()) === key)) distinct.push(s);
  }
  const short = (s: Sender) =>
    s.me ? 'me' : distinct.length > 1 ? (s.name.split(/\s+/)[0] ?? s.name) : s.name;
  let names: string;
  if (distinct.length <= 3) names = distinct.map(short).join(', ');
  else names = `${short(distinct[0]!)} .. ${distinct.slice(-2).map(short).join(', ')}`;
  return { names, count: count > 1 ? count : 0 };
}

/** The initial on a message's avatar. */
export function initialOf(name: string): string {
  const m = /[A-Za-z0-9]/.exec(name);
  return (m?.[0] ?? '?').toUpperCase();
}

/* ------------------------------------------------------------- density */

export const DENSITIES = ['default', 'comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];
export const DENSITY_KEY = 'kraken.inbox.density';

export function parseDensity(value: string | null | undefined): Density {
  return (DENSITIES as readonly string[]).includes(value ?? '') ? (value as Density) : 'default';
}

/** The Inbox page's width: Gmail uses the whole window, so wider than the other tabs. */
export const INBOX_SHELL = 'max-w-[100rem]';

/** Gmail's reading pane setting: the conversation replaces the list, or sits right of it. */
export const READING_PANES = ['none', 'right'] as const;
export type ReadingPane = (typeof READING_PANES)[number];
export const READING_PANE_KEY = 'kraken.inbox.readingPane';

export function parseReadingPane(value: string | null | undefined): ReadingPane {
  return value === 'right' ? 'right' : 'none';
}
