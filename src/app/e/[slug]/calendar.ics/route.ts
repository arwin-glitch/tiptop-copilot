import type { NextRequest } from 'next/server';
import { PUBLIC_VIEWER, eventPaths } from '@/lib/events/contracts';
import { buildIcs, icsFilename } from '@/lib/events/ics';
import { locationLine } from '@/lib/events/calendar-links';
import { sessionVisibleTo, venueForViewer } from '@/lib/events/visibility';
import { getStore } from '@/lib/runtime';
import { absoluteUrl, resolvePublicEvent } from '@/lib/services/event-public';

/**
 * /e/<slug>/calendar.ics (?session=<id>) — the public calendar file
 * (D-075): every session the public can see (or the one asked for), the
 * address only when the reveal rule makes it public. METHOD:PUBLISH, stable
 * UIDs, SEQUENCE = schedule_version.
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

const notFound = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' },
  });

export async function GET(request: NextRequest, context: Context) {
  const { slug } = await context.params;
  const resolved = await resolvePublicEvent(getStore(), slug);
  if (resolved.kind !== 'event') return notFound();
  const { event } = resolved;
  const only = request.nextUrl.searchParams.get('session');
  const sessions = resolved.sessions.filter(
    (s) => sessionVisibleTo(s, PUBLIC_VIEWER) && (!only || s.id === only),
  );
  if (only && !sessions.length) return notFound();
  const ics = buildIcs({
    eventTitle: event.title,
    sequence: event.schedule_version,
    url: absoluteUrl(eventPaths.page(event.slug)),
    cancelled: event.status === 'cancelled',
    now: new Date(),
    sessions: sessions
      .filter((s) => s.starts_at ?? event.starts_at)
      .map((s) => {
        const venue = venueForViewer(s.venue ?? event.venue, PUBLIC_VIEWER);
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
      'Cache-Control': 'no-store',
    },
  });
}
