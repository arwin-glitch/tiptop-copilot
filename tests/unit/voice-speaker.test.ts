import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * stopSpeaking() must quiet Arwin at once: no cloned audio that was still
 * downloading may start afterwards, and a waiting speak() must finish.
 */

class FakeAudio {
  static made: FakeAudio[] = [];
  onended: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = true;
  currentTime = 0;
  constructor(readonly src: string) {
    FakeAudio.made.push(this);
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

let synth: {
  cancel: ReturnType<typeof vi.fn>;
  speak: ReturnType<typeof vi.fn>;
  getVoices: () => [];
};
let releaseAudio: () => void;

beforeEach(() => {
  vi.resetModules();
  FakeAudio.made = [];
  synth = { cancel: vi.fn(), speak: vi.fn(), getVoices: () => [] };
  vi.stubGlobal('window', {
    localStorage: { getItem: () => null, setItem: () => undefined },
    speechSynthesis: synth,
  });
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      constructor(readonly text: string) {}
    },
  );
  vi.stubGlobal('Audio', FakeAudio);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  let audioReady: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    audioReady = r;
  });
  releaseAudio = audioReady;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') {
        return { ok: true, json: async () => ({ available: true }) };
      }
      // The cloned audio arrives only when the test says so (ignores abort on purpose).
      await gate;
      return { ok: true, blob: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('stopSpeaking', () => {
  it('never plays a cloned answer that arrives after the stop', async () => {
    const { speak, stopSpeaking } = await import('@/lib/voice/speaker');
    const done = speak('Here is your day.');
    await tick();
    stopSpeaking();
    releaseAudio();
    await done;
    expect(FakeAudio.made).toHaveLength(0);
    // And the device voice does not take over either.
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it('stops a playing cloned answer and finishes the waiting speak()', async () => {
    const { speak, stopSpeaking } = await import('@/lib/voice/speaker');
    releaseAudio();
    const done = speak('Here is your day.');
    for (let i = 0; i < 30 && FakeAudio.made.length === 0; i += 1) await tick();
    const audio = FakeAudio.made[0];
    expect(audio?.paused).toBe(false);
    stopSpeaking();
    expect(audio?.paused).toBe(true);
    await expect(done).resolves.toBeUndefined();
    expect(synth.cancel).toHaveBeenCalled();
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it('says Arwin is audible only while his cloned voice actually plays', async () => {
    const { speak, speechAudible, stopSpeaking } = await import('@/lib/voice/speaker');
    const done = speak('Here is your day.');
    await tick();
    // Still downloading: silent.
    expect(speechAudible()).toBe(false);
    releaseAudio();
    for (let i = 0; i < 30 && FakeAudio.made.length === 0; i += 1) await tick();
    FakeAudio.made[0]?.onplaying?.();
    expect(speechAudible()).toBe(true);
    stopSpeaking();
    expect(speechAudible()).toBe(false);
    await done;
  });

  it('finishes a device-voice speak() even when the engine never says it ended', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ available: false }) })),
    );
    const { speak, stopSpeaking } = await import('@/lib/voice/speaker');
    const done = speak('Short one.');
    for (let i = 0; i < 5 && synth.speak.mock.calls.length === 0; i += 1) await tick();
    expect(synth.speak).toHaveBeenCalledTimes(1);
    stopSpeaking();
    await expect(done).resolves.toBeUndefined();
  });
});
