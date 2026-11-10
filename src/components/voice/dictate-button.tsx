'use client';

import * as React from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { cn } from '@/lib/util/cn';
import {
  BrowserSpeechUnavailable,
  canListen,
  preferredListener,
  startListening,
  type Listener,
  type ListenerKind,
} from '@/lib/voice/listener';
import { fixHeard, loadVoiceNames } from '@/lib/voice/names';

/**
 * The chat box's mic: say the question and it is written into the box,
 * cleaned up the same way Voice Arwin cleans up speech (lib/voice/fix.ts).
 * It is only typed in, never sent: the person reads it and presses Ask.
 */

let preferred: ListenerKind | null = null;

export function DictateButton({
  value,
  onChange,
  disabled,
  onDone,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Focus back to the box when done. */
  onDone?: () => void;
}) {
  const supported = React.useSyncExternalStore(noSubscribe, canListen, serverFalse);
  const [state, setState] = React.useState<'idle' | 'listening' | 'writing'>('idle');
  const [note, setNote] = React.useState<string | null>(null);
  const listener = React.useRef<Listener | null>(null);
  const latest = React.useRef(value);
  React.useEffect(() => {
    latest.current = value;
  }, [value]);

  React.useEffect(() => () => listener.current?.cancel(), []);
  const startRef = React.useRef<((using?: ListenerKind) => void) | null>(null);

  const start = React.useCallback(
    (using?: ListenerKind) => {
      const base = latest.current.trim();
      const join = (text: string) => (base && text ? `${base} ${text}` : base || text);
      void loadVoiceNames();
      setNote(null);
      setState('listening');
      const l = startListening(
        {
          onPartial: (text) => onChange(join(text)),
          onLevel: () => undefined,
          onStatus: (s) => {
            setNote(s);
            if (s && /writing/i.test(s)) setState('writing');
          },
        },
        using ?? preferred ?? preferredListener(),
      );
      listener.current = l;
      l.result.then(
        (heard) => {
          if (listener.current !== l) return;
          listener.current = null;
          setState('idle');
          setNote(null);
          const fixed = fixHeard(heard.text);
          onChange(join(fixed.text));
          if (!heard.text) setNote('Didn’t catch that. Tap the mic and try again.');
          onDone?.();
        },
        (err: unknown) => {
          if (listener.current !== l) return;
          listener.current = null;
          if (err instanceof BrowserSpeechUnavailable && (using ?? preferred) !== 'whisper') {
            preferred = 'whisper';
            startRef.current?.('whisper');
            return;
          }
          setState('idle');
          setNote(err instanceof Error ? err.message : 'The microphone could not start.');
        },
      );
    },
    [onChange, onDone],
  );
  React.useEffect(() => {
    startRef.current = start;
  }, [start]);

  if (!supported) return null;

  const listening = state === 'listening';
  return (
    <span className="inline-flex items-center gap-2">
      {note ? (
        <span className="text-micro max-w-[12rem] truncate text-[var(--fg-subtle)]" title={note}>
          {note}
        </span>
      ) : null}
      <button
        type="button"
        disabled={disabled || state === 'writing'}
        onClick={() => (listening ? listener.current?.stop() : start())}
        aria-label={listening ? 'Stop dictating' : 'Dictate your question'}
        title={listening ? 'Stop' : 'Speak your question'}
        aria-pressed={listening}
        data-ask-dictate=""
        className={cn(
          'inline-flex size-8 items-center justify-center rounded-full border border-[var(--border-strong)] text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] disabled:opacity-50',
          listening &&
            'border-[var(--gold)] bg-[var(--primary)] text-[var(--primary-fg)] hover:bg-[var(--primary-hover)] motion-safe:animate-pulse',
        )}
      >
        {state === 'writing' ? (
          <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        ) : listening ? (
          <Square className="size-3.5 fill-current" aria-hidden="true" />
        ) : (
          <Mic className="size-4" aria-hidden="true" />
        )}
      </button>
    </span>
  );
}

const noSubscribe = () => () => undefined;
const serverFalse = () => false;
