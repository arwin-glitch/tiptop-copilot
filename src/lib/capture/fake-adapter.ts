import { syntheticVoiceprint } from '@/lib/transcribe/voiceprint';
import type { WorkerConfig } from './speech-protocol';
import {
  ModelLoadError,
  type AsrResult,
  type LoadProgress,
  type LoadedAsr,
  type ModelAdapter,
  type SpeakerTurn,
} from './speech-pipeline';
import { VAD_RATE } from './vad';

/**
 * A stand-in for Whisper and the speaker models (D-076), for the unit tests
 * and demo mode's end-to-end test of the on-device engine. No model, no
 * download, no network: every chunk of speech becomes a numbered line, and
 * the voices alternate between two made-up voiceprints, so the whole worker
 * path (chunking, queue, clustering, labels, finish) runs in a real browser
 * in seconds. Never used outside demo mode and the tests.
 */

export const FAKE_VOICEPRINT_MODEL = 'fake-voiceprint@1';

export interface FakeAdapterOptions {
  /** Pretend each call takes this long (ms), to test falling behind. */
  delayMs?: number;
  /** The text for the nth chunk (from 1); defaults to "Line n …". */
  textFor?: (n: number, seconds: number) => string;
  /** The voice (any seed) for the nth embedding (from 1); defaults to alternating two voices. */
  voiceFor?: (n: number) => string;
  /** Fail loading with this message. */
  failLoad?: { message: string; retryable: boolean };
}

const pause = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export class FakeModelAdapter implements ModelAdapter {
  readonly voiceprintModel = FAKE_VOICEPRINT_MODEL;
  private chunks = 0;
  private embeds = 0;
  /** How many times transcribe ran (partials included). */
  calls = 0;

  constructor(private readonly options: FakeAdapterOptions = {}) {}

  async loadAsr(config: WorkerConfig, onProgress: (p: LoadProgress) => void): Promise<LoadedAsr> {
    if (this.options.failLoad) {
      throw new ModelLoadError(this.options.failLoad.message, this.options.failLoad.retryable);
    }
    const total = 3_000_000;
    for (const share of [0.25, 0.75, 1]) {
      await pause(0);
      onProgress({ loadedBytes: total * share, totalBytes: total });
    }
    return { device: 'wasm', model: config.choice, message: null };
  }

  async loadSpeakers(onProgress: (p: LoadProgress) => void): Promise<void> {
    await pause(0);
    onProgress({ loadedBytes: 1_000_000, totalBytes: 1_000_000 });
  }

  async transcribe(audio: Float32Array): Promise<AsrResult> {
    this.calls += 1;
    await pause(this.options.delayMs ?? 0);
    const seconds = audio.length / VAD_RATE;
    this.chunks += 1;
    const n = this.chunks;
    const text =
      this.options.textFor?.(n, seconds) ??
      `Line ${n} heard on this computer, ${Math.max(1, Math.round(seconds))} seconds.`;
    return { text, segments: [{ startS: 0, endS: seconds, text }] };
  }

  async segment(audio: Float32Array): Promise<SpeakerTurn[]> {
    return [{ startS: 0, endS: audio.length / VAD_RATE, speaker: 0 }];
  }

  async embed(): Promise<Float32Array> {
    await pause(this.options.delayMs ?? 0);
    this.embeds += 1;
    const seed =
      this.options.voiceFor?.(this.embeds) ?? (this.embeds % 2 === 1 ? 'voice-one' : 'voice-two');
    return syntheticVoiceprint(seed);
  }
}
