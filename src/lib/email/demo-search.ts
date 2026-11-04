/**
 * Gmail search operators for the demo mailbox, which has no Gmail behind
 * it: enough of the syntax for the search chips, the people suggestions and
 * Create filter to behave in the demo as they do on a real mailbox. Plain
 * words match the sender, subject and snippet, as before.
 *
 * Understood: from:, to:, subject:, has:attachment, is:unread|read|starred|
 * important, newer_than:/older_than: (d, m, y), after:/before: (YYYY/MM/DD),
 * a leading - to negate, (grouped words), "quoted phrases" and OR between
 * whole alternatives (`from:a OR to:a`).
 */

export interface DemoSearchable {
  who: string;
  subject: string;
  snippet: string;
  at: string | null;
  unread: boolean;
  starred: boolean;
  important?: boolean;
  hasAttachment?: boolean;
  /** Every address and name on the conversation, lowercased: from, to and cc. */
  people: string;
  /** Addresses that sent a message on it, lowercased. */
  senders: string;
  /** Addresses it went to, lowercased. */
  recipients: string;
  /** The mailbox itself sent a message on it. */
  fromMe: boolean;
}

const TOKEN = /(-?)(\w+):(\([^)]*\)|"[^"]*"|\S+)|(-?)("[^"]*"|\([^)]*\)|\S+)/g;

const strip = (v: string) => v.replace(/^[("]|[)"]$/g, '').toLowerCase();

function ageDays(value: string): number | null {
  const m = /^(\d+)([dmy])$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  return unit === 'd' ? n : unit === 'm' ? n * 31 : n * 365;
}

function dateOf(value: string): number | null {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function words(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function tokenMatches(
  row: DemoSearchable,
  key: string,
  value: string,
  now: Date,
  me: string,
): boolean {
  const at = row.at ? Date.parse(row.at) : NaN;
  const text = `${row.who} ${row.subject} ${row.snippet}`.toLowerCase();
  switch (key) {
    case 'from':
      if (value === 'me') return row.fromMe;
      return words(value).every(
        (w) => row.senders.includes(w) || row.who.toLowerCase().includes(w),
      );
    case 'to':
      if (value === 'me') return row.recipients.includes(me);
      return words(value).every((w) => row.recipients.includes(w));
    case 'subject':
      return words(value).every((w) => row.subject.toLowerCase().includes(w));
    case 'has':
      return value === 'attachment' ? Boolean(row.hasAttachment) : false;
    case 'is':
      if (value === 'unread') return row.unread;
      if (value === 'read') return !row.unread;
      if (value === 'starred') return row.starred;
      if (value === 'important') return Boolean(row.important);
      return false;
    case 'newer_than':
    case 'older_than': {
      const days = ageDays(value);
      if (days === null || Number.isNaN(at)) return false;
      const cut = now.getTime() - days * 86_400_000;
      return key === 'newer_than' ? at >= cut : at < cut;
    }
    case 'after':
    case 'before': {
      const day = dateOf(value);
      if (day === null || Number.isNaN(at)) return false;
      return key === 'after' ? at >= day : at < day;
    }
    default:
      // An operator the demo does not know: matched as text, like a word.
      return text.includes(`${key}:${value}`) || row.people.includes(value);
  }
}

function alternativeMatches(row: DemoSearchable, query: string, now: Date, me: string): boolean {
  for (const m of query.matchAll(TOKEN)) {
    let hit: boolean;
    let negate: boolean;
    if (m[2] !== undefined) {
      negate = m[1] === '-';
      hit = tokenMatches(row, m[2].toLowerCase(), strip(m[3] ?? ''), now, me);
    } else {
      negate = m[4] === '-';
      const value = strip(m[5] ?? '');
      if (!value) continue;
      const text = `${row.who} ${row.subject} ${row.snippet} ${row.people}`.toLowerCase();
      hit = words(value).every((w) => text.includes(w));
    }
    if (negate ? hit : !hit) return false;
  }
  return true;
}

/** Whether a demo conversation matches a Gmail search. An empty query matches everything. */
export function demoMatches(
  row: DemoSearchable,
  query: string,
  options: { now?: Date; mailbox?: string } = {},
): boolean {
  const q = query.trim();
  if (!q) return true;
  const now = options.now ?? new Date();
  const me = (options.mailbox ?? '').toLowerCase();
  return q
    .split(/\s+OR\s+/)
    .filter((alt) => alt.trim())
    .some((alt) => alternativeMatches(row, alt, now, me));
}
