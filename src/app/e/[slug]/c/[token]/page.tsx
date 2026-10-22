import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { CheckinLanding } from '@/components/events/checkin/checkin-landing';
import { EventShell } from '@/components/events/ticket/event-shell';
import { Ticket } from '@/components/events/ticket/ticket';
import { env } from '@/lib/config/env';
import { GRANT_COOKIE, eventPaths } from '@/lib/events/contracts';
import { getStore } from '@/lib/runtime';
import { qrPerson, resolveCheckinActor } from '@/lib/services/event-checkin';
import {
  absoluteUrl,
  buildTicket,
  publishedDoc,
  resolveCheckinToken,
  resolvePublicEvent,
} from '@/lib/services/event-public';

/**
 * /e/<slug>/c/<token> — where a ticket's QR code lands (D-075). Any phone
 * camera opens it. Staff (an owner session, or this event's staff-link
 * cookie) get "Check in Sarah Lee – Reception (+1)" and one tap POSTs the
 * check-in; everyone else sees that guest's ticket. This GET never checks
 * anyone in, and never shows a personal link.
 */

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string; token: string }> };

export const metadata: Metadata = {
  title: { absolute: 'Check-in' },
  applicationName: null,
  appleWebApp: null,
  robots: { index: false, follow: false, nocache: true },
};

export default async function CheckinQrPage({ params }: Props) {
  const { slug, token } = await params;
  const store = getStore();
  const resolved = await resolvePublicEvent(store, slug);
  if (resolved.kind !== 'event') notFound();
  const guest = await resolveCheckinToken(store, resolved.event, token);
  if (!guest) notFound();
  const { event, sessions } = resolved;
  const jar = await cookies();
  const actor = await resolveCheckinActor(store, event, jar.get(GRANT_COOKIE)?.value);
  const person = actor ? await qrPerson(store, event, sessions, guest.guest) : null;
  const host = guest.guest.parent_guest_id
    ? await store.get('event_guests', event.organization_id, guest.guest.parent_guest_id)
    : guest.guest;
  const ticket =
    host && !actor ? await buildTicket(store, event, sessions, host, { full: false }) : null;
  // A plus-one's QR shows only that person's own part of the ticket.
  if (ticket && guest.guest.parent_guest_id) {
    ticket.people = ticket.people.filter((p) => p.guestId === guest.guest.id);
  }
  return (
    <EventShell doc={publishedDoc(event)} label={`Check-in for ${event.title}`}>
      <div className="evu-stack">
        <CheckinLanding
          endpoint={`/api/e/${event.slug}/c/${token}`}
          initialPerson={person}
          timeZone={event.time_zone}
          staffName={actor?.name ?? null}
        />
        {ticket ? (
          <Ticket
            ticket={ticket}
            full={false}
            pageUrl={absoluteUrl(eventPaths.page(event.slug))}
            appUrl={env().appUrl.replace(/\/+$/, '')}
            respondEndpoint={null}
          />
        ) : null}
      </div>
    </EventShell>
  );
}
