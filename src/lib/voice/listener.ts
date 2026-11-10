import { AudioGraph } from '@/lib/capture/audio-graph';
import { acquireMicrophone, mediaError, stopStream } from '@/lib/capture/media';
import type { EngineStatus } from '@/lib/capture/speech-engine';
import { DEFAULT_TUNING } from '@/lib/capture/types';
import { WhisperEngine } from '@/lib/capture/whisper-engine';
import { desktopAppVersion } from '@/lib/desktop/shared';
import { baseSession } from '@/lib/transcribe/transcriber';
import { matchWake } from './intent';

/**
 * Hears one spoken command. Two engines, both free:
 *
 * - the browser's own speech recognition (Chrome, Edge, Safari): instant
 *   words as you speak;
 * - Whisper on this computer (the Notes recorder's engine, D-076) where the
 *   browser has none or it fails: the Kraken desktop app, Firefox, the phone
 *   app. The first use downloads the speech model once.
 *
 * Either way it stops by itself after a short pause, or when stop() is called.
 */

export type ListenerKind = 'browser' | 'whisper';

export interface ListenerHandlers {
  /** Words so far (browser engine only). */
  onPartial(text: string): void;
  /** The microphone level, 0..1. */
  onLevel(level: number): void;
  /** "Getting speech ready… 40%" while Whisper loads. */
  onStatus(message: string | null): void;
}

/** What was said, and how sure the engine was (0..1; null when it does not say). */
export interface Heard {
  text: string;
  confidence: number | null;
}

const NOTHING: Heard = { text: '', confidence: null };

function average(values: number[]): number | null {
  const ok = values.filter((v) => Number.isFinite(v) && v > 0);
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
}

export interface Listener {
  readonly kind: ListenerKind;
  /** Resolves with what was said ('' for nothing), rejects with a plain-words Error. */
  readonly result: Promise<Heard>;
  /** Finish now and keep what was heard. */
  stop(): void;
  /** Throw it all away. */
  cancel(): void;
}

/** How long a pause after speech ends the command. */
const PAUSE_MS = 1_300;
/** Give up when nothing is said for this long. */
const NOTHING_SAID_MS = 8_000;
/** One command is never longer than this. */
const MAX_MS = 30_000;

interface BrowserRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult:
    | ((e: {
        results: ArrayLike<
          ArrayLike<{ transcript: string; confidence?: number }> & { isFinal: boolean }
        >;
      }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onaudiostart?: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => BrowserRecognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** The Kraken desktop app's webview has the API but no speech service behind it. */
function inDesktopApp(): boolean {
  return typeof window !== 'undefined' && desktopAppVersion() !== null;
}

export function preferredListener(): ListenerKind {
  return recognitionCtor() && !inDesktopApp() ? 'browser' : 'whisper';
}

export function canListen(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia || recognitionCtor())
  );
}

export function startListening(
  handlers: ListenerHandlers,
  kind: ListenerKind = preferredListener(),
): Listener {
  return kind === 'browser' ? browserListener(handlers) : whisperListener(handlers);
}

/** Thrown when the browser engine cannot work here, so the caller can try Whisper. */
export class BrowserSpeechUnavailable extends Error {}

function browserListener(handlers: ListenerHandlers): Listener {
  const Ctor = recognitionCtor();
  let rec: BrowserRecognition | null = Ctor ? new Ctor() : null;
  let finalText = '';
  let interim = '';
  let confidences: number[] = [];
  let cancelled = false;
  let settled = false;
  let resolve!: (t: Heard) => void;
  let reject!: (e: Error) => void;
  const heard = (): Heard => ({
    text: (finalText + interim).trim(),
    confidence: average(confidences),
  });
  const result = new Promise<Heard>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const done = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(maxTimer);
    clearTimeout(silentTimer);
    handlers.onLevel(0);
    fn();
  };
  const maxTimer = setTimeout(() => rec?.stop(), MAX_MS);
  let silentTimer = setTimeout(() => rec?.stop(), NOTHING_SAID_MS);

  if (!rec) {
    queueMicrotask(() => done(() => reject(new BrowserSpeechUnavailable('No browser speech.'))));
    return { kind: 'browser', result, stop() {}, cancel() {} };
  }
  rec.lang = 'en-US';
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.onaudiostart = () => handlers.onLevel(0.5);
  rec.onresult = (e) => {
    finalText = '';
    interim = '';
    confidences = [];
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i]!;
      const t = r[0]?.transcript ?? '';
      if (r.isFinal) {
        finalText += t;
        if (typeof r[0]?.confidence === 'number') confidences.push(r[0].confidence);
      } else interim += t;
    }
    handlers.onPartial((finalText + interim).trim());
    handlers.onLevel(0.4 + Math.random() * 0.5);
    clearTimeout(silentTimer);
    silentTimer = setTimeout(() => rec?.stop(), PAUSE_MS + 1_200);
  };
  rec.onerror = (e) => {
    if (cancelled) return done(() => resolve(NOTHING));
    if (e.error === 'no-speech' || e.error === 'aborted') return done(() => resolve(heard()));
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      // Blocked mic, or a webview with no speech service: Whisper may still work.
      return done(() => reject(new BrowserSpeechUnavailable(e.error)));
    }
    if (
      e.error === 'network' ||
      e.error === 'audio-capture' ||
      e.error === 'language-not-supported'
    ) {
      return done(() => reject(new BrowserSpeechUnavailable(e.error)));
    }
    done(() => reject(new Error('I couldn’t hear that. Try again?')));
  };
  rec.onend = () => done(() => resolve(cancelled ? NOTHING : heard()));
  try {
    rec.start();
  } catch {
    queueMicrotask(() => done(() => reject(new BrowserSpeechUnavailable('start failed'))));
  }
  return {
    kind: 'browser',
    result,
    stop() {
      rec?.stop();
    },
    cancel() {
      cancelled = true;
      rec?.abort();
      rec = null;
      done(() => resolve(NOTHING));
    },
  };
}

function loadingMessage(status: EngineStatus): string | null {
  if (status.phase === 'ready') return null;
  if (status.message && status.phase === 'failed') return status.message;
  if (status.progress !== null && status.progress < 1) {
    return `Getting speech ready on this computer… ${Math.round(status.progress * 100)}%`;
  }
  return 'Getting speech ready on this computer…';
}

function whisperListener(handlers: ListenerHandlers): Listener {
  let cancelled = false;
  let stopping = false;
  let stopNow: () => void = () => {
    stopping = true;
  };
  const result = (async () => {
    // Permission first, straight from the click.
    let media: MediaStream;
    try {
      media = await acquireMicrophone();
    } catch (error) {
      throw new Error(mediaError(error, 'mic').message);
    }
    let graph: AudioGraph;
    try {
      graph = await AudioGraph.create();
    } catch {
      stopStream(media);
      throw new Error('The browser could not start its audio engine.');
    }
    const lines: string[] = [];
    const confidences: number[] = [];
    const engine = new WhisperEngine(
      baseSession(
        'browser-whisper',
        { meetingId: 'voice', track: 'mic', language: 'en', knownVoices: [], vocabulary: [] },
        {},
      ),
      {
        onEvent: (event) => {
          if (event.type === 'final' && event.text.trim()) {
            lines.push(event.text.trim());
            if (event.confidence !== null) confidences.push(event.confidence);
          }
        },
        onClose: () => undefined,
        onStatus: (status) => handlers.onStatus(loadingMessage(status)),
      },
      // The worker "Hey Arwin" keeps warm, so the question after a wake starts at once.
      { baseMs: 0, shareWake: true },
    );
    const cleanup = () => {
      graph.detach('mic');
      stopStream(media);
      void graph.context.close().catch(() => undefined);
    };
    try {
      await engine.open();
    } catch (error) {
      cleanup();
      throw new Error(error instanceof Error ? error.message : 'Speech could not start here.');
    }
    if (cancelled) {
      cleanup();
      engine.close();
      return NOTHING;
    }

    await new Promise<void>((resolve) => {
      const started = Date.now();
      let heardAt = 0;
      let lastLoud = 0;
      const finish = () => {
        clearInterval(tick);
        resolve();
      };
      stopNow = finish;
      if (stopping) return finish();
      graph.attach('mic', media, (chunk) => {
        engine.sendAudio(chunk.samples);
        handlers.onLevel(Math.min(1, chunk.rms * 25));
        if (chunk.rms > DEFAULT_TUNING.silenceThreshold * 3) {
          lastLoud = Date.now();
          if (!heardAt) heardAt = lastLoud;
        }
      });
      const tick = setInterval(() => {
        const now = Date.now();
        if (cancelled) return finish();
        if (heardAt && now - lastLoud > PAUSE_MS) return finish();
        if (!heardAt && now - started > NOTHING_SAID_MS) return finish();
        if (now - started > MAX_MS) return finish();
      }, 100);
    });

    handlers.onLevel(0);
    cleanup();
    if (cancelled) {
      engine.close();
      return NOTHING;
    }
    handlers.onStatus('Listening done, writing it down…');
    try {
      await engine.finish(20_000);
    } catch {
      // Keep whatever lines arrived.
    }
    engine.close();
    handlers.onStatus(null);
    return {
      text: lines.join(' ').replace(/\s+/g, ' ').trim(),
      confidence: average(confidences),
    };
  })();

  return {
    kind: 'whisper',
    result,
    stop() {
      stopNow();
    },
    cancel() {
      cancelled = true;
      stopNow();
    },
  };
}

/* ------------------------------------------------------- interrupting */

export interface WakeWatch {
  stop(): void;
}

/**
 * While Arwin talks or thinks: the browser's own recognition listens for
 * "Hey Arwin" so it can be interrupted. `onHeard` fires the moment the words
 * appear (stop talking at once); `onCommand` once the sentence is finished,
 * with what followed ("" for nothing: then listen for it).
 */
export function watchForWakeInBrowser(handlers: {
  onHeard(): void;
  onCommand(rest: string): void;
}): WakeWatch | null {
  const Ctor = recognitionCtor();
  if (!Ctor || inDesktopApp()) return null;
  let active = true;
  let heard = false;
  let rec: BrowserRecognition | null = null;
  const start = () => {
    if (!active) return;
    rec = new Ctor();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i]!;
        const woke = matchWake(r[0]?.transcript ?? '');
        if (!woke) continue;
        if (!heard) {
          heard = true;
          handlers.onHeard();
        }
        if (r.isFinal) {
          active = false;
          rec?.abort();
          handlers.onCommand(woke.rest);
          return;
        }
      }
    };
    rec.onerror = () => undefined;
    // Recognition ends by itself after a while: keep it going while needed.
    rec.onend = () => {
      if (active && heard) {
        // Heard "Hey Arwin" but the sentence never finished: listen for it.
        active = false;
        handlers.onCommand('');
        return;
      }
      if (active) setTimeout(start, 250);
    };
    try {
      rec.start();
    } catch {
      active = false;
    }
  };
  start();
  return {
    stop() {
      active = false;
      try {
        rec?.abort();
      } catch {
        // Already stopped.
      }
      rec = null;
    },
  };
}
