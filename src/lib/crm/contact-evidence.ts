import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { evidenceFor, type EvidenceDetail, type RelationshipIndex } from '@/lib/network/evidence';
import { log } from '@/lib/security/redact';
import { fundAddresses, getRelationshipIndex, recordAddresses } from '@/lib/services/relationships';
import type { CrmRecord } from '@/lib/types/domain';
import { ok, type Result } from '@/lib/util/result';

/**
 * When the fund last actually spoke with someone, for keep-in-touch.
 *
 * Not a second count: this reads the relationship index (network/evidence.ts,
 * via services/relationships.ts), the same index, the same rules and the same
 * address matching as a profile's Relationship panel. So "Last contact" in the
 * Keep in touch card and in the panel beside it are one figure. That means
 * everything the index leaves out is left out here too: no-reply, newsletter
 * and role mailboxes at a company's domain, mail or meetings with more than a
 * dozen outside people, invitations someone declined or Nick declined or never
 * answered, holds, booked rooms, and every address of the fund itself
 * (members, mailboxes and Nick's aliases). A company is everyone at its
 * registrable domain; a meeting still ahead is a booking, not contact.
 */

export type ContactKind = 'inbound' | 'outbound' | 'meeting';

/** The last real contact with someone, and the next meeting booked with them. */
export interface ContactEvidence {
  /** The most recent email either way or past meeting (ISO); null when there is none on record. */
  lastContactAt: string | null;
  lastContactKind: ContactKind | null;
  /** The soonest meeting still ahead (ISO). */
  nextMeetingAt: string | null;
}

export const NO_CONTACT: ContactEvidence = {
  lastContactAt: null,
  lastContactKind: null,
  nextMeetingAt: null,
};

/** Who to look up: a CRM record, matched to mail exactly as its profile is. */
export type EvidenceTarget = Pick<CrmRecord, 'id' | 'kind' | 'name' | 'domain' | 'emails'>;

export interface ContactEvidenceIndex {
  evidenceFor(target: EvidenceTarget): ContactEvidence;
}

/** The last contact and its kind, from the index's evidence for some addresses. */
export function contactEvidenceOf(detail: EvidenceDetail): ContactEvidence {
  const e = detail.evidence;
  const lastEmail = e.lastEmailAt ? Date.parse(e.lastEmailAt) : null;
  const lastMeeting = e.lastMeetingAt ? Date.parse(e.lastMeetingAt) : null;
  let kind: ContactKind | null = null;
  if (lastMeeting !== null && (lastEmail === null || lastMeeting >= lastEmail)) kind = 'meeting';
  else if (lastEmail !== null) {
    // Threads come newest first; the newest one's last counted message.
    kind = detail.threads[0]?.lastFromUs ? 'outbound' : 'inbound';
  }
  return {
    lastContactAt: e.lastContactAt,
    lastContactKind: e.lastContactAt ? kind : null,
    nextMeetingAt: e.nextMeetingAt,
  };
}

/** Contact evidence over an index already built: pure, so it is tested without a store. */
export function contactEvidenceFrom(
  index: RelationshipIndex,
  now: Date = new Date(),
): ContactEvidenceIndex {
  return {
    evidenceFor(target: EvidenceTarget): ContactEvidence {
      const { addresses } = recordAddresses(index, target);
      if (!addresses.length) return NO_CONTACT;
      return contactEvidenceOf(evidenceFor(index, addresses, now));
    },
  };
}

/**
 * The organization's relationship index (cached, shared with the profile's
 * Relationship panel) as contact evidence. An error when mail and calendar
 * cannot be read: never "no contact", which would make every cadence look due.
 */
export async function loadContactEvidence(
  store: DataStore,
  organizationId: string,
  options: { now?: Date } = {},
): Promise<Result<ContactEvidenceIndex>> {
  const now = options.now ?? new Date();
  const loaded = await getRelationshipIndex(store, organizationId, { ownAddresses: [], now });
  if (!loaded.ok) return loaded;
  return ok(contactEvidenceFrom(loaded.value, now));
}

/**
 * Every address the fund itself sends from (members, connected mailboxes and
 * Nick's aliases): the relationship index's own list. Never throws; a failed
 * read is an empty list, logged.
 */
export async function ownAddressesFor(store: DataStore, organizationId: string): Promise<string[]> {
  try {
    return await fundAddresses(store, organizationId);
  } catch (error) {
    log.warn('Own addresses could not be read', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
