import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { ViewBeacon } from '@/components/events/rsvp/view-beacon';
import { EventShell } from '@/components/events/ticket/event-shell';
import { Ticket } from '@/components/events/ticket/ticket';
import { env } from '@/lib/config/env';
import { eventPaths } from '@/lib/events/contracts';
import { getStore } from '@/lib/runtime';
import {
  absoluteUrl,
  buildTicket,
  publishedDoc,
  resolveInvite,
  resolvePublicEvent,
} from '@/lib/services/event-public';

/**
 * /e/<slug>/i/<token>/ticket — the guest's personal ticket (D-075): their
 * sessions, plus-ones with their own QR codes, the venue as the reveal rule
 * allows, add-to-calendar, Edit RSVP and Can't make it. Read-only on GET.
 */

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string; token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const resolved = await resolvePublicEvent(getStore(), slug);
  return {
    title: {
      absolute: `Your ticket – ${resolved.kind === 'event' ? resolved.event.title : 'Event'}`,
    },
    applicationName: null,
    appleWebApp: null,
    robots: { index: false, follow: false, nocache: true },
  };
}

export default async function TicketPage({ params }: Props) {
  const { slug, token } = await params;
  const store = getStore();
  const resolved = await resolvePublicEvent(store, slug);
  if (resolved.kind === 'redirect') {
    permanentRedirect(`${eventPaths.invite(resolved.slug, token)}/ticket`);
  }
  if (resolved.kind === 'not_found') notFound();
  const guest = await resolveInvite(store, resolved.event, token);
  if (!guest) notFound();
  const ticket = await buildTicket(store, resolved.event, resolved.sessions, guest.guest, {
    full: true,
  });
  const appUrl = env().appUrl.replace(/\/+$/, '');
  return (
    <EventShell
      doc={publishedDoc(resolved.event)}
      label={`Your ticket for ${resolved.event.title}`}
    >
      <Ticket
        ticket={ticket}
        full
        pageUrl={absoluteUrl(eventPaths.page(resolved.event.slug))}
        appUrl={appUrl}
        respondEndpoint={
          resolved.event.status === 'published'
            ? `/api/e/${resolved.event.slug}/i/${token}/respond`
            : null
        }
      />
      <ViewBeacon endpoint={`/api/e/${resolved.event.slug}/view`} token={token} />
    </EventShell>
  );
}
