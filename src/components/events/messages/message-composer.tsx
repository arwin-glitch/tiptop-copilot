'use client';

import * as React from 'react';
import { Field, Select } from '@/components/ui/form';
import { DraftButton } from '@/components/events/messages/draft-button';
import type { EventAudience } from '@/lib/events/contracts';
import { STATUS_LABELS } from '@/lib/events/tab-view';
import type { EventGuestStatus } from '@/lib/types/domain';

export interface ComposerAudience {
  all: number;
  statuses: { status: EventGuestStatus; count: number }[];
  tags: { tag: string; count: number }[];
  checkedIn: number;
}

type Kind = 'invite' | 'blast';

/** The audience picker's value, as a string a <select> can hold. */
function toAudience(value: string, sessionId: string): EventAudience {
  const session = sessionId ? { sessionId } : {};
  if (value === 'all') return { kind: 'all', ...session };
  if (value === 'checked_in') return { kind: 'checked_in', ...session };
  if (value.startsWith('tag:')) return { kind: 'tag', tag: value.slice(4), ...session };
  return { kind: 'status', statuses: [value.slice(7) as EventGuestStatus], ...session };
}

/**
 * "New message": an invite or a message to any group of guests, by status,
 * tag, session or check-in, at any time (there is no cutoff after the event).
 * Drafting opens the campaign review; nothing goes until Send is tapped there.
 */
export function MessageComposer({
  eventId,
  audience,
  sessions,
  defaultSender,
}: {
  eventId: string;
  audience: ComposerAudience;
  sessions: { id: string; name: string }[];
  defaultSender: 'nick' | 'arwin';
}) {
  const [kind, setKind] = React.useState<Kind>('invite');
  const [who, setWho] = React.useState('status:invited');
  const [sessionId, setSessionId] = React.useState('');
  const [sender, setSender] = React.useState<'nick' | 'arwin'>(defaultSender);
  // Counts are for the whole event; a session narrows them, so they step aside.
  const count = (n: number) => (sessionId ? '' : ` (${n})`);

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">What</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Kind of message">
          {(
            [
              ['invite', 'Invite'],
              ['blast', 'Message to guests'],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm has-[:checked]:border-[var(--accent)] has-[:checked]:bg-[var(--accent-soft)]"
            >
              <input
                type="radio"
                name="event-message-kind"
                value={value}
                checked={kind === value}
                onChange={() => {
                  setKind(value);
                  setWho(value === 'invite' ? 'status:invited' : 'status:going');
                }}
                className="accent-[var(--accent)]"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="To" htmlFor="event-message-to">
          <Select id="event-message-to" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="all">Everyone on the list{count(audience.all)}</option>
            {audience.statuses.map((s) => (
              <option key={s.status} value={`status:${s.status}`}>
                {STATUS_LABELS[s.status]}
                {count(s.count)}
              </option>
            ))}
            <option value="checked_in">Checked in{count(audience.checkedIn)}</option>
            {audience.tags.map((t) => (
              <option key={t.tag} value={`tag:${t.tag}`}>
                Tag: {t.tag}
                {count(t.count)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Session" htmlFor="event-message-session">
          <Select
            id="event-message-session"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
          >
            <option value="">Every session</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From" htmlFor="event-message-from">
          <Select
            id="event-message-from"
            value={sender}
            onChange={(e) => setSender(e.target.value === 'arwin' ? 'arwin' : 'nick')}
          >
            <option value="nick">Nick (his signature)</option>
            <option value="arwin">Arwin</option>
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <DraftButton
          eventId={eventId}
          variant="primary"
          size="md"
          body={{ kind, audience: toAudience(who, sessionId), sender }}
        >
          {kind === 'invite' ? 'Draft the invite' : 'Draft the message'}
        </DraftButton>
        <p className="text-xs text-[var(--fg-muted)]">
          Each guest gets their own RSVP link. You review the draft and tap Send; up to 400 emails a
          day, 2,000 per message.
        </p>
      </div>
    </div>
  );
}
