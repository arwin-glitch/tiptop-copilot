'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Ear,
  EarOff,
  Keyboard,
  Loader2,
  Mic,
  MessageCircleMore,
  PhoneOff,
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
  type Heard,
  type Listener,
  type ListenerKind,
} from '@/lib/voice/listener';
import { fixHeard, loadVoiceNames } from '@/lib/voice/names';
import {
  canSpeak,
  chime,
  setSpeakingEnabled,
  speak,
  speakingEnabled,
  stopSpeaking,
  warmVoices,
} from '@/lib/voice/speaker';
import { setWakeEnabled, subscribeWake, WakeListener, wakeSnapshot } from '@/lib/voice/wake';

/**
 * Voice Arwin: talk to Kraken. Click the mic, press Ctrl+Shift+Space, or say
 * "Hey Arwin" (when switched on for this device), then say what you want:
 *
 * - "Open my inbox", "take me to Tasks, Snoozed": opens the page at once.
 * - "Find Acme", "pull up Jane Doe": opens search with it typed in.
 * - Anything else ("what's on today?"): asked in the Ask Arwin chat, and the
 *   answer is read aloud when it lands.
 *
 * It is a conversation: after each answer Arwin listens again, until "bye",
 * End, or a few quiet seconds. What was heard is cleaned up first
 * (lib/voice/fix.ts: Kraken's words and the team's names), and unclear
 * speech gets "say that again?" rather than being acted on.
 *
 * Speech is heard and spoken on the device for free; the only thing sent
 * anywhere is the question text, the same as typing it into the chat.
 */

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Turn {
  heard: string;
  /** What speech-to-text wrote, when the fix changed it. */
  raw: string | null;
  reply: string;
  threadId: string | null;
  /** Still waiting on the answer from the Ask bridge. */
  waiting: boolean;
}

/** A spoken follow-up within this long continues the same chat. */
const FOLLOW_UP_MS = 10 * 60_000;
const POLL_MS = 3_000;
const POLL_FOR_MS = 5 * 60_000;
/** Below this the engine was guessing: ask again rather than act. */
const MIN_CONFIDENCE = 0.4;
const MAX_RETRIES = 2;

export function VoiceArwin({
  aiAvailable,
  hidden = false,
}: {
  aiAvailable: boolean;
  /** Out of sight (the chat panel is open) but still listening for “Hey Arwin”. */
  hidden?: boolean;
}) {
  const router = useRouter();
  const supported = React.useSyncExternalStore(noSubscribe, canListen, serverFalse);
  const [phase, setPhaseState] = React.useState<Phase>('idle');
  const [show, setShow] = React.useState(false);
  const [partial, setPartial] = React.useState('');
  const [status, setStatus] = React.useState<string | null>(null);
  const [level, setLevel] = React.useState(0);
  const [turn, setTurn] = React.useState<Turn | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [talking, setTalkingState] = React.useState(false);
  const [voiceOn, setVoiceOn] = React.useState(() =>
    typeof window === 'undefined' ? true : speakingEnabled(),
  );
  const wakeOn = React.useSyncExternalStore(subscribeWake, wakeSnapshot, serverFalse);
  const [wakeStatus, setWakeStatus] = React.useState<string | null>(null);
  const [typing, setTyping] = React.useState(false);
  const [typed, setTyped] = React.useState('');

  const listener = React.useRef<Listener | null>(null);
  const kind = React.useRef<ListenerKind>('browser');
  const conversation = React.useRef<{ threadId: string; at: number } | null>(null);
  const pollToken = React.useRef(0);
  const retries = React.useRef(0);
  const wake = React.useRef<WakeListener | null>(null);
  const phaseRef = React.useRef<Phase>('idle');
  const talkingRef = React.useRef(false);
  const setPhase = React.useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const setTalking = React.useCallback((next: boolean) => {
    talkingRef.current = next;
    setTalkingState(next);
  }, []);
  const listenRef = React.useRef<((using?: ListenerKind) => void) | null>(null);
  const actRef = React.useRef<((heard: Heard, typedIn?: boolean) => Promise<void>) | null>(null);

  React.useEffect(() => {
    kind.current = preferredListener();
    warmVoices();
  }, []);

  /** After Arwin answers: listen for the next thing, while the chat is on. */
  const carryOn = React.useCallback(() => {
    if (talkingRef.current && phaseRef.current === 'idle') listenRef.current?.();
  }, []);

  const say = React.useCallback(
    async (text: string, then: 'carry-on' | 'stop' = 'carry-on') => {
      if (!text) return;
      setPhase('speaking');
      await speak(text);
      if (phaseRef.current !== 'speaking') return;
      setPhase('idle');
      if (then === 'carry-on') carryOn();
    },
    [carryOn, setPhase],
  );

  const endChat = React.useCallback(
    (hide: boolean) => {
      setTalking(false);
      listener.current?.cancel();
      listener.current = null;
      stopSpeaking();
      setPhase('idle');
      if (hide) {
        pollToken.current++;
        setShow(false);
        setTyping(false);
      }
    },
    [setPhase, setTalking],
  );

  /* ------------------------------------------------------- the answer */

  const waitForAnswer = React.useCallback(
    async (threadId: string, base: Turn) => {
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
        setTurn({ ...base, reply: last.content, threadId, waiting: false });
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
        setTalking(false);
      }
    },
    [say, setTalking],
  );

  const ask = React.useCallback(
    async (question: string, base: Turn) => {
      if (!aiAvailable) {
        const message = 'Ask Arwin isn’t switched on for this account yet.';
        setTurn({ ...base, reply: message, waiting: false });
        await say(message, 'stop');
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
        setTurn({ ...base, reply: message, waiting: false });
        await say(message);
        return;
      }
      const data = result.data;
      conversation.current = { threadId: data.threadId, at: Date.now() };
      const last = data.messages[data.messages.length - 1];
      if (last && last.role === 'assistant' && last.status !== 'pending') {
        setTurn({ ...base, reply: last.content, threadId: data.threadId, waiting: false });
        await say(spokenText(last.content));
        return;
      }
      // The answer comes from the Ask bridge in a moment: say so, then read it out.
      watchAskReply({ threadId: data.threadId, watching: true });
      const waiting = { ...base, reply: '', threadId: data.threadId, waiting: true };
      setTurn(waiting);
      setPhase('speaking');
      await speak('On it.');
      if (phaseRef.current === 'speaking') setPhase('thinking');
      await waitForAnswer(data.threadId, waiting);
    },
    [aiAvailable, say, setPhase, waitForAnswer],
  );

  const act = React.useCallback(
    async ({ text: raw, confidence }: Heard, typedIn = false) => {
      setError(null);
      const fixed = typedIn ? { text: raw.trim(), changed: false } : fixHeard(raw);
      const unclear =
        !typedIn &&
        fixed.text.replace(/[^\p{L}]/gu, '').length > 0 &&
        confidence !== null &&
        confidence < MIN_CONFIDENCE;
      if (unclear) {
        if (retries.current < MAX_RETRIES) {
          retries.current += 1;
          setTurn({ heard: fixed.text, raw: null, reply: '', threadId: null, waiting: false });
          setPhase('idle');
          await say('Sorry, I didn’t quite catch that. Say it again?', 'stop');
          if (phaseRef.current === 'idle') listenRef.current?.();
          return;
        }
      }
      retries.current = 0;
      const intent = voiceIntent(fixed.text);
      const base: Turn = {
        heard: fixed.text,
        raw: fixed.changed ? raw.trim() : null,
        reply: '',
        threadId: null,
        waiting: false,
      };
      switch (intent.kind) {
        case 'empty':
          if (talkingRef.current && !typedIn) {
            // A quiet moment in the chat: it ends by itself.
            setTalking(false);
            setPhase('idle');
            setStatus('Voice chat ended. Tap the mic to talk again.');
            return;
          }
          setPhase('idle');
          setTurn(null);
          setError('I didn’t catch anything. Tap the mic and try again.');
          return;
        case 'stop':
          pollToken.current++;
          setTalking(false);
          setTurn({ ...base, reply: 'Bye for now.' });
          await say('Bye for now.', 'stop');
          setShow(false);
          return;
        case 'navigate':
          setTurn({ ...base, reply: intent.reply });
          if (intent.match.href) router.push(intent.match.href);
          await say(intent.reply);
          return;
        case 'search':
          setTurn({ ...base, reply: intent.reply });
          openSearch(intent.query);
          // The search box takes the keyboard: the chat pauses here.
          setTalking(false);
          await say(intent.reply, 'stop');
          return;
        case 'ask':
          setTurn({ ...base, waiting: true });
          await ask(intent.question, base);
          return;
      }
    },
    [ask, router, say, setPhase, setTalking],
  );
  React.useEffect(() => {
    actRef.current = act;
  }, [act]);

  /* ---------------------------------------------------------- listening */

  const listen = React.useCallback(
    (using: ListenerKind = kind.current) => {
      stopSpeaking();
      listener.current?.cancel();
      void loadVoiceNames();
      setShow(true);
      setTalking(true);
      setTyping(false);
      setError(null);
      setPartial('');
      setStatus(null);
      setPhase('listening');
      chime();
      const l = startListening(
        { onPartial: setPartial, onLevel: setLevel, onStatus: setStatus },
        using,
      );
      listener.current = l;
      l.result.then(
        (heard) => {
          if (listener.current !== l) return;
          listener.current = null;
          setLevel(0);
          setStatus(null);
          if (phaseRef.current !== 'listening') return;
          void actRef.current?.(heard);
        },
        (err: unknown) => {
          if (listener.current !== l) return;
          listener.current = null;
          setLevel(0);
          setStatus(null);
          // The browser's speech service is missing here: use Whisper from now on.
          if (err instanceof BrowserSpeechUnavailable && using === 'browser') {
            kind.current = 'whisper';
            listenRef.current?.('whisper');
            return;
          }
          setTalking(false);
          setPhase('idle');
          setError(err instanceof Error ? err.message : 'The microphone could not start.');
        },
      );
    },
    [setPhase, setTalking],
  );
  React.useEffect(() => {
    listenRef.current = listen;
  }, [listen]);

  const toggle = React.useCallback(() => {
    if (phaseRef.current === 'listening') listener.current?.stop();
    else {
      pollToken.current++;
      setTurn(null);
      retries.current = 0;
      listen();
    }
  }, [listen]);

  // Ctrl+Shift+Space (⌘⇧Space on a Mac) talks from anywhere; Escape closes.
  React.useEffect(() => {
    if (!supported) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.code === 'Space' || e.key === ' ')) {
        e.preventDefault();
        toggle();
      } else if (e.key === 'Escape' && (phaseRef.current !== 'idle' || talkingRef.current)) {
        endChat(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [supported, toggle, endChat]);

  /* ----------------------------------------------------------- Hey Arwin */

  React.useEffect(() => {
    if (!supported || !wakeOn) return;
    const w = new WakeListener({
      onWake: (rest) => {
        if (phaseRef.current !== 'idle') return;
        pollToken.current++;
        retries.current = 0;
        setShow(true);
        setTurn(null);
        void loadVoiceNames();
        if (rest.replace(/[^\p{L}]/gu, '').length >= 3) {
          // "Hey Arwin, open my inbox" in one breath: do it.
          chime();
          setTalking(true);
          void actRef.current?.({ text: rest, confidence: null });
        } else {
          listenRef.current?.();
        }
      },
      onStatus: setWakeStatus,
    });
    wake.current = w;
    w.start().catch((err: unknown) => {
      setWakeStatus(err instanceof Error ? err.message : '“Hey Arwin” could not start.');
    });
    return () => {
      w.stop();
      if (wake.current === w) wake.current = null;
    };
  }, [supported, wakeOn, setTalking]);

  // Not while Arwin is listening or talking himself.
  React.useEffect(() => {
    if (phase === 'idle' && !talking) wake.current?.resume();
    else wake.current?.pause();
  }, [phase, talking]);

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
    void act({ text, confidence: null }, true);
  }

  function toggleVoice() {
    const next = !voiceOn;
    setVoiceOn(next);
    setSpeakingEnabled(next);
    if (!next && phaseRef.current === 'speaking') setPhase('idle');
  }

  function toggleWake() {
    const next = !wakeOn;
    setWakeEnabled(next);
    setWakeStatus(next ? 'Listening for “Hey Arwin” on this device.' : null);
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
    <div className={cn('pointer-events-auto relative', hidden && 'hidden')} data-voice-arwin="">
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
            <button
              type="button"
              onClick={toggleWake}
              aria-pressed={wakeOn}
              aria-label={wakeOn ? 'Turn off “Hey Arwin”' : 'Turn on “Hey Arwin”'}
              title={wakeOn ? '“Hey Arwin” is on' : '“Hey Arwin” is off'}
              className={cn(
                'rounded-md p-1 hover:text-[var(--fg)]',
                wakeOn ? 'text-[var(--accent)]' : 'text-[var(--fg-muted)]',
              )}
            >
              {wakeOn ? (
                <Ear className="size-4" aria-hidden="true" />
              ) : (
                <EarOff className="size-4" aria-hidden="true" />
              )}
            </button>
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
              onClick={() => endChat(true)}
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
                    (status
                      ? ''
                      : turn
                        ? 'Go ahead, or say “bye” to end.'
                        : 'Say something like “open my inbox” or “what’s on today?”')}
                </p>
              </div>
            ) : null}

            {turn?.heard ? (
              <div data-voice-heard="">
                <p>
                  <span className="text-[var(--fg-muted)]">You: </span>
                  {turn.heard}
                </p>
                {turn.raw ? (
                  <p className="text-xs text-[var(--fg-muted)]" data-voice-raw="">
                    Heard “{turn.raw}”, fixed to the above.
                  </p>
                ) : null}
              </div>
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

            {phase !== 'listening' && status ? (
              <p className="text-xs text-[var(--fg-muted)]">{status}</p>
            ) : null}
            {wakeStatus ? <p className="text-xs text-[var(--fg-muted)]">{wakeStatus}</p> : null}

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
              {talking ? (
                <button
                  type="button"
                  onClick={() => endChat(false)}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--border-strong)] px-2 py-1 text-xs hover:bg-[var(--bg-hover)]"
                >
                  <PhoneOff className="size-3.5" aria-hidden="true" />
                  End voice chat
                </button>
              ) : phase === 'idle' && turn ? (
                <button
                  type="button"
                  onClick={() => {
                    retries.current = 0;
                    listen();
                  }}
                  className="inline-flex items-center gap-1 rounded-md bg-[var(--primary)] px-2 py-1 text-xs text-[var(--primary-fg)] hover:bg-[var(--primary-hover)]"
                >
                  <Mic className="size-3.5" aria-hidden="true" />
                  Keep talking
                </button>
              ) : null}
              {turn?.threadId ? (
                <button
                  type="button"
                  onClick={() => {
                    openAskWidget({ threadId: turn.threadId! });
                    endChat(true);
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
        {wakeOn ? (
          <span
            aria-hidden="true"
            title="“Hey Arwin” is on"
            className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-[var(--accent)] ring-2 ring-[var(--bg)]"
          />
        ) : null}
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
