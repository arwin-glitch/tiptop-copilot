import type { StopReason } from '@/lib/types/notes';

/**
 * When the recorder stops itself (D-076). It never starts by itself.
 *
 *  - 'silence': every live track has been quiet for 15 minutes (a meeting
 *    that ended with the tab left open). A warning shows a minute before, and
 *    any sound cancels it. A socket left open costs money (AssemblyAI bills
 *    idle time), so this is a cost brake as much as a convenience.
 *  - 'call_ended': the shared tab or screen went away (the call window
 *    closed) and the microphone has been quiet for 2 minutes since.
 */

export interface AutoStopInput {
  /** Quiet time of each live track, ms of audio. */
  silentMs: number[];
  /** The meeting-audio capture ended (sharing stopped, the tab closed). */
  meetingAudioEnded: boolean;
  /** Quiet time on the microphone since the meeting audio ended. */
  micSilentSinceEndMs: number;
}

export interface AutoStopTuning {
  silenceAutoStopMs: number;
  silenceAutoStopWarningMs: number;
  callEndedGraceMs: number;
}

export type AutoStopDecision =
  | { kind: 'none' }
  | { kind: 'warn'; remainingMs: number }
  | { kind: 'stop'; reason: Extract<StopReason, 'silence' | 'call_ended'> };

export function autoStopDecision(input: AutoStopInput, tuning: AutoStopTuning): AutoStopDecision {
  if (input.meetingAudioEnded && input.micSilentSinceEndMs >= tuning.callEndedGraceMs) {
    return { kind: 'stop', reason: 'call_ended' };
  }
  if (input.silentMs.length === 0) return { kind: 'none' };
  const quiet = Math.min(...input.silentMs);
  if (quiet >= tuning.silenceAutoStopMs) return { kind: 'stop', reason: 'silence' };
  const warnFrom = tuning.silenceAutoStopMs - tuning.silenceAutoStopWarningMs;
  if (quiet >= warnFrom) return { kind: 'warn', remainingMs: tuning.silenceAutoStopMs - quiet };
  return { kind: 'none' };
}

/** Runs the decision on every update and fires each outcome once. */
export class SilenceAutoStop {
  private stopped = false;
  private warned = false;

  constructor(
    private readonly tuning: AutoStopTuning,
    private readonly handlers: {
      onWarn: (remainingMs: number) => void;
      onClear: () => void;
      onStop: (reason: 'silence' | 'call_ended') => void;
    },
  ) {}

  update(input: AutoStopInput): AutoStopDecision {
    const decision = autoStopDecision(input, this.tuning);
    if (this.stopped) return decision;
    if (decision.kind === 'stop') {
      this.stopped = true;
      this.handlers.onStop(decision.reason);
    } else if (decision.kind === 'warn') {
      this.warned = true;
      this.handlers.onWarn(decision.remainingMs);
    } else if (this.warned) {
      this.warned = false;
      this.handlers.onClear();
    }
    return decision;
  }

  /** Start over (a resume after a pause). */
  reset(): void {
    this.stopped = false;
    if (this.warned) this.handlers.onClear();
    this.warned = false;
  }
}
