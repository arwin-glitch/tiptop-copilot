'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { api } from '@/components/events/guests/guest-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/form';
import {
  DIETARY_OPTIONS,
  QUESTION_TYPE_LABELS,
  QUESTION_TYPES,
  hasOwnOptions,
  type RegistrationQuestion,
} from '@/lib/events/questions';
import type {
  EventAccess,
  EventQuestionType,
  EventRegistrationSettings,
  EventSession,
} from '@/lib/types/domain';
import { localClock, wallTimeToUtc } from '@/lib/util/time';

/**
 * The Registration tab's editor (D-075): three subtabs (no long scroll):
 *   Access    – open / approval / invite-only, accepting, closes at,
 *               capacity, spots left, waitlist and auto-promote, request an
 *               invite, responses and their labels, plus-ones, guest list.
 *   Sessions  – each session's name, times (in the venue's zone), capacity,
 *               approval and waitlist overrides, tag visibility, venue.
 *   Questions – the questions builder: types, required, help, choices,
 *               per-session, asked of plus-ones, show-if (one condition).
 */

type Tab = 'access' | 'sessions' | 'questions';

export interface RegistrationEditorProps {
  eventId: string;
  timeZone: string;
  access: EventAccess;
  capacity: number | null;
  registration: EventRegistrationSettings;
  questions: RegistrationQuestion[];
  sessions: EventSession[];
  going: Record<string, number>;
}

/** ISO → "YYYY-MM-DDTHH:mm" in the venue's zone (for <input type="datetime-local">). */
function toLocalInput(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const c = localClock(new Date(iso), timeZone);
  return `${c.dateKey}T${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;
}

function fromLocalInput(value: string, timeZone: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return wallTimeToUtc(m[1]!, Number(m[2]), Number(m[3]), timeZone)?.toISOString() ?? null;
}

function newQuestion(type: EventQuestionType, position: number): RegistrationQuestion {
  return {
    id: crypto.randomUUID(),
    type,
    label:
      type === 'dietary'
        ? 'Any dietary needs?'
        : type === 'company'
          ? 'Company'
          : type === 'job_title'
            ? 'Job title'
            : type === 'linkedin'
              ? 'LinkedIn profile'
              : type === 'terms'
                ? 'I agree to the terms'
                : '',
    help: null,
    required: false,
    options: hasOwnOptions(type) ? ['', ''] : [],
    session_id: null,
    ask_plus_ones: type === 'dietary',
    position,
    removed_at: null,
    show_if: null,
  };
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {hint ? <p className="text-xs text-[var(--fg-muted)]">{hint}</p> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/* ------------------------------------------------------------- access */

function AccessTab(props: RegistrationEditorProps & { onSaved: () => void }) {
  const [access, setAccess] = useState<EventAccess>(props.access);
  const [capacity, setCapacity] = useState<string>(
    props.capacity === null ? '' : String(props.capacity),
  );
  const [reg, setReg] = useState<EventRegistrationSettings>(props.registration);
  const [closesAt, setClosesAt] = useState(
    toLocalInput(props.registration.closes_at, props.timeZone),
  );
  const [busy, setBusy] = useState(false);

  async function save() {
    const cap = capacity.trim() === '' ? null : Number(capacity);
    if (cap !== null && (!Number.isInteger(cap) || cap < 0)) {
      toast.error('Capacity is a whole number, or blank for none.');
      return;
    }
    setBusy(true);
    const res = await api(`/api/events/${props.eventId}/registration`, {
      method: 'PUT',
      body: {
        access,
        capacity: cap,
        registration: {
          ...reg,
          closes_at: closesAt ? fromLocalInput(closesAt, props.timeZone) : null,
        },
      },
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error?.message ?? 'Those settings could not be saved.');
      return;
    }
    toast.success('Registration settings saved');
    props.onSaved();
  }

  const modes: { value: EventAccess; label: string; hint: string }[] = [
    {
      value: 'open',
      label: 'Open',
      hint: 'Anyone with the link registers and is Going (or waitlisted when full).',
    },
    {
      value: 'approval',
      label: 'Approval',
      hint: 'Anyone can ask; they wait as Pending until you approve.',
    },
    {
      value: 'invite_only',
      label: 'Invite-only',
      hint: 'Only personal links can RSVP. The page says “By invitation”.',
    },
  ];

  return (
    <div className="space-y-6" data-registration-access>
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Who can RSVP</legend>
        {modes.map((m) => (
          <label
            key={m.value}
            className="flex cursor-pointer items-start gap-2 rounded-md border border-[var(--border)] p-3"
          >
            <input
              type="radio"
              name="access"
              value={m.value}
              checked={access === m.value}
              onChange={() => setAccess(m.value)}
            />
            <span>
              <span className="block text-sm font-medium">{m.label}</span>
              <span className="block text-xs text-[var(--fg-muted)]">{m.hint}</span>
            </span>
          </label>
        ))}
        {access === 'invite_only' ? (
          <SwitchRow
            id="reg-request"
            label="Offer “Request an invite”"
            hint="Requests land in Pending for you to approve."
            checked={reg.request_invite}
            onChange={(v) => setReg({ ...reg, request_invite: v })}
          />
        ) : null}
      </fieldset>

      <section className="space-y-3">
        <SwitchRow
          id="reg-open"
          label="Accept registrations"
          checked={reg.open}
          onChange={(v) => setReg({ ...reg, open: v })}
        />
        <Field
          label={`Closes at (${props.timeZone})`}
          htmlFor="reg-closes"
          hint="After this, personal links can no longer change their RSVP."
        >
          <Input
            id="reg-closes"
            type="datetime-local"
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
          />
        </Field>
        <Field
          label="Event-wide capacity"
          htmlFor="reg-capacity"
          hint="Blank for none. Sessions have their own capacity too. Only Going counts, plus-ones included."
        >
          <Input
            id="reg-capacity"
            inputMode="numeric"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value.replace(/[^\d]/g, ''))}
          />
        </Field>
        <SwitchRow
          id="reg-remaining"
          label="Show “N spots left”"
          checked={reg.show_remaining}
          onChange={(v) => setReg({ ...reg, show_remaining: v })}
        />
        <SwitchRow
          id="reg-waitlist"
          label="Waitlist when full"
          checked={reg.waitlist}
          onChange={(v) => setReg({ ...reg, waitlist: v })}
        />
        <SwitchRow
          id="reg-auto"
          label="Auto-promote from the waitlist"
          hint="When someone cancels, the first party that fits moves up. Off by default for LP events."
          checked={reg.auto_promote}
          onChange={(v) => setReg({ ...reg, auto_promote: v })}
        />
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Responses</h3>
        <SwitchRow
          id="reg-maybe"
          label="Offer “Maybe”"
          checked={reg.response_set.maybe}
          onChange={(v) => setReg({ ...reg, response_set: { ...reg.response_set, maybe: v } })}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          {(['going', 'maybe', 'not_going'] as const).map((k) => (
            <Field
              key={k}
              label={
                k === 'going' ? 'Going label' : k === 'maybe' ? 'Maybe label' : 'Can’t go label'
              }
              htmlFor={`reg-label-${k}`}
            >
              <Input
                id={`reg-label-${k}`}
                maxLength={40}
                value={reg.response_set.labels[k]}
                onChange={(e) =>
                  setReg({
                    ...reg,
                    response_set: {
                      ...reg.response_set,
                      labels: { ...reg.response_set.labels, [k]: e.target.value },
                    },
                  })
                }
              />
            </Field>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Plus-ones</h3>
        <Field label="Guests each person may bring" htmlFor="reg-plus-max">
          <Select
            id="reg-plus-max"
            value={String(reg.plus_ones.max)}
            onChange={(e) =>
              setReg({ ...reg, plus_ones: { ...reg.plus_ones, max: Number(e.target.value) } })
            }
          >
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'None' : n}
              </option>
            ))}
          </Select>
        </Field>
        {reg.plus_ones.max > 0 ? (
          <>
            <SwitchRow
              id="reg-plus-session"
              label="Chosen per session"
              checked={reg.plus_ones.per_session}
              onChange={(v) => setReg({ ...reg, plus_ones: { ...reg.plus_ones, per_session: v } })}
            />
            <SwitchRow
              id="reg-plus-email"
              label="Ask for their email (optional for them)"
              checked={reg.plus_ones.collect_email}
              onChange={(v) =>
                setReg({ ...reg, plus_ones: { ...reg.plus_ones, collect_email: v } })
              }
            />
            <SwitchRow
              id="reg-plus-questions"
              label="Plus-ones answer the questions marked for them"
              checked={reg.plus_ones.ask_questions}
              onChange={(v) =>
                setReg({ ...reg, plus_ones: { ...reg.plus_ones, ask_questions: v } })
              }
            />
          </>
        ) : null}
      </section>

      <Field
        label="Guest list on the page"
        htmlFor="reg-wall"
        hint="Each guest must tick “Show me on the guest list”. Emails are never shown."
      >
        <Select
          id="reg-wall"
          value={reg.guest_wall}
          onChange={(e) =>
            setReg({
              ...reg,
              guest_wall: e.target.value as EventRegistrationSettings['guest_wall'],
            })
          }
        >
          <option value="hidden">Hidden</option>
          <option value="count">Count only</option>
          <option value="going">Going guests see names</option>
          <option value="public">Public</option>
        </Select>
      </Field>

      <Button variant="primary" loading={busy} onClick={save}>
        Save registration settings
      </Button>
    </div>
  );
}

/* ----------------------------------------------------------- sessions */

function SessionCard({
  eventId,
  session,
  timeZone,
  going,
  only,
  onSaved,
}: {
  eventId: string;
  session: EventSession;
  timeZone: string;
  going: number;
  only: boolean;
  onSaved: () => void;
}) {
  const [name, setName] = useState(session.name);
  const [starts, setStarts] = useState(toLocalInput(session.starts_at, timeZone));
  const [ends, setEnds] = useState(toLocalInput(session.ends_at, timeZone));
  const [capacity, setCapacity] = useState(
    session.capacity === null ? '' : String(session.capacity),
  );
  const [approval, setApproval] = useState(
    session.requires_approval === null ? 'inherit' : session.requires_approval ? 'yes' : 'no',
  );
  const [waitlist, setWaitlist] = useState(
    session.waitlist === null ? 'inherit' : session.waitlist ? 'on' : 'off',
  );
  const [tags, setTags] = useState(session.visible_to_tags.join(', '));
  const [venueName, setVenueName] = useState(session.venue?.name ?? '');
  const [venueAddress, setVenueAddress] = useState(session.venue?.address ?? '');
  const [venueReveal, setVenueReveal] = useState(session.venue?.reveal ?? 'public');
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  async function save() {
    setBusy(true);
    const venue =
      venueName.trim() || venueAddress.trim()
        ? {
            kind: 'in_person' as const,
            name: venueName.trim() || null,
            address: venueAddress.trim() || null,
            lat: null,
            lng: null,
            place_id: null,
            maps_url: null,
            online_url: null,
            reveal: venueReveal,
            notes: null,
          }
        : null;
    const res = await api<{ scheduleChanged: boolean; goingCount: number }>(
      `/api/events/${eventId}/registration/sessions/${session.id}`,
      {
        method: 'PATCH',
        body: {
          name: name.trim(),
          starts_at: starts ? fromLocalInput(starts, timeZone) : null,
          ends_at: ends ? fromLocalInput(ends, timeZone) : null,
          capacity: capacity.trim() === '' ? null : Number(capacity),
          requires_approval: approval === 'inherit' ? null : approval === 'yes',
          waitlist: waitlist === 'inherit' ? null : waitlist === 'on',
          visible_to_tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          venue,
        },
      },
    );
    setBusy(false);
    if (!res.ok || !res.data) {
      toast.error(res.error?.message ?? 'That session could not be saved.');
      return;
    }
    if (res.data.scheduleChanged && res.data.goingCount) {
      toast.warning(
        `Time or place changed. ${res.data.goingCount} going guest${res.data.goingCount === 1 ? '' : 's'} should hear about it: draft an update from the Messages tab. Their calendar files update too.`,
      );
    } else toast.success('Session saved');
    onSaved();
  }

  async function remove() {
    const yes = await confirm({
      title: `Remove ${session.name}?`,
      description: going ? `${going} going guest(s) lose their RSVP for it.` : undefined,
      confirmLabel: 'Remove session',
      tone: 'danger',
    });
    if (!yes) return;
    setBusy(true);
    const res = await api(`/api/events/${eventId}/registration/sessions/${session.id}?confirm=1`, {
      method: 'DELETE',
    });
    setBusy(false);
    if (!res.ok) toast.error(res.error?.message ?? 'That session could not be removed.');
    else toast.success('Session removed');
    onSaved();
  }

  return (
    <div
      className="space-y-3 rounded-md border border-[var(--border)] p-4"
      data-session-card={session.id}
    >
      {confirmDialog}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone="outline">
          {going} going{session.capacity !== null ? ` of ${session.capacity}` : ''}
        </Badge>
        {!only ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={remove}
            disabled={busy}
            aria-label={`Remove ${session.name}`}
          >
            <Trash2 /> Remove
          </Button>
        ) : null}
      </div>
      <Field label="Name" htmlFor={`s-name-${session.id}`}>
        <Input
          id={`s-name-${session.id}`}
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`Starts (${timeZone})`} htmlFor={`s-start-${session.id}`}>
          <Input
            id={`s-start-${session.id}`}
            type="datetime-local"
            value={starts}
            onChange={(e) => setStarts(e.target.value)}
          />
        </Field>
        <Field label="Ends" htmlFor={`s-end-${session.id}`}>
          <Input
            id={`s-end-${session.id}`}
            type="datetime-local"
            value={ends}
            onChange={(e) => setEnds(e.target.value)}
          />
        </Field>
        <Field label="Capacity" htmlFor={`s-cap-${session.id}`} hint="Blank for none.">
          <Input
            id={`s-cap-${session.id}`}
            inputMode="numeric"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value.replace(/[^\d]/g, ''))}
          />
        </Field>
        <Field
          label="Only these tags see it"
          htmlFor={`s-tags-${session.id}`}
          hint="Comma separated, e.g. LP. Blank: everyone."
        >
          <Input
            id={`s-tags-${session.id}`}
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
        </Field>
        <Field label="Approval" htmlFor={`s-appr-${session.id}`}>
          <Select
            id={`s-appr-${session.id}`}
            value={approval}
            onChange={(e) => setApproval(e.target.value)}
          >
            <option value="inherit">As the event</option>
            <option value="yes">Always approve requests</option>
            <option value="no">Never</option>
          </Select>
        </Field>
        <Field label="Waitlist" htmlFor={`s-wait-${session.id}`}>
          <Select
            id={`s-wait-${session.id}`}
            value={waitlist}
            onChange={(e) => setWaitlist(e.target.value)}
          >
            <option value="inherit">As the event</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </Select>
        </Field>
      </div>
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Different venue for this session
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Venue name" htmlFor={`s-vn-${session.id}`}>
            <Input
              id={`s-vn-${session.id}`}
              value={venueName}
              onChange={(e) => setVenueName(e.target.value)}
            />
          </Field>
          <Field label="Address" htmlFor={`s-va-${session.id}`}>
            <Input
              id={`s-va-${session.id}`}
              value={venueAddress}
              onChange={(e) => setVenueAddress(e.target.value)}
            />
          </Field>
          <Field label="Show the address to" htmlFor={`s-vr-${session.id}`}>
            <Select
              id={`s-vr-${session.id}`}
              value={venueReveal}
              onChange={(e) => setVenueReveal(e.target.value as 'public' | 'registered' | 'going')}
            >
              <option value="public">Everyone</option>
              <option value="registered">Registered guests (Going or Maybe)</option>
              <option value="going">Going to this session</option>
            </Select>
          </Field>
        </div>
        <p className="mt-2 text-xs text-[var(--fg-muted)]">
          Pending requests and the waitlist never see a hidden address.
        </p>
      </details>
      <Button size="sm" variant="primary" loading={busy} onClick={save}>
        Save session
      </Button>
    </div>
  );
}

function SessionsTab(props: RegistrationEditorProps & { onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  async function add() {
    setBusy(true);
    const res = await api(`/api/events/${props.eventId}/registration/sessions`, {
      method: 'POST',
      body: { name: `Session ${props.sessions.length + 1}` },
    });
    setBusy(false);
    if (!res.ok) toast.error(res.error?.message ?? 'That session could not be added.');
    props.onSaved();
  }
  return (
    <div className="space-y-4" data-registration-sessions>
      <p className="text-sm text-[var(--fg-muted)]">
        One event can take separate RSVPs per session (an afternoon meeting and an evening
        reception), each with its own capacity, approval, waitlist, visibility and check-in.
      </p>
      {props.sessions.map((s) => (
        <SessionCard
          key={`${s.id}-${s.updated_at}`}
          eventId={props.eventId}
          session={s}
          timeZone={props.timeZone}
          going={props.going[s.id] ?? 0}
          only={props.sessions.length === 1}
          onSaved={props.onSaved}
        />
      ))}
      <Button onClick={add} loading={busy} disabled={props.sessions.length >= 20}>
        + Add a session
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------- questions */

function QuestionsTab(props: RegistrationEditorProps & { onSaved: () => void }) {
  const [questions, setQuestions] = useState<RegistrationQuestion[]>(
    [...props.questions].filter((q) => !q.removed_at).sort((a, b) => a.position - b.position),
  );
  const [type, setType] = useState<EventQuestionType>('short_text');
  const [busy, setBusy] = useState(false);

  const update = (id: string, patch: Partial<RegistrationQuestion>) =>
    setQuestions(questions.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  const move = (index: number, delta: number) => {
    const next = [...questions];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    setQuestions(next);
  };

  async function save() {
    for (const q of questions) {
      if (!q.label.trim()) {
        toast.error('Every question needs a label.');
        return;
      }
    }
    setBusy(true);
    const removed = props.questions.filter((q) => q.removed_at);
    const res = await api(`/api/events/${props.eventId}/registration`, {
      method: 'PUT',
      body: {
        questions: [
          ...questions.map((q, i) => ({
            ...q,
            label: q.label.trim(),
            options: hasOwnOptions(q.type) ? q.options.map((o) => o.trim()).filter(Boolean) : [],
            position: i,
          })),
          ...removed,
        ],
      },
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error?.message ?? 'The questions could not be saved.');
      return;
    }
    toast.success('Questions saved. Changes apply to new answers only.');
    props.onSaved();
  }

  return (
    <div className="space-y-4" data-registration-questions>
      <p className="text-sm text-[var(--fg-muted)]">
        Name and email are always asked. A removed question stays in exports as “(removed)”.
      </p>
      {questions.map((q, i) => (
        <div
          key={q.id}
          className="space-y-3 rounded-md border border-[var(--border)] p-4"
          data-question={q.id}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge tone="accent">{QUESTION_TYPE_LABELS[q.type]}</Badge>
            <div className="flex gap-1">
              <Button
                size="icon"
                variant="ghost"
                aria-label="Move up"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Move down"
                disabled={i === questions.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Remove question"
                onClick={() => setQuestions(questions.filter((x) => x.id !== q.id))}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
          <Field label="Question" htmlFor={`q-label-${q.id}`}>
            <Input
              id={`q-label-${q.id}`}
              value={q.label}
              maxLength={200}
              onChange={(e) => update(q.id, { label: e.target.value })}
            />
          </Field>
          <Field label={q.type === 'terms' ? 'Terms text' : 'Help text'} htmlFor={`q-help-${q.id}`}>
            <Textarea
              id={`q-help-${q.id}`}
              value={q.help ?? ''}
              maxLength={2000}
              onChange={(e) => update(q.id, { help: e.target.value || null })}
            />
          </Field>
          {hasOwnOptions(q.type) ? (
            <Field label="Choices (one per line)" htmlFor={`q-opts-${q.id}`}>
              <Textarea
                id={`q-opts-${q.id}`}
                value={q.options.join('\n')}
                onChange={(e) => update(q.id, { options: e.target.value.split('\n').slice(0, 30) })}
              />
            </Field>
          ) : q.type === 'dietary' ? (
            <p className="text-xs text-[var(--fg-muted)]">Choices: {DIETARY_OPTIONS.join(', ')}.</p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Asked for" htmlFor={`q-session-${q.id}`}>
              <Select
                id={`q-session-${q.id}`}
                value={q.session_id ?? ''}
                onChange={(e) => update(q.id, { session_id: e.target.value || null })}
              >
                <option value="">The whole event</option>
                {props.sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} only
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Show only if (optional)" htmlFor={`q-if-${q.id}`}>
              <Select
                id={`q-if-${q.id}`}
                value={
                  q.show_if
                    ? q.show_if.kind === 'session'
                      ? `s:${q.show_if.session_id}`
                      : `a:${q.show_if.question_id}`
                    : ''
                }
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) update(q.id, { show_if: null });
                  else if (v.startsWith('s:'))
                    update(q.id, { show_if: { kind: 'session', session_id: v.slice(2) } });
                  else
                    update(q.id, {
                      show_if: { kind: 'answer', question_id: v.slice(2), equals: '' },
                    });
                }}
              >
                <option value="">Always</option>
                {props.sessions.map((s) => (
                  <option key={s.id} value={`s:${s.id}`}>
                    They choose {s.name}
                  </option>
                ))}
                {questions
                  .filter(
                    (x) =>
                      x.id !== q.id &&
                      (x.type === 'single_choice' ||
                        x.type === 'yes_no' ||
                        x.type === 'multi_choice'),
                  )
                  .map((x) => (
                    <option key={x.id} value={`a:${x.id}`}>
                      “{x.label || 'Untitled'}” is…
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          {q.show_if?.kind === 'answer' ? (
            <Field
              label="…this answer"
              htmlFor={`q-eq-${q.id}`}
              hint="For yes/no questions use yes or no."
            >
              <Input
                id={`q-eq-${q.id}`}
                value={q.show_if.equals}
                maxLength={200}
                onChange={(e) =>
                  update(q.id, {
                    show_if: {
                      kind: 'answer',
                      question_id: (q.show_if as { question_id: string }).question_id,
                      equals: e.target.value,
                    },
                  })
                }
              />
            </Field>
          ) : null}
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={q.required}
                onCheckedChange={(v) => update(q.id, { required: v })}
                aria-label="Required"
              />
              Required
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={q.ask_plus_ones}
                onCheckedChange={(v) => update(q.id, { ask_plus_ones: v })}
                aria-label="Ask plus-ones too"
              />
              Ask plus-ones too
            </label>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Add a question" htmlFor="q-new-type">
          <Select
            id="q-new-type"
            value={type}
            onChange={(e) => setType(e.target.value as EventQuestionType)}
          >
            {QUESTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {QUESTION_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          onClick={() => setQuestions([...questions, newQuestion(type, questions.length)])}
          disabled={questions.length >= 40}
        >
          + Add
        </Button>
      </div>
      <Button variant="primary" loading={busy} onClick={save}>
        Save questions
      </Button>
    </div>
  );
}

export function RegistrationEditor(props: RegistrationEditorProps) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('access');
  const onSaved = () => router.refresh();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Registration settings">
        {(
          [
            ['access', 'Access'],
            ['sessions', `Sessions (${props.sessions.length})`],
            ['questions', `Questions (${props.questions.filter((q) => !q.removed_at).length})`],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            role="tab"
            aria-selected={tab === value}
            variant={tab === value ? 'primary' : 'secondary'}
            onClick={() => setTab(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {tab === 'access' ? <AccessTab {...props} onSaved={onSaved} /> : null}
      {tab === 'sessions' ? <SessionsTab {...props} onSaved={onSaved} /> : null}
      {tab === 'questions' ? <QuestionsTab {...props} onSaved={onSaved} /> : null}
    </div>
  );
}
