import type { SpeechSession } from '@/lib/types/notes';
import { baseSession, type SpeechSessionInput, type Transcriber } from './transcriber';

/**
 * Whisper in the recorder's browser (D-076): free, on the device, no key.
 * The session is only settings; which model runs (Fast, Better, Best) is the
 * recorder's own choice, kept on that computer (lib/capture/speech-preferences.ts),
 * because the model is downloaded and cached by that browser.
 */
export class BrowserWhisperTranscriber implements Transcriber {
  readonly provider = 'browser-whisper' as const;

  session(input: SpeechSessionInput): SpeechSession {
    return baseSession(this.provider, input, {});
  }
}
