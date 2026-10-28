'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import '@/components/events/rsvp/ev-ui.css';
import { formatCheckinTime } from '@/lib/events/format';
import type { CheckinResult, DoorList as DoorListData } from '@/lib/services/event-checkin';

/**
 * The door list (D-075): live counters per session, search, one-tap check-in
 * and undo, walk-ins, and Door mode (large type for a phone or iPad at the
 * door). The same component serves owners (Check-in tab, /api/events/[id]/
 * checkin) and staff links (/e/checkin/[eventId], /api/e/checkin/[eventId]/…).
 * Polls every 15 s so two doors see each other's check-ins.
 */

type Kind = 'owner' | 'staff';

function urls(kind: Kind, eventId: string) {
  return kind === 'owner'
    ? {
        list: `/api/events/${eventId}/checkin`,
        checkin: `/api/events/${eventId}/checkin`,
        walkIn: `/api/events/${eventId}/checkin`,
      }
    : {
        list: `/api/e/checkin/${eventId}/guests`,
        checkin: `/api/e/checkin/${eventId}/checkin`,
        walkIn: `/api/e/checkin/${eventId}/walk-in`,
      };
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  return (await res.json().catch(() => null)) as {
    ok?: boolean;
    result?: CheckinResult;
    error?: { message?: string };
  } | null;
}

export function DoorList({
  kind,
  eventId,
  initial,
  embedded = false,
}: {
  kind: Kind;
  eventId: string;
  initial: DoorListData;
  /** Inside Kraken's Check-in tab (no page heading of its own). */
  embedded?: boolean;
}) {
  const api = useMemo(() => urls(kind, eventId), [kind, eventId]);
  const [list, setList] = useState(initial);
  const [sessionId, setSessionId] = useState(
    initial.currentSessionId ?? initial.sessions[0]?.id ?? '',
  );
  const [q, setQ] = useState('');
  const [doorMode, setDoorMode] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string } | null>(null);
  const [walkIn, setWalkIn] = useState({
    open: false,
    firstName: '',
    lastName: '',
    company: '',
    email: '',
  });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(api.list, { credentials: 'same-origin', cache: 'no-store' });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        list?: DoorListData;
      } | null;
      if (data?.ok && data.list) setList(data.list);
    } catch {
      // offline: keep what we have
    }
  }, [api.list]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const session = list.sessions.find((s) => s.id === sessionId) ?? list.sessions[0];
  const needle = q.trim().toLowerCase();
  const entries = list.entries
    .filter((e) => session && e.sessions[session.id])
    .filter(
      (e) =>
        !needle ||
        e.name.toLowerCase().includes(needle) ||
        (e.company ?? '').toLowerCase().includes(needle) ||
        (e.plusOneOf ?? '').toLowerCase().includes(needle),
    );

  async function toggle(guestId: string, undo: boolean) {
    if (!session) return;
    setBusy(guestId);
    const body =
      kind === 'owner'
        ? { action: undo ? 'undo' : 'checkin', guestId, sessionId: session.id }
        : { guestId, sessionId: session.id, undo };
    const data = await postJson(api.checkin, body).catch(() => null);
    setBusy(null);
    if (!data?.ok || !data.result) {
      setNotice({
        tone: 'bad',
        text: data?.error?.message ?? 'That did not go through. Try again.',
      });
      return;
    }
    const r = data.result;
    const time = formatCheckinTime(r.at, list.timeZone);
    setNotice(
      r.state === 'checked_in'
        ? { tone: 'ok', text: `${r.name} checked in${time ? ` · ${time}` : ''}` }
        : r.state === 'already'
          ? {
              tone: 'warn',
              text: `${r.name} was already checked in${time ? ` ${time}` : ''}${r.by ? ` by ${r.by}` : ''}`,
            }
          : r.state === 'undone'
            ? { tone: 'warn', text: `Check-in undone for ${r.name}` }
            : { tone: 'bad', text: `${r.name} is not on the list for ${session.name}` },
    );
    await refresh();
  }

  async function addWalkIn(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !walkIn.firstName.trim()) return;
    setBusy('walk-in');
    const body = {
      ...(kind === 'owner' ? { action: 'walk_in' } : {}),
      firstName: walkIn.firstName.trim(),
      lastName: walkIn.lastName.trim() || undefined,
      company: walkIn.company.trim() || undefined,
      email: walkIn.email.trim() || undefined,
      sessionId: session.id,
    };
    const data = await postJson(api.walkIn, body).catch(() => null);
    setBusy(null);
    if (!data?.ok) {
      setNotice({
        tone: 'bad',
        text: data?.error?.message ?? 'That did not go through. Try again.',
      });
      return;
    }
    setNotice({ tone: 'ok', text: `${walkIn.firstName.trim()} added and checked in` });
    setWalkIn({ open: false, firstName: '', lastName: '', company: '', email: '' });
    await refresh();
  }

  return (
    <div data-ev-ui data-door-mode={doorMode} className="evu-door evu-stack" data-door-list>
      <div className="evu-row" style={{ justifyContent: 'space-between' }}>
        {embedded ? (
          <h2 className="evu-title">Door list</h2>
        ) : (
          <h1 className="evu-title" style={{ fontSize: '1.5rem' }}>
            {list.title}
          </h1>
        )}
        <label className="evu-choice" data-checked={doorMode}>
          <input
            type="checkbox"
            checked={doorMode}
            onChange={(e) => setDoorMode(e.target.checked)}
          />
          <span>Door mode</span>
        </label>
      </div>
      {list.sessions.length > 1 ? (
        <div className="evu-tabs" role="tablist" aria-label="Sessions">
          {list.sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              className="evu-tab"
              aria-selected={s.id === session?.id}
              onClick={() => setSessionId(s.id)}
            >
              {s.name}
            </button>
          ))}
        </div>
      ) : null}
      {session ? (
        <div className="evu-row" aria-live="polite">
          <span className="evu-counter" data-door-counter>
            {session.checkedIn} / {session.going}
          </span>
          <span className="evu-muted">checked in · {session.name}</span>
        </div>
      ) : null}
      {notice ? (
        <div className="evu-big-status" data-tone={notice.tone} role="status">
          {notice.text}
        </div>
      ) : null}
      <div>
        <label className="evu-label" htmlFor="door-search">
          Find a guest
        </label>
        <input
          id="door-search"
          className="evu-input"
          type="search"
          autoComplete="off"
          placeholder="Name or company"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div role="list" aria-label="Guests">
        {entries.map((e) => {
          const state = session ? e.sessions[session.id] : undefined;
          const inAt = state?.checkedInAt ?? null;
          return (
            <div
              key={e.guestId}
              role="listitem"
              className="evu-door-row"
              data-in={Boolean(inAt)}
              data-door-guest={e.guestId}
            >
              <div style={{ minWidth: 0 }}>
                <div className="evu-door-name">
                  {e.name}
                  {e.badges.map((b) => (
                    <span key={b} className="evu-chip" style={{ marginLeft: 6 }}>
                      {b}
                    </span>
                  ))}
                </div>
                <div className="evu-muted evu-small">
                  {[
                    e.company,
                    e.plusOneOf ? `Guest of ${e.plusOneOf}` : null,
                    inAt ? `In ${formatCheckinTime(inAt, list.timeZone)}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              {inAt ? (
                <button
                  type="button"
                  className="evu-btn evu-btn-secondary"
                  disabled={busy !== null}
                  onClick={() => toggle(e.guestId, true)}
                  aria-label={`Undo check-in for ${e.name}`}
                >
                  Undo
                </button>
              ) : (
                <button
                  type="button"
                  className="evu-btn evu-btn-primary"
                  disabled={busy !== null}
                  onClick={() => toggle(e.guestId, false)}
                  aria-label={`Check in ${e.name}`}
                >
                  Check in
                </button>
              )}
            </div>
          );
        })}
        {!entries.length ? (
          <p className="evu-muted">
            {needle ? 'Nobody matches that.' : 'Nobody is going to this session yet.'}
          </p>
        ) : null}
      </div>
      {walkIn.open ? (
        <form className="evu-card evu-stack" onSubmit={addWalkIn} aria-label="Add a walk-in">
          <div className="evu-grid2">
            <div>
              <label className="evu-label" htmlFor="walk-first">
                First name
              </label>
              <input
                id="walk-first"
                className="evu-input"
                required
                maxLength={100}
                value={walkIn.firstName}
                onChange={(e) => setWalkIn({ ...walkIn, firstName: e.target.value })}
              />
            </div>
            <div>
              <label className="evu-label" htmlFor="walk-last">
                Last name
              </label>
              <input
                id="walk-last"
                className="evu-input"
                maxLength={100}
                value={walkIn.lastName}
                onChange={(e) => setWalkIn({ ...walkIn, lastName: e.target.value })}
              />
            </div>
          </div>
          <div className="evu-grid2">
            <div>
              <label className="evu-label" htmlFor="walk-company">
                Company
              </label>
              <input
                id="walk-company"
                className="evu-input"
                maxLength={200}
                value={walkIn.company}
                onChange={(e) => setWalkIn({ ...walkIn, company: e.target.value })}
              />
            </div>
            <div>
              <label className="evu-label" htmlFor="walk-email">
                Email (optional)
              </label>
              <input
                id="walk-email"
                className="evu-input"
                type="email"
                maxLength={320}
                value={walkIn.email}
                onChange={(e) => setWalkIn({ ...walkIn, email: e.target.value })}
              />
            </div>
          </div>
          <div className="evu-row">
            <button type="submit" className="evu-btn evu-btn-primary" disabled={busy !== null}>
              Add and check in
            </button>
            <button
              type="button"
              className="evu-btn evu-btn-secondary"
              onClick={() => setWalkIn({ ...walkIn, open: false })}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="evu-btn evu-btn-secondary"
          onClick={() => setWalkIn({ ...walkIn, open: true })}
        >
          + Walk-in
        </button>
      )}
    </div>
  );
}
