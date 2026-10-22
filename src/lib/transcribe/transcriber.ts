import type { TranscriberProvider, TranscriptTrack, SttSession } from '@/lib/types/notes';
import type { Result } from '@/lib/util/result';

/**
 * The speech-to-text seam (D-076), server side.
 *
 * Audio never reaches the server: the browser streams it straight to the
 * vendor. What the server does is mint the short-lived credential that lets
 * the browser open that socket, and decide the session's settings (model,
 * diarization, which consented voices to recognise), so the long-lived key
 * stays in Render's environment and the settings stay in one place.
 *
 * Three implementations: `speechmatics` (the default; the only vendor that
 * names enrolled voices live), `assemblyai` (fallback and cost lever) and
 * `mock` (demo mode: no vendor at all, the recorder plays the scripted call).
 * getTranscriber (./index.ts) picks one; nothing else names a vendor.
 */

/** A consented, enrolled voice to recognise. `label` is the voice profile's id, never a name. */
export interface KnownSpeaker {
  label: string;
  identifiers: string[];
}

export interface MintSessionInput {
  meetingId: string;
  track: TranscriptTrack;
  /** BCP 47 language, 'en' by default. */
  language: string;
  /**
   * Consented voices on this meeting's invite plus the team, at most
   * NOTES_LIMITS.maxVoiceIdentifiersPerSession. Only the meeting-audio and
   * mixed tracks use them: every mic word is the recorder's.
   */
  knownSpeakers: KnownSpeaker[];
  /** Names and terms worth spelling right (portfolio companies, founders). */
  vocabulary: string[];
  now?: Date;
}

export interface Transcriber {
  readonly provider: TranscriberProvider;
  /** False when the vendor key is missing; mintSession then says so plainly. */
  available(): boolean;
  mintSession(input: MintSessionInput): Promise<Result<SttSession>>;
}

/** The audio every session expects: 16 kHz mono PCM16, little-endian. */
export const SESSION_AUDIO = { sampleRate: 16000, encoding: 'pcm_s16le', channels: 1 } as const;

/** How long a vendor call may take before minting gives up. */
export const MINT_TIMEOUT_MS = 8000;
