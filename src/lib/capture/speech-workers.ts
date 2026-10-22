import type { FromWorker, LoadStatus, ToWorker, WorkerConfig } from './speech-protocol';

/**
 * The speech workers (D-076): one Web Worker per track, so the microphone and
 * the meeting audio are transcribed side by side (on the CPU that means two
 * cores), and one shared by both tracks for Best, whose model is too big to
 * load twice. A worker outlives a pause: the model stays loaded for a couple
 * of minutes after the last engine lets go, so Resume starts at once.
 */

/** The part of a Worker the engines use, so tests can run the pipeline in-process. */
export interface WorkerLike {
  postMessage(message: ToWorker, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: FromWorker }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WorkerFactory = () => WorkerLike;

/** The real worker, bundled from src/workers/speech.worker.ts. */
export const browserWorkerFactory: WorkerFactory = () =>
  new Worker(new URL('../../workers/speech.worker.ts', import.meta.url), {
    type: 'module',
    name: 'copilot-speech',
  }) as unknown as WorkerLike;

type Listener = (message: FromWorker) => void;

export class SpeechWorkerHost {
  private readonly worker: WorkerLike;
  private readonly listeners = new Set<Listener>();
  status: LoadStatus | null = null;
  dead = false;
  refs = 0;
  idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly key: string,
    config: WorkerConfig,
    factory: WorkerFactory,
  ) {
    this.worker = factory();
    this.worker.onmessage = (event) => this.dispatch(event.data);
    this.worker.onerror = () =>
      this.dispatch({
        type: 'fatal',
        message: 'The speech engine stopped unexpectedly.',
        retryable: true,
      });
    this.worker.postMessage({ type: 'init', config });
  }

  private dispatch(message: FromWorker): void {
    if (message.type === 'status') this.status = message.status;
    if (message.type === 'fatal') this.dead = true;
    for (const listener of [...this.listeners]) listener(message);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  post(message: ToWorker, transfer?: Transferable[]): void {
    if (this.dead) return;
    this.worker.postMessage(message, transfer);
  }

  terminate(): void {
    this.dead = true;
    this.listeners.clear();
    try {
      this.worker.terminate();
    } catch {
      // Already gone.
    }
  }
}

export class SpeechWorkerPool {
  private readonly hosts = new Map<string, SpeechWorkerHost>();

  constructor(
    private readonly factory: WorkerFactory = browserWorkerFactory,
    private readonly idleMs = 120_000,
  ) {}

  /** A worker for this configuration and slot (a track, or 'shared'), started if need be. */
  acquire(config: WorkerConfig, slot: string): SpeechWorkerHost {
    const key = `${config.adapter}|${config.choice}|${config.device}|${config.language}|${slot}`;
    let host = this.hosts.get(key);
    if (host?.dead) {
      host.terminate();
      this.hosts.delete(key);
      host = undefined;
    }
    if (!host) {
      host = new SpeechWorkerHost(key, config, this.factory);
      this.hosts.set(key, host);
    }
    if (host.idleTimer) clearTimeout(host.idleTimer);
    host.idleTimer = null;
    host.refs += 1;
    return host;
  }

  /** An engine is done with its worker; it stops after a while unused. */
  release(host: SpeechWorkerHost): void {
    host.refs = Math.max(0, host.refs - 1);
    if (host.refs > 0 || host.dead) {
      if (host.dead) this.discard(host);
      return;
    }
    if (host.idleTimer) clearTimeout(host.idleTimer);
    host.idleTimer = setTimeout(() => {
      if (host.refs === 0) this.discard(host);
    }, this.idleMs);
  }

  /** Stop a worker now (it failed, or nothing will use it again). */
  discard(host: SpeechWorkerHost): void {
    if (host.idleTimer) clearTimeout(host.idleTimer);
    host.idleTimer = null;
    host.terminate();
    if (this.hosts.get(host.key) === host) this.hosts.delete(host.key);
  }

  /** Stop every worker (the recorder is torn down, or a test ends). */
  terminateAll(): void {
    for (const host of [...this.hosts.values()]) this.discard(host);
  }

  get size(): number {
    return this.hosts.size;
  }
}

let shared: SpeechWorkerPool | null = null;

/** The page's pool of speech workers. */
export function speechWorkerPool(): SpeechWorkerPool {
  if (!shared) shared = new SpeechWorkerPool();
  return shared;
}
