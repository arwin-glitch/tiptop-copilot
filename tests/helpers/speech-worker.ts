import { FakeModelAdapter, type FakeAdapterOptions } from '@/lib/capture/fake-adapter';
import { SpeechPipeline, type PipelineOptions } from '@/lib/capture/speech-pipeline';
import type { FromWorker, ToWorker } from '@/lib/capture/speech-protocol';
import type { WorkerFactory, WorkerLike } from '@/lib/capture/speech-workers';

/**
 * The speech worker, in-process (D-076): the real pipeline with the fake
 * model, behind the same message interface as a Web Worker, with messages
 * delivered on a later tick each way like structured cloning would. Lets the
 * engine, the pool and the recorder be tested in Node with no model.
 */

export class InProcessWorker implements WorkerLike {
  onmessage: ((event: { data: FromWorker }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;
  readonly received: ToWorker[] = [];
  readonly sent: FromWorker[] = [];
  readonly adapter: FakeModelAdapter;
  private readonly pipeline: SpeechPipeline;

  constructor(adapterOptions: FakeAdapterOptions = {}, pipelineOptions: PipelineOptions = {}) {
    this.adapter = new FakeModelAdapter(adapterOptions);
    this.pipeline = new SpeechPipeline(
      this.adapter,
      (message) => {
        this.sent.push(message);
        setTimeout(() => {
          if (!this.terminated) this.onmessage?.({ data: message });
        }, 0);
      },
      { partials: false, ...pipelineOptions },
    );
  }

  postMessage(message: ToWorker): void {
    if (this.terminated) return;
    this.received.push(message);
    setTimeout(() => {
      if (!this.terminated) this.pipeline.handle(message);
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Behave like a worker that crashed. */
  crash(): void {
    this.onerror?.(new Error('crashed'));
  }
}

/** A factory that records every worker it makes. */
export function inProcessWorkers(
  adapterOptions: FakeAdapterOptions = {},
  pipelineOptions: PipelineOptions = {},
): { factory: WorkerFactory; workers: InProcessWorker[] } {
  const workers: InProcessWorker[] = [];
  return {
    workers,
    factory: () => {
      const worker = new InProcessWorker(adapterOptions, pipelineOptions);
      workers.push(worker);
      return worker;
    },
  };
}

/**
 * Speech-like PCM16, `ms` long: a 220 Hz tone at about -14 dBFS whose
 * loudness rises and falls four times a second, like syllables, dipping
 * between them the way a voice does.
 */
export function speech(ms: number): Int16Array {
  const n = Math.round((ms / 1000) * 16_000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / 16_000;
    const envelope = 0.1 + 0.9 * Math.abs(Math.sin(Math.PI * 4 * t));
    out[i] = Math.round(Math.sin(2 * Math.PI * 220 * t) * 6000 * envelope);
  }
  return out;
}

/** Silence, `ms` long. */
export function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((ms / 1000) * 16_000));
}

/** Audio in 100 ms pieces, as the worklet sends it. */
export function* pieces(...parts: Int16Array[]): Generator<Int16Array> {
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1600) yield part.slice(i, i + 1600);
  }
}
