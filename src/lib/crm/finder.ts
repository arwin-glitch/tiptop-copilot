import { affinitySmartValues } from '@/lib/network/strength';
import type { CrmField, CrmRecordKind, CrmValue } from '@/lib/types/domain';
import { single } from '@/lib/util/page-tabs';

/**
 * Knowledge → Find & save: companies and people across the whole CRM by
 * name, place and when you were last in touch — "people in Austin I talked
 * to in the last three years" — saved as a list or added to one.
 *
 * Pure, so the server tab, the client form and the tests agree on what the
 * URL says and on what "in Austin" and "in touch since" mean.
 */

export interface CrmFinderCriteria {
  kind: CrmRecordKind;
  /** Part of a name, email or domain. */
  q: string;
  /** Part of where they are ("Austin", or "Austin, TX"). */
  place: string;
  /** Last in touch within this many years; null for any time or never. */
  years: number | null;
  /** Only the companies or people on this list. */
  listId: string | null;
}

export const CRM_FINDER_PATH = '/knowledge';
export const CRM_FINDER_TAB = 'find';
export const CRM_FINDER_YEARS_MAX = 20;
/** The choices the form offers for "in touch within". */
export const CRM_FINDER_YEAR_CHOICES = [1, 2, 3, 5, 10] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = Record<string, string | string[] | undefined>;

const clean = (value: unknown, max = 200): string =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';

/** Criteria from any shape (a URL's params, an action's input), with anything unusable dropped. */
export function normalizeFinderCriteria(raw: {
  kind?: unknown;
  q?: unknown;
  place?: unknown;
  years?: unknown;
  listId?: unknown;
}): CrmFinderCriteria {
  const years = Number(raw.years);
  const listId = typeof raw.listId === 'string' && UUID_RE.test(raw.listId) ? raw.listId : null;
  return {
    kind: raw.kind === 'company' ? 'company' : 'person',
    q: clean(raw.q),
    place: clean(raw.place),
    years: Number.isInteger(years) && years >= 1 && years <= CRM_FINDER_YEARS_MAX ? years : null,
    listId,
  };
}

/** The finder's criteria from the page's URL. */
export function parseFinderParams(params: Params): CrmFinderCriteria {
  return normalizeFinderCriteria({
    kind: single(params.kind),
    q: single(params.q),
    place: single(params.place),
    years: single(params.years),
    listId: single(params.list),
  });
}

/** The finder's URL for some criteria: only what is set, so a bare search stays short. */
export function finderHref(criteria: Partial<CrmFinderCriteria>): string {
  const params = new URLSearchParams({ tab: CRM_FINDER_TAB });
  if (criteria.kind === 'company') params.set('kind', 'company');
  if (criteria.q) params.set('q', criteria.q);
  if (criteria.place) params.set('place', criteria.place);
  if (criteria.years) params.set('years', String(criteria.years));
  if (criteria.listId) params.set('list', criteria.listId);
  return `${CRM_FINDER_PATH}?${params.toString()}`;
}

/**
 * Whether the criteria narrow the CRM enough to search: a name, a place or a
 * list. "In touch within" alone would read every person in the CRM.
 */
export function finderIsNarrowed(criteria: CrmFinderCriteria): boolean {
  return Boolean(criteria.q || criteria.place || criteria.listId);
}

/** "People in Austin, in touch within 3 years": what the results are, in words. */
export function describeFinder(criteria: CrmFinderCriteria, listName?: string | null): string {
  const parts = [criteria.kind === 'company' ? 'Companies' : 'People'];
  if (criteria.q) parts.push(`matching “${criteria.q}”`);
  if (criteria.place) parts.push(`in ${criteria.place}`);
  if (listName) parts.push(`on ${listName}`);
  if (criteria.years) {
    parts.push(`in touch within ${criteria.years} ${criteria.years === 1 ? 'year' : 'years'}`);
  }
  return parts.join(', ').replace(/^(\w+), /, '$1 ');
}

/* -------------------------------------------------------------- places */

/**
 * The record field labels that hold where a company or person is: Affinity's
 * "Location" (a place, written "City, State, Country" by the sync) and the
 * names CSV exports and enrichment use for the same thing.
 */
const LOCATION_LABEL =
  /^(location|locations|city|headquarters|hq|hq location|headquarters location|office location|current location|based in|metro|region)$/i;

/**
 * The labels the database pre-filter reads (a JSON path each, so single
 * words); the rest of LOCATION_LABEL is matched after the read.
 */
export const LOCATION_PREFILTER_LABELS = [
  'Location',
  'Locations',
  'City',
  'Headquarters',
  'HQ',
  'Metro',
  'Region',
] as const;

const valueText = (value: CrmValue | undefined): string | null => {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) return value.join('; ').trim() || null;
  return null;
};

/** Where a record is, from its fields: the first place-like label with a value. */
export function recordLocation(fields: Readonly<Record<string, CrmValue>>): string | null {
  for (const [label, value] of Object.entries(fields)) {
    if (!LOCATION_LABEL.test(label.trim())) continue;
    const text = valueText(value);
    if (text) return text;
  }
  return null;
}

const placeKey = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Whether a location is in the place asked for: every comma-separated part
 * of the place appears in it, ignoring case and punctuation — "austin" and
 * "Austin, TX" both match "Austin, TX, United States".
 */
export function placeMatches(location: string | null, place: string): boolean {
  const parts = place.split(',').map(placeKey).filter(Boolean);
  if (!parts.length) return true;
  if (!location) return false;
  const where = placeKey(location);
  return parts.every((part) => where.includes(part));
}

/** The part of a place the database narrows by: its longest comma-separated part. */
export function placeSearchTerm(place: string): string {
  return (
    place
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] ?? ''
  );
}

/* -------------------------------------------------------- last contact */

export interface CrmFinderContact {
  /** An ISO date or date-time. */
  at: string;
  /** Copilot's own mail and calendar, or a date Affinity carried. */
  source: 'copilot' | 'affinity';
}

/** A date as a time; a bare day is that day in UTC. NaN when unreadable. */
function timeOf(at: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T00:00:00Z` : at);
}

/**
 * When someone was last in touch, the later of what Copilot's own mail and
 * calendar saw and what Affinity recorded (its last contact, last email or
 * last meeting, on the record or on any list they are on). Null when neither
 * has a readable date.
 */
export function lastContactOf(input: {
  recordFields: Readonly<Record<string, CrmValue>>;
  /** Their rows on lists, with those lists' columns. */
  entries?: readonly {
    fields: readonly Pick<CrmField, 'key' | 'name'>[];
    values: Readonly<Record<string, CrmValue>>;
  }[];
  /** Copilot's last contact from mail and calendar. */
  copilotAt?: string | null;
}): CrmFinderContact | null {
  const affinity = affinitySmartValues(input.entries ?? [], input.recordFields);
  const candidates: CrmFinderContact[] = [];
  for (const at of [affinity.last_contact, affinity.last_email, affinity.last_meeting]) {
    if (at) candidates.push({ at, source: 'affinity' });
  }
  if (input.copilotAt) candidates.push({ at: input.copilotAt, source: 'copilot' });
  let best: CrmFinderContact | null = null;
  let bestAt = -Infinity;
  for (const c of candidates) {
    const t = timeOf(c.at);
    if (Number.isNaN(t)) continue;
    // A tie goes to Copilot's own evidence.
    if (t > bestAt || (t === bestAt && c.source === 'copilot')) {
      best = c;
      bestAt = t;
    }
  }
  return best;
}

/** Whether a last contact falls within `years` of `now`. */
export function contactedWithin(
  contact: CrmFinderContact | null,
  years: number,
  now: Date = new Date(),
): boolean {
  if (!contact) return false;
  const since = new Date(now.getTime());
  since.setUTCFullYear(since.getUTCFullYear() - years);
  return timeOf(contact.at) >= since.getTime();
}

/** Newest contact first, then the never-contacted, each by name. */
export function compareFinderRows(
  a: { name: string; lastContact: CrmFinderContact | null },
  b: { name: string; lastContact: CrmFinderContact | null },
): number {
  const ta = a.lastContact ? timeOf(a.lastContact.at) : -Infinity;
  const tb = b.lastContact ? timeOf(b.lastContact.at) : -Infinity;
  if (ta !== tb) return tb - ta;
  return a.name.localeCompare(b.name);
}
