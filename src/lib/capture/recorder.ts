import {
  NEVER_RECORD_MESSAGE,
  type CaptureSource,
  type MeetingView,
  type SpeakerView,
  type StopReason,
  type TranscriberProvider,
  type TranscriptEvent,
  type TranscriptTrack,
} from '@/lib/types/notes';
import { clusterKeyFor } from '@/lib/transcribe/cluster';
import { NotesClient, type ApiFailure } from './api-client';
import { AudioGraph, type PcmChunk } from './audio-graph';
import { LevelMeter, SilenceTracker, noMeetingAudio } from './levels';
import { LineAssembler, joinText, type AssembledLine } from './lines';
import {
  NoMeetingAudioError,
  acquireMeetingAudio,
  acquireMicrophone,
  detectCapabilities,
  mediaError,
  stopStream,
} from './media';
import { MeetRosterBridge, RosterTimeline } from './meet-roster';
import { SegmentUploader, type LineForUpload } from './segment-uploader';
import { SilenceAutoStop } from './silence-autostop';
import { createSpeechSocket } from './socket-factory';
import type { SpeechSocketFactory, WebSocketFactory } from './speech-socket';
import { TokenBroker } from './token-broker';
import { TrackStream } from './track-stream';
import {
  CAPTURE_RATE,
  DEFAULT_TUNING,
  LIVE_LINES_KEPT,
  SAMPLES_PER_MS,
  type LiveLine,
  type RecorderCapabilities,
  type RecorderError,
  type RecorderMode,
  type RecorderSnapshot,
  type RecorderStatus,
  type RecorderTuning,
  type RecorderWarning,
  type RecorderWarningCode,
  type SocketState,
  type StartOptions,
  type TrackSnapshot,
  type UploadSnapshot,
} from './types';
import { VisibilityWatch, WakeLockKeeper } from './wake-lock';

/**
 * The web recorder (D-076, WS3): Chrome on a computer, and the iPhone Home
 * Screen app in the foreground.
 *
 * Order of events, so nothing is heard before it may be:
 *   1. start() refuses outright unless the consent step was confirmed.
 *   2. From the click: the browser asks for the meeting tab or screen and the
 *      microphone (the browser insists on a click for the share picker).
 *      Nothing is processed yet.
 *   3. POST /start with the consent: the server logs it and checks the
 *      never-record list. A refusal releases the devices at once; no audio
 *      ever left the page.
 *   4. Only then does audio flow: worklets turn each track into 16 kHz PCM16,
 *      into the 30-second in-memory buffer and on to the vendor over a socket
 *      opened with a 60-second key from POST /stt-token.
 *   5. Finished lines go to POST /segments in batches with a rising seq.
 * Pause closes the sockets (an idle socket still costs money) and stops
 * taking audio; resume asks for fresh keys. Stop lets the vendor finish,
 * uploads what is left, then tells the server, which runs the notes job.
 *
 * Framework-free; use-meeting-recorder.ts is the React face of it.
 */

export interface GraphLike {
  readonly sampleRate: number;
  readonly currentFrame: number;
  attach(
    track: TranscriptTrack,
    stream: MediaStream,
    onChunk: (chunk: PcmChunk) => void,
    active?: boolean,
  ): void;
  setActive(track: TranscriptTrack, active: boolean): void;
  setAllActive(active: boolean): void;
  detach(track: TranscriptTrack): void;
  has(track: TranscriptTrack): boolean;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export interface WindowLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface RecorderDeps {
  client: Pick<
    NotesClient,
    'start' | 'pause' | 'stop' | 'sttToken' | 'uploadSegments' | 'listSegments'
  >;
  microphone: () => Promise<MediaStream>;
  meetingAudio: () => Promise<MediaStream>;
  createGraph: (options?: { nativeRate?: boolean }) => Promise<GraphLike>;
  socketFactory: SpeechSocketFactory;
  webSocket?: WebSocketFactory;
  wakeLock: Pick<WakeLockKeeper, 'hold' | 'release' | 'supported'>;
  capabilities: () => RecorderCapabilities;
  isOnline: () => boolean;
  win: WindowLike | null;
  /** The document, for visibility (phones). */
  doc?: ConstructorParameters<typeof VisibilityWatch>[2];
  now: () => number;
}

export interface RecorderOptions {
  mode?: RecorderMode;
  tuning?: Partial<RecorderTuning>;
  /** Keep recording when the page that started it unmounts (needs a recording indicator elsewhere). */
  keepAliveWhenUnmounted?: boolean;
  deps?: Partial<RecorderDeps>;
}

function browserDeps(): RecorderDeps {
  const hasWindow = typeof window !== 'undefined';
  return {
    client: new NotesClient(),
    microphone: () => acquireMicrophone(),
    meetingAudio: () => acquireMeetingAudio(),
    createGraph: (options) => AudioGraph.create(options),
    socketFactory: createSpeechSocket,
    wakeLock: new WakeLockKeeper(),
    capabilities: () => detectCapabilities(),
    isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
    win: hasWindow ? window : null,
    now: () => Date.now(),
  };
}

const NO_CAPABILITIES: RecorderCapabilities = {
  microphone: false,
  meetingAudio: false,
  audioWorklet: false,
  wakeLock: false,
  ios: false,
  standalone: false,
  mobile: false,
  platform: 'other',
};

const EMIT_EVERY_MS = 80;

interface TrackRuntime {
  stream: TrackStream;
  assembler: LineAssembler;
  meter: LevelMeter;
  silence: SilenceTracker;
  media: MediaStream | null;
  live: boolean;
  muted: boolean;
  socket: SocketState;
  /** No chunk seen since this track was (re)attached: its first one sets its clock. */
  needsAlign: boolean;
  partial: TranscriptEvent | null;
}

export function tracksFor(mode: RecorderMode): TranscriptTrack[] {
  return mode === 'call' ? ['mic', 'system'] : ['mixed'];
}

export class MeetingRecorder {
  readonly meetingId: string;
  private mode: RecorderMode;
  private readonly tuning: RecorderTuning;
  private readonly keepAlive: boolean;
  private readonly depsOverride: Partial<RecorderDeps>;
  private deps_: RecorderDeps | null = null;

  private status: RecorderStatus = 'idle';
  private provider: TranscriberProvider | null = null;
  private error: RecorderError | null = null;
  private stopReason: StopReason | null = null;
  private meeting: MeetingView | null = null;
  private speakers: SpeakerView[] = [];
  private lines: LiveLine[] = [];
  private warnings = new Map<RecorderWarningCode, RecorderWarning>();
  private upload: UploadSnapshot = { pending: 0, lastSeq: null, retrying: false, fatal: null };
  private capabilities: RecorderCapabilities;

  private graph: GraphLike | null = null;
  private runtimes = new Map<TranscriptTrack, TrackRuntime>();
  private uploader: SegmentUploader | null = null;
  private broker: TokenBroker | null = null;
  private autoStop: SilenceAutoStop;
  private micSinceMeetingEnded: SilenceTracker;
  private meetingAudioEnded = false;
  private startFrame = 0;
  private pauseFrame: number | null = null;
  private pausedFrames = 0;
  private offsetSamples = 0;
  private released = false;
  private run = 0;
  private wallAnchor: { wall: number; rec: number } | null = null;
  private roster: RosterTimeline;
  private bridge: MeetRosterBridge | null = null;
  private visibility: VisibilityWatch | null = null;
  private stopRetry: ReturnType<typeof setTimeout> | null = null;
  /** Lines handed to the uploader, by their live-view key, until they get a seq. */
  private readonly pendingKeys = new Map<LineForUpload, string>();

  private snapshot_: RecorderSnapshot;
  private readonly listeners = new Set<() => void>();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private unmountTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(meetingId: string, options: RecorderOptions = {}) {
    this.meetingId = meetingId;
    this.mode = options.mode ?? 'call';
    this.tuning = { ...DEFAULT_TUNING, ...options.tuning };
    this.keepAlive = options.keepAliveWhenUnmounted === true;
    this.depsOverride = options.deps ?? {};
    this.capabilities =
      typeof window === 'undefined' && !this.depsOverride.capabilities
        ? NO_CAPABILITIES
        : (this.depsOverride.capabilities ?? (() => detectCapabilities()))();
    this.autoStop = new SilenceAutoStop(this.tuning, {
      onWarn: (remainingMs) =>
        this.warn({
          code: 'silence_autostop_soon',
          message: `Nobody has spoken for a while. Recording stops in ${clock(remainingMs)} unless someone speaks.`,
        }),
      onClear: () => this.clearWarning('silence_autostop_soon'),
      onStop: (reason) => void this.stop(reason),
    });
    this.micSinceMeetingEnded = new SilenceTracker(this.tuning.silenceThreshold);
    this.roster = new RosterTimeline((wall) => this.recordingClockAt(wall));
    this.snapshot_ = this.buildSnapshot();
    this.serverSnapshot = { ...this.snapshot_, status: 'idle', capabilities: NO_CAPABILITIES };
  }

  private readonly serverSnapshot: RecorderSnapshot;

  private get deps(): RecorderDeps {
    if (!this.deps_) this.deps_ = { ...browserDeps(), ...this.depsOverride };
    return this.deps_;
  }

  /* ------------------------------------------------------- subscription */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.unmountTimer) {
      clearTimeout(this.unmountTimer);
      this.unmountTimer = null;
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.onLastUnsubscribe();
    };
  };

  getSnapshot = (): RecorderSnapshot => this.snapshot_;

  /**
   * What the server rendered: idle, with no device abilities, so hydration
   * matches; the browser's real abilities arrive with the first client render.
   */
  getServerSnapshot = (): RecorderSnapshot => this.serverSnapshot;

  private emitNow(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.snapshot_ = this.buildSnapshot();
    for (const l of [...this.listeners]) l();
  }

  private emitSoon(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emitNow();
    }, EMIT_EVERY_MS);
  }

  private setStatus(status: RecorderStatus): void {
    this.status = status;
    this.emitNow();
  }

  private onLastUnsubscribe(): void {
    if (this.keepAlive) return;
    if (this.status !== 'recording' && this.status !== 'paused') return;
    this.unmountTimer = setTimeout(() => {
      this.unmountTimer = null;
      if (this.listeners.size === 0) void this.pauseAndRelease();
    }, this.tuning.unmountPauseMs);
  }

  /* ------------------------------------------------------------ getters */

  get currentStatus(): RecorderStatus {
    return this.status;
  }

  /** Recorded time, pauses excluded. */
  get elapsedMs(): number {
    let max = this.offsetSamples / SAMPLES_PER_MS;
    for (const rt of this.runtimes.values()) max = Math.max(max, rt.stream.heardMs);
    return max;
  }

  setMode(mode: RecorderMode): void {
    if (this.status === 'idle' || this.status === 'stopped' || this.status === 'error') {
      this.mode = mode;
      this.emitNow();
    }
  }

  /* -------------------------------------------------------------- start */

  /**
   * Start recording. Call it from the click on Start: the browser shows the
   * share picker only for a click. Refuses without a confirmed consent step.
   */
  async start(options: StartOptions): Promise<boolean> {
    if (this.status !== 'idle' && this.status !== 'stopped' && this.status !== 'error')
      return false;
    if (!options || !options.consent || options.consent.confirmed !== true) {
      this.fail({
        code: 'consent_required',
        message: 'Confirm that everyone knows the call is being transcribed first.',
      });
      return false;
    }
    const caps = this.capabilities;
    const tracks = tracksFor(this.mode);
    if (!caps.microphone || !caps.audioWorklet) {
      this.fail({
        code: 'unsupported',
        message: 'This browser cannot record.',
        stillUsable: 'Use Chrome on a computer, or Safari on an iPhone.',
      });
      return false;
    }
    if (this.mode === 'call' && !caps.meetingAudio) {
      this.fail({
        code: 'meeting_audio_unsupported',
        message: 'This browser cannot hear the meeting audio.',
        stillUsable: 'Use Chrome or Edge on a computer, or record in "Mic only" mode.',
      });
      return false;
    }
    const run = ++this.run;
    this.resetForStart();
    this.setStatus('starting');
    const deps = this.deps;

    // 2. The devices, straight from the click. The share picker first: it
    //    needs the click; the context is made now so a phone lets it start.
    const meetingP = this.mode === 'call' ? deps.meetingAudio() : Promise.resolve(null);
    const micP = deps.microphone();
    // iPhones run the context at its own rate and the worklet downsamples:
    // Safari has distorted microphones fed into a 16 kHz context.
    const graphP = deps.createGraph({ nativeRate: caps.ios });
    const [meetingR, micR, graphR] = await Promise.allSettled([meetingP, micP, graphP]);
    const acquired = [meetingR, micR].flatMap((r) =>
      r.status === 'fulfilled' && r.value ? [r.value] : [],
    );
    const graphOk = graphR.status === 'fulfilled' ? graphR.value : null;
    if (meetingR.status === 'rejected' || micR.status === 'rejected' || !graphOk) {
      acquired.forEach(stopStream);
      await graphOk?.close();
      if (meetingR.status === 'rejected') {
        const e = meetingR.reason;
        this.fail(e instanceof NoMeetingAudioError ? e.recorderError : mediaError(e, 'meeting'));
      } else if (micR.status === 'rejected') {
        this.fail(mediaError(micR.reason, 'mic'));
      } else {
        this.fail({
          code: 'audio_engine',
          message: 'The browser could not start its audio engine.',
          stillUsable: 'Reload the page and try again, or use Chrome.',
        });
      }
      return false;
    }
    const mic = micR.value as MediaStream;
    const meetingAudio = meetingR.value as MediaStream | null;
    if (run !== this.run) {
      acquired.forEach(stopStream);
      await graphOk.close();
      return false;
    }

    // 3. The server: consent logged, never-record checked.
    const captureSource: CaptureSource = options.captureSource ?? (caps.ios ? 'iphone' : 'web');
    const started = await deps.client.start(this.meetingId, {
      consent: options.consent,
      captureSource,
      ...(options.kind ? { kind: options.kind } : {}),
    });
    if (run !== this.run || !started.ok) {
      acquired.forEach(stopStream);
      await graphOk.close();
      if (run === this.run && !started.ok) this.fail(startError(started.error));
      return false;
    }
    this.meeting = started.value.meeting;

    // A meeting resumed after a reload continues its seq and its clock.
    const lastSeq = this.meeting.lastSeq;
    if (lastSeq !== null && lastSeq >= 0) {
      const tail = await deps.client.listSegments(this.meetingId, lastSeq - 1, 1);
      const endMs = tail.ok ? (tail.value.segments.at(-1)?.endMs ?? 0) : 0;
      this.offsetSamples = Math.round(endMs * SAMPLES_PER_MS);
    }
    if (run !== this.run) {
      acquired.forEach(stopStream);
      await graphOk.close();
      return false;
    }

    // 4. Audio flows: into the buffer at once, to the vendor once a socket opens.
    this.graph = graphOk;
    this.startFrame = graphOk.currentFrame;
    this.broker = new TokenBroker(async (t) => {
      const r = await deps.client.sttToken(this.meetingId, t);
      return r.ok ? { ok: true, value: r.value } : r;
    });
    this.uploader = new SegmentUploader({
      send: (segments, opts) => deps.client.uploadSegments(this.meetingId, segments, opts),
      firstSeq: (lastSeq ?? -1) + 1,
      intervalMs: this.tuning.uploadIntervalMs,
      isOnline: deps.isOnline,
      onChange: (s) => {
        this.upload = s;
        this.syncUploadWarnings();
        this.emitSoon();
        // The server refused lines for good (the meeting was stopped in another
        // tab, Notes was turned off): recording on would only lose them.
        if (s.fatal && (this.status === 'recording' || this.status === 'paused')) {
          void this.onFatal({ ...s.fatal, status: 0, retryable: false });
        }
        // After a stop, the uploader kept going only to save what was left.
        if (s.pending === 0 && this.status === 'stopped') this.uploader?.stop();
      },
      onSpeakers: (speakers) => {
        this.speakers = speakers;
        this.emitSoon();
      },
      onAssigned: (line, seq) => this.markAssigned(line, seq),
    });
    for (const track of tracks) this.runtimes.set(track, this.newRuntime(track));
    const mediaFor = (track: TranscriptTrack) => (track === 'system' ? meetingAudio : mic);
    try {
      for (const track of tracks) {
        const media = mediaFor(track);
        if (media) await this.attachTrack(track, media);
      }
    } catch {
      this.teardownCapture();
      this.fail({
        code: 'audio_engine',
        message: 'The browser could not start its audio engine.',
        stillUsable: 'Reload the page and try again, or use Chrome.',
      });
      void deps.client.pause(this.meetingId, true);
      return false;
    }
    this.uploader.start();

    const minted = await this.broker.requestMany(tracks);
    if (run !== this.run) return false;
    if (!minted.ok) {
      this.teardownCapture();
      this.fail(failureToError(minted.error));
      void deps.client.pause(this.meetingId, true);
      return false;
    }
    this.provider = minted.value[0]?.provider ?? null;
    this.addWindowListeners();
    this.setStatus('recording');
    for (const session of minted.value) {
      void this.runtimes.get(session.track)?.stream.connect(session);
    }
    void deps.wakeLock.hold();
    if (caps.mobile) {
      this.warn({
        code: 'keep_screen_open',
        message: 'Keep this screen open: the phone stops the microphone when it locks.',
      });
    }
    this.bridge = new MeetRosterBridge(this.roster, () => this.emitSoon());
    this.bridge.start();
    this.bridge.announce(this.meetingId, true, true);
    return true;
  }

  private resetForStart(): void {
    this.error = null;
    this.stopReason = null;
    this.provider = null;
    this.lines = [];
    this.speakers = [];
    this.warnings.clear();
    this.runtimes.clear();
    this.meetingAudioEnded = false;
    this.pauseFrame = null;
    this.pausedFrames = 0;
    this.offsetSamples = 0;
    this.released = false;
    this.wallAnchor = null;
    this.meeting = null;
    this.autoStop.reset();
    this.micSinceMeetingEnded.reset();
    this.upload = { pending: 0, lastSeq: null, retrying: false, fatal: null };
    if (this.stopRetry) clearTimeout(this.stopRetry);
    this.stopRetry = null;
  }

  private newRuntime(track: TranscriptTrack): TrackRuntime {
    const rt: TrackRuntime = {
      stream: undefined as unknown as TrackStream,
      assembler: new LineAssembler((line) => this.onLine(line)),
      meter: new LevelMeter(),
      silence: new SilenceTracker(this.tuning.silenceThreshold),
      media: null,
      live: false,
      muted: false,
      socket: 'idle',
      needsAlign: true,
      partial: null,
    };
    rt.stream = new TrackStream({
      track,
      requestSession: (t) =>
        this.broker
          ? this.broker.request(t)
          : Promise.resolve({
              ok: false,
              error: { code: 'stopped', message: 'Stopped.', status: 0, retryable: false },
            }),
      socketFactory: this.deps.socketFactory,
      webSocket: this.deps.webSocket,
      tuning: this.tuning,
      isOnline: this.deps.isOnline,
      onPiece: (piece) => {
        rt.assembler.add(piece);
        this.emitSoon();
      },
      onPartial: (event) => {
        rt.partial = event;
        this.emitSoon();
      },
      onState: (state) => {
        rt.socket = state;
        this.syncReconnectWarning();
        this.emitSoon();
      },
      onGap: (missedMs) =>
        this.warn({
          code: 'audio_gap',
          track,
          message: `About ${Math.max(1, Math.round(missedMs / 1000))} seconds could not be transcribed while the connection was down.`,
        }),
      onFatal: (error) => void this.onFatal(error),
    });
    return rt;
  }

  /** Wire one track's capture into the graph, with its device events. */
  private async attachTrack(track: TranscriptTrack, media: MediaStream): Promise<void> {
    const rt = this.runtimes.get(track);
    if (!rt || !this.graph) return;
    rt.media = media;
    rt.live = true;
    rt.muted = false;
    rt.needsAlign = true;
    try {
      this.graph.attach(track, media, (chunk) => this.onChunk(chunk));
    } catch (error) {
      // Firefox will not connect a microphone to a 16 kHz context: run at its own rate.
      if (
        error &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'NotSupportedError'
      ) {
        const heard = Math.round(this.elapsedMs * SAMPLES_PER_MS);
        await this.graph.close();
        this.graph = await this.deps.createGraph({ nativeRate: true });
        // A new context starts its own clock; the recording's carries on.
        this.offsetSamples = heard;
        this.startFrame = this.graph.currentFrame;
        this.pausedFrames = 0;
        for (const [t, other] of this.runtimes) {
          if (other.media && t !== track) this.graph.attach(t, other.media, (c) => this.onChunk(c));
        }
        this.graph.attach(track, media, (chunk) => this.onChunk(chunk));
      } else {
        throw error;
      }
    }
    for (const t of media.getAudioTracks()) {
      t.addEventListener('ended', () => this.onTrackEnded(track, media));
      t.addEventListener('mute', () => this.onTrackMute(track, true));
      t.addEventListener('unmute', () => this.onTrackMute(track, false));
    }
  }

  /* --------------------------------------------------------- the audio */

  /** Recording-clock sample for a context frame (pauses excluded). */
  private sampleAtFrame(frame: number): number {
    const rate = this.graph?.sampleRate ?? CAPTURE_RATE;
    const frames = Math.max(0, frame - this.startFrame - this.pausedFrames);
    return this.offsetSamples + Math.round((frames / rate) * CAPTURE_RATE);
  }

  private onChunk(chunk: PcmChunk): void {
    // While starting, audio is kept in memory only once the server has logged
    // consent (the graph exists from then on), so the first words are not lost
    // while the speech keys are minted.
    if (this.status !== 'recording' && !(this.status === 'starting' && this.graph)) return;
    const rt = this.runtimes.get(chunk.track);
    if (!rt) return;
    if (rt.needsAlign) {
      rt.needsAlign = false;
      rt.stream.alignTo(this.sampleAtFrame(chunk.frame));
    }
    rt.stream.pushAudio(chunk.samples, chunk.rms);
    const durationMs = chunk.samples.length / SAMPLES_PER_MS;
    rt.meter.update(chunk.rms);
    rt.silence.hear(chunk.rms, durationMs);
    rt.assembler.tick(rt.stream.heardMs);
    if (chunk.track === 'mic' && this.meetingAudioEnded) {
      this.micSinceMeetingEnded.hear(chunk.rms, durationMs);
    }
    this.wallAnchor = { wall: this.deps.now(), rec: this.elapsedMs };

    const system = this.runtimes.get('system');
    if (system?.live) {
      if (noMeetingAudio(system.silence.silentMs, this.tuning.noMeetingAudioWarningMs)) {
        if (!this.warnings.has('no_meeting_audio')) {
          this.warn({
            code: 'no_meeting_audio',
            track: 'system',
            message:
              'No meeting audio detected. Check that you shared the meeting tab (or Entire screen) with its audio ticked.',
            action: 'share_again',
          });
        }
      } else if (this.warnings.has('no_meeting_audio')) {
        this.clearWarning('no_meeting_audio');
      }
    }
    this.autoStop.update({
      silentMs: [...this.runtimes.values()].filter((r) => r.live).map((r) => r.silence.silentMs),
      meetingAudioEnded: this.meetingAudioEnded,
      micSilentSinceEndMs: this.micSinceMeetingEnded.silentMs,
    });
    this.emitSoon();
  }

  /** Wall-clock time to the recording clock, for the Meet roster; null unless recording. */
  private recordingClockAt(wallMs: number): number | null {
    if (this.status !== 'recording' || !this.wallAnchor) return null;
    return Math.max(0, this.wallAnchor.rec + (wallMs - this.wallAnchor.wall));
  }

  private onLine(line: AssembledLine): void {
    const live: LiveLine = {
      key: `${line.track}:${Math.round(line.startMs)}`,
      track: line.track,
      clusterKey: clusterKeyFor(line.track, line.speakerLabel),
      speakerLabel: line.speakerLabel,
      startMs: line.startMs,
      endMs: line.endMs,
      text: line.text,
      final: true,
      seq: null,
    };
    // Keep the live view in the order things were said.
    let i = this.lines.length;
    while (i > 0 && (this.lines[i - 1]?.startMs ?? 0) > live.startMs) i -= 1;
    this.lines.splice(i, 0, live);
    if (this.lines.length > LIVE_LINES_KEPT)
      this.lines.splice(0, this.lines.length - LIVE_LINES_KEPT);
    const upload: LineForUpload = {
      track: line.track,
      speakerLabel: line.speakerLabel,
      startMs: line.startMs,
      endMs: line.endMs,
      text: line.text,
      confidence: line.confidence,
    };
    this.pendingKeys.set(upload, live.key);
    this.uploader?.push(upload);
    this.emitSoon();
  }

  private markAssigned(line: LineForUpload, seq: number): void {
    const key = this.pendingKeys.get(line);
    this.pendingKeys.delete(line);
    if (!key) return;
    const found = this.lines.find((l) => l.key === key);
    if (found) found.seq = seq;
  }

  /* -------------------------------------------------- device events */

  private onTrackEnded(track: TranscriptTrack, media: MediaStream): void {
    const rt = this.runtimes.get(track);
    if (!rt || rt.media !== media || !rt.live) return;
    rt.live = false;
    rt.meter.reset();
    this.graph?.detach(track);
    stopStream(media);
    rt.media = null;
    if (this.status === 'recording' || this.status === 'paused') {
      void rt.stream.finish().then(() => rt.assembler.flush());
    }
    if (track === 'system') {
      this.meetingAudioEnded = true;
      this.micSinceMeetingEnded.reset();
      this.clearWarning('no_meeting_audio');
      this.warn({
        code: 'meeting_audio_ended',
        track,
        message: 'Sharing stopped, so Copilot no longer hears the meeting. Share again, or stop.',
        action: 'share_again',
      });
    } else {
      this.warn({
        code: 'mic_ended',
        track,
        message: 'The microphone stopped (unplugged or taken by another app).',
        action: 'retry_mic',
      });
    }
    this.emitNow();
  }

  private onTrackMute(track: TranscriptTrack, muted: boolean): void {
    const rt = this.runtimes.get(track);
    if (!rt) return;
    rt.muted = muted;
    if ([...this.runtimes.values()].some((r) => r.muted && r.live)) {
      this.warn({
        code: 'track_muted',
        track,
        message: this.capabilities.mobile
          ? 'The phone paused the microphone. Keep this screen open and unlocked.'
          : 'The browser paused this audio (another app may have taken the device).',
      });
    } else {
      this.clearWarning('track_muted');
    }
    this.emitNow();
  }

  /** Share the meeting tab or screen again (from a click). */
  async shareMeetingAudioAgain(): Promise<boolean> {
    if (this.mode !== 'call' || (this.status !== 'recording' && this.status !== 'paused')) {
      return false;
    }
    let media: MediaStream;
    try {
      media = await this.deps.meetingAudio();
    } catch (error) {
      this.warn({
        code: 'meeting_audio_ended',
        track: 'system',
        message:
          (error instanceof NoMeetingAudioError
            ? error.recorderError
            : mediaError(error, 'meeting')
          ).message + ' Share again, or stop.',
        action: 'share_again',
      });
      return false;
    }
    return this.reattach('system', media);
  }

  /** Start the microphone again (from a click). */
  async retryMicrophone(): Promise<boolean> {
    if (this.status !== 'recording' && this.status !== 'paused') return false;
    let media: MediaStream;
    try {
      media = await this.deps.microphone();
    } catch (error) {
      this.warn({
        code: 'mic_ended',
        message: mediaError(error, 'mic').message,
        action: 'retry_mic',
      });
      return false;
    }
    return this.reattach(this.mode === 'call' ? 'mic' : 'mixed', media);
  }

  private async reattach(track: TranscriptTrack, media: MediaStream): Promise<boolean> {
    const rt = this.runtimes.get(track);
    if (!rt || !this.graph) {
      stopStream(media);
      return false;
    }
    const old = rt.media;
    if (old && old !== media) {
      this.graph.detach(track);
      stopStream(old);
    }
    await this.attachTrack(track, media);
    rt.silence.reset();
    if (this.status === 'paused') {
      this.graph.setActive(track, false);
      for (const t of media.getAudioTracks()) t.enabled = false;
    } else {
      void rt.stream.connect();
    }
    if (track === 'system') {
      this.meetingAudioEnded = false;
      this.clearWarning('meeting_audio_ended');
    } else {
      this.clearWarning('mic_ended');
    }
    this.emitNow();
    return true;
  }

  /* ------------------------------------------------------- pause/resume */

  /** Pause: nothing is heard, the sockets close (an idle socket still costs money). */
  async pause(): Promise<boolean> {
    if (this.status !== 'recording') return false;
    const run = this.run;
    this.setStatus('paused');
    this.graph?.setAllActive(false);
    this.pauseFrame = this.graph?.currentFrame ?? null;
    for (const rt of this.runtimes.values()) {
      for (const t of rt.media?.getAudioTracks() ?? []) t.enabled = false;
      rt.meter.reset();
    }
    this.roster.closeAll(this.elapsedMs);
    this.bridge?.announce(this.meetingId, false, true);
    await Promise.all([...this.runtimes.values()].map((rt) => rt.stream.finish()));
    for (const rt of this.runtimes.values()) {
      rt.assembler.flush();
      rt.partial = null;
    }
    void this.uploader?.flush();
    const paused = await this.deps.client.pause(this.meetingId, true);
    if (run !== this.run) return false;
    if (paused.ok) this.meeting = paused.value.meeting;
    this.emitNow();
    return true;
  }

  /** Resume after a pause (from a click: a released recording asks for the devices again). */
  async resume(): Promise<boolean> {
    if (this.status !== 'paused') return false;
    const run = this.run;
    const deps = this.deps;
    if (this.released) {
      const ok = await this.reacquire();
      if (!ok || run !== this.run) return false;
    }
    const resumed = await deps.client.pause(this.meetingId, false);
    if (run !== this.run) return false;
    if (!resumed.ok) {
      this.warn({
        code: 'left_page',
        message: `Could not resume: ${resumed.error.message}`,
        action: 'resume',
      });
      return false;
    }
    this.meeting = resumed.value.meeting;
    this.clearWarning('left_page');
    await this.graph?.resume();
    if (this.pauseFrame !== null && this.graph) {
      this.pausedFrames += Math.max(0, this.graph.currentFrame - this.pauseFrame);
    }
    this.pauseFrame = null;
    for (const [track, rt] of this.runtimes) {
      if (!rt.live) continue;
      for (const t of rt.media?.getAudioTracks() ?? []) t.enabled = true;
      this.graph?.setActive(track, true);
    }
    this.autoStop.reset();
    this.setStatus('recording');
    this.bridge?.announce(this.meetingId, true, true);
    const live = [...this.runtimes.entries()].filter(([, rt]) => rt.live).map(([t]) => t);
    if (live.length === 0 || !this.broker) return true;
    const minted = await this.broker.requestMany(live);
    if (run !== this.run) return false;
    if (!minted.ok) {
      if (minted.error.retryable) {
        for (const t of live) void this.runtimes.get(t)?.stream.connect();
      } else {
        await this.onFatal(minted.error);
      }
      return true;
    }
    for (const session of minted.value) {
      void this.runtimes.get(session.track)?.stream.connect(session);
    }
    return true;
  }

  /** Leaving the page: pause, and let go of the microphone and the share. */
  private async pauseAndRelease(): Promise<void> {
    if (this.status === 'recording') await this.pause();
    if (this.status !== 'paused') return;
    for (const [track, rt] of this.runtimes) {
      this.graph?.detach(track);
      stopStream(rt.media);
      rt.media = null;
    }
    await this.graph?.close();
    this.graph = null;
    this.released = true;
    void this.deps.wakeLock.release();
    this.warn({
      code: 'left_page',
      message: 'Recording paused because you left the meeting page. Resume to carry on.',
      action: 'resume',
    });
  }

  private async reacquire(): Promise<boolean> {
    const deps = this.deps;
    const tracks = [...this.runtimes.keys()];
    const meetingP = tracks.includes('system') ? deps.meetingAudio() : Promise.resolve(null);
    const micP = deps.microphone();
    const graphP = deps.createGraph({ nativeRate: this.capabilities.ios });
    const [meetingR, micR, graphR] = await Promise.allSettled([meetingP, micP, graphP]);
    if (
      meetingR.status === 'rejected' ||
      micR.status === 'rejected' ||
      graphR.status === 'rejected'
    ) {
      if (meetingR.status === 'fulfilled') stopStream(meetingR.value);
      if (micR.status === 'fulfilled') stopStream(micR.value);
      if (graphR.status === 'fulfilled') await graphR.value.close();
      const reason =
        micR.status === 'rejected'
          ? mediaError(micR.reason, 'mic')
          : meetingR.status === 'rejected'
            ? mediaError(meetingR.reason, 'meeting')
            : { code: 'audio_engine', message: 'The browser could not start its audio engine.' };
      this.warn({ code: 'left_page', message: reason.message, action: 'resume' });
      return false;
    }
    this.graph = graphR.value;
    // The new context's clock starts again; keep the recording clock where it was.
    this.offsetSamples = Math.round(this.elapsedMs * SAMPLES_PER_MS);
    this.startFrame = this.graph.currentFrame;
    this.pausedFrames = 0;
    this.pauseFrame = this.graph.currentFrame;
    for (const track of tracks) {
      const media = track === 'system' ? meetingR.value : micR.value;
      if (!media) continue;
      await this.attachTrack(track, media);
      this.graph.setActive(track, false);
    }
    this.released = false;
    void deps.wakeLock.hold();
    return true;
  }

  /* --------------------------------------------------------------- stop */

  /** Stop: the vendor finishes, the last lines upload, then the server runs the notes job. */
  async stop(reason: StopReason = 'user'): Promise<boolean> {
    if (this.status === 'starting') {
      this.run += 1;
      this.teardownCapture();
      // The server already started it: stop it there too, with nothing recorded.
      if (this.meeting?.status === 'recording') {
        void this.deps.client.stop(this.meetingId, { reason, recordedMs: 0 });
      }
      this.setStatus('idle');
      return true;
    }
    if (this.status !== 'recording' && this.status !== 'paused') return false;
    const run = ++this.run;
    this.stopReason = reason;
    this.setStatus('stopping');
    this.graph?.setAllActive(false);
    this.clearWarning('silence_autostop_soon');
    this.bridge?.stop(this.meetingId);
    this.roster.closeAll(this.elapsedMs);
    await Promise.all([...this.runtimes.values()].map((rt) => rt.stream.finish()));
    for (const rt of this.runtimes.values()) {
      rt.assembler.flush();
      rt.partial = null;
    }
    const recordedMs = Math.round(this.elapsedMs);
    const uploader = this.uploader;
    const left = uploader ? await uploader.drain(this.tuning.drainTimeoutMs) : 0;
    this.teardownCapture({ keepUploader: left > 0 });
    if (left > 0) {
      this.warn({
        code: 'uploads_pending',
        message: `${left} transcript line${left === 1 ? ' is' : 's are'} still saving. Keep this page open for a moment.`,
      });
    }
    await this.tellServerStopped(run, reason, recordedMs);
    return true;
  }

  private async tellServerStopped(
    run: number,
    reason: StopReason,
    recordedMs: number,
  ): Promise<void> {
    const result = await this.deps.client.stop(this.meetingId, { reason, recordedMs });
    if (run !== this.run) return;
    if (result.ok) {
      this.meeting = result.value.meeting;
      this.setStatus('stopped');
      return;
    }
    if (result.error.retryable) {
      // Copilot did not hear the stop (offline, restarting): keep telling it.
      this.status = 'stopped';
      this.warn({
        code: 'upload_retrying',
        message: 'Stopped here; telling Copilot as soon as it can be reached.',
      });
      this.stopRetry = setTimeout(() => {
        this.stopRetry = null;
        void this.tellServerStopped(run, reason, recordedMs);
      }, 5000);
      return;
    }
    // Already stopped elsewhere (another tab), or the meeting is gone.
    this.status = 'stopped';
    this.error = { code: result.error.code, message: result.error.message };
    this.emitNow();
  }

  private async onFatal(error: ApiFailure): Promise<void> {
    if (this.status !== 'recording' && this.status !== 'paused' && this.status !== 'starting')
      return;
    this.run += 1;
    for (const rt of this.runtimes.values()) rt.assembler.flush();
    const uploader = this.uploader;
    if (uploader) await uploader.drain(3000);
    this.teardownCapture();
    this.fail(failureToError(error));
    if (error.code !== 'conflict') void this.deps.client.pause(this.meetingId, true);
  }

  private teardownCapture(options: { keepUploader?: boolean } = {}): void {
    for (const [track, rt] of this.runtimes) {
      rt.stream.close();
      this.graph?.detach(track);
      stopStream(rt.media);
      rt.media = null;
      rt.live = false;
      rt.meter.reset();
    }
    void this.graph?.close();
    this.graph = null;
    this.broker?.cancel();
    if (!options.keepUploader) this.uploader?.stop();
    this.removeWindowListeners();
    this.bridge?.stop(this.meetingId);
    this.bridge = null;
    void this.deps_?.wakeLock.release();
    this.clearWarning('keep_screen_open');
    this.clearWarning('reconnecting');
    this.clearWarning('offline');
  }

  private fail(error: RecorderError): void {
    this.error = error;
    this.setStatus('error');
  }

  /* ------------------------------------------------- the page around it */

  private readonly onOffline = () => {
    this.warn({
      code: 'offline',
      message:
        'You are offline. Copilot keeps the last 30 seconds and catches up when the network is back.',
    });
  };

  private readonly onOnline = () => {
    this.clearWarning('offline');
    for (const rt of this.runtimes.values()) rt.stream.onlineAgain();
    void this.uploader?.flush();
  };

  private readonly onBeforeUnload = (event: Event) => {
    if (this.status === 'recording' || this.status === 'paused' || this.status === 'stopping') {
      event.preventDefault();
      (event as BeforeUnloadEvent).returnValue = '';
    }
  };

  private readonly onPageHide = () => {
    if (this.status !== 'recording' && this.status !== 'paused') return;
    this.uploader?.flushOnPageHide();
    // Never leave the meeting "recording" with nothing feeding it (a pause the
    // server missed included; pausing twice is harmless).
    void this.deps.client.pause(this.meetingId, true, { keepalive: true });
  };

  private addWindowListeners(): void {
    const win = this.deps.win;
    if (win) {
      win.addEventListener('offline', this.onOffline);
      win.addEventListener('online', this.onOnline);
      win.addEventListener('beforeunload', this.onBeforeUnload);
      win.addEventListener('pagehide', this.onPageHide);
    }
    if (!this.deps.isOnline()) this.onOffline();
    this.visibility = new VisibilityWatch(
      () => undefined,
      (awayMs) => {
        void this.graph?.resume();
        if (this.capabilities.mobile && this.status === 'recording' && awayMs > 3000) {
          this.warn({
            code: 'screen_was_off',
            message: `The screen was off or Copilot was in the background for ${clock(awayMs)}; nothing was heard then.`,
          });
        }
      },
      this.deps.doc,
    );
    this.visibility.start();
  }

  private removeWindowListeners(): void {
    const win = this.deps_?.win;
    if (win) {
      win.removeEventListener('offline', this.onOffline);
      win.removeEventListener('online', this.onOnline);
      win.removeEventListener('beforeunload', this.onBeforeUnload);
      win.removeEventListener('pagehide', this.onPageHide);
    }
    this.visibility?.stop();
    this.visibility = null;
  }

  /* ------------------------------------------------------------ warnings */

  private warn(warning: RecorderWarning): void {
    this.warnings.set(warning.code, warning);
    this.emitSoon();
  }

  private clearWarning(code: RecorderWarningCode): void {
    if (this.warnings.delete(code)) this.emitSoon();
  }

  /** Hide a warning the person has read (it comes back if the cause does). */
  dismissWarning(code: RecorderWarningCode): void {
    this.clearWarning(code);
  }

  private syncReconnectWarning(): void {
    const reconnecting = [...this.runtimes.values()].some((r) => r.socket === 'reconnecting');
    if (reconnecting && (this.status === 'recording' || this.status === 'starting')) {
      this.warn({
        code: 'reconnecting',
        message:
          'Reconnecting to the speech service. Nothing is lost: the last 30 seconds are kept.',
      });
    } else {
      this.clearWarning('reconnecting');
    }
  }

  private syncUploadWarnings(): void {
    if (this.upload.fatal) {
      this.warn({
        code: 'upload_retrying',
        message: `Lines are not saving: ${this.upload.fatal.message}`,
      });
    } else if (this.upload.retrying && this.upload.pending > 0) {
      this.warn({
        code: 'upload_retrying',
        message: 'Saving lines is retrying; they wait on this page until Copilot answers.',
      });
    } else {
      this.clearWarning('upload_retrying');
      if (this.upload.pending === 0) this.clearWarning('uploads_pending');
    }
  }

  /* ------------------------------------------------------------ snapshot */

  private buildSnapshot(): RecorderSnapshot {
    const tracks: RecorderSnapshot['tracks'] = {};
    const partials: RecorderSnapshot['partials'] = {};
    for (const [track, rt] of this.runtimes) {
      const t: TrackSnapshot = {
        track,
        level: rt.meter.value,
        live: rt.live,
        muted: rt.muted,
        socket: rt.socket,
        silentMs: rt.silence.silentMs,
        heardMs: rt.stream.heardMs,
      };
      tracks[track] = t;
      const pending = rt.assembler.current();
      const text = joinText(pending?.text ?? '', rt.partial?.text ?? '');
      if (text) {
        const speakerLabel = rt.partial?.speakerLabel ?? pending?.speakerLabel ?? null;
        const startMs = pending?.startMs ?? rt.partial?.startMs ?? 0;
        partials[track] = {
          key: `${track}:partial`,
          track,
          clusterKey: clusterKeyFor(track, speakerLabel),
          speakerLabel,
          startMs,
          endMs: rt.partial?.endMs ?? pending?.endMs ?? startMs,
          text,
          final: false,
          seq: null,
        };
      }
    }
    return {
      meetingId: this.meetingId,
      status: this.status,
      mode: this.mode,
      provider: this.provider,
      elapsedMs: Math.round(this.elapsedMs),
      tracks,
      warnings: [...this.warnings.values()],
      lines: this.lines.map((l) => ({ ...l })),
      partials,
      speakers: this.speakers,
      upload: this.upload,
      error: this.error,
      stopReason: this.stopReason,
      meeting: this.meeting,
      roster: this.roster.snapshot(this.bridge?.isConnected ?? false),
      capabilities: this.capabilities,
    };
  }
}

/* ------------------------------------------------------------- helpers */

function startError(error: ApiFailure): RecorderError {
  if (error.status === 403 && error.details && 'never_record' in error.details) {
    return {
      code: 'never_record',
      message: NEVER_RECORD_MESSAGE,
      stillUsable: 'Typed notes still work for this meeting.',
    };
  }
  return failureToError(error);
}

function failureToError(error: ApiFailure): RecorderError {
  return {
    code: error.code,
    message: error.message,
    ...(error.stillUsable ? { stillUsable: error.stillUsable } : {}),
  };
}

/** "1:05" for a duration. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/* ------------------------------------------------------------ registry */

const registry = new Map<string, MeetingRecorder>();

/**
 * The recorder for a meeting. One per meeting per page, so a re-render, React
 * StrictMode or a second component never starts a second capture. On the
 * server it is a throwaway idle instance (nothing to record there).
 */
export function meetingRecorder(meetingId: string, options: RecorderOptions = {}): MeetingRecorder {
  if (typeof window === 'undefined' || options.deps) return new MeetingRecorder(meetingId, options);
  const existing = registry.get(meetingId);
  if (existing) {
    if (options.mode) existing.setMode(options.mode);
    return existing;
  }
  const created = new MeetingRecorder(meetingId, options);
  registry.set(meetingId, created);
  return created;
}

/** Test hook: forget every recorder. */
export function resetRecordersForTesting(): void {
  registry.clear();
}
