import type { SpeechDevice, SpeechModelChoice } from '@/lib/transcribe/models';
import { AudioGraph } from './audio-graph';
import { LevelMeter } from './levels';
import { acquireMicrophone, mediaError, stopStream } from './media';
import type { SpeechPreferences } from './speech-preferences';
import type { AdapterKind, FromWorker, WorkerConfig } from './speech-protocol';
import { speechWorkerPool, type SpeechWorkerPool } from './speech-workers';

/**
 * "Test my setup" (D-076): five seconds of the microphone, transcribed on
 * this computer with the chosen model, and how long that took. It answers
 * the two questions before a first meeting: does the model download and run
 * here, and does it keep up? Nothing is sent or saved; the sample is dropped
 * once transcribed. The first test downloads the model, which every meeting
 * after it then finds in the browser.
 */

export const SETUP_TEST_MS = 5000;

export type SetupTestPhase = 'idle' | 'recording' | 'loading' | 'transcribing' | 'done' | 'error';

export interface SetupTestResult {
  text: string;
  audioMs: number;
  elapsedMs: number;
  device: SpeechDevice | null;
  model: SpeechModelChoice | null;
  /** Transcribing took well under the time spoken: room for both tracks and telling voices apart. */
  keepsUp: boolean;
}

export interface SetupTestState {
  phase: SetupTestPhase;
  level: number;
  /** Seconds of the sample left to record. */
  secondsLeft: number;
  progress: number | null;
  totalMb: number;
  result: SetupTestResult | null;
  error: string | null;
}

const IDLE: SetupTestState = {
  phase: 'idle',
  level: 0,
  secondsLeft: SETUP_TEST_MS / 1000,
  progress: null,
  totalMb: 0,
  result: null,
  error: null,
};

/** Keeps up when transcribing takes at most this share of the time spoken. */
const KEEPS_UP_RATIO = 0.6;

export class SetupTest {
  private state_: SetupTestState = IDLE;
  private readonly listeners = new Set<() => void>();
  private running = false;

  constructor(
    private readonly pool: SpeechWorkerPool = speechWorkerPool(),
    private readonly adapter: AdapterKind = 'transformers',
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.state_;

  getServerSnapshot = () => IDLE;

  private set(patch: Partial<SetupTestState>): void {
    this.state_ = { ...this.state_, ...patch };
    for (const l of [...this.listeners]) l();
  }

  /** Record five seconds and transcribe them. Call from a click (the microphone prompt needs one). */
  async run(preferences: SpeechPreferences, language = 'en'): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.set({ ...IDLE, phase: 'recording' });
    try {
      const samples = await this.record();
      if (!samples) return;
      this.set({ phase: 'loading', level: 0, secondsLeft: 0 });
      await this.transcribe(samples, preferences, language);
    } finally {
      this.running = false;
    }
  }

  private async record(): Promise<Int16Array | null> {
    let media: MediaStream;
    try {
      media = await acquireMicrophone();
    } catch (error) {
      this.set({ phase: 'error', error: mediaError(error, 'mic').message });
      return null;
    }
    let graph: AudioGraph;
    try {
      graph = await AudioGraph.create();
    } catch {
      stopStream(media);
      this.set({ phase: 'error', error: 'The browser could not start its audio engine.' });
      return null;
    }
    const meter = new LevelMeter();
    const pieces: Int16Array[] = [];
    let heard = 0;
    const target = (SETUP_TEST_MS / 1000) * 16_000;
    await new Promise<void>((resolve) => {
      graph.attach('mic', media, (chunk) => {
        if (heard >= target) return;
        pieces.push(chunk.samples);
        heard += chunk.samples.length;
        this.set({
          level: meter.update(chunk.rms),
          secondsLeft: Math.max(0, Math.ceil((target - heard) / 16_000)),
        });
        if (heard >= target) resolve();
      });
      // A microphone that never delivers still ends the test.
      setTimeout(resolve, SETUP_TEST_MS + 4000);
    });
    graph.detach('mic');
    stopStream(media);
    await graph.close();
    const out = new Int16Array(heard);
    let offset = 0;
    for (const p of pieces) {
      out.set(p.subarray(0, Math.min(p.length, out.length - offset)), offset);
      offset += p.length;
      if (offset >= out.length) break;
    }
    if (out.length === 0) {
      this.set({
        phase: 'error',
        error: 'The microphone sent no sound. Check it in the sound check.',
      });
      return null;
    }
    return out;
  }

  private async transcribe(
    samples: Int16Array,
    preferences: SpeechPreferences,
    language: string,
  ): Promise<void> {
    const config: WorkerConfig = {
      choice: preferences.model,
      device: preferences.device,
      language,
      adapter: this.adapter,
    };
    const host = this.pool.acquire(config, 'test');
    const requestId = Date.now();
    await new Promise<void>((resolve) => {
      const unsubscribe = host.subscribe((message: FromWorker) => {
        if (message.type === 'status') {
          this.set({
            phase: message.status.phase === 'ready' ? 'transcribing' : 'loading',
            progress: message.status.progress,
            totalMb: message.status.totalMb,
          });
        } else if (message.type === 'test-result' && message.requestId === requestId) {
          unsubscribe();
          this.set({
            phase: 'done',
            result: {
              text: message.text,
              audioMs: message.audioMs,
              elapsedMs: message.elapsedMs,
              device: message.device,
              model: message.model,
              keepsUp: message.elapsedMs <= message.audioMs * KEEPS_UP_RATIO,
            },
          });
          resolve();
        } else if (message.type === 'fatal') {
          unsubscribe();
          this.set({ phase: 'error', error: message.message });
          resolve();
        }
      });
      if (host.status) {
        this.set({
          phase: host.status.phase === 'ready' ? 'transcribing' : 'loading',
          progress: host.status.progress,
          totalMb: host.status.totalMb,
        });
      }
      host.post({ type: 'test', requestId, samples }, [samples.buffer]);
    });
    this.pool.release(host);
  }

  reset(): void {
    if (!this.running) this.set(IDLE);
  }
}
