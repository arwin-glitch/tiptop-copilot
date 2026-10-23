import { NOTES_API } from '@/lib/notes/api';
import type {
  ListSegmentsResponse,
  MeetingResponse,
  NotesApiError,
  SegmentUpload,
  StartRecordingRequest,
  StopRecordingRequest,
  StopRecordingResponse,
  SpeechSetupResponse,
  TranscriptTrack,
  UploadSegmentsResponse,
} from '@/lib/types/notes';

/**
 * The recorder's calls to WS1's /api/notes routes (D-076), typed against the
 * day-0 contract. Every call answers a result instead of throwing, and says
 * whether trying again can help: a dropped connection or a busy server can,
 * a refusal (consent missing, never-record, the meeting stopped elsewhere)
 * cannot.
 */

export interface ApiFailure {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
  stillUsable?: string;
  details?: Record<string, string | number | boolean | null>;
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiFailure };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const RETRYABLE_STATUS = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

export class NotesClient {
  constructor(private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)) {}

  private async call<T>(
    url: string,
    method: 'GET' | 'POST',
    body?: unknown,
    options: { keepalive?: boolean } = {},
  ): Promise<ApiResult<T>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        keepalive: options.keepalive,
      });
    } catch {
      return {
        ok: false,
        error: {
          code: 'network',
          message: 'Copilot could not be reached. Retrying.',
          status: 0,
          retryable: true,
        },
      };
    }
    const json = (await response.json().catch(() => null)) as
      (T & { ok: true }) | NotesApiError | null;
    if (response.ok && json && (json as { ok?: unknown }).ok === true) {
      return { ok: true, value: json as T };
    }
    const error = json && json.ok === false ? json.error : null;
    return {
      ok: false,
      error: {
        code: error?.code ?? `http_${response.status}`,
        message: error?.message ?? `Copilot answered ${response.status}.`,
        status: response.status,
        retryable: error?.retryable === true || RETRYABLE_STATUS.has(response.status),
        stillUsable: error?.stillUsable,
        details: error?.details,
      },
    };
  }

  start(meetingId: string, body: StartRecordingRequest) {
    return this.call<MeetingResponse>(NOTES_API.start(meetingId), 'POST', body);
  }

  pause(meetingId: string, paused: boolean, options: { keepalive?: boolean } = {}) {
    return this.call<MeetingResponse>(NOTES_API.pause(meetingId), 'POST', { paused }, options);
  }

  stop(meetingId: string, body: StopRecordingRequest) {
    return this.call<StopRecordingResponse>(NOTES_API.stop(meetingId), 'POST', body);
  }

  speechSetup(meetingId: string, tracks: TranscriptTrack[]) {
    return this.call<SpeechSetupResponse>(NOTES_API.speechSetup(meetingId), 'POST', { tracks });
  }

  uploadSegments(
    meetingId: string,
    segments: SegmentUpload[],
    options: { keepalive?: boolean } = {},
  ) {
    return this.call<UploadSegmentsResponse>(
      NOTES_API.segments(meetingId),
      'POST',
      { segments },
      options,
    );
  }

  listSegments(meetingId: string, after: number, limit: number) {
    const url = `${NOTES_API.segments(meetingId)}?after=${after}&limit=${limit}`;
    return this.call<ListSegmentsResponse>(url, 'GET');
  }
}
