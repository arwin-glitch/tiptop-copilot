'use client';

import * as React from 'react';

/**
 * "Ask Arwin" on the public job board: a floating button (bottom right) that
 * opens a small chat. Answers come from /api/jobs-board/ask (the published
 * roles, then the written answers, then, only when switched on, the jobs
 * assistant routine, which this widget polls for). Everything it shows is
 * rendered as plain text: the visitor's words and every answer are React
 * text, never HTML, and only the board's own links (paths starting "/") are
 * ever linked.
 *
 * Accessible: the button says whether the chat is open; the open chat is a
 * labelled dialog that closes on Esc (focus goes back to the button) and
 * reads answers out through a polite live region. On a phone it is a modal
 * bottom sheet over a backdrop (tap it to close) that keeps focus inside
 * it, and the button sits above a role page's Apply bar. From 640px wide it
 * is a non-modal popover: the page behind stays usable, so it is not
 * announced as modal and Tab can leave it. Motion follows
 * prefers-reduced-motion (ask.css).
 */

const ASK_URL = '/api/jobs-board/ask';
const POLL_MS = 4_000;
/** Polls before giving up: three minutes' worth. */
const MAX_POLLS = (3 * 60_000) / POLL_MS;
const MAX_CHARS = 300;

interface Link {
  label: string;
  detail: string | null;
  href: string;
}

type Reply =
  | {
      kind: 'answer';
      source: 'board' | 'written';
      text: string;
      links: Link[];
      seeAll: Link | null;
      suggestions: string[];
    }
  | { kind: 'pending'; questionId: string; text: string; suggestions: string[] }
  | { kind: 'none'; text: string; suggestions: string[] };

interface Message {
  id: number;
  from: 'visitor' | 'arwin';
  text: string;
  links?: Link[];
  seeAll?: Link | null;
  /** Waiting on the routine: shows a "looking into it" line until it answers. */
  waiting?: boolean;
}

const FALLBACK =
  "I don't have an answer for that one. Try the filters, or ask about a team, place or company.";

/** A board path only: "/acme/engineer-1a2b" or "/jobs?fn=engineering", never another site. */
function safeHref(href: unknown): string | null {
  return typeof href === 'string' && href.startsWith('/') && !href.startsWith('//') ? href : null;
}

function cleanLinks(raw: unknown): Link[] {
  if (!Array.isArray(raw)) return [];
  const out: Link[] = [];
  for (const item of raw.slice(0, 5)) {
    const link = item as Partial<Link> | null;
    const href = safeHref(link?.href);
    if (!href || typeof link?.label !== 'string') continue;
    out.push({
      label: link.label.slice(0, 160),
      detail: typeof link.detail === 'string' ? link.detail.slice(0, 160) : null,
      href,
    });
  }
  return out;
}

function newSessionId(): string {
  const bytes = new Uint8Array(12);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Below this width the chat is a modal bottom sheet with a backdrop (ask.css). */
const SHEET_QUERY = '(max-width: 639px)';

function subscribeSheet(onChange: () => void): () => void {
  const query = window.matchMedia?.(SHEET_QUERY);
  if (!query) return () => undefined;
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

const isSheet = () => window.matchMedia?.(SHEET_QUERY).matches ?? false;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AskArwin({ greeting, chips }: { greeting: string; chips: string[] }) {
  const [open, setOpen] = React.useState(false);
  const [messages, setMessages] = React.useState<Message[]>(() => [
    { id: 0, from: 'arwin', text: greeting },
  ]);
  const [suggestions, setSuggestions] = React.useState<string[]>(chips);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const nextId = React.useRef(1);
  const session = React.useRef<string | null>(null);
  const polls = React.useRef(new Set<number>());
  const panelRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const logRef = React.useRef<HTMLDivElement>(null);
  // A modal bottom sheet on a phone; a non-modal popover on a wider screen.
  const sheet = React.useSyncExternalStore(subscribeSheet, isSheet, () => false);
  const titleId = React.useId();
  const panelId = React.useId();

  const close = React.useCallback(() => {
    setOpen(false);
    window.setTimeout(() => buttonRef.current?.focus(), 0);
  }, []);

  React.useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Esc closes from anywhere on the page while the chat is open.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  React.useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages, open]);

  React.useEffect(() => {
    const timers = polls.current;
    return () => {
      for (const t of timers) window.clearTimeout(t);
      timers.clear();
    };
  }, []);

  const push = (message: Omit<Message, 'id'>): number => {
    const id = nextId.current++;
    setMessages((list) => [...list.slice(-40), { ...message, id }]);
    return id;
  };

  const settle = (id: number, patch: Partial<Message>) =>
    setMessages((list) => list.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  const poll = (messageId: number, questionId: string, attempt = 1) => {
    const timer = window.setTimeout(async () => {
      polls.current.delete(timer);
      let status = 'pending';
      let answer: string | null = null;
      try {
        const response = await fetch(`${ASK_URL}/answer?id=${encodeURIComponent(questionId)}`, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        const body = (await response.json()) as { ok?: boolean; status?: string; answer?: unknown };
        if (!body.ok) status = 'expired';
        else {
          status = body.status ?? 'pending';
          answer = typeof body.answer === 'string' ? body.answer.slice(0, 600) : null;
        }
      } catch {
        // A dropped poll is retried until the wait runs out.
      }
      if (status === 'answered' && answer) {
        settle(messageId, { text: answer, waiting: false });
      } else if (status === 'pending' && attempt < MAX_POLLS) {
        poll(messageId, questionId, attempt + 1);
      } else {
        settle(messageId, { text: FALLBACK, waiting: false });
      }
    }, POLL_MS);
    polls.current.add(timer);
  };

  const ask = async (raw: string) => {
    const question = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    if (!question || busy) return;
    setDraft('');
    setBusy(true);
    push({ from: 'visitor', text: question });
    session.current ??= newSessionId();
    try {
      const response = await fetch(ASK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ question, sessionId: session.current }),
        cache: 'no-store',
      });
      const body = (await response.json()) as {
        ok?: boolean;
        reply?: Reply;
        error?: { message?: string };
      };
      const reply = body.ok ? body.reply : undefined;
      if (!reply) {
        push({
          from: 'arwin',
          text:
            response.status === 429
              ? 'That was a lot of questions. Try again in a minute.'
              : "I can't answer right now. Try the filters on the board.",
        });
      } else if (reply.kind === 'pending') {
        const id = push({ from: 'arwin', text: String(reply.text).slice(0, 300), waiting: true });
        poll(id, reply.questionId);
      } else if (reply.kind === 'answer') {
        push({
          from: 'arwin',
          text: String(reply.text).slice(0, 800),
          links: cleanLinks(reply.links),
          seeAll: cleanLinks(reply.seeAll ? [reply.seeAll] : [])[0] ?? null,
        });
      } else {
        push({ from: 'arwin', text: String(reply.text || FALLBACK).slice(0, 300) });
      }
      const next = Array.isArray(reply?.suggestions)
        ? reply.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [];
      setSuggestions(next.length > 0 ? next.map((s) => s.slice(0, 80)) : chips);
    } catch {
      push({ from: 'arwin', text: "I can't answer right now. Try the filters on the board." });
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    // Focus is kept inside only while the chat is modal (the phone sheet).
    if (event.key !== 'Tab' || !sheet) return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="jb-ask" data-open={open ? 'true' : 'false'}>
      {open ? <div className="jb-ask-backdrop" aria-hidden="true" onClick={close} /> : null}
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          className="jb-ask-panel"
          role="dialog"
          aria-modal={sheet ? 'true' : undefined}
          aria-labelledby={titleId}
          onKeyDown={onKeyDown}
        >
          <div className="jb-ask-head">
            <span className="jb-ask-avatar" aria-hidden="true">
              A
            </span>
            <div className="jb-ask-head-text">
              <h2 id={titleId}>Ask Arwin</h2>
              <p>TipTop&rsquo;s AI assistant for this job board</p>
            </div>
            <button type="button" className="jb-ask-close" onClick={close} aria-label="Close chat">
              <CloseIcon />
            </button>
          </div>
          <div
            ref={logRef}
            className="jb-ask-log"
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            aria-label="Conversation with Arwin"
            tabIndex={0}
          >
            {messages.map((m) => (
              <div key={m.id} className={`jb-ask-msg jb-ask-msg-${m.from}`}>
                <span className="jb-sr">{m.from === 'arwin' ? 'Arwin: ' : 'You: '}</span>
                <p>{m.text}</p>
                {m.waiting ? (
                  <p className="jb-ask-waiting" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </p>
                ) : null}
                {m.links && m.links.length > 0 ? (
                  <ul className="jb-ask-links">
                    {m.links.map((link) => (
                      <li key={link.href}>
                        <a href={link.href}>
                          <span className="jb-ask-link-title">{link.label}</span>
                          {link.detail ? (
                            <span className="jb-ask-link-detail">{link.detail}</span>
                          ) : null}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {m.seeAll ? (
                  <a className="jb-ask-see-all" href={m.seeAll.href}>
                    {m.seeAll.label} <span aria-hidden="true">→</span>
                  </a>
                ) : null}
              </div>
            ))}
          </div>
          {suggestions.length > 0 ? (
            <div className="jb-ask-chips" aria-label="Suggested questions" role="group">
              {suggestions.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className="jb-ask-chip"
                  disabled={busy}
                  onClick={() => void ask(chip)}
                >
                  {chip}
                </button>
              ))}
            </div>
          ) : null}
          <form
            className="jb-ask-form"
            onSubmit={(event) => {
              event.preventDefault();
              void ask(draft);
            }}
          >
            <label htmlFor={`${panelId}-q`} className="jb-sr">
              Your question
            </label>
            <input
              ref={inputRef}
              id={`${panelId}-q`}
              className="jb-ask-input"
              value={draft}
              maxLength={MAX_CHARS}
              autoComplete="off"
              placeholder="Ask about roles, teams or places"
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              type="submit"
              className="jb-ask-send"
              disabled={busy || !draft.trim()}
              aria-label="Send question"
            >
              <SendIcon />
            </button>
          </form>
        </div>
      ) : null}
      <button
        ref={buttonRef}
        type="button"
        className="jb-ask-bubble"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        onClick={() => (open ? close() : setOpen(true))}
      >
        {open ? <CloseIcon /> : <ChatIcon />}
        <span className="jb-ask-bubble-label">{open ? 'Close' : 'Ask Arwin'}</span>
      </button>
    </div>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6a.5.5 0 0 1-.8-.4V16h0a2.5 2.5 0 0 1-1-2V5.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M4 12h14M13 6l6 6-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
