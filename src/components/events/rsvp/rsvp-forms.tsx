'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { EventRsvpContext, EventSessionPublic } from '@/lib/events/contracts';
import { PlusOnes, type PlusOneDraft } from './plus-ones';
import { QuestionField, type AnswerMap } from './question-field';
import {
  askedQuestions,
  DEFAULT_TIME_ZONE,
  postRsvp,
  type RsvpResponse,
  type SlotLabels,
} from './rsvp-shared';
import { SessionTime } from './session-time';

/**
 * The RSVP forms (D-075, client):
 *   - PublicForm: open and approval events, and an invite-only page's
 *     "Request an invite": name, email, sessions, questions, plus-ones,
 *     the honeypot, the signed render time, and Turnstile when enabled.
 *   - InviteForm: a personal link — Going / Maybe / Can't go per session,
 *     preloaded with the guest's name, answers and plus-ones; the same link
 *     edits or cancels later.
 * The server re-checks everything; these only guide.
 */

type Done = (response: RsvpResponse) => void;

function sessionNote(s: EventSessionPublic, showRemaining: boolean): string | null {
  if (s.full) return s.waitlistOpen ? 'Full – join the waitlist' : 'Full';
  if (s.requiresApproval) return 'The host approves requests';
  if (showRemaining && s.remaining !== null)
    return `${s.remaining} spot${s.remaining === 1 ? '' : 's'} left`;
  return null;
}

function cleanAnswers(answers: AnswerMap): AnswerMap {
  const out: AnswerMap = {};
  for (const [k, v] of Object.entries(answers)) {
    if (v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------ Turnstile */

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        options: { sitekey: string; callback: (token: string) => void },
      ) => string;
      remove?: (id: string) => void;
    };
  }
}

function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let widget: string | null = null;
    let cancelled = false;
    const mount = () => {
      if (cancelled || !ref.current || !window.turnstile) return;
      widget = window.turnstile.render(ref.current, { sitekey: siteKey, callback: onToken });
    };
    if (window.turnstile) mount();
    else {
      const src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      let script = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
      if (!script) {
        script = document.createElement('script');
        script.src = src;
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener('load', mount);
    }
    return () => {
      cancelled = true;
      if (widget && window.turnstile?.remove) window.turnstile.remove(widget);
    };
  }, [siteKey, onToken]);
  return <div ref={ref} />;
}

/* ----------------------------------------------------------- public form */

export function PublicForm({
  context,
  labels,
  request,
  onDone,
}: {
  context: EventRsvpContext;
  labels: SlotLabels;
  /** "Request an invite" on an invite-only page. */
  request: boolean;
  onDone: Done;
}) {
  const reg = context.registration;
  const timeZone = context.timeZone ?? DEFAULT_TIME_ZONE;
  const sessions = reg.sessions;
  const choosable = sessions.filter((s) => !s.full || s.waitlistOpen || request);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [chosen, setChosen] = useState<string[]>(choosable.length === 1 ? [choosable[0]!.id] : []);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [plusOnes, setPlusOnes] = useState<PlusOneDraft[]>([]);
  const [showOnWall, setShowOnWall] = useState(false);
  const [website, setWebsite] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const questions = useMemo(
    () => askedQuestions(reg.questions, chosen, answers),
    [reg.questions, chosen, answers],
  );
  const chosenSessions = sessions.filter((s) => chosen.includes(s.id));
  const allFull = chosenSessions.length > 0 && chosenSessions.every((s) => s.full);
  const approval = request || chosenSessions.some((s) => s.requiresApproval);
  const submitLabel = request
    ? 'Request an invite'
    : allFull
      ? 'Join the waitlist'
      : approval
        ? 'Request to join'
        : labels.cta === 'RSVP'
          ? 'Register'
          : labels.cta;

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!firstName.trim()) next.firstName = 'Add your first name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()))
      next.email = 'Enter a valid email address.';
    if (!chosen.length) next.sessions = 'Choose at least one session.';
    for (const q of questions) {
      const v = answers[q.id];
      if (q.required && (v === undefined || v === '' || (Array.isArray(v) && !v.length)))
        next[q.id] = 'Required.';
    }
    for (const p of plusOnes)
      if (!p.firstName.trim()) next[`${p.key}:firstName`] = 'Your guest needs a name.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    if (!validate() || !context.endpoint) return;
    setBusy(true);
    const via = new URLSearchParams(window.location.search).get('via');
    const response = await postRsvp(context.endpoint, {
      formToken: context.formToken ?? '',
      website,
      turnstileToken: turnstileToken ?? undefined,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      company: company.trim() || undefined,
      sessions: chosen,
      answers: cleanAnswers(answers),
      plusOnes: plusOnes.map((p) => ({
        firstName: p.firstName.trim(),
        lastName: p.lastName.trim(),
        email: p.email.trim() || undefined,
        sessions: p.sessionIds.filter((id) => chosen.includes(id)),
        answers: cleanAnswers(p.answers),
      })),
      showOnWall,
      request,
      via: via && /^[a-z0-9-]{2,32}$/.test(via) ? via : undefined,
    });
    setBusy(false);
    if (!response.ok) {
      setMessage(response.error?.message ?? 'That did not go through. Try again.');
      return;
    }
    onDone(response);
  }

  return (
    <form className="evu-stack" onSubmit={submit} noValidate data-rsvp-form="public">
      <div className="evu-grid2">
        <div>
          <label className="evu-label" htmlFor="rsvp-first">
            First name
            <span className="evu-required" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id="rsvp-first"
            className="evu-input"
            autoComplete="given-name"
            maxLength={100}
            value={firstName}
            aria-invalid={errors.firstName ? true : undefined}
            onChange={(e) => setFirstName(e.target.value)}
          />
          {errors.firstName ? <p className="evu-error">{errors.firstName}</p> : null}
        </div>
        <div>
          <label className="evu-label" htmlFor="rsvp-last">
            Last name
          </label>
          <input
            id="rsvp-last"
            className="evu-input"
            autoComplete="family-name"
            maxLength={100}
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
          />
        </div>
      </div>
      <div>
        <label className="evu-label" htmlFor="rsvp-email">
          Email
          <span className="evu-required" aria-hidden="true">
            *
          </span>
        </label>
        <input
          id="rsvp-email"
          className="evu-input"
          type="email"
          autoComplete="email"
          maxLength={320}
          value={email}
          aria-invalid={errors.email ? true : undefined}
          onChange={(e) => setEmail(e.target.value)}
        />
        {errors.email ? <p className="evu-error">{errors.email}</p> : null}
      </div>
      <div>
        <label className="evu-label" htmlFor="rsvp-company">
          Company <span className="evu-muted evu-small">(optional)</span>
        </label>
        <input
          id="rsvp-company"
          className="evu-input"
          autoComplete="organization"
          maxLength={200}
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
      </div>

      {sessions.length > 1 || (sessions[0] && sessions[0].startsAt) ? (
        <fieldset className="evu-stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="evu-label">{sessions.length > 1 ? 'Which sessions?' : 'When'}</legend>
          {sessions.map((s) => {
            const disabled = s.full && !s.waitlistOpen && !request;
            const checked = chosen.includes(s.id);
            const note = sessionNote(s, reg.showRemaining);
            return (
              <label key={s.id} className="evu-choice" data-checked={checked} data-session={s.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() =>
                    setChosen(checked ? chosen.filter((x) => x !== s.id) : [...chosen, s.id])
                  }
                />
                <span>
                  <strong>{s.name}</strong>
                  <SessionTime
                    startsAt={s.startsAt}
                    endsAt={s.endsAt}
                    timeZone={timeZone}
                    className="evu-muted evu-small"
                  />
                  {note ? (
                    <span
                      className="evu-chip"
                      data-tone={s.full ? 'warn' : undefined}
                      style={{ marginTop: 4 }}
                    >
                      {note}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
          {errors.sessions ? <p className="evu-error">{errors.sessions}</p> : null}
        </fieldset>
      ) : null}

      {questions.map((q) => (
        <QuestionField
          key={q.id}
          question={q}
          idPrefix="rsvp"
          answers={answers}
          error={errors[q.id]}
          onChange={(k, v) => {
            const next = { ...answers };
            if (v === undefined) delete next[k];
            else next[k] = v;
            setAnswers(next);
          }}
        />
      ))}

      <PlusOnes
        registration={reg}
        sessions={chosenSessions.map((s) => ({ id: s.id, name: s.name }))}
        value={plusOnes}
        onChange={setPlusOnes}
        errors={errors}
      />

      {reg.guestWall === 'going' || reg.guestWall === 'public' ? (
        <label className="evu-choice" data-checked={showOnWall}>
          <input
            type="checkbox"
            checked={showOnWall}
            onChange={(e) => setShowOnWall(e.target.checked)}
          />
          <span>Show me on the guest list</span>
        </label>
      ) : null}

      <div className="evu-hp" aria-hidden="true">
        <label htmlFor="rsvp-website">Website</label>
        <input
          id="rsvp-website"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>

      {reg.turnstileSiteKey ? (
        <Turnstile siteKey={reg.turnstileSiteKey} onToken={setTurnstileToken} />
      ) : null}

      {message ? (
        <p className="evu-error" role="alert">
          {message}
        </p>
      ) : null}
      <button type="submit" className="evu-btn evu-btn-primary evu-btn-wide" disabled={busy}>
        {busy ? 'Sending…' : submitLabel}
      </button>
      <p className="evu-muted evu-small">
        Your email is only shared with the host. It never appears on this page.
      </p>
    </form>
  );
}

/* -------------------------------------------------------- personal link */

type Answer = 'going' | 'maybe' | 'not_going';

export function InviteForm({
  context,
  labels,
  onDone,
  onCancel,
}: {
  context: EventRsvpContext;
  labels: SlotLabels;
  onDone: Done;
  onCancel?: () => void;
}) {
  const invite = context.invite!;
  const reg = context.registration;
  const timeZone = context.timeZone ?? DEFAULT_TIME_ZONE;
  const sessions = reg.sessions.filter((s) => invite.respondable.includes(s.id));
  const initial: Record<string, Answer | null> = {};
  for (const s of sessions) {
    const status = invite.responses[s.id];
    initial[s.id] =
      status === 'going' || status === 'pending' || status === 'waitlist'
        ? 'going'
        : status === 'maybe'
          ? 'maybe'
          : status === 'not_going'
            ? 'not_going'
            : null;
  }
  const [responses, setResponses] = useState(initial);
  const [firstName, setFirstName] = useState(invite.firstName ?? '');
  const [lastName, setLastName] = useState(invite.lastName ?? '');
  const [company, setCompany] = useState(invite.company ?? '');
  const [answers, setAnswers] = useState<AnswerMap>(() => {
    const out: AnswerMap = {};
    for (const [k, v] of Object.entries(invite.answers)) {
      if (
        typeof v === 'string' ||
        typeof v === 'number' ||
        typeof v === 'boolean' ||
        Array.isArray(v)
      ) {
        out[k] = v as AnswerMap[string];
      }
    }
    return out;
  });
  const [plusOnes, setPlusOnes] = useState<PlusOneDraft[]>(() =>
    invite.plusOnes.map((p) => ({
      key: `existing-${p.id}`,
      id: p.id,
      firstName: p.firstName,
      lastName: p.lastName ?? '',
      email: p.email ?? '',
      sessionIds: p.sessionIds,
      answers: p.answers as AnswerMap,
    })),
  );
  const [showOnWall, setShowOnWall] = useState(invite.showOnWall);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attending = Object.entries(responses)
    .filter(([, r]) => r === 'going' || r === 'maybe')
    .map(([id]) => id);
  const questions = askedQuestions(reg.questions, attending, answers);
  const answered = Object.values(responses).some(Boolean);
  const isEdit = Object.keys(invite.responses).some(
    (id) => invite.responses[id] && invite.responses[id] !== 'invited',
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    const next: Record<string, string> = {};
    if (!answered) next.responses = 'Choose an answer for at least one session.';
    if (!firstName.trim()) next.firstName = 'Add your first name.';
    for (const q of questions) {
      const v = answers[q.id];
      if (q.required && (v === undefined || v === '' || (Array.isArray(v) && !v.length)))
        next[q.id] = 'Required.';
    }
    for (const p of plusOnes)
      if (!p.firstName.trim()) next[`${p.key}:firstName`] = 'Your guest needs a name.';
    setErrors(next);
    if (Object.keys(next).length || !context.endpoint) return;
    setBusy(true);
    const chosen = Object.fromEntries(Object.entries(responses).filter(([, r]) => r)) as Record<
      string,
      Answer
    >;
    const response = await postRsvp(context.endpoint, {
      formToken: context.formToken ?? undefined,
      responses: chosen,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      company: company.trim(),
      answers: cleanAnswers(answers),
      plusOnes: plusOnes.map((p) => ({
        id: p.id,
        firstName: p.firstName.trim(),
        lastName: p.lastName.trim(),
        email: p.email.trim() || undefined,
        sessions: p.sessionIds.filter((id) => attending.includes(id)),
        answers: cleanAnswers(p.answers),
      })),
      showOnWall,
    });
    setBusy(false);
    if (!response.ok) {
      setMessage(response.error?.message ?? 'That did not go through. Try again.');
      return;
    }
    onDone(response);
  }

  const options: { value: Answer; label: string }[] = [
    { value: 'going', label: labels.going },
    ...(reg.responseSet.maybe ? [{ value: 'maybe' as const, label: labels.maybe }] : []),
    { value: 'not_going', label: labels.notGoing },
  ];

  return (
    <form className="evu-stack" onSubmit={submit} noValidate data-rsvp-form="invite">
      {sessions.map((s) => (
        <div key={s.id} className="evu-card evu-stack" data-session={s.id}>
          <div>
            <strong>{s.name}</strong>
            <SessionTime
              startsAt={s.startsAt}
              endsAt={s.endsAt}
              timeZone={timeZone}
              className="evu-muted evu-small"
            />
            {s.full && responses[s.id] !== 'going' ? (
              <span className="evu-chip" data-tone="warn" style={{ marginTop: 4 }}>
                {s.waitlistOpen ? 'Full – you would join the waitlist' : 'Full'}
              </span>
            ) : null}
          </div>
          <div className="evu-seg" role="group" aria-label={`Your answer for ${s.name}`}>
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={responses[s.id] === o.value}
                onClick={() => setResponses({ ...responses, [s.id]: o.value })}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      {errors.responses ? <p className="evu-error">{errors.responses}</p> : null}

      <div className="evu-grid2">
        <div>
          <label className="evu-label" htmlFor="inv-first">
            First name
            <span className="evu-required" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id="inv-first"
            className="evu-input"
            autoComplete="given-name"
            maxLength={100}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
          />
          {errors.firstName ? <p className="evu-error">{errors.firstName}</p> : null}
        </div>
        <div>
          <label className="evu-label" htmlFor="inv-last">
            Last name
          </label>
          <input
            id="inv-last"
            className="evu-input"
            autoComplete="family-name"
            maxLength={100}
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
          />
        </div>
      </div>
      <div>
        <label className="evu-label" htmlFor="inv-company">
          Company
        </label>
        <input
          id="inv-company"
          className="evu-input"
          autoComplete="organization"
          maxLength={200}
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
      </div>

      {questions.map((q) => (
        <QuestionField
          key={q.id}
          question={q}
          idPrefix="inv"
          answers={answers}
          error={errors[q.id]}
          onChange={(k, v) => {
            const next = { ...answers };
            if (v === undefined) delete next[k];
            else next[k] = v;
            setAnswers(next);
          }}
        />
      ))}

      <PlusOnes
        registration={reg}
        sessions={sessions
          .filter((s) => attending.includes(s.id))
          .map((s) => ({ id: s.id, name: s.name }))}
        value={plusOnes}
        onChange={setPlusOnes}
        errors={errors}
      />

      {reg.guestWall === 'going' || reg.guestWall === 'public' ? (
        <label className="evu-choice" data-checked={showOnWall}>
          <input
            type="checkbox"
            checked={showOnWall}
            onChange={(e) => setShowOnWall(e.target.checked)}
          />
          <span>Show me on the guest list</span>
        </label>
      ) : null}

      {message ? (
        <p className="evu-error" role="alert">
          {message}
        </p>
      ) : null}
      <div className="evu-row">
        <button type="submit" className="evu-btn evu-btn-primary" disabled={busy}>
          {busy ? 'Sending…' : isEdit ? 'Update my RSVP' : 'Send my RSVP'}
        </button>
        {onCancel ? (
          <button type="button" className="evu-btn evu-btn-secondary" onClick={onCancel}>
            Keep my answer
          </button>
        ) : null}
      </div>
      {invite.requestPath ? (
        <p className="evu-muted evu-small">
          Not {invite.firstName ?? 'you'}?{' '}
          <a className="evu-btn-link" href={invite.requestPath}>
            Request your own invite
          </a>
        </p>
      ) : null}
    </form>
  );
}
