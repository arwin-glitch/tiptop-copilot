import { SpeechPipeline, type ModelAdapter } from '@/lib/capture/speech-pipeline';
import type { FromWorker, ToWorker } from '@/lib/capture/speech-protocol';

/**
 * Copilot Notes' speech worker (D-076): Whisper and the speaker models, off
 * the page's main thread, on this computer. One worker per track (or one
 * shared, for the largest model); lib/capture/whisper-engine.ts makes them.
 *
 * Audio comes in, text goes out, nothing is stored. The models load lazily
 * (the fake one only in demo mode and the tests), so the page never pays for
 * transformers.js until a recording, a sound check or a setup test starts.
 */

interface WorkerScope {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const post = (message: FromWorker) => scope.postMessage(message);

let pipeline: SpeechPipeline | null = null;
let creating: Promise<void> | null = null;
/** Messages that arrive while the models' code loads, in order. */
const waiting: ToWorker[] = [];

async function create(message: Extract<ToWorker, { type: 'init' }>): Promise<void> {
  let adapter: ModelAdapter;
  try {
    if (message.config.adapter === 'fake') {
      const { FakeModelAdapter } = await import('@/lib/capture/fake-adapter');
      adapter = new FakeModelAdapter();
    } else {
      const { TransformersAdapter } = await import('@/lib/capture/transformers-adapter');
      adapter = new TransformersAdapter();
    }
  } catch {
    post({
      type: 'fatal',
      message: 'The speech engine could not load. Reload the page and try again.',
      retryable: true,
    });
    return;
  }
  pipeline = new SpeechPipeline(adapter, post);
  pipeline.handle(message);
  for (const queued of waiting.splice(0)) pipeline.handle(queued);
}

scope.onmessage = (event) => {
  const message = event.data;
  if (pipeline) {
    pipeline.handle(message);
    return;
  }
  if (!creating) {
    if (message.type !== 'init') return;
    creating = create(message);
    return;
  }
  waiting.push(message);
};
