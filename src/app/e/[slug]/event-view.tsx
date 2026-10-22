import { EventPage } from '@/components/events/render/event-page';
import { RsvpSlot } from '@/components/events/rsvp/rsvp-slot';
import { SessionTime } from '@/components/events/rsvp/session-time';
import { ViewBeacon } from '@/components/events/rsvp/view-beacon';
import { EventShell } from '@/components/events/ticket/event-shell';
import { eventPaths, type EventInvitePrefill, type EventRsvpContext } from '@/lib/events/contracts';
import type { EventDoc } from '@/lib/events/schema';
import { absoluteUrl, type PublicPage } from '@/lib/services/event-public';

/**
 * The guest's render of an event (D-075): WS2's EventPage with the
 * viewer-filtered published document, the facts and the RSVP context, plus
 * (when the page has no RSVP section) a plain RSVP section so a personal
 * link can always answer, the JSON-LD for public events, and the view
 * beacon. Shared by /e/<slug> and /e/<slug>/i/<token>.
 */

/** JSON for a <script type="application/ld+json">, with every character that could end the script escaped. */
export function jsonLdString(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Event JSON-LD for a public, published event: name, dates, location, image, organizer, status. */
export function eventJsonLd(page: PublicPage, organizer: string | null): Record<string, unknown> {
  const { facts } = page;
  const venue = facts.venue;
  const online = venue?.kind === 'online';
  const location =
    venue && (venue.name || venue.address || venue.onlineUrl)
      ? online
        ? { '@type': 'VirtualLocation', url: venue.onlineUrl ?? absoluteUrl(facts.path) }
        : {
            '@type': 'Place',
            name: venue.name ?? undefined,
            address: venue.address
              ? { '@type': 'PostalAddress', streetAddress: venue.address }
              : undefined,
          }
      : undefined;
  return {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: facts.title,
    startDate: facts.startsAt ?? undefined,
    endDate: facts.endsAt ?? undefined,
    eventStatus: facts.cancelled
      ? 'https://schema.org/EventCancelled'
      : 'https://schema.org/EventScheduled',
    eventAttendanceMode: online
      ? 'https://schema.org/OnlineEventAttendanceMode'
      : venue?.kind === 'hybrid'
        ? 'https://schema.org/MixedEventAttendanceMode'
        : 'https://schema.org/OfflineEventAttendanceMode',
    location,
    image: facts.ogImageUrl ? [facts.ogImageUrl] : undefined,
    url: absoluteUrl(facts.path),
    organizer: organizer ? { '@type': 'Organization', name: organizer } : undefined,
    description: page.doc.meta.seoDescription || undefined,
  };
}

function hasRsvpSection(doc: EventDoc): boolean {
  return doc.sections.some((s) => s.type === 'rsvp');
}

export function EventView({
  page,
  endpoint,
  invite,
  token,
  nonce,
  organizer,
}: {
  page: PublicPage;
  /** POST target for this viewer's RSVP; null when the event takes none. */
  endpoint: string | null;
  invite: EventInvitePrefill | null;
  token: string | null;
  nonce: string | undefined;
  organizer: string | null;
}) {
  const { event, facts } = page;
  const rsvp: EventRsvpContext = {
    endpoint,
    formToken: page.formToken,
    registration: page.registration,
    viewer: page.viewer,
    ticketPath: page.ticketPath,
    timeZone: event.time_zone,
    invite,
  };
  const indexable = event.visibility === 'public' && event.status === 'published' && !token;
  return (
    <>
      {indexable ? (
        <script
          type="application/ld+json"
          nonce={nonce}
          // JSON-LD must be a raw script body. The object holds only the
          // owner-set title, dates and venue, serialised with every <, >, &
          // and line separator escaped, so it can never close the tag.
          // eslint-disable-next-line no-restricted-syntax -- escaped JSON-LD, see jsonLdString
          dangerouslySetInnerHTML={{ __html: jsonLdString(eventJsonLd(page, organizer)) }}
        />
      ) : null}
      <EventPage
        doc={page.doc}
        facts={facts}
        media={page.media}
        viewer={page.viewer}
        mode="live"
        rsvp={rsvp}
        nonce={nonce}
      />
      {!hasRsvpSection(page.doc) && (invite || endpoint) ? (
        <section
          data-ev-ui
          data-rsvp-fallback
          aria-label="RSVP"
          style={{ padding: '24px 16px 48px' }}
        >
          <div style={{ maxWidth: 640, margin: '0 auto' }}>
            <RsvpSlot
              variant="inline"
              labels={{ cta: 'RSVP', going: '', maybe: '', notGoing: '' }}
              mode="live"
              context={rsvp}
            />
          </div>
        </section>
      ) : null}
      <ViewBeacon endpoint={`/api/e/${event.slug}/view`} token={token} />
    </>
  );
}

export function CancelledView({ page }: { page: PublicPage }) {
  const { facts } = page;
  return (
    <EventShell doc={page.doc} label={`${facts.title} – cancelled`}>
      <div className="evu-card evu-stack" data-event-cancelled>
        <p className="evu-chip" data-tone="bad" style={{ width: 'fit-content' }}>
          Cancelled
        </p>
        <h1 className="evu-title" style={{ fontSize: '1.75rem' }}>
          {facts.title}
        </h1>
        {facts.startsAt ? (
          <SessionTime
            startsAt={facts.startsAt}
            endsAt={facts.endsAt}
            timeZone={facts.timeZone}
            className="evu-muted"
          />
        ) : null}
        <p style={{ whiteSpace: 'pre-wrap' }}>
          {facts.cancelled?.message?.trim() ||
            'This event has been cancelled. We’re sorry for any trouble.'}
        </p>
        {page.ticketPath ? (
          <a className="evu-btn-link" href={page.ticketPath}>
            Your ticket
          </a>
        ) : null}
      </div>
    </EventShell>
  );
}

export function eventPageUrl(slug: string): string {
  return absoluteUrl(eventPaths.page(slug));
}
