import type { SttSession, TranscriberProvider, TranscriptTrack } from '@/lib/types/notes';
import type { ApiFailure, ApiResult } from './api-client';

/**
 * Speech keys for the recorder's tracks (D-076). Keys come from POST
 * /stt-token, 30 an hour per person, so requests that arrive together (both
 * tracks dropping when the network goes) share one call.
 */

export type MintTokens = (
  tracks: TranscriptTrack[],
) => Promise<ApiResult<{ provider: TranscriberProvider; sessions: SttSession[] }>>;

type Waiter = {
  track: TranscriptTrack;
  resolve: (result: ApiResult<SttSession>) => void;
};

export class TokenBroker {
  private waiting: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly mint: MintTokens,
    private readonly gatherMs = 120,
  ) {}

  /** A fresh session for one track; joins any request made in the next moment. */
  request(track: TranscriptTrack): Promise<ApiResult<SttSession>> {
    return new Promise((resolve) => {
      this.waiting.push({ track, resolve });
      if (!this.timer) this.timer = setTimeout(() => void this.run(), this.gatherMs);
    });
  }

  /** Sessions for several tracks in one call (start and resume). */
  async requestMany(tracks: TranscriptTrack[]): Promise<ApiResult<SttSession[]>> {
    const result = await this.mint(tracks);
    if (!result.ok) return result;
    const sessions: SttSession[] = [];
    for (const track of tracks) {
      const session = result.value.sessions.find((s) => s.track === track);
      if (!session) return { ok: false, error: missing(track) };
      sessions.push(session);
    }
    return { ok: true, value: sessions };
  }

  private async run(): Promise<void> {
    this.timer = null;
    const batch = this.waiting;
    this.waiting = [];
    const tracks = [...new Set(batch.map((w) => w.track))];
    if (tracks.length === 0) return;
    const result = await this.mint(tracks);
    for (const w of batch) {
      if (!result.ok) {
        w.resolve(result);
        continue;
      }
      const session = result.value.sessions.find((s) => s.track === w.track);
      w.resolve(session ? { ok: true, value: session } : { ok: false, error: missing(w.track) });
    }
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.waiting;
    this.waiting = [];
    for (const w of batch) {
      w.resolve({
        ok: false,
        error: { code: 'cancelled', message: 'Stopped.', status: 0, retryable: false },
      });
    }
  }
}

function missing(track: TranscriptTrack): ApiFailure {
  return {
    code: 'missing_session',
    message: `Copilot did not return a speech session for the ${track} track.`,
    status: 200,
    retryable: true,
  };
}
