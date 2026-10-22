import 'server-only';
import { isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import {
  EMPTY_GUEST_COUNTS,
  type AudienceMember,
  type EventAudience,
  type GuestCounts,
  type NeedsNotifyingGroup,
} from '@/lib/events/contracts';
import { log } from '@/lib/security/redact';
import type { EventGuestStatus } from '@/lib/types/domain';
import { ok, type Result } from '@/lib/util/result';

/**
 * CONTRACT STUB — owned by WS4 (Guests). Replace the bodies, keep the
 * exports and signatures (WS5 builds library cards, campaign audiences and
 * the "Needs notifying" queue on them).
 *
 *   guestCounts      WORKING: per-event counts by guest-level status.
 *   resolveAudience  [] until WS4: campaign recipients with their personal
 *                    rsvpPath (/e/<slug>/i/<token>, event-rsvp/v1 HMAC).
 *   needsNotifying   [] until WS4: status changes no SENT campaign told the
 *                    guest about, grouped one message per kind.
 *   markNotified     no-op until WS4: called by WS5 only after a campaign has
 *                    actually sent, never on draft.
 */

/** Guest-level status: the strongest of their per-session statuses. */
const STATUS_RANK: EventGuestStatus[] = [
  'going',
  'pending',
  'waitlist',
  'maybe',
  'invited',
  'not_going',
  'declined',
];

export function guestLevelStatus(statuses: readonly EventGuestStatus[]): EventGuestStatus {
  for (const status of STATUS_RANK) if (statuses.includes(status)) return status;
  return 'invited';
}

export async function guestCounts(
  store: DataStore,
  organizationId: string,
  eventIds: readonly string[],
): Promise<Record<string, GuestCounts>> {
  const out: Record<string, GuestCounts> = {};
  for (const id of eventIds) out[id] = { ...EMPTY_GUEST_COUNTS };
  if (eventIds.length === 0) return out;
  try {
    const [guests, rows] = await Promise.all([
      store.list('event_guests', organizationId, { in: { event_id: [...eventIds] } }),
      store.list('event_guest_sessions', organizationId, { in: { event_id: [...eventIds] } }),
    ]);
    const byGuest = new Map<string, { statuses: EventGuestStatus[]; checkedIn: boolean }>();
    for (const row of rows) {
      const entry = byGuest.get(row.guest_id) ?? { statuses: [], checkedIn: false };
      entry.statuses.push(row.status);
      if (row.checked_in_at) entry.checkedIn = true;
      byGuest.set(row.guest_id, entry);
    }
    for (const guest of guests) {
      const counts = out[guest.event_id];
      if (!counts) continue;
      const entry = byGuest.get(guest.id);
      const status = guestLevelStatus(entry?.statuses ?? []);
      counts.total += 1;
      if (entry?.checkedIn) counts.checkedIn += 1;
      if (status === 'going') {
        counts.going += 1;
        if (guest.parent_guest_id) counts.plusOnes += 1;
      } else if (status === 'pending') counts.pending += 1;
      else if (status === 'waitlist') counts.waitlist += 1;
      else if (status === 'maybe') counts.maybe += 1;
      else if (status === 'invited') counts.invited += 1;
      else if (status === 'not_going') counts.notGoing += 1;
      else if (status === 'declined') counts.declined += 1;
    }
  } catch (error) {
    if (!isMissingTableError(error)) {
      log.error('Event guest counts failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

export async function resolveAudience(
  store: DataStore,
  organizationId: string,
  eventId: string,
  audience: EventAudience,
): Promise<Result<AudienceMember[]>> {
  void store;
  void organizationId;
  void eventId;
  void audience;
  return ok([]);
}

export async function needsNotifying(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<Result<NeedsNotifyingGroup[]>> {
  void store;
  void organizationId;
  void eventId;
  return ok([]);
}

export async function markNotified(
  store: DataStore,
  organizationId: string,
  eventId: string,
  items: readonly { guestId: string; sessionId: string; status: EventGuestStatus }[],
): Promise<Result<{ updated: number }>> {
  void store;
  void organizationId;
  void eventId;
  void items;
  return ok({ updated: 0 });
}
