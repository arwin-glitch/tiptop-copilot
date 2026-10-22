import { MockSpeechEngine } from './mock-engine';
import type { SpeechEngineFactory } from './speech-engine';
import { WhisperEngine, type WhisperEngineOptions } from './whisper-engine';

/** The engine for a session's provider. The server decides the provider; the browser follows it. */
export const createSpeechEngine: SpeechEngineFactory = (session, handlers, options) => {
  switch (session.provider) {
    case 'browser-whisper':
      return new WhisperEngine(session, handlers, options);
    case 'mock':
      return new MockSpeechEngine(session, handlers, options);
  }
};

/**
 * An engine factory that always runs Whisper in the browser, whatever the
 * server said: demo mode's sound-check page uses it to try the on-device
 * engine end to end (with the fake model in the tests, the real one for a
 * person checking their computer).
 */
export function whisperEngineFactory(
  extra: Omit<WhisperEngineOptions, 'baseMs' | 'mockSpeed'>,
): SpeechEngineFactory {
  return (session, handlers, options) =>
    new WhisperEngine({ ...session, provider: 'browser-whisper' }, handlers, {
      ...options,
      ...extra,
    });
}
