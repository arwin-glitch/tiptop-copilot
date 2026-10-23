import type { TranscriptTrack } from '@/lib/types/notes';
import { CAPTURE_RATE, CHUNK_MS } from './types';

/**
 * The audio path in the browser (D-076): one AudioContext, ideally at 16 kHz
 * so the browser resamples for us, and one AudioWorklet node per track
 * (public/worklets/pcm16.js) turning that track into 100 ms chunks of PCM16.
 * The nodes feed a muted gain so the graph keeps running without playing
 * anything back (no echo, nothing heard twice).
 *
 * If the browser cannot run a 16 kHz context, or cannot connect a microphone
 * to one (Firefox refuses mismatched rates), the context runs at its own rate
 * and the worklet downsamples: create({ nativeRate: true }).
 */

export const WORKLET_URL = '/worklets/pcm16.js';
export const WORKLET_NAME = 'pcm16';

export interface PcmChunk {
  track: TranscriptTrack;
  /** The context frame the chunk started at (one clock for every track). */
  frame: number;
  samples: Int16Array;
  rms: number;
  peak: number;
}

interface TrackNodes {
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
}

export class AudioGraph {
  private readonly nodes = new Map<TranscriptTrack, TrackNodes>();
  private sink: GainNode | null = null;

  private constructor(readonly context: AudioContext) {}

  /** Make the context and load the worklet. Call from a click so the context may start. */
  static async create(options: { nativeRate?: boolean } = {}): Promise<AudioGraph> {
    let context: AudioContext;
    try {
      context = options.nativeRate
        ? new AudioContext({ latencyHint: 'interactive' })
        : new AudioContext({ sampleRate: CAPTURE_RATE, latencyHint: 'interactive' });
    } catch {
      context = new AudioContext({ latencyHint: 'interactive' });
    }
    try {
      await context.audioWorklet.addModule(WORKLET_URL);
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
    const graph = new AudioGraph(context);
    if (context.state !== 'running') await context.resume().catch(() => undefined);
    return graph;
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }

  /** The context's clock, in frames. */
  get currentFrame(): number {
    return Math.round(this.context.currentTime * this.context.sampleRate);
  }

  private sinkNode(): GainNode {
    if (!this.sink) {
      this.sink = this.context.createGain();
      this.sink.gain.value = 0;
      this.sink.connect(this.context.destination);
    }
    return this.sink;
  }

  attach(
    track: TranscriptTrack,
    stream: MediaStream,
    onChunk: (chunk: PcmChunk) => void,
    active = true,
  ): void {
    this.detach(track);
    const source = this.context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(this.context, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { targetRate: CAPTURE_RATE, chunkMs: CHUNK_MS, active },
    });
    node.port.onmessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        frame?: number;
        samples?: ArrayBuffer;
        rms?: number;
        peak?: number;
      };
      if (data.type !== 'chunk' || !data.samples) return;
      onChunk({
        track,
        frame: data.frame ?? 0,
        samples: new Int16Array(data.samples),
        rms: data.rms ?? 0,
        peak: data.peak ?? 0,
      });
    };
    source.connect(node);
    node.connect(this.sinkNode());
    this.nodes.set(track, { source, node });
  }

  /** Stop (or restart) taking audio from a track; nothing is kept while inactive. */
  setActive(track: TranscriptTrack, active: boolean): void {
    this.nodes.get(track)?.node.port.postMessage({ type: 'active', active });
  }

  setAllActive(active: boolean): void {
    for (const track of this.nodes.keys()) this.setActive(track, active);
  }

  has(track: TranscriptTrack): boolean {
    return this.nodes.has(track);
  }

  detach(track: TranscriptTrack): void {
    const nodes = this.nodes.get(track);
    if (!nodes) return;
    this.nodes.delete(track);
    try {
      nodes.node.port.postMessage({ type: 'stop' });
      nodes.node.port.onmessage = null;
      nodes.source.disconnect();
      nodes.node.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  /** Wake the context after a phone suspended it (screen off, a call). */
  async resume(): Promise<void> {
    if (this.context.state !== 'running' && this.context.state !== 'closed') {
      await this.context.resume().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    for (const track of [...this.nodes.keys()]) this.detach(track);
    this.sink?.disconnect();
    this.sink = null;
    if (this.context.state !== 'closed') await this.context.close().catch(() => undefined);
  }
}
