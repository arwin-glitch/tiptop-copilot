'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Keyboard,
  Loader2,
  Mic,
  MessageCircleMore,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { askFromWidgetAction } from '@/app/actions/ask';
import { openAskWidget, watchAskReply } from '@/components/ask/ask-events';
import { openSearch } from '@/components/shell/search-events';
import type { ChatMessage } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';
import { spokenText, voiceIntent } from '@/lib/voice/intent';
import {
  BrowserSpeechUnavailable,
  canListen,
  preferredListener,
  startListening,
  type Listener,
  type ListenerKind,
} from '@/lib/voice/listener';
import {
  canSpeak,
  setSpeakingEnabled,
  speak,
  speakingEnabled,
  stopSpeaking,
  warmVoices,
} from '@/lib/voice/speaker';

/**
 * Voice Arwin: talk to Kraken. Click the mic (or press Ctrl+Shift+Space),
 * say what you want, and Arwin does it and answers out loud:
 *
 * - "Open my inbox", "take me to Tasks, Snoozed": opens the page at once.
 * - "Find Acme", "pull up Jane Doe": opens search with it typed in.
 * - Anything else ("what's on today?", "draft a reply to Bob"): asked in the
 *   Ask Arwin chat, and the answer is read aloud when it lands.
 *
 * Speech is heard and spoken on this computer for free (listener.ts,
 * speaker.ts); the only thing sent anywhere is the question text, the same
 * as typing it into the chat.
 */

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Turn {
  heard: string;
  reply: string;
  threadId: string | null;
  /** Still waiting on the answer from the Ask bridge. */
  waiting: boolean;
}

/** A spoken follow-up within this long continues the same chat. */
const FOLLOW_UP_MS = 10 * 60_000;
const POLL_MS = 3_000;
const POLL_FOR_MS = 5 * 60_000;

export function VoiceArwin({ aiAvailable }: { aiAvailable: boolean }) {
  const router = useRouter();
  const supported = React.useSyncExternalStore(noSubscribe, canListen, serverFalse);
  const [phase, setPhaseState] = React.useState<Phase>('idle');
  const [show, setShow] = React.useState(false);
  const [partial, setPartial] = React.useState('');
  const [status, setStatus] = React.useState<string | null>(null);
  const [level, setLevel] = React.useState(0);
  const [turn, setTurn] = React.useState<Turn | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [voiceOn, setVoiceOn] = React.useState(() =>
    typeof window === 'undefined' ? true : speakingEnabled(),
  );
  const [typing, setTyping] = React.useState(false);
  const [typed, setTyped] = React.useState('');

  const listener = React.useRef<Listener | null>(null);
  const kind = React.useRef<ListenerKind>('browser');
  const conversation = React.useRef<{ threadId: string; at: number } | null>(null);
  const pollToken = React.useRef(0);
  const phaseRef = React.useRef<Phase>('idle');
  const setPhase = React.useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const listenAgain = React.useRef<((using: ListenerKind) => void) | null>(null);

  React.useEffect(() => {
    kind.current = preferredListener();
    warmVoices();
  }, []);

  const say = React.useCallback(
    async (text: string) => {
      if (!text) return;
      setPhase('speaking');
      await speak(text);
      if (phaseRef.current === 'speaking') setPhase('idle');
    },
    [setPhase],
  );

  /* ------------------------------------------------------- the answer */

  const waitForAnswer = React.useCallback(
    async (threadId: string, heard: string) => {
      const token = ++pollToken.current;
      const started = Date.now();
      while (Date.now() - started < POLL_FOR_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (token !== pollToken.current) return;
        let body = null as { ok?: boolean; messages?: ChatMessage[] } | null;
        try {
          const res = await fetch(`/api/ask/thread?id=${encodeURIComponent(threadId)}`, {
            cache: 'no-store',
          });
          body = (await res.json().catch(() => null)) as typeof body;
        } catch {
          continue;
        }
        if (token !== pollToken.current) return;
        const last = body?.messages?.[body.messages.length - 1];
        if (!last || last.role !== 'assistant' || last.status === 'pending') continue;
        setTurn({ heard, reply: last.content, threadId, waiting: false });
        setShow(true);
        // Heard here, so the chat bubble need not announce it again.
        watchAskReply({ threadId, watching: false, answerId: last.id });
        await say(spokenText(last.content));
        return;
      }
      if (token === pollToken.current) {
        setTurn((t) =>
          t
            ? {
                ...t,
                waiting: false,
                reply: 'Still working on it. I’ll ping you in the chat when it’s ready.',
              }
            : t,
        );
      }
    },
    [say],
  );

  const ask = React.useCallback(
    async (question: string) => {
      if (!aiAvailable) {
        setTurn({
          heard: question,
          reply: 'Ask Arwin isn’t switched on for this account yet.',
          threadId: null,
          waiting: false,
        });
        await say('Ask Arwin isn’t switched on for this account yet.');
        return;
      }
      setPhase('thinking');
      const recent = conversation.current;
      const threadId =
        recent && Date.now() - recent.at < FOLLOW_UP_MS ? recent.threadId : undefined;
      let result: Awaited<ReturnType<typeof askFromWidgetAction>>;
      try {
        result = await askFromWidgetAction(question, { threadId });
      } catch {
        result = {
          ok: false,
          error: { code: 'internal', message: 'That question could not be sent.' },
        };
      }
      if (!result.ok || !result.data) {
        const message = result.error?.message ?? 'That question could not be sent.';
        setTurn({ heard: question, reply: message, threadId: null, waiting: false });
        await say(message);
        return;
      }
      const data = result.data;
      conversation.current = { threadId: data.threadId, at: Date.now() };
      const last = data.messages[data.messages.length - 1];
      if (last && last.role === 'assistant' && last.status !== 'pending') {
        setTurn({ heard: question, reply: last.content, threadId: data.threadId, waiting: false });
        await say(spokenText(last.content));
        return;
      }
      // The answer comes from the Ask bridge in a moment: say so, then read it out.
      watchAskReply({ threadId: data.threadId, watching: true });
      setTurn({ heard: question, reply: '', threadId: data.threadId, waiting: true });
      await say('On it.');
      void waitForAnswer(data.threadId, question);
    },
    [aiAvailable, say, setPhase, waitForAnswer],
  );

  const act = React.useCallback(
    async (heard: string) => {
      setError(null);
      const intent = voiceIntent(heard);
      switch (intent.kind) {
        case 'empty':
          setPhase('idle');
          setTurn(null);
          setError('I didn’t catch anything. Click the mic and try again.');
          return;
        case 'stop':
          pollToken.current++;
          stopSpeaking();
          setPhase('idle');
          setShow(false);
          return;
        case 'navigate':
          setTurn({ heard, reply: intent.reply, threadId: null, waiting: false });
          if (intent.match.href) router.push(intent.match.href);
          await say(intent.reply);
          return;
        case 'search':
          setTurn({ heard, reply: intent.reply, threadId: null, waiting: false });
          openSearch(intent.query);
          await say(intent.reply);
          return;
        case 'ask':
          setTurn({ heard, reply: '', threadId: null, waiting: true });
          await ask(intent.question);
          return;
      }
    },
    [ask, router, say, setPhase],
  );

  /* ---------------------------------------------------------- listening */

  const listen = React.useCallback(
    (using: ListenerKind = kind.current) => {
      stopSpeaking();
      pollToken.current++;
      listener.current?.cancel();
      setShow(true);
      setTyping(false);
      setError(null);
      setPartial('');
      setStatus(null);
      setTurn(null);
      setPhase('listening');
      const l = startListening(
        {
          onPartial: setPartial,
          onLevel: setLevel,
          onStatus: setStatus,
        },
        using,
      );
      listener.current = l;
      l.result.then(
        (text) => {
          if (listener.current !== l) return;
          listener.current = null;
          setLevel(0);
          setStatus(null);
          if (phaseRef.current !== 'listening') return;
          void act(text);
        },
        (err: unknown) => {
          if (listener.current !== l) return;
          listener.current = null;
          setLevel(0);
          setStatus(null);
          // The browser's speech service is missing here: use Whisper from now on.
          if (err instanceof BrowserSpeechUnavailable && using === 'browser') {
            kind.current = 'whisper';
            listenAgain.current?.('whisper');
            return;
          }
          setPhase('idle');
          setError(err instanceof Error ? err.message : 'The microphone could not start.');
        },
      );
    },
    [act, setPhase],
  );
  React.useEffect(() => {
    listenAgain.current = listen;
  }, [listen]);

  const stopListening = React.useCallback(() => {
    listener.current?.stop();
  }, []);

  const toggle = React.useCallback(() => {
    if (phaseRef.current === 'listening') stopListening();
    else listen();
  }, [listen, stopListening]);

  const close = React.useCallback(() => {
    listener.current?.cancel();
    listener.current = null;
    pollToken.current++;
    stopSpeaking();
    setPhase('idle');
    setShow(false);
    setTyping(false);
  }, [setPhase]);

  // Ctrl+Shift+Space (⌘⇧Space on a Mac) talks from anywhere; Escape closes.
  React.useEffect(() => {
    if (!supported) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.code === 'Space' || e.key === ' ')) {
        e.preventDefault();
        toggle();
      } else if (e.key === 'Escape' && phaseRef.current !== 'idle') {
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [supported, toggle, close]);

  React.useEffect(
    () => () => {
      listener.current?.cancel();
      pollToken.current++;
      stopSpeaking();
    },
    [],
  );

  function submitTyped(e: React.FormEvent) {
    e.preventDefault();
    const text = typed.trim();
    if (!text) return;
    setTyped('');
    setTyping(false);
    setTurn(null);
    setError(null);
    void act(text);
  }

  function toggleVoice() {
    const next = !voiceOn;
    setVoiceOn(next);
    setSpeakingEnabled(next);
    if (!next && phaseRef.current === 'speaking') setPhase('idle');
  }

  if (!supported) return null;

  const busy = phase !== 'idle';
  const label =
    phase === 'listening'
      ? 'Stop listening'
      : phase === 'speaking'
        ? 'Stop talking and listen again'
        : 'Talk to Arwin (Ctrl+Shift+Space)';
  const headline =
    phase === 'listening'
      ? (status ?? 'Listening…')
      : phase === 'thinking'
        ? 'Thinking…'
        : phase === 'speaking'
          ? 'Arwin is talking'
          : turn?.waiting
            ? 'Working on it…'
            : 'Voice Arwin';

  return (
    <div className="pointer-events-auto relative" data-voice-arwin="">
      {show ? (
        <section
          aria-label="Voice Arwin"
          aria-live="polite"
          className="shadow-overlay motion-safe:animate-rise absolute right-0 bottom-full mb-3 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-strong)] bg-[var(--bg-overlay)] text-[var(--fg)]"
        >
          <header className="dark relative flex items-center gap-2 bg-[var(--bg-sidebar)] px-3 py-2 text-[var(--fg)] after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[linear-gradient(90deg,transparent,var(--gold)_25%,var(--gold)_75%,transparent)]">
            <span
              aria-hidden="true"
              className={cn(
                'size-2 rounded-full bg-[var(--accent)]',
                busy && 'motion-safe:animate-pulse',
              )}
            />
            <p className="min-w-0 flex-1 truncate text-sm font-medium" data-voice-status="">
              {headline}
            </p>
            {canSpeak() ? (
              <button
                type="button"
                onClick={toggleVoice}
                aria-label={voiceOn ? 'Mute Arwin’s voice' : 'Turn Arwin’s voice on'}
                title={voiceOn ? 'Mute voice' : 'Voice on'}
                className="rounded-md p-1 text-[var(--fg-muted)] hover:text-[var(--fg)]"
              >
                {voiceOn ? (
                  <Volume2 className="size-4" aria-hidden="true" />
                ) : (
                  <VolumeX className="size-4" aria-hidden="true" />
                )}
              </button>
            ) : null}
            <button
              type="button"
              onClick={close}
              aria-label="Close Voice Arwin"
              title="Close"
              className="rounded-md p-1 text-[var(--fg-muted)] hover:text-[var(--fg)]"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </header>

          <div className="space-y-2 px-3 py-3 text-sm">
            {phase === 'listening' ? (
              <div className="flex items-center gap-3">
                <LevelBars level={level} />
                <p className="min-w-0 flex-1 text-[var(--fg-muted)] italic" data-voice-partial="">
                  {partial ||
                    (status ? '' : 'Say something like “open my inbox” or “what’s on today?”')}
                </p>
              </div>
            ) : null}

            {turn?.heard ? (
              <p data-voice-heard="">
                <span className="text-[var(--fg-muted)]">You: </span>
                {turn.heard}
              </p>
            ) : null}

            {turn && (turn.reply || turn.waiting) ? (
              <div className="flex gap-2" data-voice-reply="">
                <span className="text-[var(--label-gold)]">Arwin:</span>
                {turn.waiting && !turn.reply ? (
                  <Loader2
                    className="mt-0.5 size-4 text-[var(--fg-muted)] motion-safe:animate-spin"
                    aria-label="Waiting for the answer"
                  />
                ) : (
                  <p className="line-clamp-6 min-w-0 flex-1 whitespace-pre-line">{turn.reply}</p>
                )}
              </div>
            ) : null}

            {error ? (
              <p role="alert" className="text-[var(--danger,#c0392b)]">
                {error}
              </p>
            ) : null}

            {typing ? (
              <form onSubmit={submitTyped} className="flex gap-2">
                <input
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="Type what you’d say…"
                  aria-label="Type a command for Arwin"
                  className="min-w-0 flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-1 text-sm"
                />
                <button
                  type="submit"
                  className="rounded-md bg-[var(--primary)] px-2 py-1 text-sm text-[var(--primary-fg)]"
                >
                  Go
                </button>
              </form>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              {turn?.threadId ? (
                <button
                  type="button"
                  onClick={() => {
                    openAskWidget({ threadId: turn.threadId! });
                    close();
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--border-strong)] px-2 py-1 text-xs hover:bg-[var(--bg-hover)]"
                >
                  <MessageCircleMore className="size-3.5" aria-hidden="true" />
                  Open in chat
                </button>
              ) : null}
              {!typing && phase !== 'listening' ? (
                <button
                  type="button"
                  onClick={() => setTyping(true)}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--border-strong)] px-2 py-1 text-xs hover:bg-[var(--bg-hover)]"
                >
                  <Keyboard className="size-3.5" aria-hidden="true" />
                  Type instead
                </button>
              ) : null}
              <span className="ml-auto text-[11px] text-[var(--fg-subtle,var(--fg-muted))]">
                Ctrl+Shift+Space
              </span>
            </div>
          </div>
        </section>
      ) : null}

      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        title={label}
        aria-pressed={phase === 'listening'}
        data-voice-mic=""
        data-tour="ask-voice"
        className={cn(
          'shadow-lifted relative flex size-11 items-center justify-center rounded-full border border-[var(--gold)] bg-[var(--bg-overlay)] text-[var(--fg)] transition-[background-color,transform] duration-[var(--motion-fast)] hover:bg-[var(--bg-hover)] active:scale-95',
          phase === 'listening' &&
            'bg-[var(--primary)] text-[var(--primary-fg)] hover:bg-[var(--primary-hover)]',
        )}
      >
        {phase === 'listening' ? (
          <>
            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-full ring-2 ring-[var(--gold)] transition-transform duration-100"
              style={{ transform: `scale(${1 + level * 0.35})`, opacity: 0.4 + level * 0.6 }}
            />
            <Square className="size-4 fill-current" aria-hidden="true" />
          </>
        ) : phase === 'thinking' ? (
          <Loader2 className="size-5 motion-safe:animate-spin" aria-hidden="true" />
        ) : (
          <Mic className="size-5" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

const noSubscribe = () => () => undefined;
const serverFalse = () => false;

function LevelBars({ level }: { level: number }) {
  const bars = [0.5, 0.8, 1, 0.8, 0.5];
  return (
    <span aria-hidden="true" className="flex h-6 items-center gap-0.5">
      {bars.map((w, i) => (
        <span
          key={i}
          className="w-1 rounded-full bg-[var(--accent)] transition-[height] duration-100"
          style={{ height: `${Math.max(4, Math.min(24, 4 + level * w * 22))}px` }}
        />
      ))}
    </span>
  );
}
