'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { EventRsvpContext, RsvpSlotProps } from '@/lib/events/contracts';
import './ev-ui.css';
import { InviteForm, PublicForm } from './rsvp-forms';
import {
  DEFAULT_TIME_ZONE,
  playRsvpMoment,
  resolveLabels,
  resultFor,
  STATUS_TEXT,
  type RsvpResponse,
  type SlotLabels,
} from './rsvp-shared';
import { SessionTime } from './session-time';

/**
 * RsvpSlot (D-075, WS4) — the RSVP block's working part, mounted by WS2's
 * RSVP block. Props: RsvpSlotProps (lib/events/contracts.ts).
 *
 * Placements: inline (the form in the section), sheet (a button opening it
 * in a dialog), sticky (a bottom bar) and corner (a floating ticket button).
 *
 * What it shows, in order:
 *   - studio / og / no endpoint: a static, non-interactive mock, no network;
 *   - a personal link: Going / Maybe / Can't go per session, prefilled, or a
 *     summary with "View ticket" and "Change my RSVP";
 *   - a remembered browser: "You're going ✓ View ticket";
 *   - registration closed, or "By invitation" (with "Request an invite");
 *   - the public form.
 * After a submit: the result state, and the RSVP moment when Going.
 */

const noSubscribe = () => () => undefined;
function readRequestParam(): boolean {
  return new URLSearchParams(window.location.search).get('request') === '1';
}

function StaticMock({ labels, context }: { labels: SlotLabels; context: EventRsvpContext | null }) {
  return (
    <div
      className={context?.registration.sessions.length ? 'evu-card evu-stack' : 'evu-stack'}
      data-rsvp-static
    >
      {context?.registration.sessions.length ? (
        <ul className="evu-list">
          {context.registration.sessions.map((s) => (
            <li key={s.id} className="evu-stack">
              <strong>{s.name}</strong>
              <SessionTime
                startsAt={s.startsAt}
                endsAt={s.endsAt}
                timeZone={context.timeZone ?? DEFAULT_TIME_ZONE}
                className="evu-muted evu-small"
              />
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        className="evu-btn evu-btn-primary"
        disabled
        aria-disabled="true"
        tabIndex={-1}
      >
        {labels.cta}
      </button>
    </div>
  );
}

function Result({
  response,
  labels,
  context,
  onEdit,
}: {
  response: RsvpResponse;
  labels: SlotLabels;
  context: EventRsvpContext;
  onEdit?: () => void;
}) {
  const sessions = response.outcome?.sessions ?? {};
  const view = resultFor(sessions, labels);
  const names = new Map(context.registration.sessions.map((s) => [s.id, s.name]));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="evu-stack" data-rsvp-result={view.tone}>
      <div className="evu-result" data-tone={view.tone} ref={ref} tabIndex={-1} role="status">
        <span className="evu-result-icon" aria-hidden="true">
          {view.icon}
        </span>
        <div className="evu-stack">
          <h3 className="evu-title">{view.title}</h3>
          <p className="evu-muted">{view.body}</p>
          {!response.ticketPath && !context.invite && view.tone !== 'bad' ? (
            // Approval and invite-only pages answer an email already on the
            // list exactly like a new request, so say where its link is.
            <p className="evu-muted evu-small" data-rsvp-already>
              Already on the list? Use the link in your invitation.
            </p>
          ) : null}
          {Object.keys(sessions).length > 1 ? (
            <ul className="evu-list">
              {Object.entries(sessions).map(([id, status]) => (
                <li key={id} className="evu-row" style={{ justifyContent: 'space-between' }}>
                  <span>{names.get(id) ?? 'Session'}</span>
                  <span className="evu-chip">{STATUS_TEXT[status]}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      <div className="evu-row">
        {response.ticketPath ? (
          <a className="evu-btn evu-btn-primary" href={response.ticketPath}>
            View my ticket
          </a>
        ) : null}
        {onEdit ? (
          <button type="button" className="evu-btn evu-btn-secondary" onClick={onEdit}>
            Change my RSVP
          </button>
        ) : null}
      </div>
    </div>
  );
}

function InviteSummary({
  context,
  labels,
  onChange,
}: {
  context: EventRsvpContext;
  labels: SlotLabels;
  onChange: () => void;
}) {
  const invite = context.invite!;
  const sessions = context.registration.sessions.filter((s) => invite.respondable.includes(s.id));
  const going = Object.values(invite.responses).includes('going');
  return (
    <div className="evu-stack" data-rsvp-summary>
      <div className="evu-result" data-tone={going ? 'ok' : 'neutral'}>
        <span className="evu-result-icon" aria-hidden="true">
          {going ? '✓' : '•'}
        </span>
        <div className="evu-stack">
          <h3 className="evu-title">{going ? 'You’re going' : 'Your RSVP'}</h3>
          <ul className="evu-list">
            {sessions.map((s) => {
              const status = invite.responses[s.id];
              const text =
                status === 'going'
                  ? labels.going
                  : status === 'maybe'
                    ? labels.maybe
                    : status === 'not_going'
                      ? labels.notGoing
                      : status
                        ? STATUS_TEXT[status]
                        : 'No answer yet';
              return (
                <li key={s.id} className="evu-row" style={{ justifyContent: 'space-between' }}>
                  <span>{s.name}</span>
                  <span className="evu-chip" data-tone={status === 'going' ? 'ok' : undefined}>
                    {text}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <div className="evu-row">
        {context.ticketPath ? (
          <a className="evu-btn evu-btn-primary" href={context.ticketPath}>
            View my ticket
          </a>
        ) : null}
        {context.registration.open ? (
          <button type="button" className="evu-btn evu-btn-secondary" onClick={onChange}>
            Change my RSVP
          </button>
        ) : (
          <p className="evu-muted evu-small">RSVPs are closed. Contact the host to change yours.</p>
        )}
      </div>
    </div>
  );
}

function SlotContent({ context, labels }: { context: EventRsvpContext; labels: SlotLabels }) {
  const reg = context.registration;
  const invite = context.invite ?? null;
  const viewer = context.viewer;
  const answeredBefore = invite
    ? Object.values(invite.responses).some((s) => s && s !== 'invited')
    : false;
  const [mode, setMode] = useState<'summary' | 'form' | 'request' | 'result'>(() => {
    if (invite) return answeredBefore ? 'summary' : 'form';
    if (viewer.kind === 'guest' && viewer.rsvp && Object.keys(viewer.rsvp).length) return 'summary';
    return 'form';
  });
  // "Not Sarah? Request your own invite" lands on /e/<slug>?request=1. Read
  // on the client only, so the server render and hydration agree.
  const requestParam = useSyncExternalStore(noSubscribe, readRequestParam, () => false);
  const [response, setResponse] = useState<RsvpResponse | null>(null);

  const done = (r: RsvpResponse) => {
    setResponse(r);
    setMode('result');
    if (r.outcome && Object.values(r.outcome.sessions).includes('going')) playRsvpMoment();
  };

  if (mode === 'result' && response) {
    return (
      <Result
        response={response}
        labels={labels}
        context={context}
        onEdit={invite && reg.open ? () => setMode('form') : undefined}
      />
    );
  }

  if (invite) {
    if (mode === 'summary')
      return <InviteSummary context={context} labels={labels} onChange={() => setMode('form')} />;
    if (!reg.open) {
      return (
        <p className="evu-muted">
          RSVPs are closed for this event. Contact the host to change yours.
        </p>
      );
    }
    return (
      <InviteForm
        context={context}
        labels={labels}
        onDone={done}
        onCancel={answeredBefore ? () => setMode('summary') : undefined}
      />
    );
  }

  // A remembered browser.
  if (mode === 'summary' && viewer.kind === 'guest') {
    const going = viewer.going;
    return (
      <div className="evu-stack" data-rsvp-remembered>
        <div className="evu-result" data-tone={going ? 'ok' : 'neutral'}>
          <span className="evu-result-icon" aria-hidden="true">
            {going ? '✓' : '•'}
          </span>
          <div>
            <h3 className="evu-title">{going ? 'You’re going' : 'You’ve responded'}</h3>
            <p className="evu-muted">
              {viewer.firstName ? `Welcome back, ${viewer.firstName}.` : 'Welcome back.'}
            </p>
          </div>
        </div>
        <div className="evu-row">
          {context.ticketPath ? (
            <a className="evu-btn evu-btn-primary" href={context.ticketPath}>
              View my ticket
            </a>
          ) : null}
          {reg.open && reg.access !== 'invite_only' ? (
            <button type="button" className="evu-btn evu-btn-link" onClick={() => setMode('form')}>
              Register someone else
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (!reg.open) {
    return (
      <div className="evu-card" data-rsvp-closed>
        <p>
          <strong>Registration is closed.</strong>
        </p>
        <p className="evu-muted">Contact the host if you have questions.</p>
      </div>
    );
  }

  if (reg.access === 'invite_only') {
    if ((mode === 'request' || (requestParam && mode === 'form')) && reg.requestInvite) {
      return (
        <div className="evu-stack">
          <p className="evu-muted">Tell the host who you are. They’ll let you know.</p>
          <PublicForm context={context} labels={labels} request onDone={done} />
        </div>
      );
    }
    return (
      <div className="evu-card evu-stack" data-rsvp-invite-only>
        <p>
          <strong>By invitation</strong>
        </p>
        <p className="evu-muted">Use the personal link in your invitation to RSVP.</p>
        {reg.requestInvite ? (
          <button
            type="button"
            className="evu-btn evu-btn-secondary"
            onClick={() => setMode('request')}
          >
            Request an invite
          </button>
        ) : null}
      </div>
    );
  }

  return <PublicForm context={context} labels={labels} request={false} onDone={done} />;
}

function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="evu-sheet"
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="evu-row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 className="evu-title">{title}</h2>
        <button
          type="button"
          className="evu-btn evu-btn-secondary"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function RsvpSlot({ variant, labels, mode, context }: RsvpSlotProps) {
  const resolved = context
    ? resolveLabels(labels, context)
    : {
        cta: labels.cta || 'RSVP',
        going: labels.going || 'Going',
        maybe: labels.maybe || 'Maybe',
        notGoing: labels.notGoing || "Can't go",
      };
  const [open, setOpen] = useState(false);
  const interactive = (mode === 'live' || mode === 'preview') && Boolean(context?.endpoint);

  if (!interactive || !context) {
    return (
      <div data-ev-ui data-rsvp-slot data-variant={variant} data-static="true">
        <StaticMock labels={resolved} context={context} />
      </div>
    );
  }

  if (variant === 'inline') {
    return (
      <div data-ev-ui data-rsvp-slot data-variant="inline">
        <SlotContent context={context} labels={resolved} />
      </div>
    );
  }

  const trigger = (
    <button
      type="button"
      className="evu-btn evu-btn-primary"
      onClick={() => setOpen(true)}
      data-rsvp-open
    >
      {resolved.cta}
    </button>
  );
  return (
    <div data-ev-ui data-rsvp-slot data-variant={variant}>
      {variant === 'sticky' ? (
        <div className="evu-sticky">{trigger}</div>
      ) : variant === 'corner' ? (
        <div className="evu-corner">{trigger}</div>
      ) : (
        trigger
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title={resolved.cta}>
        {open ? <SlotContent context={context} labels={resolved} /> : null}
      </Sheet>
    </div>
  );
}
