import type { SpeechSession, TranscriptEvent, TranscriptTrack } from '@/lib/types/notes';
import type { ApiFailure, ApiResult } from './api-client';
import type { FinishedPiece } from './lines';
import { AudioRingBuffer, type AudioChunk } from './ring-buffer';
import type {
  EngineStatus,
  SpeechEngine,
  SpeechEngineClose,
  SpeechEngineFactory,
} from './speech-engine';
import { SAMPLES_PER_MS, type EngineState, type RecorderTuning } from './types';

/**
 * One track's journey from audio to finished pieces (D-076): the in-memory
 * replay buffer, the speech engine, and what happens when the engine stops.
 *
 * The recording has its own clock: samples of 16 kHz audio heard on this
 * track, pauses excluded. An engine's times count from the first audio it was
 * sent, so every event is moved onto the recording clock by that engine's
 * starting point.
 *
 * Restarting without gaps or repeats (an engine can stop: the graphics chip
 * was reset, the browser ended the worker):
 *  - every chunk goes into the 30-second buffer before anything else;
 *  - `confirmedUpTo` is how far the engine has finished: the end of its last
 *    finished line, or everything sent when it finished cleanly;
 *  - a new engine (after a stop, or a resume) starts from `confirmedUpTo`,
 *    replaying the buffer from there, so speech that was mid-line is heard
 *    again in full;
 *  - a finished line that ends at or before the last one already delivered
 *    is a repeat, and is dropped.
 * Only when an engine stays down longer than the buffer is audio lost, and
 * then the gap is reported (onGap) rather than hidden. The on-device engine
 * queues what it hears itself, so a slow first download loses nothing.
 */

const REPEAT_TOLERANCE_MS = 20;

export interface TrackStreamDeps {
  track: TranscriptTrack;
  requestSession: (track: TranscriptTrack) => Promise<ApiResult<SpeechSession>>;
  engineFactory: SpeechEngineFactory;
  tuning: Pick<
    RecorderTuning,
    | 'reconnectBufferMs'
    | 'finishTimeoutMs'
    | 'reconnectBackoffMs'
    | 'mockSpeed'
    | 'silenceThreshold'
  >;
  isOnline: () => boolean;
  onPiece: (piece: FinishedPiece) => void;
  onPartial: (event: TranscriptEvent | null) => void;
  onState: (state: EngineState) => void;
  onEngineStatus?: (status: EngineStatus | null) => void;
  onGap: (missedMs: number) => void;
  onFatal: (error: ApiFailure) => void;
}

export class TrackStream {
  readonly track: TranscriptTrack;
  private readonly ring: AudioRingBuffer;
  private engine: SpeechEngine | null = null;
  private generation = 0;
  private state_: EngineState = 'idle';
  /** The next chunk's place on the recording clock. */
  private nextSample = 0;
  /** Where the current engine's audio starts. */
  private baseSample = 0;
  /** One past the last sample sent to the current engine. */
  private sentUpTo = 0;
  private confirmedUpTo = 0;
  private lastFinalEndMs = Number.NEGATIVE_INFINITY;
  private wanted = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private replaying = false;

  constructor(private readonly deps: TrackStreamDeps) {
    this.track = deps.track;
    this.ring = new AudioRingBuffer(deps.tuning.reconnectBufferMs, deps.tuning.silenceThreshold);
  }

  get state(): EngineState {
    return this.state_;
  }

  /** Recording-clock ms of audio heard on this track. */
  get heardMs(): number {
    return this.nextSample / SAMPLES_PER_MS;
  }

  private setState(state: EngineState): void {
    if (this.state_ === state) return;
    this.state_ = state;
    this.deps.onState(state);
  }

  /**
   * Move this track's clock forward to `sample` (a track that starts late,
   * or starts again after sharing ended, joins the recording where it is).
   */
  alignTo(sample: number): void {
    if (sample > this.nextSample) {
      this.nextSample = Math.round(sample);
      // Nothing between was heard on this track, so there is nothing to replay.
      this.confirmedUpTo = Math.max(this.confirmedUpTo, this.nextSample);
    }
  }

  /** A chunk of 16 kHz PCM16 from the worklet. */
  pushAudio(samples: Int16Array, rmsValue: number): void {
    const chunk: AudioChunk = { startSample: this.nextSample, samples, rms: rmsValue };
    this.nextSample += samples.length;
    this.ring.push(chunk);
    if (this.engine?.isOpen && !this.replaying) {
      this.engine.sendAudio(samples);
      this.sentUpTo = this.nextSample;
    }
  }

  /** Start an engine (with the session already fetched, or ask for one). */
  async connect(session?: SpeechSession): Promise<void> {
    this.wanted = true;
    this.clearRetry();
    if (this.engine) return;
    const generation = ++this.generation;
    this.setState(this.attempt > 0 ? 'restarting' : 'starting');
    let setup: SpeechSession;
    if (session) {
      setup = session;
    } else {
      const result = await this.deps.requestSession(this.track);
      if (generation !== this.generation || !this.wanted) return;
      if (!result.ok) {
        if (result.error.retryable) this.scheduleRetry();
        else this.fail(result.error);
        return;
      }
      setup = result.value;
    }

    // Where this engine starts: from what the last one finished.
    let from = this.confirmedUpTo;
    const oldest = this.ring.oldestSample();
    if (oldest !== null && from < oldest) {
      const lostLoud = this.ring.loudTrimmedAfter(from);
      if (lostLoud > 0) this.deps.onGap(Math.round(lostLoud / SAMPLES_PER_MS));
      from = oldest;
    }
    const replay = this.ring.from(from);
    this.baseSample = replay[0]?.startSample ?? this.nextSample;
    this.sentUpTo = this.baseSample;

    const engine = this.deps.engineFactory(
      setup,
      {
        onEvent: (event) => {
          if (generation === this.generation) this.handleEvent(event);
        },
        onClose: (info) => {
          if (generation === this.generation) this.handleClose(info);
        },
        onStatus: (status) => {
          if (generation === this.generation) this.deps.onEngineStatus?.(status);
        },
      },
      { baseMs: this.baseSample / SAMPLES_PER_MS, mockSpeed: this.deps.tuning.mockSpeed },
    );
    this.engine = engine;
    try {
      await engine.open();
    } catch (error) {
      if (generation !== this.generation) return;
      this.engine = null;
      engine.close();
      const retryable =
        !error ||
        typeof error !== 'object' ||
        (error as { retryable?: unknown }).retryable !== false;
      if (!retryable) {
        this.fail({
          code: 'speech_unavailable',
          message: error instanceof Error ? error.message : 'Speech cannot run on this computer.',
          status: 0,
          retryable: false,
          stillUsable: 'Typed notes still work for this meeting.',
        });
      } else if (this.wanted) {
        this.scheduleRetry();
      }
      return;
    }
    if (generation !== this.generation || !this.wanted) {
      engine.close();
      return;
    }
    this.attempt = 0;
    this.setState('open');
    this.replayFrom(this.baseSample, engine, generation);
  }

  /** Send the buffer from `start` on, then hand over to live audio. The engine queues it. */
  private replayFrom(start: number, engine: SpeechEngine, generation: number): void {
    this.replaying = true;
    try {
      let cursor = start;
      for (const chunk of this.ring.from(start)) {
        if (generation !== this.generation || !engine.isOpen) return;
        if (chunk.startSample + chunk.samples.length <= cursor) continue;
        engine.sendAudio(chunk.samples);
        cursor = chunk.startSample + chunk.samples.length;
        this.sentUpTo = cursor;
      }
    } finally {
      if (generation === this.generation) this.replaying = false;
    }
  }

  private handleEvent(event: TranscriptEvent): void {
    const baseMs = this.baseSample / SAMPLES_PER_MS;
    const startMs = Math.max(0, baseMs + event.startMs);
    const endMs = Math.max(startMs, baseMs + event.endMs);
    if (event.type === 'partial') {
      if (endMs <= this.lastFinalEndMs) return;
      this.deps.onPartial({ ...event, track: this.track, startMs, endMs });
      return;
    }
    if (endMs <= this.lastFinalEndMs + REPEAT_TOLERANCE_MS) return;
    this.lastFinalEndMs = endMs;
    this.confirmedUpTo = Math.max(this.confirmedUpTo, Math.round(endMs * SAMPLES_PER_MS));
    this.deps.onPartial(null);
    this.deps.onPiece({
      track: this.track,
      speakerLabel: this.track === 'mic' ? null : event.speakerLabel,
      startMs,
      endMs,
      text: event.text,
      confidence: event.confidence,
    });
  }

  private handleClose(info: SpeechEngineClose): void {
    this.engine = null;
    this.replaying = false;
    this.deps.onPartial(null);
    if (info.expected || !this.wanted) {
      this.setState('closed');
      return;
    }
    if (info.retryable) {
      this.scheduleRetry();
    } else {
      this.fail({
        code: 'speech_unavailable',
        message: info.reason || 'Speech stopped on this computer.',
        status: info.code,
        retryable: false,
        stillUsable: 'Typed notes still work for this meeting.',
      });
    }
  }

  private scheduleRetry(): void {
    if (!this.wanted) return;
    this.clearRetry();
    this.setState('restarting');
    const waits = this.deps.tuning.reconnectBackoffMs;
    const wait = waits[Math.min(this.attempt, waits.length - 1)] ?? 1000;
    this.attempt += 1;
    // A model that could not download waits for the network (onlineAgain).
    if (!this.deps.isOnline()) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, wait);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private fail(error: ApiFailure): void {
    this.wanted = false;
    this.clearRetry();
    this.setState('failed');
    this.deps.onFatal(error);
  }

  /** "Remember this voice": one voice's voiceprint from the running engine, or null. */
  voiceprint(
    label: string,
    timeoutMs: number,
  ): Promise<{ voiceprint: string; modelVersion: string } | null> {
    const engine = this.engine;
    if (!engine?.isOpen || !engine.voiceprint) return Promise.resolve(null);
    return engine.voiceprint(label, timeoutMs);
  }

  /** The network is back: try now instead of waiting out the backoff. */
  onlineAgain(): void {
    if (!this.wanted || this.engine) return;
    if (this.state_ === 'restarting' || this.state_ === 'starting') {
      this.clearRetry();
      void this.connect();
    }
  }

  /**
   * Stop taking audio and let the engine transcribe what is left (pause and
   * stop). Afterwards everything sent counts as finished, so a resume
   * replays nothing.
   */
  async finish(): Promise<void> {
    this.wanted = false;
    this.clearRetry();
    const engine = this.engine;
    if (engine) {
      await engine.finish(this.deps.tuning.finishTimeoutMs);
      this.confirmedUpTo = Math.max(this.confirmedUpTo, this.sentUpTo);
    }
    this.generation += 1;
    this.engine = null;
    this.replaying = false;
    this.setState('closed');
    // Resumed while the last words were still being transcribed: start again now.
    if (this.wanted) void this.connect();
  }

  /** Close at once (an error, or the page going away). */
  close(): void {
    this.wanted = false;
    this.clearRetry();
    this.generation += 1;
    const engine = this.engine;
    this.engine = null;
    engine?.close();
    this.setState('closed');
  }

  /** Forget the buffer (the track's capture ended for good). */
  clearBuffer(): void {
    this.ring.clear();
  }
}
