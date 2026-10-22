import type { TranscriberProvider } from '@/lib/types/notes';
import { AssemblyAISocket } from './assemblyai-socket';
import { MockSpeechSocket } from './mock-socket';
import type { SpeechSocketFactory } from './speech-socket';
import { SpeechmaticsSocket } from './speechmatics-socket';

/** The socket for a session's vendor. The server decides the vendor; the browser follows it. */
export const createSpeechSocket: SpeechSocketFactory = (session, handlers, options) => {
  switch (session.provider) {
    case 'speechmatics':
      return new SpeechmaticsSocket(session, handlers, options);
    case 'assemblyai':
      return new AssemblyAISocket(session, handlers, options);
    case 'mock':
      return new MockSpeechSocket(session, handlers, options);
  }
};

/**
 * How fast a reconnect may replay the buffer, as a multiple of real time.
 * Both vendors expect roughly real-time audio and buffer only so much, so the
 * catch-up is gentle: 30 seconds of backlog clears in about 30 s at 2x and
 * 60 s at 1.5x while live audio keeps arriving. The human smoke test with a
 * real key confirms both. The mock hears instantly.
 */
export function replaySpeedFor(provider: TranscriberProvider): number {
  if (provider === 'speechmatics') return 2;
  if (provider === 'assemblyai') return 1.5;
  return Number.POSITIVE_INFINITY;
}
