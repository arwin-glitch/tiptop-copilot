import { NOTES_LIMITS, type SttSession, type TranscriptTrack } from '@/lib/types/notes';
import { err, ok, type Result } from '@/lib/util/result';
import {
  MINT_TIMEOUT_MS,
  SESSION_AUDIO,
  type MintSessionInput,
  type Transcriber,
} from './transcriber';

/**
 * AssemblyAI Universal-Streaming (D-076), the fallback and the cost lever.
 *
 * Minting: GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=60
 * with the long-lived key in Authorization returns a temporary token. It is
 * not single-use, so one is minted per session. The browser connects to
 * wss://streaming.assemblyai.com/v3/ws with the token and the settings below
 * as query parameters.
 * (https://www.assemblyai.com/docs/streaming/authenticate-with-a-temporary-token)
 *
 * Sessions: one per track, as AssemblyAI recommends; speaker labels on the
 * meeting audio and on a mixed track. It cannot recognise enrolled voices, so
 * known speakers are ignored here and names come from the rest of the ladder.
 * Billing runs while a socket is open, idle included, so the recorder closes
 * sockets on pause and on long silence. The account must opt out of model
 * training (zero retention for streaming).
 */

export const ASSEMBLYAI_TOKEN_URL = 'https://streaming.assemblyai.com/v3/token';
export const ASSEMBLYAI_SOCKET_URL = 'wss://streaming.assemblyai.com/v3/ws';

/** A session's longest life: a long board meeting, then the socket must be reopened. */
const MAX_SESSION_SECONDS = 3 * 60 * 60;

/** The socket's query parameters for one track. Exported for the tests. */
export function assemblyaiQuery(
  track: TranscriptTrack,
  vocabulary: string[],
): Record<string, string> {
  const query: Record<string, string> = {
    sample_rate: String(SESSION_AUDIO.sampleRate),
    encoding: SESSION_AUDIO.encoding,
    format_turns: 'true',
  };
  if (track !== 'mic') {
    query.speaker_labels = 'true';
    query.max_speakers = String(Math.min(NOTES_LIMITS.maxSpeakersPerSession, 10));
  }
  const terms = [...new Set(vocabulary.map((v) => v.trim()).filter(Boolean))].slice(0, 100);
  if (terms.length > 0) query.keyterms_prompt = JSON.stringify(terms);
  return query;
}

export class AssemblyAITranscriber implements Transcriber {
  readonly provider = 'assemblyai' as const;

  constructor(
    private readonly apiKey: string | undefined,
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
    if (input.purpose === 'enrollment') {
      // AssemblyAI tells voices apart within one session but cannot
      // recognise an enrolled voice in the next one.
      return err(
        'invalid_input',
        'Remembering a voice needs Speechmatics (TRANSCRIBER_PROVIDER=speechmatics).',
        { stillUsable: 'Names still come from the mic, the calendar and taps.' },
      );
    }
    const now = input.now ?? new Date();
    const url = new URL(ASSEMBLYAI_TOKEN_URL);
    url.searchParams.set('expires_in_seconds', String(NOTES_LIMITS.sttTokenTtlSeconds));
    url.searchParams.set('max_session_duration_seconds', String(MAX_SESSION_SECONDS));
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Authorization: this.apiKey },
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
        'The speech service refused the key. Check ASSEMBLYAI_API_KEY.',
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
    const body = (await response.json().catch(() => null)) as { token?: unknown } | null;
    const token = typeof body?.token === 'string' ? body.token : null;
    if (!token) {
      return err(
        'provider_unavailable',
        'The speech service answered without a token. Try again.',
        {
          retryable: true,
        },
      );
    }
    return ok({
      track: input.track,
      provider: 'assemblyai',
      wsUrl: ASSEMBLYAI_SOCKET_URL,
      token,
      expiresAt: new Date(now.getTime() + NOTES_LIMITS.sttTokenTtlSeconds * 1000).toISOString(),
      sessionConfig: { query: assemblyaiQuery(input.track, input.vocabulary) },
      audio: { ...SESSION_AUDIO },
    });
  }
}
