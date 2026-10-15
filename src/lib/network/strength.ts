/**
 * Relationship strength: a score you can audit.
 *
 * Affinity's relationship score is a number from a model nobody can inspect.
 * This one is arithmetic on counts the reader can open — threads, replies,
 * meetings, dates — and every point it awards is listed beside it. The Network
 * page's rule still holds: the evidence is the answer; the score is only a
 * short way of saying how much evidence there is and how fresh it is.
 *
 * Pure and client-safe (no `server-only`), because the badge that shows a
 * score is a client component and the scoring rules are what tests pin down.
 */

/* ------------------------------------------------------------------ model */

/**
 * Every weight in one place, so the "why" text and the tests read the same
 * numbers the score does.
 *
 * - Email is capped at 45: six two-way threads say as much as sixty.
 *   A thread only counts fully when both sides wrote on it; a cold pitch
 *   nobody answered is barely a relationship, so it earns a single point.
 * - Meetings are capped at 40: sitting down three times is the ceiling.
 * - Reciprocity (15) rewards relationships where they reach out too, not only
 *   where Nick chases. It needs at least one reply or meeting to count.
 * - Recency multiplies the total: half the strength fades every 120 days
 *   without contact. A booking still ahead does not count — it has not
 *   happened yet.
 */
export const STRENGTH_MODEL = {
  email: { perTwoWayThread: 8, perOutboundOnlyThread: 2, perInboundOnlyThread: 1, max: 45 },
  meetings: { perMeeting: 15, max: 40 },
  reciprocity: { both: 15, theyStart: 10, weStart: 8, max: 15 },
  halfLifeDays: 120,
  strongAt: 60,
  warmAt: 30,
} as const;

/** Strong/Warm with no contact for this many days counts as going cold. */
export const DEFAULT_GOING_COLD_DAYS = 60;

const DAY_MS = 86_400_000;

export type StrengthLabel = 'strong' | 'warm' | 'cold' | 'none';

export const STRENGTH_LABELS: Record<StrengthLabel, string> = {
  strong: 'Strong',
  warm: 'Warm',
  cold: 'Cold',
  none: 'None',
};

/* --------------------------------------------------------------- evidence */

/**
 * What the mail and calendar say about one person (or everyone at one
 * company), counted. Times are ISO strings; null means "nothing on record",
 * never "long ago".
 */
export interface RelationshipEvidence {
  /** Threads with at least one message to or from them that has already been sent. */
  threads: number;
  /** Threads where both sides wrote. */
  twoWayThreads: number;
  /** Threads where only Nick's side wrote. */
  outboundOnlyThreads: number;
  /** Threads where only they wrote. */
  inboundOnlyThreads: number;
  /** Threads whose first message was from Nick's side. */
  weStarted: number;
  /** Threads whose first message was from them. */
  theyStarted: number;
  emailsIn: number;
  emailsOut: number;
  /** Meetings that have already happened. A booking is not an encounter. */
  meetingsHeld: number;
  firstEmailAt: string | null;
  lastEmailAt: string | null;
  lastMeetingAt: string | null;
  /** Soonest meeting still ahead. */
  nextMeetingAt: string | null;
  /** The later of the last email and the last meeting. */
  lastContactAt: string | null;
}

export const NO_EVIDENCE: RelationshipEvidence = {
  threads: 0,
  twoWayThreads: 0,
  outboundOnlyThreads: 0,
  inboundOnlyThreads: 0,
  weStarted: 0,
  theyStarted: 0,
  emailsIn: 0,
  emailsOut: 0,
  meetingsHeld: 0,
  firstEmailAt: null,
  lastEmailAt: null,
  lastMeetingAt: null,
  nextMeetingAt: null,
  lastContactAt: null,
};

export function hasEvidence(e: RelationshipEvidence): boolean {
  return e.threads > 0 || e.meetingsHeld > 0;
}

/* ------------------------------------------------------------------ score */

export interface StrengthPart {
  key: 'email' | 'meetings' | 'reciprocity';
  /** What was counted, in words: "9 two-way threads, 3 one-way". */
  label: string;
  points: number;
  max: number;
}

export interface RelationshipStrength {
  /** 0–100. 0 only when there is no evidence at all. */
  score: number;
  label: StrengthLabel;
  /** Points before recency: the sum of `parts`. */
  base: number;
  parts: StrengthPart[];
  /** The multiplier recency applied, to two places — the exact figure used. */
  recency: number;
  /** Whole days since the last contact, or null with none on record. */
  daysSinceContact: number | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function daysSince(at: string | null, now: Date): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

/** The recency multiplier for this many days without contact, rounded to the two places shown. */
export function recencyFactor(days: number | null): number {
  if (days === null) return 0;
  return Math.round(Math.pow(0.5, days / STRENGTH_MODEL.halfLifeDays) * 100) / 100;
}

export function labelForScore(score: number, evidence: boolean): StrengthLabel {
  if (!evidence) return 'none';
  if (score >= STRENGTH_MODEL.strongAt) return 'strong';
  if (score >= STRENGTH_MODEL.warmAt) return 'warm';
  return 'cold';
}

/**
 * The score for some evidence, as of `now`. Deterministic: the same evidence
 * and the same `now` always give the same score, parts and label.
 */
export function scoreRelationship(
  evidence: RelationshipEvidence,
  now: Date = new Date(),
): RelationshipStrength {
  const m = STRENGTH_MODEL;
  const any = hasEvidence(evidence);

  const oneWay = evidence.outboundOnlyThreads + evidence.inboundOnlyThreads;
  const emailPoints = Math.min(
    m.email.max,
    evidence.twoWayThreads * m.email.perTwoWayThread +
      evidence.outboundOnlyThreads * m.email.perOutboundOnlyThread +
      evidence.inboundOnlyThreads * m.email.perInboundOnlyThread,
  );
  const emailLabel =
    evidence.threads === 0
      ? 'No email threads'
      : `${plural(evidence.twoWayThreads, 'two-way thread')}${oneWay ? `, ${oneWay} one-way` : ''}`;

  const meetingPoints = Math.min(m.meetings.max, evidence.meetingsHeld * m.meetings.perMeeting);
  const meetingLabel =
    evidence.meetingsHeld === 0
      ? 'No meetings held'
      : `${plural(evidence.meetingsHeld, 'meeting')} held`;

  const replied = evidence.twoWayThreads > 0 || evidence.meetingsHeld > 0;
  let reciprocityPoints = 0;
  let reciprocityLabel = 'No reply either way yet';
  if (replied && evidence.weStarted > 0 && evidence.theyStarted > 0) {
    reciprocityPoints = m.reciprocity.both;
    reciprocityLabel = 'Both sides start conversations';
  } else if (replied && evidence.theyStarted > 0) {
    reciprocityPoints = m.reciprocity.theyStart;
    reciprocityLabel = 'They start, Nick replies';
  } else if (replied && evidence.weStarted > 0) {
    reciprocityPoints = m.reciprocity.weStart;
    reciprocityLabel = 'Nick starts, they reply';
  } else if (evidence.threads === 0 && evidence.meetingsHeld > 0) {
    reciprocityLabel = 'Met, with no email on record';
  }

  const parts: StrengthPart[] = [
    { key: 'email', label: emailLabel, points: emailPoints, max: m.email.max },
    { key: 'meetings', label: meetingLabel, points: meetingPoints, max: m.meetings.max },
    {
      key: 'reciprocity',
      label: reciprocityLabel,
      points: reciprocityPoints,
      max: m.reciprocity.max,
    },
  ];
  const base = emailPoints + meetingPoints + reciprocityPoints;
  const days = daysSince(evidence.lastContactAt, now);
  const recency = recencyFactor(days);
  // Any real contact keeps a relationship off zero: "cold" and "none" are
  // different claims, and only the second means nothing ever happened.
  const score = any ? Math.min(100, Math.max(1, Math.round(base * recency))) : 0;

  return {
    score,
    label: labelForScore(score, any),
    base,
    parts,
    recency,
    daysSinceContact: days,
  };
}

/* ---------------------------------------------------------------- wording */

function shortDate(at: string, now: Date, timeZone: string): string {
  const d = new Date(at);
  const year = (x: Date) =>
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(x);
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    ...(year(d) === year(now) ? {} : { year: 'numeric' }),
  }).format(d);
}

/**
 * The evidence in one line: "12 threads, last Oct 3; 2 meetings, last Sep 30;
 * next meeting Oct 20". Dates in the reader's time zone, with the year when it
 * is not this one.
 */
export function evidenceSummary(
  e: RelationshipEvidence,
  now: Date = new Date(),
  timeZone = 'UTC',
): string {
  const parts: string[] = [];
  if (e.threads > 0) {
    parts.push(
      `${plural(e.threads, 'thread')}${e.lastEmailAt ? `, last ${shortDate(e.lastEmailAt, now, timeZone)}` : ''}`,
    );
  }
  if (e.meetingsHeld > 0) {
    parts.push(
      `${plural(e.meetingsHeld, 'meeting')}${e.lastMeetingAt ? `, last ${shortDate(e.lastMeetingAt, now, timeZone)}` : ''}`,
    );
  }
  if (e.nextMeetingAt) parts.push(`next meeting ${shortDate(e.nextMeetingAt, now, timeZone)}`);
  return parts.length ? parts.join('; ') : 'No mail or meetings on record';
}

/** "×0.93 for 12 days since the last contact". */
export function recencyText(strength: RelationshipStrength): string {
  if (strength.daysSinceContact === null) return 'No contact on record';
  const days = strength.daysSinceContact;
  const since = days === 0 ? 'contact today' : `${plural(days, 'day')} since the last contact`;
  return `×${strength.recency.toFixed(2)} for ${since}`;
}

/* ------------------------------------------------------------ going cold */

/**
 * What a relationship was worth before the silence: the label its points earn
 * with recency left out. Going cold is decided on this, not on today's score —
 * recency is exactly what discounts a quiet relationship, so judging by the
 * discounted label would drop people from the list the longer they go
 * unattended (anyone quiet for more than about 211 days scores Cold however
 * strong the history).
 */
export function peakLabel(strength: Pick<RelationshipStrength, 'base' | 'label'>): StrengthLabel {
  if (strength.label === 'none') return 'none';
  return labelForScore(strength.base, true);
}

/**
 * A relationship worth something (Strong or Warm before recency) that has
 * gone quiet: no email or meeting for `days` or more, and nothing booked. A
 * meeting in the diary means it is already being looked after.
 */
export function isGoingCold(
  strength: Pick<RelationshipStrength, 'base' | 'label' | 'daysSinceContact'>,
  evidence: Pick<RelationshipEvidence, 'nextMeetingAt'>,
  days: number = DEFAULT_GOING_COLD_DAYS,
): boolean {
  const peak = peakLabel(strength);
  if (peak !== 'strong' && peak !== 'warm') return false;
  if (evidence.nextMeetingAt) return false;
  return strength.daysSinceContact !== null && strength.daysSinceContact >= days;
}

/** A `?days=` value as a going-cold window: whole days, 7 to 365, else the default. */
export function goingColdDays(raw: string | null | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 7 && n <= 365 ? n : DEFAULT_GOING_COLD_DAYS;
}

/* ----------------------------------------------------------- smart fields */

export const SMART_FIELD_KEYS = [
  'first_email',
  'last_email',
  'last_meeting',
  'next_meeting',
  'last_contact',
] as const;

export type SmartFieldKey = (typeof SMART_FIELD_KEYS)[number];

export const SMART_FIELD_LABELS: Record<SmartFieldKey, string> = {
  first_email: 'First email',
  last_email: 'Last email',
  last_meeting: 'Last meeting',
  next_meeting: 'Next meeting',
  last_contact: 'Last contact',
};

/**
 * One smart field: a date from Copilot's own mail and calendar, or — where
 * Copilot has nothing, or for the first email an earlier date — the value an
 * Affinity import carried, marked as such. `at` is an ISO date or date-time,
 * or for an Affinity cell that was never a readable date, the cell as written.
 */
export interface SmartValue {
  at: string | null;
  source: 'copilot' | 'affinity' | null;
  /**
   * For Copilot's first email: how far back the synced mail it was found in
   * reaches (ISO), since anything older was never scanned.
   */
  scannedFrom?: string | null;
}

export type SmartFields = Record<SmartFieldKey, SmartValue>;

/** Affinity's own names for these columns, as an export writes them. */
const AFFINITY_HEADERS: Record<SmartFieldKey, RegExp> = {
  first_email: /^(first email|first emailed|date of first email)( date)?( \(auto\))?$/,
  last_email: /^(last email|last emailed|date of last email)( date)?( \(auto\))?$/,
  last_meeting: /^(last meeting|last event|date of last meeting)( date)?( \(auto\))?$/,
  next_meeting: /^(next meeting|next event|date of next meeting)( date)?( \(auto\))?$/,
  last_contact:
    /^(last contact|last contacted|last interaction|last touch(point)?|date of last contact)( date)?( \(auto\))?$/,
};

const headerKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** Which smart field an imported column is, by its name; null for any other column. */
export function smartFieldForHeader(name: string): SmartFieldKey | null {
  const key = headerKey(name);
  for (const field of SMART_FIELD_KEYS) if (AFFINITY_HEADERS[field].test(key)) return field;
  return null;
}

type CellValue = string | number | string[] | null | undefined;

/**
 * The smart-field values an Affinity import left on a record: from any list
 * entry's columns (by the list field's name) and the record's own extra
 * columns (by label). Where several lists carry one, the first email and next
 * meeting take the earliest date and the rest the latest; a cell that is not a
 * date is kept only when nothing readable was found.
 */
export function affinitySmartValues(
  sources: readonly {
    fields: readonly { key: string; name: string }[];
    values: Readonly<Record<string, CellValue>>;
  }[],
  recordFields: Readonly<Record<string, CellValue>> = {},
): Partial<Record<SmartFieldKey, string>> {
  const found = new Map<SmartFieldKey, string[]>();
  const add = (field: SmartFieldKey | null, value: CellValue) => {
    if (!field || typeof value !== 'string' || !value.trim()) return;
    const list = found.get(field) ?? [];
    list.push(value.trim());
    found.set(field, list);
  };
  for (const source of sources) {
    for (const f of source.fields) add(smartFieldForHeader(f.name), source.values[f.key]);
  }
  for (const [label, value] of Object.entries(recordFields)) add(smartFieldForHeader(label), value);

  const out: Partial<Record<SmartFieldKey, string>> = {};
  for (const [field, values] of found) {
    const dated = values
      .map((v) => ({ v, t: smartTime(v) }))
      .filter((x) => !Number.isNaN(x.t))
      .sort((a, b) => a.t - b.t);
    const earliest = field === 'first_email' || field === 'next_meeting';
    const pick = dated.length ? (earliest ? dated[0] : dated[dated.length - 1])?.v : values[0];
    if (pick) out[field] = pick;
  }
  return out;
}

/** A smart-field date as a time; an Affinity day ("2021-03-04") is that day in UTC. NaN when unreadable. */
function smartTime(at: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T00:00:00Z` : at);
}

/**
 * Copilot's evidence first, with the Affinity value, marked, where Copilot has
 * none. The first email is the exception: Copilot only sees the newest synced
 * mail, so its "first" is only the earliest in that window, and an earlier
 * Affinity date is the truer one and wins. `scannedFrom` (the oldest message
 * scanned) rides along on Copilot's first email so a reader can see the limit.
 */
export function smartFields(
  evidence: RelationshipEvidence,
  affinity: Partial<Record<SmartFieldKey, string>> = {},
  options: { scannedFrom?: string | null } = {},
): SmartFields {
  const ours: Record<SmartFieldKey, string | null> = {
    first_email: evidence.firstEmailAt,
    last_email: evidence.lastEmailAt,
    last_meeting: evidence.lastMeetingAt,
    next_meeting: evidence.nextMeetingAt,
    last_contact: evidence.lastContactAt,
  };
  const out = {} as SmartFields;
  for (const key of SMART_FIELD_KEYS) {
    const mine = ours[key];
    const theirs = affinity[key] ?? null;
    const earlierTheirs =
      key === 'first_email' &&
      mine !== null &&
      theirs !== null &&
      smartTime(theirs) < smartTime(mine);
    out[key] =
      mine && !earlierTheirs
        ? key === 'first_email'
          ? { at: mine, source: 'copilot', scannedFrom: options.scannedFrom ?? null }
          : { at: mine, source: 'copilot' }
        : theirs
          ? { at: theirs, source: 'affinity' }
          : { at: null, source: null };
  }
  return out;
}

/** A smart value as text: "Oct 3, 2026", or an unreadable Affinity cell as written. */
export function formatSmartValue(value: SmartValue, timeZone: string): string {
  if (!value.at) return '—';
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(value.at);
  const t = smartTime(value.at);
  if (Number.isNaN(t)) return value.at;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: dayOnly ? 'UTC' : timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(t);
}

/* --------------------------------------------------- what pages are sent */

/** The few figures a badge or a list cell needs, small enough to send for every row. */
export interface StrengthBadgeData {
  score: number;
  label: StrengthLabel;
  /** The evidence line, for the badge's title. */
  summary: string;
}

/** One CRM record's relationship figures, as a list's optional columns show them. */
export interface RecordRelationshipRow extends StrengthBadgeData {
  smart: SmartFields;
}
