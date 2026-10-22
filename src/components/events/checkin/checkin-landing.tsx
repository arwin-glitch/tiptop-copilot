'use client';

import { useCallback, useEffect, useState } from 'react';
import '@/components/events/rsvp/ev-ui.css';
import { formatCheckinTime } from '@/lib/events/format';
import type { CheckinResult, QrPerson } from '@/lib/services/event-checkin';

/**
 * What door staff see after scanning a ticket's QR with any phone camera
 * (D-075): "Check in Sarah Lee – Reception (+1)", one tap, and a green /
 * amber / red answer. The server decides who is staff (an owner session or
 * the event's staff-link cookie); when the page was rendered without
 * knowing (a SameSite=Strict cookie on a camera-opened tab), this asks once
 * with a same-origin POST and stays hidden for everyone else, who just see
 * the ticket. Nothing here runs on a GET.
 */

type Tone = 'ok' | 'warn' | 'bad';

interface Answer {
  tone: Tone;
  text: string;
}

function answerFor(
  result: CheckinResult,
  sessionName: string,
  timeZone: string,
  party: number,
): Answer {
  const time = formatCheckinTime(result.at, timeZone);
  switch (result.state) {
    case 'checked_in':
      return {
        tone: 'ok',
        text: `Checked in ✓ ${result.name} – ${sessionName}${party ? ` (+${party})` : ''}${time ? ` · ${time}` : ''}`,
      };
    case 'already':
      return {
        tone: 'warn',
        text: `Already checked in${time ? ` ${time}` : ''}${result.by ? ` by ${result.by}` : ''}`,
      };
    case 'undone':
      return { tone: 'warn', text: `Check-in undone for ${result.name}` };
    case 'not_checked_in':
      return { tone: 'warn', text: `${result.name} was not checked in` };
    case 'not_on_list':
      return { tone: 'bad', text: `${result.name} is not on the list for ${sessionName}` };
  }
}

export function CheckinLanding({
  endpoint,
  initialPerson,
  timeZone,
  staffName,
}: {
  endpoint: string;
  initialPerson: QrPerson | null;
  timeZone: string;
  staffName: string | null;
}) {
  const [person, setPerson] = useState<QrPerson | null>(initialPerson);
  const [staff, setStaff] = useState<string | null>(staffName);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      return (await res.json().catch(() => null)) as {
        ok?: boolean;
        person?: QrPerson;
        staff?: string;
        result?: CheckinResult;
        partyCheckedIn?: number;
        error?: { message?: string };
      } | null;
    },
    [endpoint],
  );

  useEffect(() => {
    if (initialPerson) return;
    let cancelled = false;
    post({ action: 'status' })
      .then((data) => {
        if (cancelled || !data?.ok || !data.person) return;
        setPerson(data.person);
        setStaff(data.staff ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [initialPerson, post]);

  if (!person) return null;
  const current = person.sessions.find((s) => s.sessionId === person.currentSessionId) ?? null;
  const notToday = person.currentSessionId && !current;

  async function act(sessionId: string, action: 'checkin' | 'undo', party: boolean) {
    setBusy(`${sessionId}:${action}:${party}`);
    const data = await post({
      action,
      sessionId,
      ...(action === 'checkin' ? { party } : {}),
    }).catch(() => null);
    setBusy(null);
    if (!data?.ok || !data.result) {
      setAnswer({
        tone: 'bad',
        text: data?.error?.message ?? 'That did not go through. Try again.',
      });
      return;
    }
    const name = person!.sessions.find((s) => s.sessionId === sessionId)?.name ?? 'this session';
    setAnswer(answerFor(data.result, name, timeZone, data.partyCheckedIn ?? 0));
    if (data.person) setPerson(data.person);
  }

  return (
    <section className="evu-card evu-stack" data-checkin-landing aria-label="Check in">
      <p className="evu-muted evu-small" style={{ margin: 0 }}>
        Door check-in{staff ? ` · ${staff}` : ''}
      </p>
      <h1 className="evu-title" style={{ fontSize: '1.6rem' }}>
        {person.name}
      </h1>
      {person.company || person.plusOneOf ? (
        <p className="evu-muted" style={{ margin: 0 }}>
          {[person.company, person.plusOneOf ? `Guest of ${person.plusOneOf}` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
      {answer ? (
        <div
          className="evu-big-status"
          data-tone={answer.tone}
          role="status"
          data-checkin-answer={answer.tone}
        >
          {answer.text}
        </div>
      ) : notToday ? (
        <div className="evu-big-status" data-tone="bad" role="status" data-checkin-answer="bad">
          Not on the list for the session happening now
        </div>
      ) : null}
      <ul className="evu-list">
        {person.sessions.map((s) => {
          const going = s.status === 'going';
          const isCurrent = s.sessionId === person.currentSessionId;
          return (
            <li key={s.sessionId} className="evu-stack" data-checkin-session={s.sessionId}>
              <div className="evu-row" style={{ justifyContent: 'space-between' }}>
                <strong>
                  {s.name}
                  {isCurrent ? ' · now' : ''}
                </strong>
                <span
                  className="evu-chip"
                  data-tone={s.checkedInAt ? 'ok' : going ? undefined : 'bad'}
                >
                  {s.checkedInAt
                    ? `In · ${formatCheckinTime(s.checkedInAt, timeZone)}${s.checkedInBy ? ` by ${s.checkedInBy}` : ''}`
                    : going
                      ? 'Going'
                      : 'Not on the list'}
                </span>
              </div>
              {going ? (
                <div className="evu-row">
                  {!s.checkedInAt ? (
                    <button
                      type="button"
                      className="evu-btn evu-btn-primary"
                      disabled={busy !== null}
                      onClick={() => act(s.sessionId, 'checkin', false)}
                    >
                      Check in {person.name.split(' ')[0]}
                      {s.partyPending.length ? '' : ` – ${s.name}`}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="evu-btn evu-btn-secondary"
                      disabled={busy !== null}
                      onClick={() => act(s.sessionId, 'undo', false)}
                    >
                      Undo check-in
                    </button>
                  )}
                  {s.partyPending.length ? (
                    <button
                      type="button"
                      className="evu-btn evu-btn-primary"
                      disabled={busy !== null}
                      onClick={() => act(s.sessionId, 'checkin', true)}
                    >
                      {s.checkedInAt ? 'Check in their guest' : 'Check in'} (+
                      {s.partyPending.length})
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {!person.sessions.length ? <p className="evu-muted">No sessions on this ticket.</p> : null}
    </section>
  );
}
