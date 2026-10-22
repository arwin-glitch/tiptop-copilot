import type { TranscriptTrack } from '@/lib/types/notes';
import { AudioGraph } from './audio-graph';
import { LevelMeter } from './levels';
import {
  NoMeetingAudioError,
  acquireMeetingAudio,
  acquireMicrophone,
  detectCapabilities,
  mediaError,
  stopStream,
} from './media';
import { DEFAULT_TUNING, type RecorderCapabilities, type RecorderError } from './types';

/**
 * A sound check before a call (D-076): does Copilot hear the microphone, and
 * does it hear the meeting tab or screen? Entirely on this computer: no
 * meeting is made, no speech service is called, nothing is sent or stored.
 * It answers the most common capture mistakes (the wrong tab, "Share tab
 * audio" left unticked) before they cost a meeting.
 */

export type SoundCheckSource = 'mic' | 'meeting';

export interface SoundCheckSourceState {
  running: boolean;
  level: number;
  /** Sound has been heard since the test started. */
  heard: boolean;
  error: RecorderError | null;
}

export interface SoundCheckSnapshot {
  mic: SoundCheckSourceState;
  meeting: SoundCheckSourceState;
  capabilities: RecorderCapabilities;
}

const IDLE: SoundCheckSourceState = { running: false, level: 0, heard: false, error: null };

/**
 * What the server rendered: no device abilities, so hydration matches. (Not
 * detectCapabilities(undefined, undefined): in the browser those undefineds
 * fall back to the real navigator, and the page would not match the server.)
 */
const SERVER_CAPABILITIES: RecorderCapabilities = {
  microphone: false,
  meetingAudio: false,
  audioWorklet: false,
  wakeLock: false,
  ios: false,
  standalone: false,
  mobile: false,
  platform: 'other',
};

const trackFor = (source: SoundCheckSource): TranscriptTrack =>
  source === 'mic' ? 'mic' : 'system';

export class SoundCheck {
  private graph: AudioGraph | null = null;
  private streams: Partial<Record<SoundCheckSource, MediaStream>> = {};
  private meters: Record<SoundCheckSource, LevelMeter> = {
    mic: new LevelMeter(),
    meeting: new LevelMeter(),
  };
  private state: Record<SoundCheckSource, SoundCheckSourceState> = { mic: IDLE, meeting: IDLE };
  private snapshot_: SoundCheckSnapshot;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly capabilities: RecorderCapabilities;
  private readonly serverSnapshot: SoundCheckSnapshot;

  constructor() {
    this.capabilities = detectCapabilities();
    this.snapshot_ = this.build();
    this.serverSnapshot = { mic: IDLE, meeting: IDLE, capabilities: SERVER_CAPABILITIES };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot_;

  getServerSnapshot = () => this.serverSnapshot;

  private build(): SoundCheckSnapshot {
    return {
      mic: { ...this.state.mic },
      meeting: { ...this.state.meeting },
      capabilities: this.capabilities,
    };
  }

  private emit(soon = false): void {
    if (soon) {
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.emit();
      }, 80);
      return;
    }
    this.snapshot_ = this.build();
    for (const l of [...this.listeners]) l();
  }

  /** Start testing a source. Call from a click (the share picker needs one). */
  async test(source: SoundCheckSource): Promise<void> {
    if (this.state[source].running) return;
    // The picker or the permission prompt first, straight from the click.
    const mediaP = source === 'mic' ? acquireMicrophone() : acquireMeetingAudio();
    const graphP = this.graph ? Promise.resolve(this.graph) : AudioGraph.create();
    let media: MediaStream;
    try {
      media = await mediaP;
    } catch (error) {
      this.state[source] = {
        ...IDLE,
        error:
          error instanceof NoMeetingAudioError
            ? error.recorderError
            : mediaError(error, source === 'mic' ? 'mic' : 'meeting'),
      };
      this.emit();
      return;
    }
    try {
      this.graph = await graphP;
    } catch {
      stopStream(media);
      this.state[source] = {
        ...IDLE,
        error: { code: 'audio_engine', message: 'The browser could not start its audio engine.' },
      };
      this.emit();
      return;
    }
    this.streams[source] = media;
    this.meters[source].reset();
    this.state[source] = { running: true, level: 0, heard: false, error: null };
    this.graph.attach(trackFor(source), media, (chunk) => {
      const level = this.meters[source].update(chunk.rms);
      const heard = this.state[source].heard || chunk.rms > DEFAULT_TUNING.silenceThreshold;
      this.state[source] = { ...this.state[source], level, heard };
      this.emit(true);
    });
    for (const t of media.getAudioTracks()) {
      t.addEventListener('ended', () => this.end(source));
    }
    this.emit();
  }

  /** Stop testing one source. */
  end(source: SoundCheckSource): void {
    this.graph?.detach(trackFor(source));
    stopStream(this.streams[source]);
    delete this.streams[source];
    this.state[source] = { ...this.state[source], running: false, level: 0 };
    this.emit();
  }

  /** Stop everything and let go of the devices. */
  async dispose(): Promise<void> {
    this.end('mic');
    this.end('meeting');
    const graph = this.graph;
    this.graph = null;
    await graph?.close();
  }
}
