'use client';

import * as React from 'react';
import {
  CalendarCheck2,
  Coffee,
  HelpCircle,
  Loader2,
  MessageCircle,
  MessageSquare,
  Plus,
  Send,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { AiTag } from '@/components/ask/ai-tag';
import { Button } from '@/components/ui/button';
import { Input, Label, Textarea } from '@/components/ui/form';
import type { ChatAnswer, ChatPlace, ChatSlot, ChatStart, ChatTimes } from '@/lib/booking/chat';
import { KIND_LABEL, firstName, type MeetingKind, type MeetingType } from '@/lib/booking/config';
import type { ChatFormFill } from '@/lib/booking/request';
import { DECK_URL, EMAIL_INPUT, LIMITS } from '@/lib/booking/request';
import { cn } from '@/lib/util/cn';

/**
 * The booking page's assistant, "Arwin" (D-078): an AI assistant, tagged so,
 * with no paid AI behind it. It books right here: a 30-minute call or an
 * in-person coffee, lunch or dinner, the next open times as buttons, a place,
 * guests if the link allows them, then name and email, sent through the same
 * public request route as the page's form (every rule and cap applies). It
 * answers questions from the answers written in Copilot, matched on the
 * server; a question none of them covers may go to the booking assistant
 * routine on Arwin's own Claude plan, and the answer appears here when it
 * comes (a minute or two), while the visitor keeps booking. It never says a
 * person will confirm anything.
 *
 * The page still passes `mode` and `onFill` (the old helper's); they are
 * accepted and unused: the assistant books on its own now.
 */

export interface BookingChatProps {
  slug: string;
  hostName: string;
  firmName: string;
  /** In-person kinds the page offers; the assistant reads its own from the server. */
  kinds: MeetingKind[];
  /** The visitor's time zone, as the page shows times. */
  zone: string;
  /** "30-min Zoom call": what a call is on, never its link (the server's own label wins). */
  callLabel?: string;
  /** Unused since D-078 (kept so the page's props still fit). */
  mode?: 'live' | 'guided';
  /** Unused since D-078 (kept so the page's props still fit). */
  onFill?: (fill: ChatFormFill) => void;
}

type Query = { type: MeetingType; kind: MeetingKind | null };

type BookingStatus = 'booked' | 'held' | 'pending' | 'message';

interface Done {
  status: BookingStatus;
  title: string;
  lines: string[];
  manageUrl: string | null;
}

type Turn =
  | { id: string; role: 'user'; text: string }
  | {
      id: string;
      role: 'assistant';
      text: string;
      /** An answer written in Copilot: the question it answered. */
      matched?: string;
      /** "Did you mean" chips under an answer. */
      suggestions?: string[];
      times?: { query: Query; slots: ChatSlot[]; more: boolean; page: number };
      /** A question sent to the booking assistant routine. */
      pending?: { id: string; question: string; startedAt: number };
      /** The routine's answer arrived. */
      ai?: boolean;
      /** Offer to leave this question as a message. */
      leaveMessage?: string;
      done?: Done;
    };

type Step =
  | { kind: 'menu' }
  | { kind: 'kinds' }
  | { kind: 'place'; query: Query; slot: ChatSlot }
  | {
      kind: 'details';
      query: Query;
      slot: ChatSlot;
      placeId: string | null;
      customPlace: string;
    }
  | { kind: 'message'; note: string }
  | { kind: 'none' };

const POLL_MS = 4_000;
const WAIT_MS = 3 * 60_000;

let turnSeq = 0;
const nextId = () => `t${++turnSeq}`;

function sessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    // Fall through to a plain random id.
  }
  return `s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Only a link back into this site may come from the server as the manage link. */
function safeManageUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  try {
    const url = new URL(raw);
    return url.origin === window.location.origin ? url.toString() : null;
  } catch {
    return null;
  }
}

function meetingLabel(query: Query, callLabel: string): string {
  return query.type === 'call'
    ? callLabel
    : `${KIND_LABEL[query.kind ?? 'coffee']}, 1 hour in person`;
}

export function BookingChat({
  slug,
  hostName,
  firmName,
  zone,
  callLabel: pageCallLabel = '30-min Google Meet',
}: BookingChatProps) {
  const first = firstName(hostName) || 'the host';
  const [open, setOpen] = React.useState(false);
  const [start, setStart] = React.useState<ChatStart | null>(null);
  const callLabel = start?.callLabel || pageCallLabel;
  const [startProblem, setStartProblem] = React.useState<string | null>(null);
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [step, setStep] = React.useState<Step>({ kind: 'menu' });
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const session = React.useRef<string>('');
  const listRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const uid = React.useId();

  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns, step, open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const say = React.useCallback(
    (turn: Omit<Extract<Turn, { role: 'assistant' }>, 'id' | 'role'>) => {
      setTurns((t) => [...t, { id: nextId(), role: 'assistant', ...turn }]);
    },
    [],
  );
  const echo = (text: string) =>
    setTurns((t) => [...t, { id: nextId(), role: 'user', text: text.slice(0, 600) }]);

  const call = React.useCallback(
    async <T,>(
      body: Record<string, unknown>,
    ): Promise<{ ok: true; value: T } | { ok: false; message: string }> => {
      const res = await fetch(`/api/meet/${encodeURIComponent(slug)}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeZone: zone, ...body }),
      }).catch(() => null);
      const json = (await res?.json().catch(() => null)) as
        (T & { ok?: boolean; error?: { message?: string } }) | null;
      if (!res?.ok || !json?.ok) {
        return {
          ok: false,
          message: json?.error?.message ?? 'Something went wrong. You can still use the page.',
        };
      }
      return { ok: true, value: json };
    },
    [slug, zone],
  );

  const openChat = async () => {
    setOpen(true);
    if (!session.current) session.current = sessionId();
    if (start || busy) return;
    setBusy(true);
    const res = await call<ChatStart>({ action: 'start' });
    setBusy(false);
    if (!res.ok) {
      setStartProblem(res.message);
      return;
    }
    setStart(res.value);
    setTurns([{ id: nextId(), role: 'assistant', text: res.value.greeting }]);
  };

  const showTimes = async (query: Query, page = 0) => {
    setBusy(true);
    const res = await call<ChatTimes>({
      action: 'times',
      type: query.type,
      ...(query.kind ? { kind: query.kind } : {}),
      page,
    });
    setBusy(false);
    if (!res.ok) {
      say({ text: res.message });
      return;
    }
    setStep({ kind: 'none' });
    say({
      text: res.value.slots.length
        ? `${res.value.reply} Times are in ${res.value.zoneLabel}.`
        : res.value.reply,
      times: { query, slots: res.value.slots, more: res.value.more, page },
      ...(res.value.slots.length ? {} : { leaveMessage: '' }),
    });
  };

  const chooseCall = () => {
    echo('Book a 30-min call');
    void showTimes({ type: 'call', kind: null });
  };
  const chooseInPerson = () => {
    echo('Meet in person');
    if (start && start.kinds.length === 1) {
      void showTimes({ type: 'in_person', kind: start.kinds[0]! });
      return;
    }
    say({ text: 'Coffee, lunch or dinner?' });
    setStep({ kind: 'kinds' });
  };
  const chooseKind = (kind: MeetingKind) => {
    echo(KIND_LABEL[kind]);
    void showTimes({ type: 'in_person', kind });
  };
  const chooseQuestion = () => {
    echo('Ask a question');
    say({
      text: start?.suggestions.length
        ? 'Type your question below, or tap one of these.'
        : 'Type your question below.',
      suggestions: start?.suggestions ?? [],
    });
    setStep({ kind: 'menu' });
    window.setTimeout(() => inputRef.current?.focus(), 50);
  };
  const chooseMessage = (note = '') => {
    echo('Leave a message or deck');
    say({ text: `Write your message for ${first} below. A deck link is welcome too.` });
    setStep({ kind: 'message', note });
  };

  const pickSlot = (query: Query, slot: ChatSlot) => {
    echo(slot.label);
    if (query.type === 'in_person') {
      say({ text: 'Where would you like to meet?' });
      setStep({ kind: 'place', query, slot });
      return;
    }
    say({
      text: `${meetingLabel(query, callLabel)} on ${slot.label}. Who should get the invitation?`,
    });
    setStep({ kind: 'details', query, slot, placeId: null, customPlace: '' });
  };

  const pickPlace = (query: Query, slot: ChatSlot, place: ChatPlace | null, custom = '') => {
    echo(place ? place.name : custom);
    say({
      text: `${meetingLabel(query, callLabel)} on ${slot.label}. Who should get the invitation?`,
    });
    setStep({ kind: 'details', query, slot, placeId: place?.id ?? null, customPlace: custom });
  };

  const ask = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    echo(question);
    setBusy(true);
    const res = await call<ChatAnswer>({
      action: 'ask',
      question: question.slice(0, 600),
      sessionId: session.current || (session.current = sessionId()),
    });
    setBusy(false);
    if (!res.ok) {
      say({ text: res.message });
      return;
    }
    const answer = res.value;
    if (answer.kind === 'answer') {
      say({ text: answer.answer, matched: answer.matched, suggestions: answer.suggestions });
      return;
    }
    if (answer.kind === 'intent') {
      say({ text: answer.reply });
      const intent = answer.intent;
      if (intent.intent === 'call') void showTimes({ type: 'call', kind: null });
      else if (intent.intent === 'message') setStep({ kind: 'message', note: '' });
      else if (intent.kind) void showTimes({ type: 'in_person', kind: intent.kind });
      else setStep({ kind: 'kinds' });
      return;
    }
    if (answer.kind === 'pending') {
      say({
        text: answer.reply,
        pending: { id: answer.questionId, question, startedAt: Date.now() },
        suggestions: answer.suggestions,
      });
      return;
    }
    say({ text: answer.reply, suggestions: answer.suggestions, leaveMessage: question });
  };

  const settlePending = React.useCallback(
    (turnId: string, outcome: { answer: string } | { timedOut: true }) => {
      setTurns((list) =>
        list.map((t) => {
          if (t.id !== turnId || t.role !== 'assistant' || !t.pending) return t;
          const question = t.pending.question;
          if ('answer' in outcome) {
            return { id: t.id, role: 'assistant', text: outcome.answer, ai: true };
          }
          return {
            id: t.id,
            role: 'assistant',
            text: 'No answer yet. You can leave this question as a message instead.',
            leaveMessage: question,
          };
        }),
      );
    },
    [],
  );

  const sendText = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    void ask(text);
  };

  const startOver = () => {
    setStep({ kind: 'menu' });
    say({ text: 'What would you like to do?' });
  };

  const onBooked = (done: Done) => {
    setStep({ kind: 'none' });
    say({ text: done.title, done });
  };

  const onTaken = (query: Query, message: string) => {
    say({ text: message });
    void showTimes(query);
  };

  return (
    <>
      {!open ? (
        <button
          type="button"
          onClick={() => void openChat()}
          className="shadow-lifted fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[var(--z-overlay)] inline-flex h-12 items-center gap-2 rounded-full bg-[var(--primary)] px-4 text-sm font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover)]"
          aria-haspopup="dialog"
        >
          <MessageCircle className="size-4" aria-hidden="true" />
          Ask Arwin
          <AiTag className="border-[var(--primary-fg)] text-[var(--primary-fg)]" />
        </button>
      ) : null}
      {open ? (
        <section
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${uid}-title`}
          className="shadow-overlay fixed inset-0 z-[var(--z-overlay)] flex flex-col bg-[var(--bg-overlay)] sm:inset-auto sm:right-4 sm:bottom-4 sm:h-[min(40rem,calc(100dvh-2rem))] sm:w-[25rem] sm:rounded-[var(--radius-panel)] sm:border sm:border-[var(--border)]"
        >
          <header className="dark flex items-center gap-3 bg-[var(--bg-band)] px-4 py-3 text-[var(--fg)] sm:rounded-t-[var(--radius-panel)]">
            <span
              aria-hidden="true"
              className="flex size-8 items-center justify-center rounded-full bg-[var(--jewel)] font-serif text-sm font-semibold text-[var(--jewel-fg)]"
            >
              A
            </span>
            <div className="min-w-0 flex-1">
              <h2 id={`${uid}-title`} className="flex items-center gap-1.5 text-sm font-semibold">
                Arwin <AiTag />
              </h2>
              <p className="truncate text-xs text-[var(--fg-muted)]">
                {first}&apos;s AI scheduling assistant
                {firmName ? ` · ${firmName}` : ''}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setOpen(false)}
              aria-label="Close chat"
            >
              <X aria-hidden="true" />
            </Button>
          </header>

          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            <div className="space-y-3" aria-live="polite">
              {startProblem ? (
                <Bubble role="assistant">{startProblem}</Bubble>
              ) : !start && busy ? (
                <p className="text-xs text-[var(--fg-subtle)]">Arwin is getting ready…</p>
              ) : null}
              {turns.map((turn) =>
                turn.role === 'user' ? (
                  <Bubble key={turn.id} role="user">
                    {turn.text}
                  </Bubble>
                ) : (
                  <AssistantTurn
                    key={turn.id}
                    turn={turn}
                    slug={slug}
                    firstName={first}
                    onSlot={pickSlot}
                    onMore={(query, page) => void showTimes(query, page)}
                    onSuggestion={(q) => void ask(q)}
                    onLeaveMessage={(note) => chooseMessage(note)}
                    onSettle={settlePending}
                  />
                ),
              )}
              {busy && start ? (
                <p className="flex items-center gap-1.5 text-xs text-[var(--fg-subtle)]">
                  <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                  Arwin is looking…
                </p>
              ) : null}
            </div>

            {start ? (
              <StepPanel
                step={step}
                start={start}
                slug={slug}
                zone={zone}
                firstName={first}
                onCall={chooseCall}
                onInPerson={chooseInPerson}
                onQuestion={chooseQuestion}
                onMessage={() => chooseMessage()}
                onKind={chooseKind}
                onPlace={pickPlace}
                onStartOver={startOver}
                onBooked={onBooked}
                onTaken={onTaken}
              />
            ) : null}
          </div>

          <div className="space-y-2 border-t border-[var(--border)] px-4 py-3">
            <form onSubmit={sendText} className="flex items-end gap-2">
              <label htmlFor={`${uid}-input`} className="sr-only">
                Ask Arwin a question
              </label>
              <textarea
                id={`${uid}-input`}
                ref={inputRef}
                rows={1}
                maxLength={600}
                value={draft}
                disabled={!start}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Type a question"
                className="max-h-28 min-h-10 flex-1 resize-none rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] px-3 py-2 text-sm"
              />
              <Button
                type="submit"
                variant="primary"
                size="icon"
                aria-label="Send to Arwin"
                disabled={busy || !start}
              >
                <Send aria-hidden="true" />
              </Button>
            </form>
            <p className="text-[11px] leading-snug text-[var(--fg-subtle)]">
              Arwin is an AI assistant. It sees open times only, never what is on {first}&apos;s
              calendar.
            </p>
          </div>
        </section>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ turns */

function Bubble({
  role,
  children,
  className,
}: {
  role: 'user' | 'assistant';
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col', role === 'user' ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[88%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-line',
          role === 'user'
            ? 'rounded-br-sm bg-[var(--primary)] text-[var(--primary-fg)]'
            : 'rounded-bl-sm border border-[var(--border)] bg-[var(--bg-raised)]',
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

function Chip({
  onClick,
  children,
  icon,
  tone = 'plain',
}: {
  onClick: () => void;
  children: React.ReactNode;
  icon?: React.ReactNode;
  tone?: 'plain' | 'time';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-left text-xs font-medium',
        tone === 'time'
          ? 'border-[var(--border-strong)] bg-[var(--bg)] hover:border-[var(--primary)] hover:bg-[var(--accent-soft)]'
          : 'border-[var(--border-strong)] bg-[var(--bg-raised)] hover:bg-[var(--bg-hover)]',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function AssistantTurn({
  turn,
  slug,
  firstName: first,
  onSlot,
  onMore,
  onSuggestion,
  onLeaveMessage,
  onSettle,
}: {
  turn: Extract<Turn, { role: 'assistant' }>;
  slug: string;
  firstName: string;
  onSlot: (query: Query, slot: ChatSlot) => void;
  onMore: (query: Query, page: number) => void;
  onSuggestion: (q: string) => void;
  onLeaveMessage: (note: string) => void;
  onSettle: (turnId: string, outcome: { answer: string } | { timedOut: true }) => void;
}) {
  if (turn.done) return <DoneCard done={turn.done} />;
  return (
    <div className="flex flex-col items-start gap-2">
      <Bubble role="assistant">
        {turn.pending ? (
          <span className="flex items-start gap-2">
            <Loader2
              className="mt-0.5 size-4 shrink-0 animate-spin text-[var(--accent)]"
              aria-hidden="true"
            />
            <span>{turn.text}</span>
          </span>
        ) : (
          turn.text
        )}
        {turn.matched ? (
          <span className="mt-1 block text-[11px] text-[var(--fg-subtle)]">
            Answer to: {turn.matched}
          </span>
        ) : null}
        {turn.ai ? (
          <span className="mt-1 flex items-center gap-1 text-[11px] text-[var(--fg-subtle)]">
            Answered by Arwin <AiTag />
          </span>
        ) : null}
      </Bubble>
      {turn.pending ? (
        <PendingAnswer
          slug={slug}
          questionId={turn.pending.id}
          startedAt={turn.pending.startedAt}
          onDone={(outcome) => onSettle(turn.id, outcome)}
        />
      ) : null}
      {turn.times?.slots.length ? (
        <div className="flex max-w-full flex-wrap gap-1.5" role="group" aria-label="Open times">
          {turn.times.slots.map((slot) => (
            <Chip key={slot.start} tone="time" onClick={() => onSlot(turn.times!.query, slot)}>
              {slot.label}
            </Chip>
          ))}
          {turn.times.more ? (
            <Chip onClick={() => onMore(turn.times!.query, turn.times!.page + 1)}>More times</Chip>
          ) : null}
        </div>
      ) : null}
      {turn.suggestions?.length ? (
        <div className="flex max-w-full flex-wrap gap-1.5" role="group" aria-label="Did you mean">
          <span className="sr-only">Did you mean:</span>
          {turn.suggestions.map((q) => (
            <Chip
              key={q}
              onClick={() => onSuggestion(q)}
              icon={<HelpCircle className="size-3.5" aria-hidden="true" />}
            >
              {q}
            </Chip>
          ))}
        </div>
      ) : null}
      {turn.leaveMessage !== undefined ? (
        <Chip
          onClick={() => onLeaveMessage(turn.leaveMessage ?? '')}
          icon={<MessageSquare className="size-3.5" aria-hidden="true" />}
        >
          {turn.leaveMessage
            ? `Leave this as a message for ${first}`
            : `Leave a message for ${first}`}
        </Chip>
      ) : null}
    </div>
  );
}

/**
 * Polls for one routine answer every few seconds, for up to three minutes
 * from when it was asked (closing and reopening the chat keeps the clock).
 */
function PendingAnswer({
  slug,
  questionId,
  startedAt,
  onDone,
}: {
  slug: string;
  questionId: string;
  startedAt: number;
  onDone: (outcome: { answer: string } | { timedOut: true }) => void;
}) {
  const done = React.useRef(onDone);
  React.useEffect(() => {
    done.current = onDone;
  }, [onDone]);
  React.useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      if (stopped) return;
      if (Date.now() - startedAt > WAIT_MS) {
        done.current({ timedOut: true });
        return;
      }
      const res = await fetch(
        `/api/meet/${encodeURIComponent(slug)}/chat/answer?id=${encodeURIComponent(questionId)}`,
      ).catch(() => null);
      const json = (await res?.json().catch(() => null)) as {
        ok?: boolean;
        status?: 'pending' | 'answered' | 'expired';
        answer?: string | null;
      } | null;
      if (stopped) return;
      if (json?.ok && json.status === 'answered' && json.answer) {
        done.current({ answer: json.answer });
        return;
      }
      if ((json?.ok && json.status === 'expired') || res?.status === 404) {
        done.current({ timedOut: true });
        return;
      }
      timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    timer = window.setTimeout(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [slug, questionId, startedAt]);
  return null;
}

function DoneCard({ done }: { done: Done }) {
  return (
    <div
      className="w-full rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-3.5"
      data-booking-status={done.status}
    >
      <p className="flex items-center gap-2 text-sm font-semibold">
        <CalendarCheck2 className="size-4 text-[var(--accent)]" aria-hidden="true" />
        {done.title}
      </p>
      {done.lines.map((line) => (
        <p key={line} className="mt-1 text-sm text-[var(--fg-muted)]">
          {line}
        </p>
      ))}
      {done.manageUrl ? (
        <a
          href={done.manageUrl}
          className="mt-2 inline-block text-sm text-[var(--accent)] underline decoration-[color:var(--link-underline)] underline-offset-4"
        >
          Reschedule or cancel
        </a>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- steps */

function StepPanel({
  step,
  start,
  slug,
  zone,
  firstName: first,
  onCall,
  onInPerson,
  onQuestion,
  onMessage,
  onKind,
  onPlace,
  onStartOver,
  onBooked,
  onTaken,
}: {
  step: Step;
  start: ChatStart;
  slug: string;
  zone: string;
  firstName: string;
  onCall: () => void;
  onInPerson: () => void;
  onQuestion: () => void;
  onMessage: () => void;
  onKind: (kind: MeetingKind) => void;
  onPlace: (query: Query, slot: ChatSlot, place: ChatPlace | null, custom?: string) => void;
  onStartOver: () => void;
  onBooked: (done: Done) => void;
  onTaken: (query: Query, message: string) => void;
}) {
  const [custom, setCustom] = React.useState('');
  const uid = React.useId();
  if (step.kind === 'none') {
    return (
      <div className="flex flex-wrap gap-1.5 pt-1">
        <Chip onClick={onStartOver}>Start over</Chip>
      </div>
    );
  }
  if (step.kind === 'menu') {
    return (
      <div
        className="flex flex-wrap gap-1.5 pt-1"
        role="group"
        aria-label="What would you like to do?"
      >
        <Chip onClick={onCall} icon={<Video className="size-3.5" aria-hidden="true" />}>
          Book a 30-min call
        </Chip>
        {start.offers.inPerson ? (
          <Chip onClick={onInPerson} icon={<Coffee className="size-3.5" aria-hidden="true" />}>
            Meet in person
          </Chip>
        ) : null}
        <Chip onClick={onQuestion} icon={<HelpCircle className="size-3.5" aria-hidden="true" />}>
          Ask a question
        </Chip>
        <Chip onClick={onMessage} icon={<MessageSquare className="size-3.5" aria-hidden="true" />}>
          Leave a message or deck
        </Chip>
      </div>
    );
  }
  if (step.kind === 'kinds') {
    return (
      <div
        className="flex flex-wrap gap-1.5 pt-1"
        role="group"
        aria-label="Coffee, lunch or dinner?"
      >
        {start.kinds.map((k) => (
          <Chip key={k} onClick={() => onKind(k)}>
            {KIND_LABEL[k]}
          </Chip>
        ))}
        <Chip onClick={onStartOver}>Start over</Chip>
      </div>
    );
  }
  if (step.kind === 'place') {
    return (
      <div className="space-y-2 pt-1">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Places">
          {start.places.map((p) => (
            <Chip key={p.id} onClick={() => onPlace(step.query, step.slot, p)}>
              {p.name}
              {p.area ? <span className="text-[var(--fg-subtle)]"> · {p.area}</span> : null}
            </Chip>
          ))}
        </div>
        {start.allowCustomPlace ? (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const value = custom.trim();
              if (value) onPlace(step.query, step.slot, null, value.slice(0, LIMITS.customPlace));
            }}
          >
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor={`${uid}-custom`} className="text-xs">
                Or suggest a place
              </Label>
              <Input
                id={`${uid}-custom`}
                value={custom}
                maxLength={LIMITS.customPlace}
                onChange={(e) => setCustom(e.target.value)}
              />
            </div>
            <Button type="submit" size="md" disabled={!custom.trim()}>
              Use this place
            </Button>
          </form>
        ) : null}
        <Chip onClick={onStartOver}>Start over</Chip>
      </div>
    );
  }
  if (step.kind === 'details' || step.kind === 'message') {
    return (
      <DetailsForm
        key={
          step.kind === 'details'
            ? `${step.slot.start}:${step.placeId}:${step.customPlace}`
            : `m:${step.note}`
        }
        step={step}
        start={start}
        slug={slug}
        zone={zone}
        firstName={first}
        onStartOver={onStartOver}
        onBooked={onBooked}
        onTaken={onTaken}
      />
    );
  }
  return null;
}

function DetailsForm({
  step,
  start,
  slug,
  zone,
  firstName: first,
  onStartOver,
  onBooked,
  onTaken,
}: {
  step: Extract<Step, { kind: 'details' } | { kind: 'message' }>;
  start: ChatStart;
  slug: string;
  zone: string;
  firstName: string;
  onStartOver: () => void;
  onBooked: (done: Done) => void;
  onTaken: (query: Query, message: string) => void;
}) {
  const isMessage = step.kind === 'message';
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [company, setCompany] = React.useState('');
  const [note, setNote] = React.useState(isMessage ? step.note : '');
  const [deckUrl, setDeckUrl] = React.useState('');
  const [guests, setGuests] = React.useState<string[]>([]);
  const [website, setWebsite] = React.useState('');
  const [problem, setProblem] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const uid = React.useId();
  const canAddGuest = !isMessage && start.guests.allowed && guests.length < start.guests.max;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (sending) return;
    setProblem(null);
    if (!name.trim()) return setProblem('Add your name.');
    const mail = EMAIL_INPUT.safeParse(email);
    if (!mail.success) return setProblem('Check your email address.');
    if (isMessage && !note.trim() && !deckUrl.trim()) return setProblem('Write your message.');
    if (deckUrl.trim() && !DECK_URL.safeParse(deckUrl).success) {
      return setProblem('Use a deck link that starts with https://');
    }
    const cleanGuests: string[] = [];
    for (const raw of guests) {
      if (!raw.trim()) continue;
      const g = EMAIL_INPUT.safeParse(raw);
      if (!g.success) return setProblem(`Check the guest address ${raw.trim()}.`);
      if (g.data !== mail.data && !cleanGuests.includes(g.data)) cleanGuests.push(g.data);
    }
    setSending(true);
    const body: Record<string, unknown> = {
      name: name.trim(),
      email: mail.data,
      company: company.trim(),
      type: isMessage ? 'message' : step.query.type,
      kind: !isMessage && step.query.type === 'in_person' ? step.query.kind : null,
      start: isMessage ? null : step.slot.start,
      placeId: !isMessage && step.query.type === 'in_person' ? step.placeId : null,
      customPlace:
        !isMessage && step.query.type === 'in_person' && !step.placeId ? step.customPlace : '',
      note: note.trim(),
      deckUrl: deckUrl.trim(),
      timeZone: zone,
      source: 'chatbot',
      website,
    };
    if (cleanGuests.length) body.guests = cleanGuests;
    const res = await fetch(`/api/meet/${encodeURIComponent(slug)}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    setSending(false);
    const json = (await res?.json().catch(() => null)) as {
      ok?: boolean;
      status?: BookingStatus;
      manageUrl?: string;
      error?: { code?: string; message?: string };
    } | null;
    if (!res?.ok || !json?.ok) {
      if (!isMessage && json?.error?.code === 'conflict') {
        onTaken(step.query, 'That time was just taken. Here are the next open times.');
        return;
      }
      setProblem(json?.error?.message ?? 'That did not go through. Try again.');
      return;
    }
    const status: BookingStatus =
      json.status && ['booked', 'held', 'pending', 'message'].includes(json.status)
        ? json.status
        : isMessage
          ? 'message'
          : 'pending';
    onBooked(
      doneFor(status, step, start, mail.data, cleanGuests, first, safeManageUrl(json.manageUrl)),
    );
  };

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-3"
      aria-label={isMessage ? 'Your message' : 'Your details'}
    >
      <div className="grid gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${uid}-name`} className="text-xs">
            Name
          </Label>
          <Input
            id={`${uid}-name`}
            value={name}
            maxLength={LIMITS.name}
            autoComplete="name"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${uid}-email`} className="text-xs">
            Email
          </Label>
          <Input
            id={`${uid}-email`}
            type="email"
            value={email}
            maxLength={LIMITS.email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${uid}-company`} className="text-xs">
            Company (optional)
          </Label>
          <Input
            id={`${uid}-company`}
            value={company}
            maxLength={LIMITS.company}
            autoComplete="organization"
            onChange={(e) => setCompany(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${uid}-note`} className="text-xs">
            {isMessage ? `Message for ${first}` : 'What would you like to talk about? (optional)'}
          </Label>
          <Textarea
            id={`${uid}-note`}
            value={note}
            maxLength={LIMITS.note}
            className="min-h-16"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {isMessage ? (
          <div className="space-y-1">
            <Label htmlFor={`${uid}-deck`} className="text-xs">
              Deck link (optional)
            </Label>
            <Input
              id={`${uid}-deck`}
              type="url"
              inputMode="url"
              value={deckUrl}
              maxLength={LIMITS.deckUrl}
              placeholder="https://"
              onChange={(e) => setDeckUrl(e.target.value)}
            />
          </div>
        ) : null}
        {!isMessage && start.guests.allowed ? (
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium">Guests (optional)</legend>
            {guests.map((g, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Label htmlFor={`${uid}-guest-${i}`} className="sr-only">
                  Guest {i + 1} email
                </Label>
                <Input
                  id={`${uid}-guest-${i}`}
                  type="email"
                  value={g}
                  maxLength={LIMITS.email}
                  placeholder="name@company.com"
                  onChange={(e) =>
                    setGuests((list) => list.map((v, j) => (j === i ? e.target.value : v)))
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove guest ${i + 1}`}
                  onClick={() => setGuests((list) => list.filter((_, j) => j !== i))}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            ))}
            {canAddGuest ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="px-0"
                onClick={() => setGuests((list) => [...list, ''])}
              >
                <Plus aria-hidden="true" />
                Add guest
              </Button>
            ) : null}
          </fieldset>
        ) : null}
        <div className="sr-only" aria-hidden="true">
          <label htmlFor={`${uid}-website`}>Website</label>
          <input
            id={`${uid}-website`}
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </div>
      </div>
      {problem ? (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" loading={sending}>
          {isMessage ? 'Send message' : `Book ${step.slot.label}`}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onStartOver}>
          Start over
        </Button>
      </div>
    </form>
  );
}

function doneFor(
  status: BookingStatus,
  step: Extract<Step, { kind: 'details' } | { kind: 'message' }>,
  start: ChatStart,
  email: string,
  guests: string[],
  first: string,
  manageUrl: string | null,
): Done {
  if (step.kind === 'message') {
    return {
      status: 'message',
      title: `Your message is on its way to ${first}.`,
      lines: [],
      manageUrl: null,
    };
  }
  const place = step.placeId
    ? start.places.find((p) => p.id === step.placeId)?.name
    : step.customPlace || null;
  const summary = `${meetingLabel(step.query, start.callLabel)} · ${step.slot.label}${place ? ` · ${place}` : ''}`;
  const invited = guests.length
    ? `${email} and ${guests.length} guest${guests.length === 1 ? '' : 's'}`
    : email;
  if (status === 'booked') {
    return {
      status,
      title: 'You’re booked.',
      lines: [summary, `The calendar invitation is on its way to ${invited}.`],
      manageUrl,
    };
  }
  if (status === 'held') {
    return {
      status,
      title: 'Your time is held. The calendar invitation is on its way.',
      lines: [summary],
      manageUrl,
    };
  }
  return {
    status,
    title: 'Your request is in.',
    lines: [summary, `The calendar invitation goes to ${invited} once the time is set.`],
    manageUrl,
  };
}
