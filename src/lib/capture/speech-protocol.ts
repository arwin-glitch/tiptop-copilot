import type { KnownVoice, TranscriptEvent, TranscriptTrack } from '@/lib/types/notes';
import type { SpeechDevice, SpeechModelChoice } from '@/lib/transcribe/models';

/**
 * The messages between the page and the speech worker (D-076). Client-safe
 * and framework-free: the worker (src/workers/speech.worker.ts), the engine
 * that talks to it (whisper-engine.ts) and the tests all build against this.
 *
 * Only audio goes in and only text comes out. Audio stays in the worker's
 * memory until it is transcribed and is then dropped; nothing is stored.
 */

/** Which models run the pipeline: the real ones, or a fake for the tests and the demo. */
export type AdapterKind = 'transformers' | 'fake';

/** 'auto': WebGPU when the browser has it, otherwise WebAssembly. */
export type DevicePreference = 'auto' | SpeechDevice;

/**
 * How a stream is transcribed. 'notes' (the default): whole sentences with
 * timestamps, nothing dropped. 'wake': "Hey Arwin" listening, cut at short
 * pauses, short text without timestamps, and only the newest speech matters.
 */
export type StreamMode = 'notes' | 'wake';

export interface WorkerConfig {
  choice: SpeechModelChoice;
  device: DevicePreference;
  language: string;
  adapter: AdapterKind;
}

export type ToWorker =
  | { type: 'init'; config: WorkerConfig }
  | {
      type: 'start';
      streamId: string;
      track: TranscriptTrack;
      /** Tell voices apart (the meeting-audio and mixed tracks). */
      diarize: boolean;
      knownVoices: KnownVoice[];
      vocabulary: string[];
      /** Left out for 'notes'. */
      mode?: StreamMode;
    }
  | { type: 'audio'; streamId: string; samples: Int16Array }
  /** Transcribe what is left, then answer 'finished'. */
  | { type: 'finish'; streamId: string }
  | { type: 'close'; streamId: string }
  | { type: 'voiceprint'; streamId: string; requestId: number; label: string }
  /** "Test my setup": transcribe one short sample and say how long it took. */
  /** `warm`: only to warm the model up (short decode, the result is ignored). */
  | { type: 'test'; requestId: number; samples: Int16Array; warm?: boolean };

export type LoadPhase = 'loading' | 'ready' | 'failed';

export interface LoadStatus {
  phase: LoadPhase;
  /** 0..1 while downloading; null when the size is not known yet. */
  progress: number | null;
  loadedMb: number;
  totalMb: number;
  /** What actually runs, which can differ from the choice (Best without a graphics chip). */
  device: SpeechDevice | null;
  model: SpeechModelChoice | null;
  /** A plain-words reason when it failed, or why it fell back. */
  message: string | null;
}

export type FromWorker =
  | { type: 'status'; status: LoadStatus }
  | { type: 'started'; streamId: string }
  /** Times are ms from the stream's first sample. */
  | { type: 'event'; streamId: string; event: TranscriptEvent }
  /** Audio heard but not transcribed yet (ms), and audio transcribed so far (ms). */
  | { type: 'progress'; streamId: string; backlogMs: number; doneMs: number }
  | { type: 'finished'; streamId: string }
  | {
      type: 'voiceprint';
      requestId: number;
      voiceprint: string | null;
      modelVersion: string | null;
    }
  | {
      type: 'test-result';
      requestId: number;
      text: string;
      audioMs: number;
      elapsedMs: number;
      device: SpeechDevice | null;
      model: SpeechModelChoice | null;
    }
  /** The worker cannot go on (no model could load, the graphics chip was lost). */
  | { type: 'fatal'; message: string; retryable: boolean };
