import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { isPageLive } from '@/lib/events/contracts';
import type { Campaign, CampaignRecipient } from '@/lib/types/domain';
import { guestLinks } from './event-public';

/**
 * Whether an event message's personal {{rsvp_link}}s would still open when
 * it is sent (D-075 review fix). A draft copies each guest's link at draft
 * time; by the send the guest may have had their links rotated or been
 * removed, or the page may be unpublished, and every link would then be a
 * 404. The campaign review and the confirmation refuse such a send.
 *
 * Only the token is compared: a slug change keeps old links working (they
 * forward to the new address).
 */
export interface EventLinkCheck {
  /** The event's page is live (published or cancelled with a published page). */
  live: boolean;
  /** Pending recipients whose link no longer matches their current one. */
  stale: number;
  /**
   * A status notice's people whose status changed since it was drafted (a
   * "waitlisted" notice to someone promoted since): it would tell them the
   * wrong thing.
   */
  changedStatus: number;
}

interface NoticeItem {
  guestId: string;
  sessionId: string;
  status: string;
}

function noticeItems(meta: unknown): NoticeItem[] {
  const list = (meta as { notify?: unknown } | null)?.notify;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (i): i is NoticeItem =>
      Boolean(i) &&
      typeof (i as NoticeItem).guestId === 'string' &&
      typeof (i as NoticeItem).sessionId === 'string' &&
      typeof (i as NoticeItem).status === 'string',
  );
}

const TOKEN_IN_LINK = /\/e\/[^/]+\/i\/([^/?#]+)$/;

function tokenOf(link: unknown): string | null {
  if (typeof link !== 'string') return null;
  try {
    return TOKEN_IN_LINK.exec(new URL(link).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function eventLinkCheck(
  store: DataStore,
  organizationId: string,
  campaign: Pick<Campaign, 'event_id' | 'event_kind' | 'event_meta'>,
  recipients: readonly CampaignRecipient[],
): Promise<EventLinkCheck | undefined> {
  if (!campaign.event_id) return undefined;
  const event = await store.get('events', organizationId, campaign.event_id);
  if (!event) return { live: false, stale: 0, changedStatus: 0 };
  const guests = await store.list('event_guests', organizationId, {
    eq: { event_id: event.id },
  });
  let changedStatus = 0;
  if (campaign.event_kind === 'notice') {
    const items = noticeItems(campaign.event_meta);
    const rows = await store.list('event_guest_sessions', organizationId, {
      eq: { event_id: event.id },
    });
    const now = new Map(rows.map((r) => [`${r.guest_id}:${r.session_id}`, r.status]));
    const emailOf = new Map(guests.map((g) => [g.id, g.email?.toLowerCase() ?? null]));
    const pendingEmails = new Set(
      recipients.filter((r) => r.status === 'pending').map((r) => r.email.trim().toLowerCase()),
    );
    const moved = new Set<string>();
    for (const i of items) {
      const email = emailOf.get(i.guestId);
      if (!email || !pendingEmails.has(email)) continue;
      if (now.get(`${i.guestId}:${i.sessionId}`) !== i.status) moved.add(i.guestId);
    }
    changedStatus = moved.size;
  }
  const pending = recipients.filter((r) => r.status === 'pending' && r.merge?.rsvp_link);
  if (!pending.length) return { live: isPageLive(event), stale: 0, changedStatus };
  const byEmail = new Map(
    guests.filter((g) => g.email && !g.parent_guest_id).map((g) => [g.email!, g]),
  );
  let stale = 0;
  for (const r of pending) {
    const guest = byEmail.get(r.email.trim().toLowerCase());
    const current = guest ? guestLinks(event, guest).invitePath : null;
    const want = current ? tokenOf(`https://x${current}`) : null;
    if (!want || tokenOf(r.merge?.rsvp_link) !== want) stale += 1;
  }
  return { live: isPageLive(event), stale, changedStatus };
}
