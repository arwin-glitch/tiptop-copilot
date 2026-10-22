import { meterLevel } from './pcm';

/**
 * Loudness for the recorder (D-076): the per-track meters, and how long each
 * track has been quiet. Quiet time counts audio, not the wall clock, so a
 * paused recording is not "silent" and a tab that stops sending audio is
 * caught by its own warning instead.
 */

/** A meter that rises fast and falls slowly, the way a person reads loudness. */
export class LevelMeter {
  private value_ = 0;

  constructor(
    private readonly attack = 0.6,
    private readonly release = 0.2,
  ) {}

  update(rmsValue: number): number {
    const target = meterLevel(rmsValue);
    const k = target > this.value_ ? this.attack : this.release;
    this.value_ += (target - this.value_) * k;
    if (this.value_ < 0.001) this.value_ = 0;
    return this.value_;
  }

  get value(): number {
    return this.value_;
  }

  reset(): void {
    this.value_ = 0;
  }
}

/** How long one track has heard nothing above the threshold, in ms of audio. */
export class SilenceTracker {
  private silent = 0;
  private heard = false;

  constructor(private readonly threshold: number) {}

  /** One chunk: its loudness and length. Answers the quiet time so far. */
  hear(rmsValue: number, durationMs: number): number {
    if (rmsValue > this.threshold) {
      this.silent = 0;
      this.heard = true;
    } else {
      this.silent += durationMs;
    }
    return this.silent;
  }

  get silentMs(): number {
    return this.silent;
  }

  /** Something above the threshold has been heard since the last reset. */
  get everHeard(): boolean {
    return this.heard;
  }

  reset(): void {
    this.silent = 0;
    this.heard = false;
  }
}

/**
 * "No meeting audio detected": the meeting-audio track has been quiet for
 * 20 s. Usually the wrong tab was shared, or "Share tab audio" / "Share system
 * audio" was left unticked. It clears by itself once sound arrives.
 */
export function noMeetingAudio(systemSilentMs: number, warnAfterMs: number): boolean {
  return systemSilentMs >= warnAfterMs;
}
