import type { SpeechSession, TranscriberProvider, TranscriptTrack } from '@/lib/types/notes';
import type { ApiFailure, ApiResult } from './api-client';

/**
 * Each track's speech settings for one recording (D-076), from POST
 * /speech-setup: asked once at the start and kept, so an engine that has to
 * restart, or a resume after a pause, starts at once without asking again.
 * Requests that arrive together (both tracks restarting) share one call.
 */

export type FetchSpeechSetup = (
  tracks: TranscriptTrack[],
) => Promise<ApiResult<{ provider: TranscriberProvider; sessions: SpeechSession[] }>>;

export class SpeechSetupCache {
  private readonly sessions = new Map<TranscriptTrack, SpeechSession>();
  private inflight: Promise<ApiResult<SpeechSession[]>> | null = null;
  private cancelled = false;

  constructor(private readonly fetchSetup: FetchSpeechSetup) {}

  /** Settings for several tracks (start and resume): from memory, or one call for the rest. */
  async requestMany(tracks: TranscriptTrack[]): Promise<ApiResult<SpeechSession[]>> {
    if (this.cancelled) return { ok: false, error: cancelled() };
    const missing = tracks.filter((t) => !this.sessions.has(t));
    if (missing.length > 0) {
      const result = await this.fetch(missing);
      if (!result.ok) return result;
    }
    const out: SpeechSession[] = [];
    for (const track of tracks) {
      const session = this.sessions.get(track);
      if (!session) return { ok: false, error: missingSession(track) };
      out.push(session);
    }
    return { ok: true, value: out };
  }

  /** Settings for one track (an engine restarting). */
  async request(track: TranscriptTrack): Promise<ApiResult<SpeechSession>> {
    const result = await this.requestMany([track]);
    if (!result.ok) return result;
    const session = result.value[0];
    return session ? { ok: true, value: session } : { ok: false, error: missingSession(track) };
  }

  private fetch(tracks: TranscriptTrack[]): Promise<ApiResult<SpeechSession[]>> {
    if (this.inflight) {
      // One call at a time; whatever it lacks is asked for after it.
      return this.inflight.then(() => this.requestMany(tracks));
    }
    const run = (async (): Promise<ApiResult<SpeechSession[]>> => {
      const result = await this.fetchSetup(tracks);
      if (!result.ok) return result;
      for (const session of result.value.sessions) this.sessions.set(session.track, session);
      return { ok: true, value: result.value.sessions };
    })();
    this.inflight = run;
    void run.finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    return run;
  }

  /** The provider of the sessions in memory, if any. */
  get provider(): TranscriberProvider | null {
    return this.sessions.values().next().value?.provider ?? null;
  }

  cancel(): void {
    this.cancelled = true;
  }
}

function cancelled(): ApiFailure {
  return { code: 'cancelled', message: 'Stopped.', status: 0, retryable: false };
}

function missingSession(track: TranscriptTrack): ApiFailure {
  return {
    code: 'missing_session',
    message: `Copilot did not return speech settings for the ${track} track.`,
    status: 200,
    retryable: true,
  };
}
