'use client';

import { useEffect, useState } from 'react';
import '@/components/events/rsvp/ev-ui.css';

/**
 * The staff link's entry page (D-075): /e/checkin#k=<secret>. The secret is
 * in the fragment, so it never reached the server with this GET or any
 * Referer. It is read here, removed from the address bar at once, and sent
 * only when the person taps "Open the door list" (a POST), so link scanners
 * and previews can never claim the link.
 */
export function StaffEntry() {
  const [secret, setSecret] = useState<string | null | undefined>(undefined);
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');

  useEffect(() => {
    const match = /(?:^#|&)k=([A-Za-z0-9_-]{20,128})/.exec(window.location.hash);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the fragment exists only in the browser
    setSecret(match?.[1] ?? null);
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  async function claim() {
    if (!secret) return;
    setState('busy');
    try {
      const res = await fetch('/api/e/checkin/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token: secret }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; path?: string } | null;
      if (data?.ok && data.path && data.path.startsWith('/e/checkin/')) {
        window.location.assign(data.path);
        return;
      }
    } catch {
      // fall through
    }
    setState('error');
  }

  return (
    <div className="evu-card evu-stack" data-staff-entry>
      <h1 className="evu-title" style={{ fontSize: '1.5rem' }}>
        Door check-in
      </h1>
      {secret === undefined ? null : secret === null ? (
        <p className="evu-muted">
          This link is incomplete. Open the full staff link you were sent, or ask the host for a new
          one.
        </p>
      ) : (
        <>
          <p className="evu-muted">
            This opens the door list on this device. Keep the link to yourself; anyone with it can
            check guests in.
          </p>
          <button
            type="button"
            className="evu-btn evu-btn-primary"
            onClick={claim}
            disabled={state === 'busy'}
          >
            {state === 'busy' ? 'Opening…' : 'Open the door list'}
          </button>
          {state === 'error' ? (
            <p className="evu-error" role="alert">
              This link is not valid. Ask the host for a new one.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
