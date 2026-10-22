import type { SpeechSession } from '@/lib/types/notes';
import type {
  EngineStatus,
  SpeechEngine,
  SpeechEngineHandlers,
  SpeechEngineOptions,
} from './speech-engine';
import { readSpeechPreferences, type SpeechPreferences } from './speech-preferences';
import type { AdapterKind, FromWorker, LoadStatus, WorkerConfig } from './speech-protocol';
import { speechWorkerPool, type SpeechWorkerHost, type SpeechWorkerPool } from './speech-workers';

/**
 * Whisper in the browser, as one track's speech engine (D-076). Free: no key,
 * no vendor, no per-minute bill. The audio goes to a Web Worker on this
 * computer (speech-workers.ts, src/workers/speech.worker.ts) and finished
 * lines come back; nothing else leaves the page but those lines.
 *
 * open() resolves as soon as the worker takes audio, before the model has
 * finished downloading: the worker queues what it hears, so the first words
 * of a meeting are never lost to a first-run download. finish() waits for
 * every queued word, for as long as the work keeps moving.
 */

/** How long the worker may go without any sign of progress before finish gives up. */
export const WHISPER_STALL_MS = 120_000;
/** How long a worker may take to accept a stream. */
const START_TIMEOUT_MS = 20_000;

export interface WhisperEngineOptions extends SpeechEngineOptions {
  pool?: SpeechWorkerPool;
  preferences?: SpeechPreferences;
  adapter?: AdapterKind;
  /** Override the stall window (tests). */
  stallMs?: number;
}

let nextStream = 1;
let nextRequest = 1;

/** An open() failure that starting again cannot fix (no Worker in this browser). */
export class EngineStartError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EngineStartError';
  }
}

export class WhisperEngine implements SpeechEngine {
  private readonly streamId = `s${nextStream++}`;
  private host: SpeechWorkerHost | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly pool: SpeechWorkerPool;
  private open_ = false;
  private closed = false;
  private finishing = false;
  private load: LoadStatus | null = null;
  private backlogMs = 0;
  private lastActivity = Date.now();
  private opening: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private finishWaiters: (() => void)[] = [];
  private readonly voiceWaiters = new Map<
    number,
    (v: { voiceprint: string; modelVersion: string } | null) => void
  >();

  constructor(
    private readonly session: SpeechSession,
    private readonly handlers: SpeechEngineHandlers,
    private readonly options: WhisperEngineOptions,
  ) {
    this.pool = options.pool ?? speechWorkerPool();
  }

  get isOpen(): boolean {
    return this.open_ && !this.closed && !this.finishing;
  }

  open(): Promise<void> {
    const prefs = this.options.preferences ?? readSpeechPreferences();
    const config: WorkerConfig = {
      choice: prefs.model,
      device: prefs.device,
      language: this.session.language || 'en',
      adapter: this.options.adapter ?? 'transformers',
    };
    let host: SpeechWorkerHost;
    try {
      host = this.pool.acquire(config, config.choice === 'best' ? 'shared' : this.session.track);
    } catch {
      return Promise.reject(
        new EngineStartError(
          'This browser cannot run speech on this computer. Use Chrome or Edge.',
          false,
        ),
      );
    }
    this.host = host;
    this.unsubscribe = host.subscribe((message) => this.onMessage(message));
    if (host.status) {
      this.load = host.status;
      this.emitStatus();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.opening) return;
        this.opening = null;
        this.release();
        reject(new EngineStartError('The speech engine did not start.', true));
      }, START_TIMEOUT_MS);
      this.opening = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      host.post({
        type: 'start',
        streamId: this.streamId,
        track: this.session.track,
        diarize: this.session.track !== 'mic',
        knownVoices: this.session.knownVoices,
        vocabulary: this.session.vocabulary,
      });
    });
  }

  private onMessage(message: FromWorker): void {
    if (this.closed) return;
    switch (message.type) {
      case 'status':
        this.load = message.status;
        this.lastActivity = Date.now();
        this.emitStatus();
        return;
      case 'started':
        if (message.streamId !== this.streamId) return;
        this.open_ = true;
        this.lastActivity = Date.now();
        this.opening?.resolve();
        this.opening = null;
        return;
      case 'event':
        if (message.streamId !== this.streamId) return;
        this.lastActivity = Date.now();
        this.handlers.onEvent(message.event);
        return;
      case 'progress':
        if (message.streamId !== this.streamId) return;
        this.lastActivity = Date.now();
        if (message.backlogMs !== this.backlogMs) {
          this.backlogMs = message.backlogMs;
          this.emitStatus();
        }
        return;
      case 'finished':
        if (message.streamId !== this.streamId) return;
        for (const done of this.finishWaiters.splice(0)) done();
        return;
      case 'voiceprint': {
        const waiter = this.voiceWaiters.get(message.requestId);
        if (!waiter) return;
        this.voiceWaiters.delete(message.requestId);
        waiter(
          message.voiceprint && message.modelVersion
            ? { voiceprint: message.voiceprint, modelVersion: message.modelVersion }
            : null,
        );
        return;
      }
      case 'fatal':
        this.fail(message.message, message.retryable);
        return;
      case 'test-result':
        return;
    }
  }

  private emitStatus(): void {
    const load = this.load;
    const status: EngineStatus = {
      phase: load?.phase ?? 'loading',
      progress: load?.progress ?? null,
      loadedMb: load?.loadedMb ?? 0,
      totalMb: load?.totalMb ?? 0,
      device: load?.device ?? null,
      model: load?.model ?? null,
      backlogMs: this.backlogMs,
      message: load?.message ?? null,
    };
    this.handlers.onStatus?.(status);
  }

  sendAudio(samples: Int16Array): void {
    if (!this.isOpen || !this.host) return;
    // A copy: the recorder keeps the original in its in-memory replay buffer.
    const copy = samples.slice();
    this.host.post({ type: 'audio', streamId: this.streamId, samples: copy }, [copy.buffer]);
  }

  async finish(timeoutMs: number): Promise<void> {
    if (!this.open_ || this.closed || !this.host) {
      this.close();
      return;
    }
    if (!this.finishing) {
      this.finishing = true;
      this.lastActivity = Date.now();
      this.host.post({ type: 'finish', streamId: this.streamId });
    }
    const stallMs = Math.max(timeoutMs, this.options.stallMs ?? WHISPER_STALL_MS);
    await new Promise<void>((resolve) => {
      const check = setInterval(
        () => {
          if (Date.now() - this.lastActivity > stallMs) {
            clearInterval(check);
            resolve();
          }
        },
        Math.min(1000, stallMs),
      );
      this.finishWaiters.push(() => {
        clearInterval(check);
        resolve();
      });
    });
    this.end(true, 1000, 'done', true);
  }

  close(): void {
    this.end(true, 1000, 'done', true);
  }

  async voiceprint(
    label: string,
    timeoutMs: number,
  ): Promise<{ voiceprint: string; modelVersion: string } | null> {
    if (!this.open_ || this.closed || !this.host) return null;
    const requestId = nextRequest++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.voiceWaiters.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.voiceWaiters.set(requestId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.host?.post({ type: 'voiceprint', streamId: this.streamId, requestId, label });
    });
  }

  private fail(message: string, retryable: boolean): void {
    if (this.closed) return;
    const host = this.host;
    if (this.opening) {
      const opening = this.opening;
      this.opening = null;
      this.closed = true;
      this.unsubscribe?.();
      if (host) this.pool.discard(host);
      this.host = null;
      opening.reject(new EngineStartError(message, retryable));
      return;
    }
    this.load = this.load ? { ...this.load, phase: 'failed', message } : null;
    this.emitStatus();
    if (host) this.pool.discard(host);
    this.host = null;
    this.end(false, 1011, message, retryable);
  }

  private end(expected: boolean, code: number, reason: string, retryable: boolean): void {
    if (this.closed) return;
    const wasOpen = this.open_;
    this.closed = true;
    this.open_ = false;
    this.host?.post({ type: 'close', streamId: this.streamId });
    this.release();
    for (const done of this.finishWaiters.splice(0)) done();
    for (const waiter of this.voiceWaiters.values()) waiter(null);
    this.voiceWaiters.clear();
    if (wasOpen) this.handlers.onClose({ expected, code, reason, retryable });
  }

  private release(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const host = this.host;
    this.host = null;
    if (host) this.pool.release(host);
  }
}
