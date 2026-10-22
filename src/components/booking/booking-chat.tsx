'use client';

import * as React from 'react';
import { MessageCircle, Send, X } from 'lucide-react';
import { AiTag } from '@/components/ask/ai-tag';
import { Button } from '@/components/ui/button';
import { KIND_LABEL, firstName, type MeetingKind, type MeetingType } from '@/lib/booking/config';
import type { ChatFormFill } from '@/lib/booking/request';
import { cn } from '@/lib/util/cn';

/**
 * The booking page's chatbot, "Arwin", the host's AI scheduling assistant
 * (an AI, and tagged so). Live, it answers in words; guided (no model, or
 * past its cap), it is three buttons. Either way it can only offer open
 * times, read the public FAQ, and fill the form: a tap on a time or a fill
 * puts it in the form, and the visitor presses Send there.
 */

interface ChatSlot {
  start: string;
  end: string;
  label: string;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  slots?: ChatSlot[];
  /** The kind the slots are for, so a tap fills the right meeting. */
  query?: { type: MeetingType; kind: MeetingKind | null };
}

interface Reply {
  mode: 'live' | 'guided';
  reply: string;
  slots: ChatSlot[];
  query?: Turn['query'];
  fill: ChatFormFill | null;
  notice?: string;
}

export function BookingChat({
  slug,
  mode: initialMode,
  hostName,
  firmName,
  kinds,
  zone,
  onFill,
}: {
  slug: string;
  mode: 'live' | 'guided';
  hostName: string;
  firmName: string;
  kinds: MeetingKind[];
  zone: string;
  onFill: (fill: ChatFormFill) => void;
}) {
  const first = firstName(hostName) || 'the host';
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState(initialMode);
  const [turns, setTurns] = React.useState<Turn[]>([
    {
      role: 'assistant',
      content: `Hi, I'm Arwin, ${first}'s AI scheduling assistant. I can find a time, tell you about ${firmName || 'the firm'}, or take a message.`,
    },
  ]);
  const [picking, setPicking] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const uid = React.useId();

  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns, picking, open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const ask = async (
    body: Record<string, unknown>,
    shown: Turn | null,
    query?: Turn['query'],
  ): Promise<void> => {
    if (busy) return;
    const history = shown ? [...turns, shown] : turns;
    if (shown) setTurns(history);
    setBusy(true);
    const res = await fetch(`/api/meet/${encodeURIComponent(slug)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeZone: zone, ...body }),
    }).catch(() => null);
    setBusy(false);
    const json = (await res?.json().catch(() => null)) as
      (Reply & { ok: boolean; error?: { message?: string } }) | null;
    if (!res?.ok || !json?.ok) {
      setTurns((t) => [
        ...t,
        {
          role: 'assistant',
          content: json?.error?.message ?? 'Something went wrong. You can still use the form.',
        },
      ]);
      return;
    }
    setMode(json.mode);
    if (json.fill) onFill(json.fill);
    setTurns((t) => [
      ...t,
      ...(json.notice ? [{ role: 'assistant' as const, content: json.notice }] : []),
      {
        role: 'assistant',
        content: json.reply,
        slots: json.slots,
        query: json.query ?? query ?? inferQuery(json.fill),
      },
    ]);
  };

  const findTime = (type: MeetingType, kind: MeetingKind | null) => {
    setPicking(false);
    const label = type === 'call' ? 'A 30-minute call' : `${KIND_LABEL[kind!]} in person`;
    void ask(
      { mode: 'guided', action: 'find_time', type, ...(kind ? { kind } : {}) },
      { role: 'user', content: label },
      { type, kind },
    );
  };

  const sendText = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    const shown: Turn = { role: 'user', content: text.slice(0, 600) };
    const messages = [...turns, shown]
      .filter((t, i) => i > 0)
      .slice(-12)
      .map((t) => ({ role: t.role, content: t.content.slice(0, 600) }));
    void ask({ mode: 'live', messages }, shown);
  };

  const tapSlot = (slot: ChatSlot, query: Turn['query']) => {
    onFill({
      type: query?.type ?? 'call',
      ...(query?.kind ? { kind: query.kind } : {}),
      start: slot.start,
    });
    setTurns((t) => [
      ...t,
      {
        role: 'assistant',
        content: `I put ${slot.label} in the form. Add your name and email there, then press Send request.`,
      },
    ]);
  };

  return (
    <>
      {!open ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            window.setTimeout(() => inputRef.current?.focus(), 50);
          }}
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
          className="shadow-overlay fixed inset-0 z-[var(--z-overlay)] flex flex-col bg-[var(--bg-overlay)] sm:inset-auto sm:right-4 sm:bottom-4 sm:h-[min(36rem,calc(100dvh-2rem))] sm:w-[24rem] sm:rounded-[var(--radius-panel)] sm:border sm:border-[var(--border)]"
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

          <div
            ref={listRef}
            className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
            aria-live="polite"
          >
            {turns.map((turn, i) => (
              <div
                key={i}
                className={cn('flex flex-col', turn.role === 'user' ? 'items-end' : 'items-start')}
              >
                <p
                  className={cn(
                    'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-line',
                    turn.role === 'user'
                      ? 'rounded-br-sm bg-[var(--primary)] text-[var(--primary-fg)]'
                      : 'rounded-bl-sm border border-[var(--border)] bg-[var(--bg-raised)]',
                  )}
                >
                  {turn.content}
                </p>
                {turn.slots?.length ? (
                  <div
                    className="mt-2 flex max-w-full flex-wrap gap-1.5"
                    role="group"
                    aria-label="Open times"
                  >
                    {turn.slots.map((slot) => (
                      <button
                        key={slot.start}
                        type="button"
                        onClick={() => tapSlot(slot, turn.query)}
                        className="min-h-9 rounded-full border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-xs font-medium hover:border-[var(--primary)] hover:bg-[var(--accent-soft)]"
                      >
                        {slot.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
            {busy ? <p className="text-xs text-[var(--fg-subtle)]">Arwin is looking…</p> : null}
          </div>

          <div className="space-y-2 border-t border-[var(--border)] px-4 py-3">
            {picking ? (
              <div
                className="flex flex-wrap gap-1.5"
                role="group"
                aria-label="What kind of meeting?"
              >
                <QuickButton onClick={() => findTime('call', null)}>30-minute call</QuickButton>
                {kinds.map((k) => (
                  <QuickButton key={k} onClick={() => findTime('in_person', k)}>
                    {KIND_LABEL[k]}
                  </QuickButton>
                ))}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick answers">
                <QuickButton onClick={() => setPicking(true)}>Find a time</QuickButton>
                <QuickButton
                  onClick={() =>
                    void ask(
                      { mode: 'guided', action: 'about' },
                      { role: 'user', content: `About ${firmName || 'the firm'}` },
                    )
                  }
                >
                  About {firmName || 'the firm'}
                </QuickButton>
                <QuickButton
                  onClick={() =>
                    void ask(
                      { mode: 'guided', action: 'message' },
                      { role: 'user', content: 'Leave a message' },
                    )
                  }
                >
                  Leave a message
                </QuickButton>
              </div>
            )}
            {mode === 'live' ? (
              <form onSubmit={sendText} className="flex items-end gap-2">
                <label htmlFor={`${uid}-input`} className="sr-only">
                  Message Arwin
                </label>
                <textarea
                  id={`${uid}-input`}
                  ref={inputRef}
                  rows={1}
                  maxLength={600}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Ask about a time, or the firm"
                  className="max-h-28 min-h-10 flex-1 resize-none rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] px-3 py-2 text-sm"
                />
                <Button
                  type="submit"
                  variant="primary"
                  size="icon"
                  aria-label="Send to Arwin"
                  disabled={busy}
                >
                  <Send aria-hidden="true" />
                </Button>
              </form>
            ) : null}
            <p className="text-[11px] leading-snug text-[var(--fg-subtle)]">
              Arwin is an AI assistant. It sees only open times, never what is on {first}&apos;s
              calendar, and it never sends anything: you press Send.
            </p>
          </div>
        </section>
      ) : null}
    </>
  );
}

function inferQuery(fill: ChatFormFill | null): Turn['query'] | undefined {
  if (!fill?.type || fill.type === 'message') return undefined;
  return { type: fill.type, kind: fill.kind ?? null };
}

function QuickButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-9 rounded-full border border-[var(--border-strong)] bg-[var(--bg-raised)] px-3 text-xs font-medium hover:bg-[var(--bg-hover)]"
    >
      {children}
    </button>
  );
}
