/**
 * Audio arithmetic for the web recorder (D-076, WS3). Pure and client-safe.
 *
 * The AudioWorklet (public/worklets/pcm16.js) runs the same arithmetic on the
 * audio thread; it is plain JavaScript and cannot import this file, so
 * tests/unit/capture-worklet.test.ts runs the worklet against these functions
 * to keep the two in step.
 */

/** Float samples (-1..1) to signed 16-bit, clipped and rounded half away from zero. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    out[i] = floatSampleToPcm16(input[i] ?? 0);
  }
  return out;
}

export function floatSampleToPcm16(sample: number): number {
  const s = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
  // Asymmetric range: -32768..32767.
  const scaled = s < 0 ? s * 0x8000 : s * 0x7fff;
  return Math.max(-0x8000, Math.min(0x7fff, Math.round(scaled)));
}

export function pcm16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const v = input[i] ?? 0;
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  return out;
}

/**
 * A streaming downsampler: each output sample is the average of the input it
 * covers (a box filter), which keeps speech clear and stops most aliasing
 * without a filter library. Handles ratios that are not whole numbers
 * (44.1 kHz to 16 kHz). Feeding the audio in pieces gives the same samples as
 * feeding it at once, so render quanta can arrive in any size.
 */
export interface Downsampler {
  readonly inRate: number;
  readonly outRate: number;
  process(input: Float32Array): Float32Array;
}

export function createDownsampler(inRate: number, outRate: number): Downsampler {
  if (!(inRate > 0) || !(outRate > 0)) throw new Error('Sample rates must be positive');
  if (outRate > inRate) throw new Error('Only downsampling is supported');
  const ratio = inRate / outRate;
  if (ratio === 1) {
    return { inRate, outRate, process: (input) => Float32Array.from(input) };
  }
  // The output sample being built covers input positions [start, start + ratio).
  let start = 0;
  let sum = 0;
  let weight = 0;
  // Input position (in input samples) of the next sample to read.
  let position = 0;
  return {
    inRate,
    outRate,
    process(input: Float32Array): Float32Array {
      const out: number[] = [];
      for (let i = 0; i < input.length; i += 1) {
        const value = input[i] ?? 0;
        let from = position;
        const to = position + 1;
        // One input sample can straddle the end of the output sample's window.
        while (from < to) {
          const end = start + ratio;
          const take = Math.min(to, end) - from;
          sum += value * take;
          weight += take;
          from += take;
          if (from >= end - 1e-9) {
            out.push(weight > 0 ? sum / weight : 0);
            start = end;
            sum = 0;
            weight = 0;
          }
        }
        position = to;
      }
      // Keep positions small so a long recording never loses precision.
      if (position > 1e6) {
        position -= start;
        start = 0;
      }
      return Float32Array.from(out);
    },
  };
}

/** Root mean square of a block of float samples. */
export function rms(input: Float32Array): number {
  if (input.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < input.length; i += 1) {
    const v = input[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / input.length);
}

/** Root mean square of PCM16 samples, on the -1..1 scale. */
export function rmsPcm16(input: Int16Array): number {
  if (input.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < input.length; i += 1) {
    const v = (input[i] ?? 0) / 0x8000;
    sum += v * v;
  }
  return Math.sqrt(sum / input.length);
}

/**
 * A meter position (0..1) for an RMS value: -60 dBFS and below is empty, 0 dBFS
 * is full, linear in decibels between, which is how loudness feels.
 */
export function meterLevel(rmsValue: number, floorDb = -60): number {
  if (!(rmsValue > 0)) return 0;
  const db = 20 * Math.log10(rmsValue);
  if (db <= floorDb) return 0;
  return Math.min(1, (db - floorDb) / -floorDb);
}
