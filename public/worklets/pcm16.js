/* global registerProcessor, AudioWorkletProcessor, sampleRate, currentFrame */
/**
 * Copilot Notes web recorder (D-076): one track's audio as 16 kHz PCM16.
 *
 * Runs on the audio thread. Each instance takes one track (the microphone, or
 * the meeting audio from a shared tab or screen), mixes it to mono,
 * downsamples it to 16 kHz when the AudioContext runs faster, and posts it to
 * the page in 100 ms chunks with the chunk's loudness. The page streams the
 * chunks to the speech vendor and keeps the last 30 seconds in memory for a
 * reconnect. Nothing here stores or sends audio anywhere else.
 *
 * Plain JavaScript because worklets load as standalone modules. The same
 * arithmetic lives in src/lib/capture/pcm.ts; tests/unit/capture-worklet.test.ts
 * runs this file against it.
 *
 * Messages in:  { type: 'active', active: boolean }  (false while paused: input is dropped)
 *               { type: 'stop' }                     (the processor ends)
 * Messages out: { type: 'chunk', frame, samples: ArrayBuffer (Int16, transferred), rms, peak }
 */

class Pcm16Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    const chunkMs = opts.chunkMs || 100;
    this.chunkSamples = Math.max(1, Math.round((this.targetRate * chunkMs) / 1000));
    this.ratio = sampleRate / this.targetRate;
    this.active = opts.active !== false;
    this.stopped = false;
    this.resetChunk();
    // Downsampler state (see createDownsampler in pcm.ts).
    this.start = 0;
    this.sum = 0;
    this.weight = 0;
    this.position = 0;
    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'active') {
        this.active = Boolean(data.active);
        if (!this.active) this.resetChunk();
      } else if (data.type === 'stop') {
        this.stopped = true;
        this.resetChunk();
      }
    };
  }

  resetChunk() {
    this.chunk = new Int16Array(this.chunkSamples);
    this.fill = 0;
    this.sumSquares = 0;
    this.peak = 0;
    this.chunkFrame = -1;
  }

  /** Append one 16 kHz float sample to the chunk; post the chunk when full. */
  push(value, frame) {
    if (this.chunkFrame < 0) this.chunkFrame = frame;
    const s = value > 1 ? 1 : value < -1 ? -1 : value || 0;
    const scaled = s < 0 ? s * 0x8000 : s * 0x7fff;
    let rounded = Math.round(scaled);
    if (rounded > 0x7fff) rounded = 0x7fff;
    if (rounded < -0x8000) rounded = -0x8000;
    this.chunk[this.fill] = rounded;
    this.fill += 1;
    this.sumSquares += s * s;
    const a = s < 0 ? -s : s;
    if (a > this.peak) this.peak = a;
    if (this.fill === this.chunkSamples) {
      const samples = this.chunk.buffer;
      this.port.postMessage(
        {
          type: 'chunk',
          frame: this.chunkFrame,
          samples,
          rms: Math.sqrt(this.sumSquares / this.chunkSamples),
          peak: this.peak,
        },
        [samples],
      );
      this.resetChunk();
    }
  }

  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    if (!this.active || !input || input.length === 0) return true;
    const channels = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i += 1) {
      let value = 0;
      for (let c = 0; c < channels; c += 1) value += input[c][i];
      value /= channels;
      const frame = currentFrame + i;
      if (this.ratio === 1) {
        this.push(value, frame);
        continue;
      }
      let from = this.position;
      const to = this.position + 1;
      while (from < to) {
        const end = this.start + this.ratio;
        const take = Math.min(to, end) - from;
        this.sum += value * take;
        this.weight += take;
        from += take;
        if (from >= end - 1e-9) {
          this.push(this.weight > 0 ? this.sum / this.weight : 0, frame);
          this.start = end;
          this.sum = 0;
          this.weight = 0;
        }
      }
      this.position = to;
    }
    if (this.position > 1e6) {
      this.position -= this.start;
      this.start = 0;
    }
    return true;
  }
}

registerProcessor('pcm16', Pcm16Processor);
