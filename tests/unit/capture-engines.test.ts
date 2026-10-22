import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpeechEngine } from '@/lib/capture/engine-factory';
import { FAKE_VOICEPRINT_MODEL } from '@/lib/capture/fake-adapter';
import { MockSpeechEngine } from '@/lib/capture/mock-engine';
import type {
  EngineStatus,
  SpeechEngineClose,
  SpeechEngineHandlers,
} from '@/lib/capture/speech-engine';
import { SpeechWorkerPool } from '@/lib/capture/speech-workers';
import { EngineStartError, WhisperEngine } from '@/lib/capture/whisper-engine';
import { MOCK_VOICEPRINT_MODEL } from '@/lib/transcribe/mock-script';
import { decodeVoiceprint } from '@/lib/transcribe/voiceprint';
import type { SpeechSession, TranscriptEvent, TranscriptTrack } from '@/lib/types/notes';
import { inProcessWorkers, pieces, silence, speech } from '../helpers/speech-worker';

/**
 * The speech engines (D-076): Whisper in a Web Worker on this computer (here,
 * the real pipeline in-process with a fake model) and the demo's scripted
 * engine. Free, no network: what goes in is audio, what comes out is text.
 */

function session(
  track: TranscriptTrack,
  provider: SpeechSession['provider'] = 'browser-whisper',
): SpeechSession {
  return {
    track,
    provider,
    language: 'en',
    vocabulary: [],
    knownVoices: [],
    sessionConfig: provider === 'mock' ? { script: 'acme-intro', track } : {},
    audio: { sampleRate: 16000, encoding: 'pcm_s16le', channels: 1 },
  };
}

function collect() {
  const events: TranscriptEvent[] = [];
  const closes: SpeechEngineClose[] = [];
  const statuses: EngineStatus[] = [];
  const handlers: SpeechEngineHandlers = {
    onEvent: (e) => events.push(e),
    onClose: (c) => closes.push(c),
    onStatus: (s) => statuses.push(s),
  };
  return { events, closes, statuses, handlers };
}

const PREFS = { model: 'fast' as const, device: 'auto' as const };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Whisper on this computer', () => {
  it('starts at once, transcribes in its worker, and reports the model loading', async () => {
    const { factory, workers } = inProcessWorkers();
    const pool = new SpeechWorkerPool(factory, 1000);
    const c = collect();
    const engine = new WhisperEngine(session('mic'), c.handlers, {
      baseMs: 0,
      pool,
      preferences: PREFS,
      adapter: 'fake',
    });
    const opening = engine.open();
    await vi.advanceTimersByTimeAsync(20);
    await opening;
    expect(engine.isOpen).toBe(true);
    for (const p of pieces(speech(3000), silence(2000))) engine.sendAudio(p);
    await vi.advanceTimersByTimeAsync(50);
    expect(c.events).toHaveLength(1);
    expect(c.events[0]).toMatchObject({ type: 'final', track: 'mic', speakerLabel: null });
    expect(c.statuses.at(-1)).toMatchObject({ phase: 'ready', model: 'fast' });
    // Audio was copied into the worker; the worker got settings, never a key.
    const start = workers[0]!.received.find((m) => m.type === 'start');
    expect(start).toMatchObject({ track: 'mic', diarize: false, knownVoices: [] });
    expect(workers[0]!.received.find((m) => m.type === 'init')).toMatchObject({
      config: { choice: 'fast', adapter: 'fake' },
    });
  });

  it('finish waits for every queued word, then closes cleanly', async () => {
    const { factory } = inProcessWorkers({ delayMs: 2000 });
    const pool = new SpeechWorkerPool(factory, 1000);
    const c = collect();
    const engine = new WhisperEngine(session('mic'), c.handlers, {
      baseMs: 0,
      pool,
      preferences: PREFS,
      adapter: 'fake',
    });
    const opening = engine.open();
    await vi.advanceTimersByTimeAsync(20);
    await opening;
    for (let i = 0; i < 3; i += 1)
      for (const p of pieces(speech(3000), silence(2000))) engine.sendAudio(p);
    let done = false;
    const finishing = engine.finish(5000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(false);
    expect(c.statuses.some((s) => s.backlogMs > 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await finishing;
    expect(c.events).toHaveLength(3);
    expect(c.closes).toEqual([{ expected: true, code: 1000, reason: 'done', retryable: true }]);
    expect(engine.isOpen).toBe(false);
  });

  it('a model that cannot run here fails plainly instead of retrying forever', async () => {
    const { factory } = inProcessWorkers({
      failLoad: { message: 'Not on this computer.', retryable: false },
    });
    const pool = new SpeechWorkerPool(factory, 1000);
    const c = collect();
    const engine = new WhisperEngine(session('mic'), c.handlers, {
      baseMs: 0,
      pool,
      preferences: PREFS,
      adapter: 'fake',
    });
    let error: unknown = null;
    const opening = engine.open().catch((e: unknown) => {
      error = e;
    });
    await vi.advanceTimersByTimeAsync(50);
    await opening;
    const refused =
      (error instanceof EngineStartError && error.retryable === false) ||
      c.closes.some((x) => !x.expected && !x.retryable);
    expect(refused).toBe(true);
    expect(pool.size).toBe(0); // the failed worker is gone
  });

  it('a worker that crashes closes the engine so the recorder can restart it', async () => {
    const { factory, workers } = inProcessWorkers();
    const pool = new SpeechWorkerPool(factory, 1000);
    const c = collect();
    const engine = new WhisperEngine(session('system'), c.handlers, {
      baseMs: 0,
      pool,
      preferences: PREFS,
      adapter: 'fake',
    });
    const opening = engine.open();
    await vi.advanceTimersByTimeAsync(20);
    await opening;
    workers[0]!.crash();
    expect(c.closes).toEqual([
      {
        expected: false,
        code: 1011,
        reason: 'The speech engine stopped unexpectedly.',
        retryable: true,
      },
    ]);
  });

  it('gives a heard voice’s voiceprint for "Remember this voice", and nothing else', async () => {
    const { factory } = inProcessWorkers({ voiceFor: () => 'priya' });
    const pool = new SpeechWorkerPool(factory, 1000);
    const c = collect();
    const engine = new WhisperEngine(session('system'), c.handlers, {
      baseMs: 0,
      pool,
      preferences: PREFS,
      adapter: 'fake',
    });
    const opening = engine.open();
    await vi.advanceTimersByTimeAsync(20);
    await opening;
    for (const p of pieces(speech(3000), silence(2000))) engine.sendAudio(p);
    await vi.advanceTimersByTimeAsync(50);
    expect(c.events[0]?.speakerLabel).toBe('A');
    const asking = engine.voiceprint('A', 1000);
    const strange = engine.voiceprint('Q', 1000);
    await vi.advanceTimersByTimeAsync(20);
    const voice = await asking;
    expect(voice?.modelVersion).toBe(FAKE_VOICEPRINT_MODEL);
    expect(decodeVoiceprint(voice!.voiceprint)).not.toBeNull();
    expect(await strange).toBeNull();
  });

  it('the server picks the engine; the browser follows it', () => {
    const c = collect();
    expect(createSpeechEngine(session('mic', 'mock'), c.handlers, { baseMs: 0 })).toBeInstanceOf(
      MockSpeechEngine,
    );
    expect(createSpeechEngine(session('mic'), c.handlers, { baseMs: 0 })).toBeInstanceOf(
      WhisperEngine,
    );
  });
});

describe('the speech workers', () => {
  it('one per track for Fast and Better; one shared for Best, which is too big to load twice', () => {
    const { factory, workers } = inProcessWorkers();
    const pool = new SpeechWorkerPool(factory, 1000);
    const config = {
      choice: 'fast' as const,
      device: 'auto' as const,
      language: 'en',
      adapter: 'fake' as const,
    };
    pool.acquire(config, 'mic');
    pool.acquire(config, 'system');
    expect(workers).toHaveLength(2);
    const best = { ...config, choice: 'best' as const };
    const a = pool.acquire(best, 'shared');
    const b = pool.acquire(best, 'shared');
    expect(a).toBe(b);
    expect(workers).toHaveLength(3);
  });

  it('keeps a worker warm through a pause, and stops it when unused', async () => {
    const { factory, workers } = inProcessWorkers();
    const pool = new SpeechWorkerPool(factory, 1000);
    const config = {
      choice: 'fast' as const,
      device: 'auto' as const,
      language: 'en',
      adapter: 'fake' as const,
    };
    const host = pool.acquire(config, 'mic');
    pool.release(host);
    await vi.advanceTimersByTimeAsync(500);
    expect(pool.acquire(config, 'mic')).toBe(host); // resumed in time: same worker, model loaded
    pool.release(host);
    await vi.advanceTimersByTimeAsync(1500);
    expect(workers[0]!.terminated).toBe(true);
    expect(pool.size).toBe(0);
  });
});

describe('the demo engine', () => {
  it('gives a made-up voiceprint for a voice heard so far, and none before', async () => {
    const c = collect();
    const engine = new MockSpeechEngine(session('system', 'mock'), c.handlers, {
      baseMs: 0,
      mockSpeed: 10,
    });
    expect(await engine.voiceprint('S1', 1000)).toBeNull();
    const opening = engine.open();
    await vi.advanceTimersByTimeAsync(50);
    await opening;
    engine.sendAudio(new Int16Array(16_000 * 2)); // 20 s of the call: Dana and Priya spoke
    const voice = await engine.voiceprint('S1', 1000);
    expect(voice?.modelVersion).toBe(MOCK_VOICEPRINT_MODEL);
    expect(decodeVoiceprint(voice!.voiceprint)).not.toBeNull();
    expect(await engine.voiceprint('S3', 1000)).toBeNull();
  });

  it('keeps transcribing when the network goes: only saving waits for it', async () => {
    const c = collect();
    const engine = new MockSpeechEngine(session('mic', 'mock'), c.handlers, {
      baseMs: 0,
      mockSpeed: 10,
    });
    const opening = engine.open();
    await vi.advanceTimersByTimeAsync(50);
    await opening;
    engine.sendAudio(new Int16Array(16_000 * 5));
    expect(c.events.length).toBeGreaterThan(0);
    expect(c.closes).toEqual([]);
  });
});
