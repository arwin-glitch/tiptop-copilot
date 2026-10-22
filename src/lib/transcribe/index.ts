import 'server-only';
import { env } from '@/lib/config/env';
import { AssemblyAITranscriber } from './assemblyai';
import { MockTranscriber } from './mock';
import { SpeechmaticsTranscriber } from './speechmatics';
import type { Transcriber } from './transcriber';

export type { KnownSpeaker, MintSessionInput, Transcriber } from './transcriber';

let override: Transcriber | null = null;

/**
 * Which transcriber this deployment uses. Demo mode always gets the mock, so
 * no test or demo ever reaches a vendor. Outside it, TRANSCRIBER_PROVIDER
 * picks the vendor (Speechmatics unless it says 'assemblyai'), and a missing
 * key gives an adapter that refuses every mint with a plain "not set up yet".
 */
export function getTranscriber(): Transcriber {
  if (override) return override;
  const e = env();
  if (e.demoMode) return new MockTranscriber();
  if (e.transcriberProvider === 'assemblyai') return new AssemblyAITranscriber(e.assemblyaiApiKey);
  return new SpeechmaticsTranscriber(e.speechmaticsApiKey, e.transcriberRegion);
}

/** Test hook: use this transcriber until reset with null. */
export function setTranscriberForTesting(transcriber: Transcriber | null): void {
  override = transcriber;
}
