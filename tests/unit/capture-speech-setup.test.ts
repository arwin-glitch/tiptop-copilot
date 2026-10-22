import { afterEach, describe, expect, it } from 'vitest';
import { demoEngine } from '@/lib/capture/demo-tuning';
import {
  DEFAULT_SPEECH_PREFERENCES,
  readSpeechPreferences,
  speechPreferencesStore,
  writeSpeechPreferences,
} from '@/lib/capture/speech-preferences';
import { SpeechSetupCache } from '@/lib/capture/speech-setup';
import type { SpeechSession, TranscriptTrack } from '@/lib/types/notes';

/**
 * The recorder's speech settings (D-076): asked of the server once per
 * recording and kept, and the model choice kept in this browser.
 */

function session(track: TranscriptTrack): SpeechSession {
  return {
    track,
    provider: 'browser-whisper',
    language: 'en',
    vocabulary: [],
    knownVoices: [],
    sessionConfig: {},
    audio: { sampleRate: 16000, encoding: 'pcm_s16le', channels: 1 },
  };
}

describe('the speech settings cache', () => {
  it('asks once for both tracks, then answers restarts and resumes from memory', async () => {
    const asked: TranscriptTrack[][] = [];
    const cache = new SpeechSetupCache(async (tracks) => {
      asked.push(tracks);
      return { ok: true, value: { provider: 'browser-whisper', sessions: tracks.map(session) } };
    });
    const first = await cache.requestMany(['mic', 'system']);
    expect(first.ok && first.value.map((s) => s.track)).toEqual(['mic', 'system']);
    expect((await cache.request('system')).ok).toBe(true);
    expect((await cache.requestMany(['mic', 'system'])).ok).toBe(true);
    expect(asked).toEqual([['mic', 'system']]);
    expect(cache.provider).toBe('browser-whisper');
  });

  it('passes a refusal on, and asks again next time', async () => {
    let calls = 0;
    const cache = new SpeechSetupCache(async (tracks) => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          error: { code: 'conflict', message: 'Start first.', status: 409, retryable: false },
        };
      }
      return { ok: true, value: { provider: 'browser-whisper', sessions: tracks.map(session) } };
    });
    expect((await cache.request('mic')).ok).toBe(false);
    expect((await cache.request('mic')).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('answers nothing once cancelled (the recording stopped)', async () => {
    const cache = new SpeechSetupCache(async (tracks) => ({
      ok: true,
      value: { provider: 'browser-whisper', sessions: tracks.map(session) },
    }));
    cache.cancel();
    const result = await cache.request('mic');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('cancelled');
  });
});

describe('the model choice', () => {
  const g = globalThis as unknown as { localStorage?: Storage };
  afterEach(() => {
    delete g.localStorage;
  });

  function memoryStorage(): Storage {
    const data = new Map<string, string>();
    return {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
      clear: () => data.clear(),
      key: () => null,
      get length() {
        return data.size;
      },
    };
  }

  it('is Fast on whatever the browser has, until someone picks', () => {
    g.localStorage = memoryStorage();
    expect(readSpeechPreferences()).toEqual(DEFAULT_SPEECH_PREFERENCES);
    expect(speechPreferencesStore.getServerSnapshot()).toEqual({ model: 'fast', device: 'auto' });
  });

  it('is kept in this browser, and ignores anything it does not know', () => {
    g.localStorage = memoryStorage();
    writeSpeechPreferences({ model: 'better', device: 'wasm' });
    expect(readSpeechPreferences()).toEqual({ model: 'better', device: 'wasm' });
    // The store hands back the same object until it changes.
    expect(speechPreferencesStore.getSnapshot()).toBe(speechPreferencesStore.getSnapshot());
    g.localStorage.setItem('copilot.notes.speech.v1', '{"model":"huge","device":"tpu"}');
    expect(readSpeechPreferences()).toEqual(DEFAULT_SPEECH_PREFERENCES);
  });

  it('lasts for the page when the browser blocks storage', () => {
    g.localStorage = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    writeSpeechPreferences({ model: 'best', device: 'webgpu' });
    expect(readSpeechPreferences()).toEqual({ model: 'best', device: 'webgpu' });
  });
});

describe('the demo page’s engine switch', () => {
  it('tries the on-device engine only when asked', () => {
    expect(demoEngine({})).toBeUndefined();
    expect(demoEngine({ engine: 'fake' })).toEqual({ adapter: 'fake' });
    expect(demoEngine({ engine: 'on-device', model: 'better', device: 'wasm' })).toEqual({
      adapter: 'transformers',
      preferences: { model: 'better', device: 'wasm' },
    });
    expect(demoEngine({ engine: 'on-device', model: 'nope' })).toEqual({
      adapter: 'transformers',
      preferences: { model: 'fast', device: 'auto' },
    });
  });
});
