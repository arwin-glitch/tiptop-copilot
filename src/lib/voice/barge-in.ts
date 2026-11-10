import { acquireMicrophone, stopStream } from '@/lib/capture/media';
import { speechAudible } from './speaker';

/**
 * Barge-in: cut Arwin off by just starting to talk while he speaks.
 *
 * The microphone is opened with echo cancellation, noise suppression and
 * auto gain on, so Arwin's own voice coming out of the speakers is mostly
 * taken out. What is left goes through a plain energy check: learn how loud
 * the room is for the first moment, then call it speech once the level stays
 * well above that for about a third of a second. Short spikes (a cough, a
 * click, a leftover echo) are ignored.
 *
 * The room is learned only while Arwin's voice is actually coming out
 * (speechAudible): the cloned voice can take a second to download, and a
 * room learned in that silence would take his own echo for the user.
 */

/** How long the room is listened to before anything counts (ms). */
export const BARGE_CALIBRATE_MS = 250;
/** How long the level must stay up to count as talking (ms). */
export const BARGE_SUSTAIN_MS = 300;
/** A dip shorter than this between words does not reset the count (ms). */
export const BARGE_GAP_MS = 60;
/** Never call anything quieter than this speech (RMS, 0..1), however quiet the room. */
export const BARGE_ABS_FLOOR = 0.02;
/** Speech must be this many times louder than the room. */
export const BARGE_RATIO = 3;
/** How often the level is read (ms). */
const POLL_MS = 30;

export interface BargeInOptions {
  calibrateMs?: number;
  sustainMs?: number;
  gapMs?: number;
  absFloor?: number;
  ratio?: number;
}

/**
 * The pure part: feed it one level reading at a time (RMS and how many ms it
 * covers) and it says true once, on the reading where talking started.
 */
export class BargeInDetector {
  private readonly calibrateMs: number;
  private readonly sustainMs: number;
  private readonly gapMs: number;
  private readonly absFloor: number;
  private readonly ratio: number;

  private elapsed = 0;
  private calibration: number[] = [];
  private floor: number | null = null;
  private loudMs = 0;
  private quietMs = 0;
  private fired = false;

  constructor(options: BargeInOptions = {}) {
    this.calibrateMs = options.calibrateMs ?? BARGE_CALIBRATE_MS;
    this.sustainMs = options.sustainMs ?? BARGE_SUSTAIN_MS;
    this.gapMs = options.gapMs ?? BARGE_GAP_MS;
    this.absFloor = options.absFloor ?? BARGE_ABS_FLOOR;
    this.ratio = options.ratio ?? BARGE_RATIO;
  }

  /** The level that counts as talking (null while still learning the room). */
  get threshold(): number | null {
    return this.floor === null ? null : Math.max(this.absFloor, this.floor * this.ratio);
  }

  get done(): boolean {
    return this.fired;
  }

  /** One reading. True only on the reading where talking was first heard. */
  push(rms: number, ms: number): boolean {
    if (this.fired) return false;
    const level = Number.isFinite(rms) && rms > 0 ? rms : 0;
    const step = Number.isFinite(ms) && ms > 0 ? ms : 0;

    if (this.floor === null) {
      this.calibration.push(level);
      this.elapsed += step;
      if (this.elapsed >= this.calibrateMs) {
        // The median, so one loud moment while learning does not deafen it.
        const sorted = [...this.calibration].sort((a, b) => a - b);
        this.floor = sorted[Math.floor(sorted.length / 2)] ?? 0;
        this.calibration = [];
      }
      return false;
    }

    const threshold = Math.max(this.absFloor, this.floor * this.ratio);
    if (level >= threshold) {
      this.loudMs += step + this.quietMs;
      this.quietMs = 0;
      if (this.loudMs >= this.sustainMs) {
        this.fired = true;
        return true;
      }
      return false;
    }
    // Quiet: a short dip between syllables is forgiven, a longer one starts over.
    this.quietMs += step;
    if (this.quietMs > this.gapMs) {
      this.loudMs = 0;
      this.quietMs = 0;
    }
    return false;
  }
}

/** The RMS of one frame of float samples (-1..1). */
export function frameRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

export interface BargeIn {
  stop(): void;
}

/**
 * Listen for the user starting to talk and call onSpeech once. Never throws;
 * when the microphone cannot open, nothing happens. stop() lets go of the
 * microphone and the audio context, and is safe to call more than once.
 */
export function startBargeIn(
  options: {
    onSpeech(): void;
    /**
     * The microphone already open (WakeListener.microphone): barge-in listens
     * on a copy of it instead of opening a second one, which a phone may
     * answer by silencing the first.
     */
    stream?: MediaStream | null;
    /** Whether Arwin is audible now; the room is learned only then. Default: the speaker's. */
    audible?: () => boolean;
  } & BargeInOptions,
  md: Pick<MediaDevices, 'getUserMedia'> | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.mediaDevices,
): BargeIn {
  let stopped = false;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const release = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    stopStream(stream);
    stream = null;
    try {
      if (context && context.state !== 'closed') void context.close().catch(() => undefined);
    } catch {
      // Already gone.
    }
    context = null;
  };

  const stop = () => {
    stopped = true;
    release();
  };

  void (async () => {
    try {
      if (typeof AudioContext === 'undefined') return;
      const shared = options.stream;
      // A copy of the open microphone (stopping it leaves the original on), or
      // a new one with MIC_CONSTRAINTS: echo cancellation ('all'), noise
      // suppression and auto gain all on, so Arwin's voice from the speakers
      // is taken out.
      let opened: MediaStream;
      if (shared?.getAudioTracks().some((t) => t.readyState === 'live')) opened = shared.clone();
      else if (md && typeof md.getUserMedia === 'function') opened = await acquireMicrophone(md);
      else return;
      if (stopped) {
        stopStream(opened);
        return;
      }
      stream = opened;
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      context = ctx;
      if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
      if (stopped) return release();

      const source = ctx.createMediaStreamSource(opened);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      // Read only: the analyser is not connected to the speakers.
      source.connect(analyser);
      const frame = new Float32Array(analyser.fftSize);
      const detector = new BargeInDetector(options);
      const audible = options.audible ?? speechAudible;
      let last = performance.now();

      timer = setInterval(() => {
        if (stopped || !context) return;
        const now = performance.now();
        const ms = now - last;
        last = now;
        // Nothing counts until Arwin is heard, so the room includes his echo.
        if (detector.threshold === null && !audible()) return;
        try {
          analyser.getFloatTimeDomainData(frame);
        } catch {
          return;
        }
        if (detector.push(frameRms(frame), ms)) {
          release();
          try {
            options.onSpeech();
          } catch {
            // The caller's problem, not the microphone's.
          }
        }
      }, POLL_MS);
    } catch {
      // No microphone (denied, busy, missing): barge-in just stays off.
      release();
    }
  })();

  return { stop };
}
