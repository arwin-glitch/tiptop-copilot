import '@/components/events/rsvp/ev-ui.css';

/**
 * The event surface's 404 (D-075): the same neutral page for an unknown
 * slug, a draft, a private event and an invalid personal or check-in link —
 * it never says which.
 */
export default function EventNotFound() {
  return (
    <main id="main" data-ev-shell="fixed" data-ev-ui>
      <div className="evu-shell-inner">
        <div className="evu-card evu-stack" data-event-not-found>
          <h1 className="evu-title" style={{ fontSize: '1.5rem' }}>
            This page isn’t available
          </h1>
          <p className="evu-muted">
            The link may be mistyped, or the event may not be open yet. If someone sent it to you,
            ask them for a fresh link.
          </p>
        </div>
      </div>
    </main>
  );
}
