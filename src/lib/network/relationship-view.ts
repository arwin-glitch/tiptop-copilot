/**
 * The shape and ordering of the relationship list.
 *
 * Split out of `services/network.ts` because that module is `server-only` and
 * the table is a client component. The same mistake cost a request-time crash
 * on `/deals`: a runtime value exported across the client boundary is a client
 * reference proxy, not the value. Types alone are erased and would be safe, but
 * the sort comparators are not, so both live here.
 */

export interface RelationshipRow {
  /** Lowercased address. The identity key — names vary, addresses do not. */
  email: string;
  /** Best name seen for this address, or null if it was only ever an address. */
  name: string | null;
  /** Messages they sent to the mailbox. */
  inboundCount: number;
  /** Messages the mailbox sent where they were a recipient. */
  outboundCount: number;
  /** Meetings that have already happened. A booking is not an encounter. */
  meetingCount: number;
  /**
   * Null when every interaction on record is still in the future — someone on
   * tomorrow's calendar you have never actually corresponded with. Rendering
   * that as a contact date would be the same lie as scoring an unanalysed deal
   * as zero.
   */
  firstContactAt: string | null;
  lastContactAt: string | null;
  /** Soonest meeting still ahead, if any. */
  nextMeetingAt: string | null;
  /** True when the most recent exchange was them writing to us. */
  awaitingUs: boolean;
  company: string | null;
  role: string | null;
  /** How this person is already known to the product. */
  links: {
    dealId: string | null;
    dealName: string | null;
    portfolioCompanyId: string | null;
    portfolioCompanyName: string | null;
  };
  /** Set when a hand-imported `network_contacts` row matches this address. */
  importedContactId: string | null;
  relationship: string | null;
  expertise: string[];
}

export const RELATIONSHIP_SORT_KEYS = [
  'person',
  'company',
  'exchanges',
  'meetings',
  'last',
  'first',
] as const;

export type RelationshipSortKey = (typeof RELATIONSHIP_SORT_KEYS)[number];
export type SortDirection = 'asc' | 'desc';

/** Falls back to most-recently-contacted for an absent or unrecognised key. */
export function asRelationshipSortKey(value: string | undefined): RelationshipSortKey {
  return RELATIONSHIP_SORT_KEYS.includes(value as RelationshipSortKey)
    ? (value as RelationshipSortKey)
    : 'last';
}

/** Total messages either direction. The headline "how much contact" figure. */
export function exchanges(row: RelationshipRow): number {
  return row.inboundCount + row.outboundCount;
}

/** Absent values sort to the end whichever way the column is pointing. */
function compareNullableTime(a: string | null, b: string | null, factor: number): number | null {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return factor * (Date.parse(a) - Date.parse(b));
}

/**
 * Ordering.
 *
 * A person with no recorded company sorts to the end rather than to the top of
 * an A–Z, for the same reason an unscored deal does not sort as zero: the field
 * is absent, not empty-and-therefore-first. Sorting by name falls back to the
 * address, because a contact known only by their address is still a contact and
 * should not silently clump at one end of the list.
 */
export function sortRelationships(
  rows: RelationshipRow[],
  sort: RelationshipSortKey,
  direction: SortDirection,
): RelationshipRow[] {
  const factor = direction === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    switch (sort) {
      case 'person': {
        const left = (a.name ?? a.email).toLowerCase();
        const right = (b.name ?? b.email).toLowerCase();
        return factor * left.localeCompare(right);
      }
      case 'company': {
        if (a.company === null && b.company === null) {
          return (a.name ?? a.email).localeCompare(b.name ?? b.email);
        }
        if (a.company === null) return 1;
        if (b.company === null) return -1;
        return factor * a.company.localeCompare(b.company);
      }
      case 'exchanges':
        return factor * (exchanges(a) - exchanges(b));
      case 'meetings':
        return factor * (a.meetingCount - b.meetingCount);
      case 'first':
        return compareNullableTime(a.firstContactAt, b.firstContactAt, factor) ?? 0;
      case 'last':
      default:
        return compareNullableTime(a.lastContactAt, b.lastContactAt, factor) ?? 0;
    }
  });
}
