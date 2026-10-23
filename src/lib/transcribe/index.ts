import 'server-only';
import { env } from '@/lib/config/env';
import { BrowserWhisperTranscriber } from './browser-whisper';
import { MockTranscriber } from './mock';
import type { Transcriber } from './transcriber';

export type { SpeechSessionInput, Transcriber } from './transcriber';

let override: Transcriber | null = null;

/**
 * Which transcriber this deployment uses. Demo mode always gets the mock, so
 * no test or demo ever downloads a model. Everywhere else it is Whisper in
 * the recorder's browser: there is no paid speech service to choose.
 */
export function getTranscriber(): Transcriber {
  if (override) return override;
  if (env().demoMode) return new MockTranscriber();
  return new BrowserWhisperTranscriber();
}

/** Test hook: use this transcriber until reset with null. */
export function setTranscriberForTesting(transcriber: Transcriber | null): void {
  override = transcriber;
}
