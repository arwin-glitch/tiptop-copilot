import { clusterKeyFor } from '@/lib/transcribe/cluster';
import {
  NOTES_LIMITS,
  type SegmentUpload,
  type SpeakerView,
  type TranscriptTrack,
  type UploadSegmentsResponse,
} from '@/lib/types/notes';
import type { ApiFailure, ApiResult } from './api-client';
import type { RecorderError, UploadSnapshot } from './types';

/**
 * Finished lines to the server (D-076): POST /segments every couple of
 * seconds, at most 200 lines a time.
 *
 * Each line gets its seq the first time it is sent, counting up from the
 * meeting's last stored seq, and keeps it for every retry. The server stores
 * on (meeting, seq) and counts a line it already has as a duplicate, so a
 * batch whose answer was lost can be sent again safely: no line is lost and
 * none is stored twice. Lines wait in memory (text only, never audio) while
 * the network is away, and go as soon as it is back.
 */

export interface LineForUpload {
  track: TranscriptTrack;
  speakerLabel: string | null;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
}

export type SendSegments = (
  segments: SegmentUpload[],
  options?: { keepalive?: boolean },
) => Promise<ApiResult<UploadSegmentsResponse>>;

export interface SegmentUploaderOptions {
  send: SendSegments;
  /** The first seq to use: the meeting's last stored seq + 1. */
  firstSeq: number;
  intervalMs?: number;
  maxBatch?: number;
  /** Retry waits, in order; the last repeats. */
  backoffMs?: number[];
  isOnline?: () => boolean;
  onChange?: (snapshot: UploadSnapshot) => void;
  onSpeakers?: (speakers: SpeakerView[]) => void;
  /** A line was given its seq (so the live view can show it as saved). */
  onAssigned?: (line: LineForUpload, seq: number) => void;
}

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000, 15_000, 30_000];
/** keepalive requests may carry at most 64 KB; a page closing sends what fits. */
const KEEPALIVE_BYTES = 60_000;

/** The upload shape of a line: whole milliseconds, never negative, text trimmed to the limit. */
export function toSegmentUpload(line: LineForUpload, seq: number): SegmentUpload {
  const startMs = Math.max(0, Math.round(line.startMs));
  const endMs = Math.max(startMs, Math.round(line.endMs));
  const text = line.text.trim().slice(0, NOTES_LIMITS.maxSegmentChars);
  const confidence =
    line.confidence == null || !Number.isFinite(line.confidence)
      ? null
      : Math.max(0, Math.min(1, line.confidence));
  return {
    seq,
    track: line.track,
    clusterKey: clusterKeyFor(line.track, line.speakerLabel),
    vendorLabel: line.speakerLabel,
    startMs,
    endMs,
    text,
    confidence,
    isFinal: true,
  };
}

export class SegmentUploader {
  private readonly queue: LineForUpload[] = [];
  /** Sent at least once, seq fixed, not yet confirmed. Oldest first. */
  private assigned: SegmentUpload[] = [];
  private nextSeq: number;
  private lastSeq: number | null;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private failures = 0;
  private retryAt = 0;
  private fatal: RecorderError | null = null;
  private readonly intervalMs: number;
  private readonly maxBatch: number;
  private readonly backoffMs: number[];
  private readonly onlineHandler = () => {
    this.retryAt = 0;
    void this.flush();
  };

  constructor(private readonly options: SegmentUploaderOptions) {
    this.nextSeq = Math.max(0, Math.floor(options.firstSeq));
    this.lastSeq = this.nextSeq > 0 ? this.nextSeq - 1 : null;
    this.intervalMs = options.intervalMs ?? NOTES_LIMITS.uploadIntervalMs;
    this.maxBatch = Math.min(
      options.maxBatch ?? NOTES_LIMITS.maxSegmentsPerRequest,
      NOTES_LIMITS.maxSegmentsPerRequest,
    );
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF;
  }

  /** Never go below seqs the server already has (a resumed recording). */
  raiseNextSeq(seq: number): void {
    if (this.assigned.length === 0 && seq > this.nextSeq) {
      this.nextSeq = Math.floor(seq);
      this.lastSeq = this.nextSeq - 1;
    }
  }

  get pending(): number {
    return this.queue.length + this.assigned.length;
  }

  snapshot(): UploadSnapshot {
    return {
      pending: this.pending,
      lastSeq: this.lastSeq,
      retrying: this.failures > 0 && !this.fatal,
      fatal: this.fatal,
    };
  }

  private changed(): void {
    this.options.onChange?.(this.snapshot());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.pending > 0) void this.flush();
    }, this.intervalMs);
    if (typeof window !== 'undefined') window.addEventListener('online', this.onlineHandler);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onlineHandler);
  }

  push(line: LineForUpload): void {
    if (!line.text.trim()) return;
    this.queue.push(line);
    this.changed();
  }

  /** Send what is waiting, once. Concurrent calls share the request in flight. */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.fatal || this.pending === 0) return Promise.resolve();
    if (Date.now() < this.retryAt) return Promise.resolve();
    if (this.options.isOnline && !this.options.isOnline()) return Promise.resolve();
    this.inFlight = this.sendOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** The batch to send: retries first, then new lines in the order they were said. */
  private nextBatch(): SegmentUpload[] {
    if (this.assigned.length < this.maxBatch && this.queue.length > 0) {
      const room = this.maxBatch - this.assigned.length;
      const fresh = this.queue.splice(0, room).sort((a, b) => a.startMs - b.startMs);
      for (const line of fresh) {
        const seq = this.nextSeq;
        this.nextSeq += 1;
        this.assigned.push(toSegmentUpload(line, seq));
        this.options.onAssigned?.(line, seq);
      }
    }
    return this.assigned.slice(0, this.maxBatch);
  }

  private async sendOnce(options: { keepalive?: boolean } = {}): Promise<void> {
    const batch = this.nextBatch();
    if (batch.length === 0) return;
    const result = await this.options.send(batch, options);
    if (result.ok) {
      const sent = new Set(batch.map((s) => s.seq));
      this.assigned = this.assigned.filter((s) => !sent.has(s.seq));
      const top = Math.max(...batch.map((s) => s.seq));
      this.lastSeq = Math.max(this.lastSeq ?? -1, top);
      this.failures = 0;
      this.retryAt = 0;
      this.options.onSpeakers?.(result.value.speakers);
      this.changed();
      return;
    }
    this.onFailure(result.error);
  }

  private onFailure(error: ApiFailure): void {
    if (!error.retryable) {
      this.fatal = { code: error.code, message: error.message, stillUsable: error.stillUsable };
      this.changed();
      return;
    }
    const wait = this.backoffMs[Math.min(this.failures, this.backoffMs.length - 1)] ?? 30_000;
    this.failures += 1;
    // A little jitter, so a server coming back is not hit by every retry at once.
    this.retryAt = Date.now() + wait + Math.floor(Math.random() * 250);
    this.changed();
  }

  /**
   * Send everything waiting, retrying through failures, until it is all
   * stored or `timeoutMs` passes. Answers how many lines are still waiting.
   */
  async drain(timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending > 0 && !this.fatal && Date.now() < deadline) {
      const waitFor = this.retryAt - Date.now();
      if (waitFor > 0) {
        await sleep(Math.min(waitFor, deadline - Date.now()));
        continue;
      }
      if (this.options.isOnline && !this.options.isOnline()) {
        await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
        continue;
      }
      await this.flush();
    }
    return this.pending;
  }

  /**
   * The page is closing: one last keepalive request with what fits. Whatever
   * does not fit is lost with the page, which the warning before leaving says.
   */
  flushOnPageHide(): void {
    if (this.pending === 0 || this.fatal) return;
    const batch = this.nextBatch();
    const fits: SegmentUpload[] = [];
    let bytes = 20;
    for (const s of batch) {
      bytes += JSON.stringify(s).length + 1;
      if (bytes > KEEPALIVE_BYTES) break;
      fits.push(s);
    }
    if (fits.length > 0) void this.options.send(fits, { keepalive: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
