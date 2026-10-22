import type {
  KnownVoice,
  SpeechSession,
  TranscriberProvider,
  TranscriptTrack,
} from '@/lib/types/notes';

/**
 * The speech-to-text seam (D-076), server side.
 *
 * Nothing here costs money and nothing here touches audio. Speech is turned
 * into text in the recorder's own browser, by Whisper in a Web Worker
 * (lib/capture/whisper-engine.ts), and only finished lines of text reach the
 * server. What the server decides is each track's settings: the language, the
 * names worth spelling right, and which consented, enrolled voices the worker
 * should recognise, so that list is built where consent is checked.
 *
 * Two implementations: `browser-whisper` (everywhere outside demo mode) and
 * `mock` (demo mode: no model at all, the recorder plays the scripted call).
 * getTranscriber (./index.ts) picks one.
 */

export interface SpeechSessionInput {
  meetingId: string;
  track: TranscriptTrack;
  /** BCP 47 language, 'en' by default. */
  language: string;
  /**
   * Consented voices on this meeting's invite plus the team, at most
   * NOTES_LIMITS.maxVoiceIdentifiersPerSession. Only the meeting-audio and
   * mixed tracks get them: every mic word is the recorder's.
   */
  knownVoices: KnownVoice[];
  /** Names and terms worth spelling right (portfolio companies, founders). */
  vocabulary: string[];
  /**
   * 'enrollment': a short solo clip of one consented person, so the recorder
   * can ask its speech worker for that voice's voiceprint and post it to
   * /api/notes/voice-profiles/enroll. 'meeting' (the default): a recording.
   */
  purpose?: 'meeting' | 'enrollment';
}

export interface Transcriber {
  readonly provider: TranscriberProvider;
  session(input: SpeechSessionInput): SpeechSession;
}

/** The audio every engine takes: 16 kHz mono PCM16, little-endian. */
export const SESSION_AUDIO = { sampleRate: 16000, encoding: 'pcm_s16le', channels: 1 } as const;

/** Vocabulary terms one session carries. */
export const MAX_VOCABULARY = 100;

/** The parts of a session every provider shares. */
export function baseSession(
  provider: TranscriberProvider,
  input: SpeechSessionInput,
  sessionConfig: Record<string, unknown>,
): SpeechSession {
  return {
    track: input.track,
    provider,
    language: input.language || 'en',
    vocabulary: input.vocabulary.slice(0, MAX_VOCABULARY),
    knownVoices: input.track === 'mic' ? [] : input.knownVoices,
    sessionConfig,
    audio: { ...SESSION_AUDIO },
  };
}
