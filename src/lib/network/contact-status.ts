/**
 * Relationship status: the tag under every person's and company's name, the
 * way Affinity shows it — Never contacted, Recently contacted, Losing touch,
 * Lost touch — worked out from the last contact Kraken can see (the newest
 * email either way, or meeting held), never from a stored field.
 *
 * Every threshold lives here, once, so the tag, the list filters, the search
 * preview and the tests all read the same numbers.
 *
 * Pure and client-safe (no `server-only`): the search palette and the list
 * filter bar are client components.
 */

/**
 * Days since the last contact at which the status changes.
 *
 * - Up to 30 days: Recently contacted (about a month — a normal reply cycle).
 * - 31 to 120 days: Losing touch (a quarter without a word; the same 120 days
 *   is the strength score's half-life, see STRENGTH_MODEL).
 * - More than 120 days: Lost touch.
 * - No email or meeting on record at all: Never contacted.
 */
export const CONTACT_STATUS_THRESHOLDS = {
  recentMaxDays: 30,
  losingMaxDays: 120,
} as const;

export const CONTACT_STATUSES = ['recent', 'losing', 'lost', 'never'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const CONTACT_STATUS_LABELS: Record<ContactStatus, string> = {
  recent: 'Recently contacted',
  losing: 'Losing touch',
  lost: 'Lost touch',
  never: 'Never contacted',
};

const DAY_MS = 86_400_000;

/** Whole days from `at` to `now` (0 for today or a time just ahead); null when there is no readable date. */
export function daysSinceContact(
  at: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

/** The status for a last-contact time. A date that cannot be read counts as no contact. */
export function contactStatus(
  lastContactAt: string | null | undefined,
  now: Date = new Date(),
): ContactStatus {
  const days = daysSinceContact(lastContactAt, now);
  if (days === null) return 'never';
  if (days <= CONTACT_STATUS_THRESHOLDS.recentMaxDays) return 'recent';
  if (days <= CONTACT_STATUS_THRESHOLDS.losingMaxDays) return 'losing';
  return 'lost';
}

/** A `?status=` value as a status, or null for anything else. */
export function asContactStatus(raw: string | null | undefined): ContactStatus | null {
  return (CONTACT_STATUSES as readonly string[]).includes(raw ?? '')
    ? (raw as ContactStatus)
    : null;
}

/* ---------------------------------------------------------------- filters */

/**
 * The list filters on last contact, as Affinity offers them: "N days or
 * fewer", "more than N days" (which includes never), and "never contacted"
 * (an empty last contact). Kept as data so a URL round-trips.
 */
export interface ContactFilter {
  status: ContactStatus | null;
  /** Last contact within this many days. */
  withinDays: number | null;
  /** Last contact more than this many days ago, or never. */
  beyondDays: number | null;
}

export const NO_CONTACT_FILTER: ContactFilter = {
  status: null,
  withinDays: null,
  beyondDays: null,
};

function dayCount(raw: string | null | undefined): number | null {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 && n <= 3650 ? n : null;
}

/** The filter in a page's search params (`status`, `within`, `beyond`). */
export function parseContactFilter(
  get: (name: string) => string | null | undefined,
): ContactFilter {
  return {
    status: asContactStatus(get('status')),
    withinDays: dayCount(get('within')),
    beyondDays: dayCount(get('beyond')),
  };
}

export function hasContactFilter(filter: ContactFilter): boolean {
  return filter.status !== null || filter.withinDays !== null || filter.beyondDays !== null;
}

/** Whether a last contact passes every part of the filter. */
export function matchesContactFilter(
  lastContactAt: string | null | undefined,
  filter: ContactFilter,
  now: Date = new Date(),
): boolean {
  const days = daysSinceContact(lastContactAt, now);
  if (filter.status !== null && contactStatus(lastContactAt, now) !== filter.status) return false;
  if (filter.withinDays !== null && (days === null || days > filter.withinDays)) return false;
  if (filter.beyondDays !== null && days !== null && days <= filter.beyondDays) return false;
  return true;
}

/* ---------------------------------------------------------------- display */

/** The colour family a last-contact date is shown in: green recent, amber older, muted lost. */
export function lastContactTone(status: ContactStatus): 'ok' | 'warn' | 'muted' {
  if (status === 'recent') return 'ok';
  if (status === 'losing') return 'warn';
  return 'muted';
}

/** "Nick Tippmann", "Nick Tippmann & Arwin", "Nick Tippmann & 2 more"; null with nobody. */
export function connectionsLabel(names: readonly string[]): string | null {
  const [first, second] = names;
  if (!first) return null;
  if (names.length === 1) return first;
  if (names.length === 2) return `${first} & ${second}`;
  return `${first} & ${names.length - 1} more`;
}

/**
 * Signal bars (0–4) for a relationship strength score (0–100), as a phone
 * shows reception: 0 only with no evidence at all, then one bar per quarter.
 */
export function signalBars(score: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(score) || score <= 0) return 0;
  if (score >= 75) return 4;
  if (score >= 50) return 3;
  if (score >= 25) return 2;
  return 1;
}
