import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createDownsampler, floatToPcm16 } from '@/lib/capture/pcm';

/**
 * public/worklets/pcm16.js runs on the browser's audio thread and cannot
 * import the TypeScript, so it carries its own copy of the arithmetic. This
 * runs the real file in a sandbox that stands in for AudioWorkletGlobalScope
 * and checks it against src/lib/capture/pcm.ts.
 */

const SOURCE = readFileSync(
  path.resolve(import.meta.dirname, '../../public/worklets/pcm16.js'),
  'utf8',
);

interface Posted {
  type: string;
  frame: number;
  samples: ArrayBuffer;
  rms: number;
  peak: number;
}

interface ProcessorLike {
  port: { onmessage: ((e: { data: unknown }) => void) | null };
  process(inputs: Float32Array[][]): boolean;
}

function loadWorklet(rate: number, options: Record<string, unknown> = {}) {
  let Processor: (new (opts: unknown) => ProcessorLike) | null = null;
  const posted: Posted[] = [];
  const scope = {
    sampleRate: rate,
    currentFrame: 0,
    registerProcessor: (name: string, ctor: new (opts: unknown) => ProcessorLike) => {
      expect(name).toBe('pcm16');
      Processor = ctor;
    },
    AudioWorkletProcessor: class {
      port = {
        onmessage: null as ((e: { data: unknown }) => void) | null,
        postMessage: (message: Posted) => posted.push(message),
      };
    },
  };
  vm.createContext(scope);
  vm.runInContext(SOURCE, scope);
  if (!Processor) throw new Error('pcm16 was not registered');
  const Ctor = Processor as new (opts: unknown) => ProcessorLike;
  const node = new Ctor({ processorOptions: { targetRate: 16000, chunkMs: 100, ...options } });
  /** Feed audio in render quanta of 128 frames, advancing the shared clock. */
  const feed = (channels: Float32Array[]) => {
    const frames = channels[0]?.length ?? 0;
    for (let i = 0; i < frames; i += 128) {
      scope.currentFrame = i;
      node.process([channels.map((c) => c.subarray(i, i + 128))]);
    }
  };
  return { node, posted, feed, scope };
}

function sine(freq: number, rate: number, n: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

describe('the pcm16 worklet', () => {
  it('at 16 kHz posts 100 ms chunks equal to floatToPcm16', () => {
    const { posted, feed } = loadWorklet(16_000);
    const input = sine(440, 16_000, 16_000 * 0.5);
    feed([input]);
    expect(posted).toHaveLength(5);
    const all = posted.flatMap((p) => Array.from(new Int16Array(p.samples)));
    expect(all).toEqual(Array.from(floatToPcm16(input)));
    expect(posted[0]?.frame).toBe(0);
    expect(posted[1]?.frame).toBe(1600); // the exact frame of the chunk's first sample
    expect(posted[0]?.rms).toBeGreaterThan(0.3);
    expect(posted[0]?.peak).toBeCloseTo(0.5, 2);
  });

  it('at 48 kHz downsamples exactly as createDownsampler does', () => {
    const { posted, feed } = loadWorklet(48_000);
    const input = sine(700, 48_000, 48_000 * 0.3);
    feed([input]);
    expect(posted).toHaveLength(3);
    const got = posted.flatMap((p) => Array.from(new Int16Array(p.samples)));
    const want = Array.from(floatToPcm16(createDownsampler(48_000, 16_000).process(input)));
    expect(got.length).toBe(4800);
    for (let i = 0; i < got.length; i += 1) {
      expect(Math.abs((got[i] ?? 0) - (want[i] ?? 0))).toBeLessThanOrEqual(1);
    }
  });

  it('mixes stereo meeting audio to mono', () => {
    const { posted, feed } = loadWorklet(16_000);
    const left = new Float32Array(1600).fill(0.5);
    const right = new Float32Array(1600).fill(-0.1);
    feed([left, right]);
    expect(Array.from(new Int16Array(posted[0]!.samples)).every((v) => v === 6553)).toBe(true);
  });

  it('drops audio while inactive (paused), and stops for good on stop', () => {
    const { node, posted, feed } = loadWorklet(16_000);
    node.port.onmessage?.({ data: { type: 'active', active: false } });
    feed([sine(300, 16_000, 3200)]);
    expect(posted).toHaveLength(0);
    node.port.onmessage?.({ data: { type: 'active', active: true } });
    feed([sine(300, 16_000, 3200)]);
    expect(posted).toHaveLength(2);
    node.port.onmessage?.({ data: { type: 'stop' } });
    expect(node.process([[new Float32Array(128)]])).toBe(false);
  });

  it('can start inactive, so nothing is heard before it is told to listen', () => {
    const { posted, feed } = loadWorklet(16_000, { active: false });
    feed([sine(300, 16_000, 3200)]);
    expect(posted).toHaveLength(0);
  });
});
