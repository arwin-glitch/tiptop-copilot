import { describe, expect, it } from 'vitest';
import {
  createDownsampler,
  floatSampleToPcm16,
  floatToPcm16,
  meterLevel,
  pcm16ToFloat,
  rms,
  rmsPcm16,
} from '@/lib/capture/pcm';
import { AudioRingBuffer } from '@/lib/capture/ring-buffer';

/**
 * The web recorder's audio arithmetic (D-076, WS3): Float32 to PCM16, and
 * 48 kHz (or 44.1 kHz) down to the 16 kHz every speech session expects.
 */

function sine(freq: number, rate: number, seconds: number, amplitude = 0.5): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function zeroCrossings(x: Float32Array): number {
  let n = 0;
  for (let i = 1; i < x.length; i += 1) {
    const a = x[i - 1] ?? 0;
    const b = x[i] ?? 0;
    if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) n += 1;
  }
  return n;
}

describe('Float32 to PCM16', () => {
  it('maps the full range onto signed 16-bit, asymmetrically', () => {
    expect(floatSampleToPcm16(0)).toBe(0);
    expect(floatSampleToPcm16(1)).toBe(32767);
    expect(floatSampleToPcm16(-1)).toBe(-32768);
    expect(floatSampleToPcm16(0.5)).toBe(16384);
    expect(floatSampleToPcm16(-0.5)).toBe(-16384);
  });

  it('clips what is out of range and zeroes what is not a number', () => {
    expect(floatSampleToPcm16(1.7)).toBe(32767);
    expect(floatSampleToPcm16(-3)).toBe(-32768);
    expect(floatSampleToPcm16(Number.NaN)).toBe(0);
    expect(floatSampleToPcm16(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('converts a block, and back within one step', () => {
    const input = Float32Array.from([0, 0.25, -0.25, 0.999, -0.999, 2, -2]);
    const pcm = floatToPcm16(input);
    expect(pcm).toBeInstanceOf(Int16Array);
    expect(Array.from(pcm)).toEqual([0, 8192, -8192, 32734, -32735, 32767, -32768]);
    const back = pcm16ToFloat(pcm);
    for (let i = 0; i < 5; i += 1) {
      expect(Math.abs((back[i] ?? 0) - (input[i] ?? 0))).toBeLessThan(1 / 32767);
    }
  });
});

describe('downsampling to 16 kHz', () => {
  it('48 kHz to 16 kHz: a third of the samples, the same tone', () => {
    const input = sine(440, 48_000, 1);
    const out = createDownsampler(48_000, 16_000).process(input);
    expect(out.length).toBe(16_000);
    // 440 Hz crosses zero 880 times a second at any sample rate.
    expect(Math.abs(zeroCrossings(out) - 880)).toBeLessThanOrEqual(2);
    // Speech-band tones keep their loudness (the box filter costs ~1 dB at 440 Hz).
    expect(rms(out)).toBeGreaterThan(rms(input) * 0.95);
  });

  it('cuts tones the 16 kHz stream cannot carry instead of folding them down', () => {
    const input = sine(12_000, 48_000, 0.5);
    const out = createDownsampler(48_000, 16_000).process(input);
    expect(rms(out)).toBeLessThan(rms(input) * 0.5);
  });

  it('gives the same samples however the audio is split into pieces', () => {
    const input = sine(1000, 48_000, 0.2);
    const whole = createDownsampler(48_000, 16_000).process(input);
    const pieces = createDownsampler(48_000, 16_000);
    const parts: number[] = [];
    // Render quanta of 128, plus odd sizes.
    for (let i = 0, size = 128; i < input.length; i += size, size = size === 128 ? 77 : 128) {
      parts.push(...pieces.process(input.subarray(i, i + size)));
    }
    expect(parts.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i += 1) {
      expect(parts[i]).toBeCloseTo(whole[i] ?? 0, 6);
    }
  });

  it('handles 44.1 kHz, which does not divide evenly', () => {
    const input = sine(300, 44_100, 1);
    const out = createDownsampler(44_100, 16_000).process(input);
    expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(1);
    expect(Math.abs(zeroCrossings(out) - 600)).toBeLessThanOrEqual(2);
  });

  it('passes 16 kHz through unchanged, and refuses to upsample', () => {
    const input = sine(200, 16_000, 0.1);
    expect(Array.from(createDownsampler(16_000, 16_000).process(input))).toEqual(Array.from(input));
    expect(() => createDownsampler(8000, 16_000)).toThrow();
  });
});

describe('loudness', () => {
  it('measures RMS on both scales', () => {
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms(Float32Array.from([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rmsPcm16(Int16Array.from([16384, -16384]))).toBeCloseTo(0.5);
  });

  it('maps loudness onto a meter in decibels', () => {
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(0.0005)).toBe(0); // below -60 dBFS
    expect(meterLevel(1)).toBe(1);
    expect(meterLevel(0.1)).toBeCloseTo(2 / 3, 2); // -20 dBFS
  });
});

describe('the reconnect buffer', () => {
  const chunk = (startSample: number, loud = true) => ({
    startSample,
    samples: new Int16Array(1600),
    rms: loud ? 0.2 : 0,
  });

  it('keeps the last 30 seconds and forgets the rest', () => {
    const ring = new AudioRingBuffer(30_000);
    for (let i = 0; i < 400; i += 1) ring.push(chunk(i * 1600)); // 40 s of 100 ms chunks
    expect(ring.newestSample()).toBe(400 * 1600);
    expect(ring.oldestSample()).toBe(100 * 1600);
    expect(ring.size).toBe(300);
  });

  it('answers the chunks from a position on, whole chunks only', () => {
    const ring = new AudioRingBuffer(30_000);
    for (let i = 0; i < 10; i += 1) ring.push(chunk(i * 1600));
    const from = ring.from(2400); // inside chunk 1
    expect(from[0]?.startSample).toBe(1600);
    expect(from).toHaveLength(9);
  });

  it('tells lost speech apart from lost silence', () => {
    const ring = new AudioRingBuffer(1000); // 1 s
    for (let i = 0; i < 30; i += 1) ring.push(chunk(i * 1600, i < 10));
    // Chunks 0-9 had sound and are gone; 10-19 were silent and are gone too.
    expect(ring.loudTrimmedAfter(0)).toBe(10 * 1600);
    expect(ring.loudTrimmedAfter(5 * 1600)).toBe(5 * 1600);
    expect(ring.loudTrimmedAfter(12 * 1600)).toBe(0);
  });
});
