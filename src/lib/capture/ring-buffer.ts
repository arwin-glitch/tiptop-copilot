import { SAMPLES_PER_MS } from './types';

/**
 * The reconnect buffer (D-076): the last 30 seconds of one track's audio, in
 * memory only, never written to disk or sent anywhere but the vendor socket.
 * When a socket drops, the new socket is fed the audio from where the vendor
 * last finished a line, so the transcript has no gap and no repeat.
 *
 * Positions are in samples of the recording's own clock (16 kHz, pauses
 * excluded), so a chunk's place never depends on when it arrived.
 */

export interface AudioChunk {
  /** Recording-clock sample index of the chunk's first sample. */
  startSample: number;
  samples: Int16Array;
  /** Loudness of the chunk (RMS, 0..1), to tell lost speech from lost silence. */
  rms: number;
}

/** Trimmed chunks with sound, remembered by position only (never their audio). */
interface LoudSpan {
  start: number;
  end: number;
}

const LOUD_SPANS_KEPT = 600;

export class AudioRingBuffer {
  private chunks: AudioChunk[] = [];
  private readonly keepSamples: number;
  private loudTrimmed: LoudSpan[] = [];

  constructor(
    keepMs: number,
    private readonly loudThreshold = 0.004,
  ) {
    this.keepSamples = Math.max(0, Math.round(keepMs * SAMPLES_PER_MS));
  }

  push(chunk: AudioChunk): void {
    this.chunks.push(chunk);
    const end = chunk.startSample + chunk.samples.length;
    const keepFrom = end - this.keepSamples;
    let drop = 0;
    while (drop < this.chunks.length) {
      const c = this.chunks[drop];
      if (!c || c.startSample + c.samples.length > keepFrom) break;
      if (c.rms > this.loudThreshold) {
        const last = this.loudTrimmed[this.loudTrimmed.length - 1];
        const cEnd = c.startSample + c.samples.length;
        if (last && last.end === c.startSample) last.end = cEnd;
        else this.loudTrimmed.push({ start: c.startSample, end: cEnd });
      }
      drop += 1;
    }
    if (drop > 0) this.chunks.splice(0, drop);
    if (this.loudTrimmed.length > LOUD_SPANS_KEPT) {
      this.loudTrimmed.splice(0, this.loudTrimmed.length - LOUD_SPANS_KEPT);
    }
  }

  /** Where the buffer starts, or null when empty. */
  oldestSample(): number | null {
    return this.chunks[0]?.startSample ?? null;
  }

  /** Where the buffer ends (one past the last sample), or null when empty. */
  newestSample(): number | null {
    const last = this.chunks[this.chunks.length - 1];
    return last ? last.startSample + last.samples.length : null;
  }

  /**
   * Samples with sound that have left the buffer after `fromSample`: speech
   * a reconnect from `fromSample` can no longer replay. Silence that left the
   * buffer is not a loss worth reporting.
   */
  loudTrimmedAfter(fromSample: number): number {
    let total = 0;
    for (const span of this.loudTrimmed) {
      if (span.end <= fromSample) continue;
      total += span.end - Math.max(span.start, fromSample);
    }
    return total;
  }

  /**
   * The chunks covering `fromSample` onward. The first chunk may start a
   * little before it: a chunk is never cut, so the vendor hears whole chunks
   * and the first words may repeat by a fraction of a second, which the
   * recorder's de-duplication absorbs.
   */
  from(fromSample: number): AudioChunk[] {
    const out: AudioChunk[] = [];
    for (const c of this.chunks) {
      if (c.startSample + c.samples.length <= fromSample) continue;
      out.push(c);
    }
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.loudTrimmed = [];
  }

  get size(): number {
    return this.chunks.length;
  }
}
