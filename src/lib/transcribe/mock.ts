import type { SpeechSession } from '@/lib/types/notes';
import { MOCK_CALL_ID, MOCK_ENROLLMENT_ID } from './mock-script';
import { baseSession, type SpeechSessionInput, type Transcriber } from './transcriber';

/**
 * Demo mode's transcriber: no model, no network. The session tells the
 * recorder to play the scripted call (./mock-script.ts) for this track.
 */
export class MockTranscriber implements Transcriber {
  readonly provider = 'mock' as const;

  session(input: SpeechSessionInput): SpeechSession {
    return baseSession(
      this.provider,
      input,
      input.purpose === 'enrollment'
        ? { script: MOCK_ENROLLMENT_ID, track: input.track, enrollment: true }
        : { script: MOCK_CALL_ID, track: input.track },
    );
  }
}
