import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BARGE_ABS_FLOOR, BargeInDetector, frameRms, startBargeIn } from '@/lib/voice/barge-in';

/** Feed readings of `ms` each; returns the index of the reading that fired, or -1. */
function feed(d: BargeInDetector, levels: number[], ms = 30): number {
  let fired = -1;
  levels.forEach((rms, i) => {
    if (d.push(rms, ms) && fired === -1) fired = i;
  });
  return fired;
}

const repeat = (rms: number, n: number) => Array.from({ length: n }, () => rms);

describe('BargeInDetector', () => {
  it('learns the room, then fires once after talking lasts long enough', () => {
    const d = new BargeInDetector();
    // 270 ms of a quiet room (9 x 30 ms), then 450 ms of talking.
    const fired = feed(d, [...repeat(0.005, 9), ...repeat(0.1, 15)]);
    expect(d.threshold).toBe(BARGE_ABS_FLOOR);
    // 300 ms of talk = the 10th loud reading, index 9 + 9.
    expect(fired).toBe(18);
    expect(d.done).toBe(true);
    // Only once.
    expect(d.push(0.2, 30)).toBe(false);
  });

  it('ignores short spikes', () => {
    const d = new BargeInDetector();
    const spikes = [...repeat(0.005, 9)];
    for (let i = 0; i < 10; i += 1) spikes.push(0.3, 0.3, ...repeat(0.005, 5));
    expect(feed(d, spikes)).toBe(-1);
  });

  it('forgives a short dip between words but not a pause', () => {
    const withDip = new BargeInDetector();
    expect(
      feed(withDip, [...repeat(0.005, 9), ...repeat(0.1, 5), 0.001, ...repeat(0.1, 5)]),
    ).toBeGreaterThan(0);

    const withPause = new BargeInDetector();
    expect(
      feed(withPause, [
        ...repeat(0.005, 9),
        ...repeat(0.1, 5),
        ...repeat(0.001, 4),
        ...repeat(0.1, 5),
      ]),
    ).toBe(-1);
  });

  it('needs speech well above a noisy room (or Arwin’s leftover echo)', () => {
    const d = new BargeInDetector();
    feed(d, repeat(0.04, 9));
    expect(d.threshold).toBeCloseTo(0.12);
    // As loud as the room: nothing.
    expect(feed(d, repeat(0.05, 20))).toBe(-1);
    // Clearly louder: talking.
    expect(feed(d, repeat(0.2, 12))).toBeGreaterThan(0);
  });

  it('is not thrown off by one loud moment while learning', () => {
    const d = new BargeInDetector();
    feed(d, [0.005, 0.005, 0.5, 0.005, 0.005, 0.005, 0.005, 0.005, 0.005]);
    expect(d.threshold).toBe(BARGE_ABS_FLOOR);
  });

  it('nothing counts while still learning the room', () => {
    const d = new BargeInDetector();
    expect(d.threshold).toBeNull();
    expect(feed(d, repeat(0.5, 8))).toBe(-1);
  });

  it('takes tuning and shrugs off bad readings', () => {
    const d = new BargeInDetector({ calibrateMs: 0, sustainMs: 60, absFloor: 0.05, ratio: 2 });
    expect(d.push(Number.NaN, 30)).toBe(false); // learns a silent room
    expect(d.push(0.06, Number.NaN)).toBe(false);
    expect(d.push(0.06, 30)).toBe(false);
    expect(d.push(0.06, 30)).toBe(true);
  });
});

describe('frameRms', () => {
  it('measures a frame', () => {
    expect(frameRms(new Float32Array(0))).toBe(0);
    expect(frameRms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
  });
});

describe('startBargeIn', () => {
  beforeEach(() => {
    vi.stubGlobal('AudioContext', class {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does nothing (and never throws) when the microphone is refused', async () => {
    const onSpeech = vi.fn();
    const md = {
      getUserMedia: vi.fn(() =>
        Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })),
      ),
    };
    const handle = startBargeIn({ onSpeech }, md);
    await new Promise((r) => setTimeout(r, 0));
    expect(md.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({ noiseSuppression: true, autoGainControl: true }),
      }),
    );
    expect(() => handle.stop()).not.toThrow();
    expect(onSpeech).not.toHaveBeenCalled();
  });

  it('lets go of a microphone that opens after stop()', async () => {
    const track = { stop: vi.fn() };
    let open: (s: MediaStream) => void = () => undefined;
    const md = {
      getUserMedia: vi.fn(
        () =>
          new Promise<MediaStream>((r) => {
            open = r;
          }),
      ),
    };
    const handle = startBargeIn({ onSpeech: vi.fn() }, md);
    handle.stop();
    open({ getTracks: () => [track] } as unknown as MediaStream);
    await new Promise((r) => setTimeout(r, 0));
    expect(track.stop).toHaveBeenCalled();
  });

  it('does nothing without a microphone API', () => {
    expect(() => startBargeIn({ onSpeech: vi.fn() }, undefined).stop()).not.toThrow();
  });

  it('listens on a copy of a microphone already open, and stops only the copy', async () => {
    const original = { stop: vi.fn(), readyState: 'live' };
    const copy = { stop: vi.fn() };
    const stream = {
      getAudioTracks: () => [original],
      getTracks: () => [original],
      clone: () => ({ getTracks: () => [copy] }),
    } as unknown as MediaStream;
    const md = { getUserMedia: vi.fn() };
    const handle = startBargeIn({ onSpeech: vi.fn(), stream }, md);
    await new Promise((r) => setTimeout(r, 0));
    handle.stop();
    expect(md.getUserMedia).not.toHaveBeenCalled();
    expect(copy.stop).toHaveBeenCalled();
    expect(original.stop).not.toHaveBeenCalled();
  });
});

describe('startBargeIn while Arwin is still silent', () => {
  let level = 0;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'performance'] });
    level = 0;
    vi.stubGlobal(
      'AudioContext',
      class {
        state = 'running';
        close = () => Promise.resolve();
        createMediaStreamSource = () => ({ connect: () => undefined });
        createAnalyser = () => ({
          fftSize: 1024,
          getFloatTimeDomainData: (frame: Float32Array) => frame.fill(level),
        });
      },
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('learns the room only once his voice is heard, so the silent download never counts', async () => {
    const onSpeech = vi.fn();
    let audible = false;
    const md = {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream),
    };
    const handle = startBargeIn({ onSpeech, audible: () => audible }, md);
    await vi.advanceTimersByTimeAsync(0);
    // The cloned voice is still downloading: the room is quiet, then loud.
    await vi.advanceTimersByTimeAsync(400);
    level = 0.2;
    await vi.advanceTimersByTimeAsync(1000);
    expect(onSpeech).not.toHaveBeenCalled();
    // Now he is heard: his echo (this loud) is the room, so it does not cut him off.
    audible = true;
    await vi.advanceTimersByTimeAsync(1500);
    expect(onSpeech).not.toHaveBeenCalled();
    // The user talks well over the echo.
    level = 0.9;
    await vi.advanceTimersByTimeAsync(600);
    expect(onSpeech).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});
