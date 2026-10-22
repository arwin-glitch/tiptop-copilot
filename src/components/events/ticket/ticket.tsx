import { SessionTime } from '@/components/events/rsvp/session-time';
import {
  appleDirectionsUrl,
  googleCalendarUrl,
  googleDirectionsUrl,
  locationLine,
  outlookCalendarUrl,
} from '@/lib/events/calendar-links';
import type { EventVenuePublic } from '@/lib/events/contracts';
import type { TicketView } from '@/lib/services/event-public';
import type { EventGuestStatus } from '@/lib/types/domain';
import { QrCode } from './qr-code';
import { CantMakeIt, SaveThisPage, TicketPeople, type TicketTab } from './ticket-client';

/**
 * The personal ticket (D-075): the guest's name, status and time per
 * session (venue time, plus "your time"), plus-ones as tabs each with their
 * own QR, the venue as the reveal rule allows with Google and Apple Maps
 * directions, add-to-calendar (the ICS carries the personal link; Google and
 * Outlook get the public page), and Edit RSVP · Can't make it · Save this
 * page. With `full` off (someone who scanned a QR), only the people and
 * their sessions show.
 */

const STATUS: Record<EventGuestStatus, { text: string; tone?: 'ok' | 'warn' | 'bad' }> = {
  going: { text: 'Going', tone: 'ok' },
  pending: { text: 'Waiting for approval' },
  waitlist: { text: 'Waitlist', tone: 'warn' },
  maybe: { text: 'Maybe' },
  invited: { text: 'Invited' },
  not_going: { text: 'Not going' },
  declined: { text: 'Declined', tone: 'bad' },
};

function VenueBlock({ venue }: { venue: EventVenuePublic }) {
  const directions = { address: venue.address, name: venue.name, lat: venue.lat, lng: venue.lng };
  const google = venue.revealed ? googleDirectionsUrl(directions) : null;
  const apple = venue.revealed ? appleDirectionsUrl(directions) : null;
  if (!venue.name && !venue.address && !venue.onlineUrl && venue.revealed) return null;
  return (
    <div className="evu-stack" data-ticket-venue>
      <h3 className="evu-title">Where</h3>
      {venue.name ? <p style={{ margin: 0 }}>{venue.name}</p> : null}
      {venue.revealed ? (
        <>
          {venue.address ? (
            <p className="evu-muted" style={{ margin: 0 }}>
              {venue.address}
            </p>
          ) : null}
          {venue.notes ? <p className="evu-muted evu-small">{venue.notes}</p> : null}
          {venue.onlineUrl ? (
            <p style={{ margin: 0 }}>
              <a
                className="evu-btn-link"
                href={venue.onlineUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                Join online
              </a>
            </p>
          ) : null}
          {google || apple ? (
            <div className="evu-row">
              {google ? (
                <a
                  className="evu-btn evu-btn-secondary"
                  href={google}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Google Maps
                </a>
              ) : null}
              {apple ? (
                <a
                  className="evu-btn evu-btn-secondary"
                  href={apple}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Apple Maps
                </a>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <p className="evu-muted evu-small">
          {venue.revealRule === 'going'
            ? 'The address is shared once you’re confirmed.'
            : 'The address is shared with registered guests.'}
        </p>
      )}
    </div>
  );
}

export function Ticket({
  ticket,
  full,
  pageUrl,
  appUrl,
  respondEndpoint,
}: {
  ticket: TicketView;
  /** The guest's own link: personal links and actions. Off for a scanned QR. */
  full: boolean;
  /** Absolute public page URL (for Google / Outlook details). */
  pageUrl: string;
  /** Absolute app origin, for the QR targets. */
  appUrl: string;
  respondEndpoint: string | null;
}) {
  const host = ticket.people.find((p) => !p.isPlusOne) ?? ticket.people[0];
  const names = new Map(ticket.sessions.map((s) => [s.id, s.name]));
  const tabs: TicketTab[] = ticket.people.map((p) => ({
    guestId: p.guestId,
    name: p.name,
    isPlusOne: p.isPlusOne,
    qr: p.checkinPath ? (
      <QrCode value={`${appUrl}${p.checkinPath}`} label={`Check-in code for ${p.name}`} />
    ) : null,
    lines: p.sessions
      .filter((s) => names.has(s.sessionId))
      .map((s) => ({
        session: names.get(s.sessionId)!,
        status: s.checkedInAt ? 'Checked in' : STATUS[s.status].text,
        tone: s.checkedInAt ? 'ok' : STATUS[s.status].tone,
      })),
  }));
  const hostRows = new Map(host?.sessions.map((s) => [s.sessionId, s]) ?? []);
  const goingSessions = ticket.sessions.filter((s) => hostRows.get(s.id)?.status === 'going');
  const cancellable = ticket.sessions
    .filter((s) => {
      const st = hostRows.get(s.id)?.status;
      return st === 'going' || st === 'maybe' || st === 'pending' || st === 'waitlist';
    })
    .map((s) => s.id);

  return (
    <article className="evu-ticket" data-ticket aria-label={`Ticket for ${host?.name ?? 'guest'}`}>
      <header className="evu-ticket-head evu-stack">
        <p
          className="evu-muted evu-small"
          style={{ margin: 0, textTransform: 'uppercase', letterSpacing: '0.08em' }}
        >
          {ticket.cancelled ? 'Cancelled' : 'Your ticket'}
        </p>
        <h1 className="evu-title" style={{ fontSize: '1.6rem', margin: 0 }}>
          {ticket.title}
        </h1>
        <p style={{ margin: 0 }}>{host?.name}</p>
      </header>
      <div className="evu-ticket-body evu-stack">
        {ticket.cancelled ? (
          <p className="evu-result" data-tone="bad">
            This event has been cancelled.
          </p>
        ) : null}
        <ul className="evu-list" data-ticket-sessions>
          {ticket.sessions.map((s) => {
            const row = hostRows.get(s.id);
            const status = row ? STATUS[row.status] : null;
            return (
              <li key={s.id} className="evu-stack" style={{ marginTop: 0 }}>
                <div className="evu-row" style={{ justifyContent: 'space-between' }}>
                  <strong>{s.name}</strong>
                  {status ? (
                    <span className="evu-chip" data-tone={status.tone}>
                      {row?.checkedInAt ? 'Checked in' : status.text}
                    </span>
                  ) : null}
                </div>
                <SessionTime
                  startsAt={s.startsAt}
                  endsAt={s.endsAt}
                  timeZone={ticket.timeZone}
                  className="evu-muted evu-small"
                />
                {s.venue ? (
                  <span className="evu-muted evu-small">
                    {[s.venue.name, s.venue.revealed ? s.venue.address : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="evu-perforation" aria-hidden="true" />
      <div className="evu-ticket-body">
        <TicketPeople tabs={tabs} />
      </div>
      {full ? (
        <>
          <div className="evu-perforation" aria-hidden="true" />
          <div className="evu-ticket-body evu-stack">
            <VenueBlock venue={ticket.venue} />
            {goingSessions.some((s) => s.startsAt) && !ticket.cancelled ? (
              <div className="evu-stack" data-ticket-calendar>
                <h3 className="evu-title">Add to calendar</h3>
                <div className="evu-row">
                  {ticket.calendarPath ? (
                    <a className="evu-btn evu-btn-secondary" href={ticket.calendarPath} download>
                      Calendar file (.ics)
                    </a>
                  ) : null}
                  {goingSessions
                    .filter((s) => s.startsAt)
                    .slice(0, 3)
                    .map((s) => {
                      const venue = s.venue ?? ticket.venue;
                      const input = {
                        title:
                          goingSessions.length > 1 ? `${ticket.title} – ${s.name}` : ticket.title,
                        startsAt: s.startsAt!,
                        endsAt: s.endsAt,
                        details: `Event page: ${pageUrl}\nYour personal link is in your invitation email.`,
                        location: venue.revealed ? locationLine(venue) : venue.name,
                      };
                      const suffix = goingSessions.length > 1 ? ` (${s.name})` : '';
                      return (
                        <span key={s.id} className="evu-row">
                          <a
                            className="evu-btn evu-btn-secondary"
                            href={googleCalendarUrl(input)}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            Google{suffix}
                          </a>
                          <a
                            className="evu-btn evu-btn-secondary"
                            href={outlookCalendarUrl(input)}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            Outlook{suffix}
                          </a>
                        </span>
                      );
                    })}
                </div>
              </div>
            ) : null}
            <div className="evu-row" data-ticket-actions>
              {ticket.invitePath && !ticket.cancelled ? (
                <a className="evu-btn evu-btn-primary" href={ticket.invitePath}>
                  Edit RSVP
                </a>
              ) : null}
              {respondEndpoint && !ticket.cancelled ? (
                <CantMakeIt endpoint={respondEndpoint} sessionIds={cancellable} />
              ) : null}
              <SaveThisPage />
            </div>
            <p className="evu-muted evu-small">
              Questions? Reply to your invitation email to reach the host.
            </p>
          </div>
        </>
      ) : null}
    </article>
  );
}
