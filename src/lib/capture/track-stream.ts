import type {
  SttSession,
  TranscriberProvider,
  TranscriptEvent,
  TranscriptTrack,
} from '@/lib/types/notes';
import type { ApiFailure, ApiResult } from './api-client';
import type { FinishedPiece } from './lines';
import { AudioRingBuffer, type AudioChunk } from './ring-buffer';
import { replaySpeedFor } from './socket-factory';
import type {
  SpeechSocket,
  SpeechSocketClose,
  SpeechSocketFactory,
  WebSocketFactory,
} from './speech-socket';
import { CHUNK_MS, SAMPLES_PER_MS, type RecorderTuning, type SocketState } from './types';

/**
 * One track's journey from audio to finished pieces (D-076): the reconnect
 * buffer, the vendor socket, and what happens when the socket drops.
 *
 * The recording has its own clock: samples of 16 kHz audio heard on this
 * track, pauses excluded. A socket's times count from the first audio it was
 * sent, so every event is moved onto the recording clock by that socket's
 * starting point.
 *
 * Reconnecting without gaps or repeats:
 *  - every chunk goes into the 30-second buffer before anything else;
 *  - `confirmedUpTo` is how far the vendor has finished: the end of its last
 *    finished line, or everything sent when a socket was closed gracefully;
 *  - a new socket (after a drop, or a resume) starts from `confirmedUpTo`,
 *    replaying the buffer from there, so speech that was mid-line when the
 *    connection went is heard again in full;
 *  - a finished line that ends at or before the last one already delivered
 *    is a repeat, and is dropped.
 * Only when a drop outlasts the buffer is audio lost, and then the gap is
 * reported (onGap) rather than hidden.
 */

const REPEAT_TOLERANCE_MS = 20;

export interface TrackStreamDeps {
  track: TranscriptTrack;
  requestSession: (track: TranscriptTrack) => Promise<ApiResult<SttSession>>;
  socketFactory: SpeechSocketFactory;
  webSocket?: WebSocketFactory;
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
  onState: (state: SocketState) => void;
  onGap: (missedMs: number) => void;
  onFatal: (error: ApiFailure) => void;
}

export class TrackStream {
  readonly track: TranscriptTrack;
  private readonly ring: AudioRingBuffer;
  private socket: SpeechSocket | null = null;
  private generation = 0;
  private state_: SocketState = 'idle';
  /** The next chunk's place on the recording clock. */
  private nextSample = 0;
  /** Where the current socket's audio starts. */
  private baseSample = 0;
  /** One past the last sample sent on the current socket. */
  private sentUpTo = 0;
  private confirmedUpTo = 0;
  private lastFinalEndMs = Number.NEGATIVE_INFINITY;
  private wanted = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private replaying = false;
  private provider: TranscriberProvider | null = null;

  constructor(private readonly deps: TrackStreamDeps) {
    this.track = deps.track;
    this.ring = new AudioRingBuffer(deps.tuning.reconnectBufferMs, deps.tuning.silenceThreshold);
  }

  get state(): SocketState {
    return this.state_;
  }

  /** Recording-clock ms of audio heard on this track. */
  get heardMs(): number {
    return this.nextSample / SAMPLES_PER_MS;
  }

  private setState(state: SocketState): void {
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
    if (this.socket?.isOpen && !this.replaying) {
      this.socket.sendAudio(samples);
      this.sentUpTo = this.nextSample;
    }
  }

  /** Open a socket (with a session already minted, or ask for one). */
  async connect(session?: SttSession): Promise<void> {
    this.wanted = true;
    this.clearRetry();
    if (this.socket) return;
    const generation = ++this.generation;
    this.setState(this.attempt > 0 ? 'reconnecting' : 'connecting');
    let minted: SttSession;
    if (session) {
      minted = session;
    } else {
      const result = await this.deps.requestSession(this.track);
      if (generation !== this.generation || !this.wanted) return;
      if (!result.ok) {
        if (result.error.retryable) this.scheduleRetry();
        else this.fail(result.error);
        return;
      }
      minted = result.value;
    }
    this.provider = minted.provider;

    // Where this socket starts: from what the vendor has finished.
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

    const socket = this.deps.socketFactory(
      minted,
      {
        onEvent: (event) => {
          if (generation === this.generation) this.handleEvent(event);
        },
        onClose: (info) => {
          if (generation === this.generation) this.handleClose(info);
        },
      },
      {
        baseMs: this.baseSample / SAMPLES_PER_MS,
        webSocket: this.deps.webSocket,
        mockSpeed: this.deps.tuning.mockSpeed,
      },
    );
    this.socket = socket;
    try {
      await socket.open();
    } catch {
      if (generation !== this.generation) return;
      this.socket = null;
      socket.close();
      if (this.wanted) this.scheduleRetry();
      return;
    }
    if (generation !== this.generation || !this.wanted) {
      socket.close();
      return;
    }
    this.attempt = 0;
    this.setState('open');
    await this.replayFrom(this.baseSample, socket, generation);
  }

  /** Send the buffer from `start` on, paced for the vendor, then hand over to live audio. */
  private async replayFrom(start: number, socket: SpeechSocket, generation: number): Promise<void> {
    const speed = this.provider ? replaySpeedFor(this.provider) : Number.POSITIVE_INFINITY;
    this.replaying = true;
    let cursor = start;
    try {
      for (;;) {
        if (generation !== this.generation || !socket.isOpen) return;
        const pending = this.ring.from(cursor).filter((c, i) => i === 0 || c.startSample >= cursor);
        if (pending.length === 0) break;
        for (const chunk of pending) {
          if (generation !== this.generation || !socket.isOpen) return;
          socket.sendAudio(chunk.samples);
          cursor = chunk.startSample + chunk.samples.length;
          this.sentUpTo = cursor;
          // Live audio keeps arriving while this runs; only a backlog is paced.
          const behind = this.nextSample - cursor;
          if (Number.isFinite(speed) && behind > CHUNK_MS * SAMPLES_PER_MS) {
            await sleep(chunk.samples.length / SAMPLES_PER_MS / speed);
          }
        }
        if (cursor >= this.nextSample) break;
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

  private handleClose(info: SpeechSocketClose): void {
    this.socket = null;
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
        code: 'speech_refused',
        message: info.reason || 'The speech service refused the connection.',
        status: info.code,
        retryable: false,
      });
    }
  }

  private scheduleRetry(): void {
    if (!this.wanted) return;
    this.clearRetry();
    this.setState('reconnecting');
    const waits = this.deps.tuning.reconnectBackoffMs;
    const wait = waits[Math.min(this.attempt, waits.length - 1)] ?? 1000;
    this.attempt += 1;
    // Offline, the next try waits for the network to come back (onlineAgain).
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

  /** The network is back: try now instead of waiting out the backoff. */
  /** The vendor's SpeakersResult on this track's open socket (voice enrolment), or null. */
  requestSpeakers(timeoutMs: number): Promise<Record<string, unknown> | null> {
    const socket = this.socket;
    if (!socket?.isOpen || !socket.requestSpeakers) return Promise.resolve(null);
    return socket.requestSpeakers(timeoutMs);
  }

  onlineAgain(): void {
    if (!this.wanted || this.socket) return;
    if (this.state_ === 'reconnecting' || this.state_ === 'connecting') {
      this.clearRetry();
      void this.connect();
    }
  }

  /**
   * Stop streaming and let the vendor finish its last lines (pause and stop).
   * Afterwards everything sent counts as finished, so a resume replays nothing.
   */
  async finish(): Promise<void> {
    this.wanted = false;
    this.clearRetry();
    const socket = this.socket;
    if (socket) {
      await socket.finish(this.deps.tuning.finishTimeoutMs);
      this.confirmedUpTo = Math.max(this.confirmedUpTo, this.sentUpTo);
    }
    this.generation += 1;
    this.socket = null;
    this.replaying = false;
    this.setState('closed');
  }

  /** Close at once (an error, or the page going away). */
  close(): void {
    this.wanted = false;
    this.clearRetry();
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.setState('closed');
  }

  /** Forget the buffer (the track's capture ended for good). */
  clearBuffer(): void {
    this.ring.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
