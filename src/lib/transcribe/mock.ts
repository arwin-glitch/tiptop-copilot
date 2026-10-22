import { randomBytes } from 'node:crypto';
import { NOTES_LIMITS, type SttSession } from '@/lib/types/notes';
import { ok, type Result } from '@/lib/util/result';
import { MOCK_CALL_ID } from './mock-script';
import { SESSION_AUDIO, type MintSessionInput, type Transcriber } from './transcriber';

/**
 * Demo mode's transcriber: no vendor, no network. The "token" opens nothing;
 * it tells the recorder to play the scripted call (./mock-script.ts) for
 * this track instead of opening a socket.
 */
export class MockTranscriber implements Transcriber {
  readonly provider = 'mock' as const;

  available(): boolean {
    return true;
  }

  async mintSession(input: MintSessionInput): Promise<Result<SttSession>> {
    const now = input.now ?? new Date();
    return ok({
      track: input.track,
      provider: 'mock',
      wsUrl: null,
      token: `mock_${randomBytes(12).toString('hex')}`,
      expiresAt: new Date(now.getTime() + NOTES_LIMITS.sttTokenTtlSeconds * 1000).toISOString(),
      sessionConfig: { script: MOCK_CALL_ID, track: input.track },
      audio: { ...SESSION_AUDIO },
    });
  }
}
