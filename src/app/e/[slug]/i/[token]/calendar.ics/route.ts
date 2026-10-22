import { eventPaths } from '@/lib/events/contracts';
import { buildIcs, icsFilename } from '@/lib/events/ics';
import { locationLine } from '@/lib/events/calendar-links';
import { venueForViewer, viewerForGuest } from '@/lib/events/visibility';
import { getStore } from '@/lib/runtime';
import { absoluteUrl, resolveInvite, resolvePublicEvent } from '@/lib/services/event-public';

/**
 * /e/<slug>/i/<token>/calendar.ics — a guest's own calendar file (D-075):
 * only the sessions they are Going to (or Maybe), with the address as their
 * status reveals it, and their personal link in DESCRIPTION and URL, so the
 * calendar entry leads back to their ticket. UIDs are per guest; SEQUENCE is
 * the event's schedule_version. Read-only.
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string; token: string }> };

const notFound = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' },
  });

export async function GET(_request: Request, context: Context) {
  const { slug, token } = await context.params;
  const store = getStore();
  const resolved = await resolvePublicEvent(store, slug);
  if (resolved.kind !== 'event') return notFound();
  const guest = await resolveInvite(store, resolved.event, token);
  if (!guest) return notFound();
  const { event } = resolved;
  const viewer = viewerForGuest(guest.guest, guest.rows);
  const attending = new Set(
    guest.rows.filter((r) => r.status === 'going' || r.status === 'maybe').map((r) => r.session_id),
  );
  const ics = buildIcs({
    eventTitle: event.title,
    sequence: event.schedule_version,
    url: absoluteUrl(eventPaths.invite(event.slug, token)),
    urlLabel: 'Your RSVP and ticket:',
    guestId: guest.guest.id,
    cancelled: event.status === 'cancelled',
    now: new Date(),
    sessions: resolved.sessions
      .filter((s) => attending.has(s.id) && (s.starts_at ?? event.starts_at))
      .map((s) => {
        const venue = venueForViewer(s.venue ?? event.venue, viewer);
        return {
          id: s.id,
          name: s.name,
          description: s.description,
          startsAt: (s.starts_at ?? event.starts_at)!,
          endsAt: s.ends_at ?? (s.starts_at ? null : event.ends_at),
          location: venue.revealed ? locationLine(venue) : venue.name,
        };
      }),
  });
  return new Response(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${icsFilename(event.slug)}"`,
      'Cache-Control': 'no-store, private',
    },
  });
}
