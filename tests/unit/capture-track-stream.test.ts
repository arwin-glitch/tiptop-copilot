import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '@/lib/capture/api-client';
import type { FinishedPiece } from '@/lib/capture/lines';
import { MockSpeechSocket } from '@/lib/capture/mock-socket';
import type {
  SpeechSocket,
  SpeechSocketFactory,
  SpeechSocketHandlers,
} from '@/lib/capture/speech-socket';
import { TrackStream, type TrackStreamDeps } from '@/lib/capture/track-stream';
import { DEFAULT_TUNING, type SocketState } from '@/lib/capture/types';
import { mockTranscriptEvents } from '@/lib/transcribe/mock-script';
import type { SttSession, TranscriptEvent, TranscriptTrack } from '@/lib/types/notes';

/**
 * One track's reconnect logic (D-076, WS3): a dropped socket comes back with
 * a fresh key and replays the 30-second buffer from where the vendor last
 * finished, so the transcript has no gap and no repeat.
 */

const SPEED = 10;
const CHUNK = 1600; // 100 ms at 16 kHz

function session(track: TranscriptTrack, n: number): SttSession {
  return {
    track,
    provider: 'mock',
    wsUrl: null,
    token: `mock_${n}`,
    expiresAt: '2026-10-22T12:00:00.000Z',
    sessionConfig: { script: 'acme-intro', track },
    audio: { sampleRate: 16000, encoding: 'pcm_s16le', channels: 1 },
  };
}

function harness(
  track: TranscriptTrack = 'mic',
  over: Partial<TrackStreamDeps> = {},
  tuning: Partial<TrackStreamDeps['tuning']> = {},
) {
  const sockets: MockSpeechSocket[] = [];
  const bases: number[] = [];
  const pieces: FinishedPiece[] = [];
  const states: SocketState[] = [];
  const gaps: number[] = [];
  const fatal: string[] = [];
  let minted = 0;
  let online = true;
  const socketFactory: SpeechSocketFactory = (s, handlers, options) => {
    const socket = new MockSpeechSocket(s, handlers, options);
    sockets.push(socket);
    bases.push(options.baseMs);
    return socket;
  };
  const stream = new TrackStream({
    track,
    requestSession: async (t): Promise<ApiResult<SttSession>> => {
      minted += 1;
      if (!online) {
        return {
          ok: false,
          error: { code: 'network', message: 'offline', status: 0, retryable: true },
        };
      }
      return { ok: true, value: session(t, minted) };
    },
    socketFactory,
    tuning: { ...DEFAULT_TUNING, reconnectBackoffMs: [20], mockSpeed: SPEED, ...tuning },
    isOnline: () => online,
    onPiece: (p) => pieces.push(p),
    onPartial: () => undefined,
    onState: (s) => states.push(s),
    onGap: (ms) => gaps.push(ms),
    onFatal: (e) => fatal.push(e.code),
    ...over,
  });
  const push = async (seconds: number, loud = true) => {
    for (let i = 0; i < seconds * 10; i += 1) {
      stream.pushAudio(new Int16Array(CHUNK), loud ? 0.2 : 0);
      await vi.advanceTimersByTimeAsync(1);
    }
  };
  return {
    stream,
    sockets,
    bases,
    pieces,
    states,
    gaps,
    fatal,
    push,
    minted: () => minted,
    setOnline: (v: boolean) => {
      online = v;
    },
  };
}

/** The script's lines for a track, on the recording clock at SPEED. */
function expected(track: TranscriptTrack, uptoMs = Number.POSITIVE_INFINITY) {
  return mockTranscriptEvents([track])
    .filter((e) => e.endMs / SPEED <= uptoMs)
    .map((e) => e.text);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a track stream', () => {
  it('delivers the whole call in order, times on the recording clock', async () => {
    const h = harness('system');
    void h.stream.connect(session('system', 0));
    await vi.advanceTimersByTimeAsync(50);
    expect(h.stream.state).toBe('open');
    await h.push(14);
    expect(h.pieces.map((p) => p.text)).toEqual(expected('system'));
    const dana = mockTranscriptEvents(['system'])[0]!;
    expect(h.pieces[0]).toMatchObject({
      track: 'system',
      speakerLabel: 'S1',
      startMs: dana.startMs / SPEED,
      endMs: dana.endMs / SPEED,
    });
  });

  it('reconnects after a drop with a fresh key: no gap and no repeat', async () => {
    const h = harness('mic');
    void h.stream.connect(session('mic', 0));
    await vi.advanceTimersByTimeAsync(50);
    await h.push(3.8); // into the owner's line that ends at 4.0 s (40 s of the call)
    const before = h.pieces.length;
    expect(before).toBeGreaterThan(0);

    // The connection goes, and the network with it, for two seconds of speech.
    h.setOnline(false);
    h.sockets[0]!.drop();
    expect(h.stream.state).toBe('reconnecting');
    await h.push(2);
    expect(h.pieces.length).toBe(before); // nothing transcribed while away

    h.setOnline(true);
    h.stream.onlineAgain();
    await vi.advanceTimersByTimeAsync(60);
    expect(h.stream.state).toBe('open');
    expect(h.sockets).toHaveLength(2);
    // The new socket starts where the vendor last finished, inside the buffer.
    expect(h.bases[1]).toBeLessThan(3800);
    expect(h.bases[1]).toBeGreaterThan(0);
    await h.push(9);

    const texts = h.pieces.map((p) => p.text);
    expect(texts).toEqual(expected('mic'));
    expect(new Set(texts).size).toBe(texts.length);
    expect(h.gaps).toEqual([]);
    // Ordered on the clock.
    const ends = h.pieces.map((p) => p.endMs);
    expect([...ends].sort((a, b) => a - b)).toEqual(ends);
  });

  it('reports a gap when a drop outlasts the buffer, and only then', async () => {
    const h = harness('system', {}, { reconnectBufferMs: 1000 });
    void h.stream.connect(session('system', 0));
    await vi.advanceTimersByTimeAsync(50);
    await h.push(1);
    h.setOnline(false);
    h.sockets[0]!.drop();
    await h.push(3); // 3 s away, 1 s kept
    h.setOnline(true);
    h.stream.onlineAgain();
    await vi.advanceTimersByTimeAsync(60);
    expect(h.gaps).toHaveLength(1);
    expect(h.gaps[0]).toBeGreaterThanOrEqual(1500);
    expect(h.gaps[0]).toBeLessThanOrEqual(3100);
  });

  it('a silent stretch that leaves the buffer is not a gap', async () => {
    const h = harness('system', {}, { reconnectBufferMs: 1000 });
    void h.stream.connect(session('system', 0));
    await vi.advanceTimersByTimeAsync(50);
    h.setOnline(false);
    h.sockets[0]!.drop();
    await h.push(3, false);
    h.setOnline(true);
    h.stream.onlineAgain();
    await vi.advanceTimersByTimeAsync(60);
    expect(h.gaps).toEqual([]);
  });

  it('after a graceful finish (pause), a new socket replays nothing', async () => {
    const h = harness('mic');
    void h.stream.connect(session('mic', 0));
    await vi.advanceTimersByTimeAsync(50);
    await h.push(2);
    const finishing = h.stream.finish();
    await vi.advanceTimersByTimeAsync(20);
    await finishing;
    expect(h.stream.state).toBe('closed');
    void h.stream.connect(session('mic', 1));
    await vi.advanceTimersByTimeAsync(50);
    expect(h.bases[1]).toBe(2000); // starts at the live edge
  });

  it('retries a failed key with backoff while online', async () => {
    let calls = 0;
    const h = harness('mic', {
      requestSession: async (t) => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            error: { code: 'rate_limited', message: 'slow down', status: 429, retryable: true },
          };
        }
        return { ok: true, value: session(t, calls) };
      },
    });
    void h.stream.connect();
    await vi.advanceTimersByTimeAsync(5);
    expect(h.stream.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
    expect(h.stream.state).toBe('open');
  });

  it('gives up on a refusal a retry cannot fix', async () => {
    const h = harness('mic', {
      requestSession: async () => ({
        ok: false,
        error: {
          code: 'not_configured',
          message: 'Recording is not set up yet.',
          status: 503,
          retryable: false,
        },
      }),
    });
    void h.stream.connect();
    await vi.advanceTimersByTimeAsync(5);
    expect(h.stream.state).toBe('failed');
    expect(h.fatal).toEqual(['not_configured']);
  });

  it('drops a vendor’s repeat of a line it already delivered', async () => {
    let handlers: SpeechSocketHandlers | null = null;
    const fakeSocket: SpeechSocket = {
      isOpen: true,
      open: async () => undefined,
      sendAudio: () => undefined,
      finish: async () => undefined,
      close: () => undefined,
    };
    const pieces: FinishedPiece[] = [];
    const stream = new TrackStream({
      track: 'system',
      requestSession: async () => ({ ok: true, value: session('system', 1) }),
      socketFactory: (_s, h) => {
        handlers = h;
        return fakeSocket;
      },
      tuning: DEFAULT_TUNING,
      isOnline: () => true,
      onPiece: (p) => pieces.push(p),
      onPartial: () => undefined,
      onState: () => undefined,
      onGap: () => undefined,
      onFatal: () => undefined,
    });
    await stream.connect(session('system', 1));
    const final = (startMs: number, endMs: number, text: string): TranscriptEvent => ({
      type: 'final',
      track: 'system',
      speakerLabel: 'S1',
      startMs,
      endMs,
      text,
      confidence: 0.9,
    });
    handlers!.onEvent(final(0, 1000, 'One.'));
    handlers!.onEvent(final(1100, 2000, 'Two.'));
    handlers!.onEvent(final(1100, 2000, 'Two.')); // replayed audio heard again
    handlers!.onEvent(final(500, 1000, 'One.'));
    handlers!.onEvent(final(2100, 3000, 'Three.'));
    expect(pieces.map((p) => p.text)).toEqual(['One.', 'Two.', 'Three.']);
  });
});
