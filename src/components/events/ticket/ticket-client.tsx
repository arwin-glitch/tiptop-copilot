'use client';

import { useState, type ReactNode } from 'react';

/**
 * The ticket's interactive bits (client): plus-one tabs (each with their own
 * QR, rendered on the server and passed in), "Can't make it" and "Save this
 * page".
 */

export interface TicketTab {
  guestId: string;
  name: string;
  isPlusOne: boolean;
  qr: ReactNode | null;
  lines: { session: string; status: string; tone?: 'ok' | 'warn' | 'bad' }[];
}

export function TicketPeople({ tabs }: { tabs: TicketTab[] }) {
  const [active, setActive] = useState(tabs[0]?.guestId ?? '');
  const current = tabs.find((t) => t.guestId === active) ?? tabs[0];
  if (!current) return null;
  return (
    <div className="evu-stack" data-ticket-people>
      {tabs.length > 1 ? (
        <div className="evu-tabs" role="tablist" aria-label="Tickets">
          {tabs.map((t) => (
            <button
              key={t.guestId}
              type="button"
              role="tab"
              className="evu-tab"
              id={`tab-${t.guestId}`}
              aria-selected={t.guestId === current.guestId}
              aria-controls={`panel-${t.guestId}`}
              onClick={() => setActive(t.guestId)}
            >
              {t.isPlusOne ? `${t.name} (guest)` : t.name}
            </button>
          ))}
        </div>
      ) : null}
      <div
        role={tabs.length > 1 ? 'tabpanel' : undefined}
        id={`panel-${current.guestId}`}
        aria-labelledby={tabs.length > 1 ? `tab-${current.guestId}` : undefined}
        className="evu-stack"
        style={{ textAlign: 'center' }}
      >
        {current.qr ?? (
          <p className="evu-muted">
            A QR code appears here once {current.isPlusOne ? 'they are' : 'you are'} going.
          </p>
        )}
        <p>
          <strong>{current.name}</strong>
        </p>
        <ul className="evu-list" style={{ textAlign: 'left' }}>
          {current.lines.map((l) => (
            <li key={l.session} className="evu-row" style={{ justifyContent: 'space-between' }}>
              <span>{l.session}</span>
              <span className="evu-chip" data-tone={l.tone}>
                {l.status}
              </span>
            </li>
          ))}
        </ul>
        {current.qr ? (
          <p className="evu-muted evu-small">
            Show this at the door. Any phone camera can scan it.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function CantMakeIt({ endpoint, sessionIds }: { endpoint: string; sessionIds: string[] }) {
  const [state, setState] = useState<'idle' | 'confirm' | 'busy' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  if (!sessionIds.length) return null;
  if (state === 'done') {
    return (
      <p className="evu-muted" role="status">
        Thanks for letting us know. You can change your answer from your invitation link.
      </p>
    );
  }
  if (state === 'confirm' || state === 'busy' || state === 'error') {
    return (
      <div className="evu-card evu-stack" role="group" aria-label="Confirm you can't make it">
        <p>Let the host know you can’t make it? Your spot goes to someone else.</p>
        {message ? <p className="evu-error">{message}</p> : null}
        <div className="evu-row">
          <button
            type="button"
            className="evu-btn evu-btn-primary"
            disabled={state === 'busy'}
            onClick={async () => {
              setState('busy');
              try {
                const res = await fetch(endpoint, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'same-origin',
                  body: JSON.stringify({
                    responses: Object.fromEntries(sessionIds.map((id) => [id, 'not_going'])),
                  }),
                });
                const data = (await res.json().catch(() => null)) as {
                  ok?: boolean;
                  error?: { message?: string };
                } | null;
                if (data?.ok) {
                  setState('done');
                  window.location.reload();
                } else {
                  setMessage(data?.error?.message ?? 'That did not go through. Try again.');
                  setState('error');
                }
              } catch {
                setMessage('You seem to be offline. Try again.');
                setState('error');
              }
            }}
          >
            {state === 'busy' ? 'Sending…' : 'Yes, I can’t make it'}
          </button>
          <button
            type="button"
            className="evu-btn evu-btn-secondary"
            onClick={() => setState('idle')}
          >
            Keep my spot
          </button>
        </div>
      </div>
    );
  }
  return (
    <button type="button" className="evu-btn evu-btn-secondary" onClick={() => setState('confirm')}>
      Can’t make it
    </button>
  );
}

export function SaveThisPage() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="evu-btn evu-btn-secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(window.location.href);
          setCopied(true);
          setTimeout(() => setCopied(false), 2500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? 'Link copied' : 'Save this page (copy link)'}
    </button>
  );
}
