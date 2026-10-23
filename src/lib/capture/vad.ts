/**
 * Voice-activity chunking for on-device Whisper (D-076). Pure and
 * client-safe: the speech worker runs it, the tests drive it with numbers.
 *
 * Whisper reads up to 30 seconds at a time and does best on whole sentences,
 * so the worker feeds it stretches of speech cut where people pause: at least
 * `minChunkMs` (about 5 s) unless a turn plainly ended, at most `maxChunkMs`
 * (about 25 s). Silence between stretches is never sent at all: it costs time
 * and is where Whisper invents words ("Thank you.").
 *
 * Speech is told from silence by loudness against an adaptive noise floor
 * (a room hum or a quiet fan raises the floor; a voice stands well above it),
 * with hysteresis so one quiet syllable does not end a sentence.
 *
 * When a stretch hits the maximum without a pause, it is cut at its quietest
 * moment near the end and the next stretch starts `overlapMs` earlier, so a
 * word cut in half is heard whole in the next one; the worker drops the words
 * the two stretches share (text-dedupe.ts).
 *
 * Every sample is accounted for: `startSample` is on the stream's own clock
 * (16 kHz samples since the stream started), so the worker can put each line
 * back on the recording's clock exactly.
 */

export const VAD_RATE = 16_000;
const FRAME_SAMPLES = 320; // 20 ms

export interface VadOptions {
  minChunkMs: number;
  maxChunkMs: number;
  /** A pause this long ends a chunk once it is at least minChunkMs long. */
  pauseCutMs: number;
  /** A pause this long ends a chunk whatever its length: the turn is over. */
  endOfTurnMs: number;
  /** Audio kept before the first loud frame, so the first consonant is not clipped. */
  preRollMs: number;
  /** A forced cut (no pause) starts the next chunk this much earlier. */
  overlapMs: number;
  /** A chunk with less speech than this is dropped as a click or a cough. */
  minSpeechMs: number;
  /** Loudness (RMS, -1..1 scale) below which a frame is never speech: about -50 dBFS. */
  absoluteFloor: number;
  /** A frame is speech when it is this many times louder than the noise floor. */
  floorRatio: number;
  /** Loud frames in a row before speech starts. */
  onsetFrames: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  minChunkMs: 5000,
  maxChunkMs: 25_000,
  pauseCutMs: 500,
  endOfTurnMs: 1500,
  preRollMs: 200,
  overlapMs: 1000,
  minSpeechMs: 300,
  absoluteFloor: 0.003,
  floorRatio: 3,
  onsetFrames: 2,
};

export interface SpeechChunk {
  /** Stream-clock sample where the chunk's audio starts. */
  startSample: number;
  /** 16 kHz mono, -1..1. */
  audio: Float32Array;
  /** Loud audio in the chunk, in ms. */
  speechMs: number;
  /** Cut at the maximum length rather than at a pause: the next chunk overlaps it. */
  forced: boolean;
  /** Samples at the start that repeat the end of the previous chunk (after a forced cut). */
  overlapSamples: number;
}

const msToSamples = (ms: number) => Math.round((ms / 1000) * VAD_RATE);

/** Frame loudness, on the -1..1 scale. */
function frameRms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = frame[i] ?? 0;
    sum += v * v;
  }
  return frame.length ? Math.sqrt(sum / frame.length) : 0;
}

/** PCM16 to float, -1..1. */
export function int16ToFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i] ?? 0;
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  return out;
}

/** A growable buffer of float samples. */
class SampleBuffer {
  private data = new Float32Array(VAD_RATE * 4);
  length = 0;

  push(samples: Float32Array): void {
    if (this.length + samples.length > this.data.length) {
      let size = this.data.length * 2;
      while (size < this.length + samples.length) size *= 2;
      const next = new Float32Array(size);
      next.set(this.data.subarray(0, this.length));
      this.data = next;
    }
    this.data.set(samples, this.length);
    this.length += samples.length;
  }

  slice(from: number, to: number): Float32Array {
    return this.data.slice(Math.max(0, from), Math.min(this.length, to));
  }

  /** Drop the first `count` samples. */
  shift(count: number): void {
    const n = Math.min(this.length, Math.max(0, count));
    this.data.copyWithin(0, n, this.length);
    this.length -= n;
  }
}

export class VadChunker {
  private readonly o: VadOptions;
  /** Stream-clock sample of buffer[0]. */
  private bufferStart = 0;
  private readonly buffer = new SampleBuffer();
  /** Samples of the current frame not yet complete. */
  private partialFrame = new Float32Array(0);
  /** Stream-clock sample where the next complete frame starts. */
  private nextFrameSample = 0;

  private noiseFloor: number;
  /** Quietest frame of each 200 ms block over the last 5 s: the floor is their minimum. */
  private blockMins: number[] = [];
  private blockMin = Number.POSITIVE_INFINITY;
  private blockFrames = 0;
  private loudRun = 0;
  private quietRun = 0;
  private inSpeech = false;
  /** Stream-clock sample where the open chunk starts, or null with no chunk open. */
  private chunkStart: number | null = null;
  private chunkOverlap = 0;
  private speechSamples = 0;
  /** Quietest frame seen near the end of the open chunk: [sample, rms]. */
  private frameLog: { sample: number; rms: number }[] = [];

  constructor(options: Partial<VadOptions> = {}) {
    this.o = { ...DEFAULT_VAD_OPTIONS, ...options };
    this.noiseFloor = this.o.absoluteFloor;
  }

  /** Stream-clock samples taken in so far. */
  get receivedSamples(): number {
    return this.nextFrameSample + this.partialFrame.length;
  }

  /** Samples of the open chunk (speech waiting for a cut), for the backlog. */
  get pendingSamples(): number {
    return this.chunkStart === null ? 0 : this.receivedSamples - this.chunkStart;
  }

  /** Whether a chunk is open (someone is mid-sentence). */
  get open(): boolean {
    return this.chunkStart !== null;
  }

  /** The open chunk's audio so far, for a live partial. Null with no chunk open. */
  current(): SpeechChunk | null {
    if (this.chunkStart === null) return null;
    const from = this.chunkStart - this.bufferStart;
    return {
      startSample: this.chunkStart,
      audio: this.buffer.slice(from, this.buffer.length),
      speechMs: (this.speechSamples / VAD_RATE) * 1000,
      forced: false,
      overlapSamples: this.chunkOverlap,
    };
  }

  /** Take audio in (16 kHz, -1..1); returns the chunks it completed. */
  push(samples: Float32Array): SpeechChunk[] {
    const out: SpeechChunk[] = [];
    this.buffer.push(samples);
    let input = samples;
    if (this.partialFrame.length) {
      const joined = new Float32Array(this.partialFrame.length + samples.length);
      joined.set(this.partialFrame);
      joined.set(samples, this.partialFrame.length);
      input = joined;
    }
    let offset = 0;
    while (offset + FRAME_SAMPLES <= input.length) {
      const frame = input.subarray(offset, offset + FRAME_SAMPLES);
      const chunk = this.frame(frame, this.nextFrameSample);
      if (chunk) out.push(chunk);
      this.nextFrameSample += FRAME_SAMPLES;
      offset += FRAME_SAMPLES;
    }
    this.partialFrame = input.slice(offset);
    this.trimBuffer();
    return out;
  }

  /** The stream ended: close the open chunk, if it holds speech. */
  flush(): SpeechChunk[] {
    if (this.chunkStart === null) return [];
    const end = this.receivedSamples;
    const chunk = this.cut(end, end, false);
    return chunk ? [chunk] : [];
  }

  private isLoud(rms: number): boolean {
    return rms > Math.max(this.o.absoluteFloor, this.noiseFloor * this.o.floorRatio);
  }

  /**
   * The noise floor, by minimum statistics: speech always has gaps between
   * words, so the quietest moments of the last few seconds are the room. A
   * steady fan raises it; a voice does not.
   */
  private trackFloor(rms: number): void {
    this.blockMin = Math.min(this.blockMin, rms);
    this.blockFrames += 1;
    if (this.blockFrames < 10) return;
    this.blockMins.push(this.blockMin);
    if (this.blockMins.length > 25) this.blockMins.shift();
    this.blockMin = Number.POSITIVE_INFINITY;
    this.blockFrames = 0;
    // Down at once; up by at most about 1 dB a block, so a long loud stretch
    // cannot teach the floor that speech is the room.
    const target = Math.max(this.o.absoluteFloor / 4, Math.min(...this.blockMins));
    this.noiseFloor = target < this.noiseFloor ? target : Math.min(target, this.noiseFloor * 1.12);
  }

  private frame(frame: Float32Array, sample: number): SpeechChunk | null {
    const rms = frameRms(frame);
    const loud = this.isLoud(rms);
    this.trackFloor(rms);
    if (loud) {
      this.loudRun += 1;
      this.quietRun = 0;
    } else {
      this.quietRun += 1;
      this.loudRun = 0;
    }
    if (!this.inSpeech && this.loudRun >= this.o.onsetFrames) {
      this.inSpeech = true;
      if (this.chunkStart === null) {
        const onset = sample - (this.o.onsetFrames - 1) * FRAME_SAMPLES;
        this.chunkStart = Math.max(this.bufferStart, onset - msToSamples(this.o.preRollMs));
        this.chunkOverlap = 0;
        this.speechSamples = 0;
        this.frameLog = [];
      }
    } else if (this.inSpeech && this.quietRun * FRAME_SAMPLES >= msToSamples(this.o.pauseCutMs)) {
      this.inSpeech = false;
    }
    if (this.chunkStart === null) return null;
    if (loud) this.speechSamples += FRAME_SAMPLES;
    this.frameLog.push({ sample, rms });
    if (this.frameLog.length > 200) this.frameLog.splice(0, this.frameLog.length - 200);

    const frameEnd = sample + FRAME_SAMPLES;
    const length = frameEnd - this.chunkStart;
    const quietMs = (this.quietRun * FRAME_SAMPLES * 1000) / VAD_RATE;
    // A pause after enough speech, or a turn plainly over: cut in the middle of the pause.
    if (
      (length >= msToSamples(this.o.minChunkMs) && quietMs >= this.o.pauseCutMs) ||
      quietMs >= this.o.endOfTurnMs
    ) {
      const pauseStart = frameEnd - this.quietRun * FRAME_SAMPLES;
      const cutAt = pauseStart + Math.round((frameEnd - pauseStart) / 2);
      return this.cut(cutAt, cutAt, false);
    }
    // Too long without a pause: cut at the quietest moment of the last 3 seconds.
    if (length >= msToSamples(this.o.maxChunkMs)) {
      const window = this.frameLog.filter((f) => f.sample >= frameEnd - msToSamples(3000));
      let quietest = window[window.length - 1] ?? { sample, rms };
      for (const f of window) if (f.rms < quietest.rms) quietest = f;
      const cutAt = Math.max(this.chunkStart + msToSamples(1000), quietest.sample + FRAME_SAMPLES);
      const nextStart = Math.max(this.chunkStart, cutAt - msToSamples(this.o.overlapMs));
      return this.cut(cutAt, nextStart, true);
    }
    return null;
  }

  /**
   * Close the open chunk at `cutAt`. A forced cut opens the next chunk at
   * `nextStart` (before the cut, for the overlap); a pause closes it.
   */
  private cut(cutAt: number, nextStart: number, forced: boolean): SpeechChunk | null {
    const start = this.chunkStart;
    if (start === null) return null;
    const audio = this.buffer.slice(start - this.bufferStart, cutAt - this.bufferStart);
    const speechMs = (this.speechSamples / VAD_RATE) * 1000;
    const chunk: SpeechChunk = {
      startSample: start,
      audio,
      speechMs,
      forced,
      overlapSamples: this.chunkOverlap,
    };
    if (forced) {
      this.chunkStart = nextStart;
      this.chunkOverlap = cutAt - nextStart;
      // The overlap is counted again; the next chunk needs speech of its own to be kept.
      this.speechSamples = 0;
      this.frameLog = this.frameLog.filter((f) => f.sample >= nextStart);
    } else {
      this.chunkStart = null;
      this.chunkOverlap = 0;
      this.speechSamples = 0;
      this.frameLog = [];
      this.inSpeech = false;
    }
    this.trimBuffer();
    return speechMs >= this.o.minSpeechMs && audio.length > 0 ? chunk : null;
  }

  /** Keep only what a chunk may still need: the open chunk, or the pre-roll. */
  private trimBuffer(): void {
    const keepFrom =
      this.chunkStart !== null
        ? this.chunkStart
        : this.receivedSamples - msToSamples(this.o.preRollMs + 100);
    const drop = keepFrom - this.bufferStart;
    if (drop > VAD_RATE) {
      this.buffer.shift(drop);
      this.bufferStart += drop;
    }
  }
}
