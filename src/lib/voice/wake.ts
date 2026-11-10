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

export interface WakeHandlers {
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

  constructor(private readonly handlers: WakeHandlers) {}

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
    // A page that opened without a click starts its audio paused: the next tap
    // or key press anywhere wakes it.
    if (this.graph.context.state !== 'running') {
      const resume = () => void this.graph?.context.resume().catch(() => undefined);
      this.resumeOnGesture = resume;
      window.addEventListener('pointerdown', resume, { once: true });
      window.addEventListener('keydown', resume, { once: true });
    }
    this.engine = new WhisperEngine(
      baseSession(
        'browser-whisper',
        { meetingId: 'wake', track: 'mic', language: 'en', knownVoices: [], vocabulary: [] },
        {},
      ),
      {
        onEvent: (event) => {
          if (this.paused || event.type !== 'final') return;
          const woke = matchWake(event.text);
          if (woke) this.handlers.onWake(woke.rest, event.text.trim());
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
          else this.handlers.onStatus(null);
        },
      },
      { baseMs: 0 },
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

  private attach(): void {
    if (!this.graph || !this.media || !this.engine) return;
    const engine = this.engine;
    this.graph.attach('mic', this.media, (chunk) => engine.sendAudio(chunk.samples));
  }

  /** Stop listening for a moment (Arwin is listening or talking himself). */
  pause(): void {
    this.paused = true;
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
      window.removeEventListener('pointerdown', this.resumeOnGesture);
      window.removeEventListener('keydown', this.resumeOnGesture);
      this.resumeOnGesture = null;
    }
    this.graph?.detach('mic');
    void this.graph?.context.close().catch(() => undefined);
    this.graph = null;
    stopStream(this.media);
    this.media = null;
    this.engine?.close();
    this.engine = null;
  }
}
