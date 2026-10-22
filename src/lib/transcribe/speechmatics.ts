import { NOTES_LIMITS, type SttSession, type TranscriptTrack } from '@/lib/types/notes';
import { err, ok, type Result } from '@/lib/util/result';
import {
  MINT_TIMEOUT_MS,
  SESSION_AUDIO,
  type KnownSpeaker,
  type MintSessionInput,
  type Transcriber,
} from './transcriber';

/**
 * Speechmatics realtime (D-076), the default vendor.
 *
 * Minting: POST https://mp.speechmatics.com/v1/api_keys?type=rt with {"ttl":60}
 * and the long-lived key as a Bearer token returns a temporary key
 * (`key_value`) that opens one realtime socket for the next 60 seconds. The
 * browser then connects to wss://<region>.rt.speechmatics.com/v2?jwt=<key>
 * and sends the StartRecognition below as its first message.
 * (https://docs.speechmatics.com/introduction/authentication)
 *
 * Sessions: the mic is one person, so no diarization and the standard
 * operating point. The meeting audio (and a single mixed track) is diarized
 * on the enhanced operating point, with up to 8 unknown voices and the
 * identifiers of consented, enrolled people, labelled by their voice
 * profile's id so no name ever reaches the vendor.
 * (https://docs.speechmatics.com/speech-to-text/realtime/speaker-identification)
 *
 * Realtime audio is not stored by Speechmatics unless the account opts into
 * model training, which it must not (see human setup in DECISIONS.md D-076).
 * The operating points are first guesses, settled by the bake-off.
 */

export const SPEECHMATICS_MINT_URL = 'https://mp.speechmatics.com/v1/api_keys?type=rt';

export function speechmaticsSocketUrl(region: string): string {
  return `wss://${region}.rt.speechmatics.com/v2`;
}

/** The StartRecognition message for one track. Exported for the tests. */
export function speechmaticsStartRecognition(
  track: TranscriptTrack,
  language: string,
  knownSpeakers: KnownSpeaker[],
  vocabulary: string[],
): Record<string, unknown> {
  const diarized = track !== 'mic';
  const speakers = diarized
    ? knownSpeakers
        .filter((s) => s.identifiers.length > 0)
        .slice(0, NOTES_LIMITS.maxVoiceIdentifiersPerSession)
        .map((s) => ({ label: s.label, speaker_identifiers: s.identifiers }))
    : [];
  const vocab = [...new Set(vocabulary.map((v) => v.trim()).filter(Boolean))]
    .slice(0, 1000)
    .map((content) => ({ content }));
  return {
    message: 'StartRecognition',
    audio_format: {
      type: 'raw',
      encoding: SESSION_AUDIO.encoding,
      sample_rate: SESSION_AUDIO.sampleRate,
    },
    transcription_config: {
      language: language.split('-')[0] || 'en',
      operating_point: diarized ? 'enhanced' : 'standard',
      enable_partials: true,
      max_delay: 2,
      ...(diarized
        ? {
            diarization: 'speaker',
            speaker_diarization_config: {
              max_speakers: NOTES_LIMITS.maxSpeakersPerSession,
              ...(speakers.length > 0 ? { speakers } : {}),
            },
          }
        : {}),
      ...(vocab.length > 0 ? { additional_vocab: vocab } : {}),
    },
  };
}

export class SpeechmaticsTranscriber implements Transcriber {
  readonly provider = 'speechmatics' as const;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly region: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  available(): boolean {
    return Boolean(this.apiKey);
  }

  async mintSession(input: MintSessionInput): Promise<Result<SttSession>> {
    if (!this.apiKey) {
      return err(
        'not_configured',
        'Recording is not set up yet: the speech-to-text key is missing.',
        {
          stillUsable: 'Typed notes and Granola notes still work.',
        },
      );
    }
    const now = input.now ?? new Date();
    let response: Response;
    try {
      response = await this.fetchImpl(SPEECHMATICS_MINT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: NOTES_LIMITS.sttTokenTtlSeconds }),
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch {
      return err('provider_unavailable', 'The speech service did not answer. Try again.', {
        retryable: true,
      });
    }
    if (response.status === 401 || response.status === 403) {
      return err(
        'provider_unauthorized',
        'The speech service refused the key. Check SPEECHMATICS_API_KEY.',
      );
    }
    if (!response.ok) {
      return err(
        'provider_unavailable',
        'The speech service could not start a session. Try again.',
        {
          retryable: true,
          details: { status: response.status },
        },
      );
    }
    const body = (await response.json().catch(() => null)) as { key_value?: unknown } | null;
    const token = typeof body?.key_value === 'string' ? body.key_value : null;
    if (!token) {
      return err('provider_unavailable', 'The speech service answered without a key. Try again.', {
        retryable: true,
      });
    }
    return ok({
      track: input.track,
      provider: 'speechmatics',
      wsUrl: speechmaticsSocketUrl(this.region),
      token,
      expiresAt: new Date(now.getTime() + NOTES_LIMITS.sttTokenTtlSeconds * 1000).toISOString(),
      sessionConfig: {
        startRecognition: speechmaticsStartRecognition(
          input.track,
          input.language,
          input.knownSpeakers,
          input.vocabulary,
        ),
      },
      audio: { ...SESSION_AUDIO },
    });
  }
}
