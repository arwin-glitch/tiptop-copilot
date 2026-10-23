import type { SpeechSession, TranscriptEvent } from '@/lib/types/notes';
import type { SpeechDevice, SpeechModelChoice } from '@/lib/transcribe/models';
import type { LoadPhase } from './speech-protocol';

/**
 * One track's speech-to-text engine (D-076). On the device, for free:
 * 'browser-whisper' runs Whisper in a Web Worker (whisper-engine.ts); demo
 * mode's 'mock' plays the scripted call (mock-engine.ts). Audio goes in
 * (16 kHz PCM16 chunks), normalised TranscriptEvents come out with times
 * relative to the first audio this engine was sent. The track stream
 * (track-stream.ts) adds the recording-clock offset, replays the in-memory
 * buffer if an engine has to restart, and drops repeats.
 */

export interface SpeechEngineClose {
  /** True when we asked for it (finish or close); false when the engine stopped by itself. */
  expected: boolean;
  code: number;
  reason: string;
  /** Starting again can help (false when this computer cannot run the model at all). */
  retryable: boolean;
}

/** What an engine is doing, for the recorder's "Getting speech ready…" and "Finishing transcript…". */
export interface EngineStatus {
  phase: LoadPhase;
  /** 0..1 while the model downloads or loads; null when the size is not known. */
  progress: number | null;
  loadedMb: number;
  totalMb: number;
  device: SpeechDevice | null;
  model: SpeechModelChoice | null;
  /** Audio heard but not transcribed yet, in ms. */
  backlogMs: number;
  /** Why it runs differently from what was chosen, or why it failed, in plain words. */
  message: string | null;
}

export interface SpeechEngineHandlers {
  onEvent: (event: TranscriptEvent) => void;
  onClose: (info: SpeechEngineClose) => void;
  onStatus?: (status: EngineStatus) => void;
}

export interface SpeechEngine {
  /** Resolves once the engine takes audio (the model may still be loading); rejects if it never will. */
  open(): Promise<void>;
  /** One chunk of 16 kHz mono PCM16. Ignored unless open. */
  sendAudio(samples: Int16Array): void;
  /**
   * The audio is over: transcribe what is left and wait for the last lines.
   * On-device engines wait as long as the work keeps moving (never dropping
   * audio); `timeoutMs` bounds how long nothing may happen.
   */
  finish(timeoutMs: number): Promise<void>;
  /** Close at once; lines not yet transcribed are lost. */
  close(): void;
  readonly isOpen: boolean;
  /**
   * "Remember this voice" (D-076): one voice's voiceprint, by its cluster
   * label, from what this engine heard, or null. Nobody else's leaves.
   */
  voiceprint?(
    label: string,
    timeoutMs: number,
  ): Promise<{ voiceprint: string; modelVersion: string } | null>;
}

export interface SpeechEngineOptions {
  /** Where this engine's audio starts on the recording clock; only the mock needs it. */
  baseMs: number;
  /** The mock's playback speed (demo mode). */
  mockSpeed?: number;
}

export type SpeechEngineFactory = (
  session: SpeechSession,
  handlers: SpeechEngineHandlers,
  options: SpeechEngineOptions,
) => SpeechEngine;
