import { AudioGraph } from '@/lib/capture/audio-graph';
import { acquireMicrophone, mediaError, stopStream } from '@/lib/capture/media';
import type { EngineStatus } from '@/lib/capture/speech-engine';
import { WhisperEngine } from '@/lib/capture/whisper-engine';
import { baseSession } from '@/lib/transcribe/transcriber';
import { matchWake } from './intent';

/**
 * "Hey Arwin": listens on this device while Kraken is open and wakes Voice
 * Arwin when someone says it. Everything is on the device: Whisper (the
 * Notes engine, D-076) turns each spoken turn into text here, the text is
 * checked for "Hey Arwin" and thrown away when it is not. Nothing leaves
 * the device until Arwin is woken.
 *
 * Opt-in per device (it keeps the microphone on). Works wherever Kraken is
 * open and allowed the mic: browsers, the desktop app and the phone app.
 * Phones stop the microphone when Kraken is in the background or locked.
 */

const WAKE_KEY = 'tiptop.voice.wake';

export function wakeEnabled(): boolean {
  try {
    return window.localStorage.getItem(WAKE_KEY) === 'on';
  } catch {
    return false;
  }
}

const wakeListeners = new Set<() => void>();
let wakeOverride: boolean | null = null;

export function setWakeEnabled(on: boolean): void {
  wakeOverride = on;
  try {
    window.localStorage.setItem(WAKE_KEY, on ? 'on' : 'off');
  } catch {
    // Private window: on for this page only.
  }
  for (const l of [...wakeListeners]) l();
}

/** For useSyncExternalStore: the setting as this device has it. */
export function subscribeWake(listener: () => void): () => void {
  wakeListeners.add(listener);
  return () => wakeListeners.delete(listener);
}

export function wakeSnapshot(): boolean {
  return wakeOverride ?? wakeEnabled();
}

/** Shown while the browser keeps the page's audio paused until a tap or key press. */
export const WAKE_TAP_MESSAGE = 'Tap anywhere to turn on “Hey Arwin”.';
/** A wake split by a pause ("Hey…" then "Arwin") is still one wake within this. */
const JOIN_MS = 2500;
/** Events that count as a tap for starting audio, on a mouse, a touch screen or a keyboard. */
const GESTURES = ['pointerup', 'touchend', 'click', 'keydown'] as const;

export interface WakeHandlers {
  /**
   * "Hey Arwin" was matched, fired right before onWake: the moment to give a
   * sound (a chime) so the speaker knows they were heard.
   */
  onHeard?(): void;
  /** "Hey Arwin" was heard; `rest` is what followed it in the same breath. */
  onWake(rest: string, heard: string): void;
  /** Model download or a problem, in plain words; null when all is well. */
  onStatus(message: string | null): void;
}

export class WakeListener {
  private media: MediaStream | null = null;
  private graph: AudioGraph | null = null;
  private engine: WhisperEngine | null = null;
  private paused = false;
  private stopped = false;
  private resumeOnGesture: (() => void) | null = null;
  private onStateChange: (() => void) | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  /** The browser holds the audio paused: the tap message wins over "all is well". */
  private suspended = false;
  /** The last line heard, kept a moment so a wake split across two lines still counts. */
  private recent: { text: string; at: number } | null = null;

  constructor(private readonly handlers: WakeHandlers) {}

  /**
   * The open microphone, for barge-in to listen on a copy of (barge-in.ts):
   * a phone may silence this one if a second microphone is opened.
   */
  get microphone(): MediaStream | null {
    return this.stopped ? null : this.media;
  }

  get running(): boolean {
    return this.engine !== null && !this.stopped;
  }

  async start(): Promise<void> {
    this.stopped = false;
    try {
      this.media = await acquireMicrophone();
    } catch (error) {
      throw new Error(mediaError(error, 'mic').message);
    }
    if (this.stopped) return this.stop();
    try {
      this.graph = await AudioGraph.create();
    } catch {
      this.stop();
      throw new Error('The browser could not start its audio engine.');
    }
    this.watchSuspended(this.graph.context);
    this.engine = new WhisperEngine(
      baseSession(
        'browser-whisper',
        { meetingId: 'wake', track: 'mic', language: 'en', knownVoices: [], vocabulary: [] },
        {},
      ),
      {
        onEvent: (event) => {
          if (this.paused || event.type !== 'final') return;
          this.heard(event.text);
        },
        onClose: (info) => {
          if (!info.expected && !this.stopped) {
            this.handlers.onStatus('“Hey Arwin” stopped. Tap the mic to start it again.');
            this.stop();
          }
        },
        onStatus: (status: EngineStatus) => {
          if (status.phase === 'failed') this.handlers.onStatus(status.message);
          else if (status.phase === 'loading' && status.progress !== null && status.progress < 1)
            this.handlers.onStatus(
              `Getting “Hey Arwin” ready… ${Math.round(status.progress * 100)}%`,
            );
          else this.status(null);
        },
      },
      // Its own worker, the Fast model, short pauses: a wake within about a second.
      { baseMs: 0, mode: 'wake' },
    );
    try {
      await this.engine.open();
    } catch (error) {
      this.stop();
      throw new Error(error instanceof Error ? error.message : 'Speech could not start here.');
    }
    if (this.stopped) return this.stop();
    this.attach();
  }

  /** One finished line: wake on "Hey Arwin", even when a pause split it from the line before. */
  private heard(text: string): void {
    const now = Date.now();
    const recent = this.recent && now - this.recent.at <= JOIN_MS ? this.recent.text : '';
    let woke = matchWake(text);
    let said = text.trim();
    if (!woke && recent) {
      said = `${recent} ${said}`;
      woke = matchWake(said);
    }
    if (!woke) {
      this.recent = { text: text.trim(), at: now };
      return;
    }
    this.recent = null;
    this.handlers.onHeard?.();
    this.handlers.onWake(woke.rest, said);
  }

  /** A status from the engine; "all is well" still shows the tap message while audio is paused. */
  private status(message: string | null): void {
    this.handlers.onStatus(message ?? (this.suspended ? WAKE_TAP_MESSAGE : null));
  }

  /**
   * A page that opened without a click starts its audio paused, and then
   * hears nothing; phones also pause it after a call or a trip to the
   * background. Say so, wake it on the next tap or key press anywhere, and
   * clear the message once it runs.
   */
  private watchSuspended(context: AudioContext): void {
    const resume = () => {
      if (context.state !== 'running' && context.state !== 'closed' && !this.stopped)
        void context.resume().catch(() => undefined);
    };
    this.resumeOnGesture = resume;
    // Kept for the listener's life, not once: a touch's pointerdown does not
    // count as a tap for audio (pointerup, touchend and click do), and a
    // phone can pause the audio again later.
    for (const type of GESTURES) window.addEventListener(type, resume, true);
    const onChange = () => {
      if (this.stopped) return;
      if (context.state === 'running') {
        if (this.suspendTimer) clearTimeout(this.suspendTimer);
        this.suspendTimer = null;
        if (this.suspended) {
          this.suspended = false;
          this.handlers.onStatus(null);
        }
        return;
      }
      if (context.state === 'closed') return;
      // Allowed already when the page had a click before: then no message at all.
      resume();
      if (this.suspendTimer || this.suspended) return;
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        if (context.state === 'running' || this.stopped) return;
        this.suspended = true;
        this.handlers.onStatus(WAKE_TAP_MESSAGE);
      }, 300);
    };
    this.onStateChange = onChange;
    context.addEventListener('statechange', onChange);
    onChange();
  }

  private attach(): void {
    if (!this.graph || !this.media || !this.engine) return;
    const engine = this.engine;
    this.graph.attach('mic', this.media, (chunk) => engine.sendAudio(chunk.samples));
  }

  /** Stop listening for a moment (Arwin is listening or talking himself). */
  pause(): void {
    this.paused = true;
    this.recent = null;
    this.graph?.detach('mic');
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (!this.stopped) this.attach();
  }

  stop(): void {
    this.stopped = true;
    if (this.resumeOnGesture) {
      for (const type of GESTURES) window.removeEventListener(type, this.resumeOnGesture, true);
      this.resumeOnGesture = null;
    }
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
    if (this.onStateChange)
      this.graph?.context.removeEventListener('statechange', this.onStateChange);
    this.onStateChange = null;
    this.suspended = false;
    this.recent = null;
    this.graph?.detach('mic');
    void this.graph?.context.close().catch(() => undefined);
    this.graph = null;
    stopStream(this.media);
    this.media = null;
    this.engine?.close();
    this.engine = null;
  }
}
