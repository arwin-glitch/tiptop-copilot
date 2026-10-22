import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssemblyAISocket, assemblyaiEvents } from '@/lib/capture/assemblyai-socket';
import { MockSpeechSocket } from '@/lib/capture/mock-socket';
import { createSpeechSocket } from '@/lib/capture/socket-factory';
import type { SpeechSocketClose, WebSocketLike } from '@/lib/capture/speech-socket';
import { SpeechmaticsSocket, speechmaticsEvents } from '@/lib/capture/speechmatics-socket';
import { mockTranscriptEvents } from '@/lib/transcribe/mock-script';
import type { SttSession, TranscriptEvent } from '@/lib/types/notes';

/**
 * The browser's speech sockets (D-076, WS3). No vendor is reached: a fake
 * WebSocket stands in, and the messages are the vendors' documented shapes.
 */

class FakeWebSocket implements WebSocketLike {
  static last: FakeWebSocket | null = null;
  binaryType = 'blob';
  readyState = 0;
  sent: (string | ArrayBufferLike | ArrayBufferView)[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.last = this;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView) {
    this.sent.push(data);
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  // Test controls.
  serverOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverSend(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  serverDrop(code = 1006, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  jsonSent(): Record<string, unknown>[] {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }

  binarySent(): number {
    return this.sent.filter((d) => typeof d !== 'string').length;
  }
}

const factory = (url: string) => new FakeWebSocket(url);

const smSession: SttSession = {
  track: 'system',
  provider: 'speechmatics',
  wsUrl: 'wss://us.rt.speechmatics.com/v2',
  token: 'temporary-key',
  expiresAt: '2026-10-22T12:00:00.000Z',
  sessionConfig: { startRecognition: { message: 'StartRecognition', audio_format: {} } },
  audio: { sampleRate: 16000, encoding: 'pcm_s16le', channels: 1 },
};

const aaiSession: SttSession = {
  track: 'system',
  provider: 'assemblyai',
  wsUrl: 'wss://streaming.assemblyai.com/v3/ws',
  token: 'temporary-token',
  expiresAt: '2026-10-22T12:00:00.000Z',
  sessionConfig: { query: { sample_rate: '16000', format_turns: 'true', speaker_labels: 'true' } },
  audio: { sampleRate: 16000, encoding: 'pcm_s16le', channels: 1 },
};

function handlers() {
  const events: TranscriptEvent[] = [];
  const closes: SpeechSocketClose[] = [];
  return {
    events,
    closes,
    h: {
      onEvent: (e: TranscriptEvent) => events.push(e),
      onClose: (c: SpeechSocketClose) => closes.push(c),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

const word = (content: string, start: number, end: number, speaker: string, type = 'word') => ({
  type,
  start_time: start,
  end_time: end,
  alternatives: [{ content, confidence: 0.9, speaker }],
});

describe('Speechmatics messages', () => {
  it('splits one AddTranscript into a line per voice, punctuation attached', () => {
    const events = speechmaticsEvents(
      {
        message: 'AddTranscript',
        results: [
          word('We', 1.0, 1.2, 'S1'),
          word('raised', 1.2, 1.6, 'S1'),
          { ...word('.', 1.6, 1.6, 'S1', 'punctuation'), attaches_to: 'previous' },
          word('Great', 2.0, 2.4, 'S2'),
          { ...word('!', 2.4, 2.4, 'S2', 'punctuation'), attaches_to: 'previous' },
        ],
      },
      'system',
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'final',
        speakerLabel: 'S1',
        startMs: 1000,
        endMs: 1600,
        text: 'We raised.',
      }),
      expect.objectContaining({
        type: 'final',
        speakerLabel: 'S2',
        startMs: 2000,
        endMs: 2400,
        text: 'Great!',
      }),
    ]);
  });

  it('reads partials, drops "unknown" labels, and never labels the mic', () => {
    const partial = speechmaticsEvents(
      { message: 'AddPartialTranscript', results: [word('Hello', 0.1, 0.4, 'UU')] },
      'system',
    );
    expect(partial[0]).toMatchObject({ type: 'partial', speakerLabel: null, text: 'Hello' });
    const mic = speechmaticsEvents(
      { message: 'AddTranscript', results: [word('Hi', 0, 0.2, 'S1')] },
      'mic',
    );
    expect(mic[0]?.speakerLabel).toBeNull();
  });

  it('opens with StartRecognition, streams audio, and ends with EndOfStream', async () => {
    const { events, closes, h } = handlers();
    const socket = new SpeechmaticsSocket(smSession, h, { baseMs: 0, webSocket: factory });
    const opening = socket.open();
    const ws = FakeWebSocket.last!;
    expect(ws.url).toBe('wss://us.rt.speechmatics.com/v2?jwt=temporary-key');
    ws.serverOpen();
    expect(ws.jsonSent()[0]).toMatchObject({ message: 'StartRecognition' });
    socket.sendAudio(new Int16Array(1600)); // not ready yet: dropped
    expect(ws.binarySent()).toBe(0);
    ws.serverSend({ message: 'RecognitionStarted', id: 'session-1' });
    await opening;
    socket.sendAudio(new Int16Array(1600));
    socket.sendAudio(new Int16Array(1600));
    expect(ws.binarySent()).toBe(2);
    ws.serverSend({ message: 'AddTranscript', results: [word('Thanks', 0.5, 0.9, 'S1')] });
    expect(events.map((e) => e.text)).toEqual(['Thanks']);

    const finishing = socket.finish(1000);
    expect(ws.jsonSent().at(-1)).toEqual({ message: 'EndOfStream', last_seq_no: 2 });
    ws.serverSend({ message: 'EndOfTranscript' });
    await finishing;
    expect(closes).toEqual([expect.objectContaining({ expected: true })]);
  });

  it('reports a dropped connection as unexpected and retryable, a refused key as fatal', async () => {
    const a = handlers();
    const s1 = new SpeechmaticsSocket(smSession, a.h, { baseMs: 0, webSocket: factory });
    const p1 = s1.open();
    FakeWebSocket.last!.serverOpen();
    FakeWebSocket.last!.serverSend({ message: 'RecognitionStarted' });
    await p1;
    FakeWebSocket.last!.serverDrop(1006);
    expect(a.closes).toEqual([expect.objectContaining({ expected: false, retryable: true })]);

    const b = handlers();
    const s2 = new SpeechmaticsSocket(smSession, b.h, { baseMs: 0, webSocket: factory });
    const p2 = s2.open();
    FakeWebSocket.last!.serverOpen();
    FakeWebSocket.last!.serverSend({ message: 'Error', type: 'not_authorised', reason: 'bad key' });
    FakeWebSocket.last!.serverDrop(4001, 'bad key');
    await expect(p2).rejects.toThrow('bad key');
  });
});

describe('AssemblyAI messages', () => {
  const turn = (over: Record<string, unknown>) => ({
    type: 'Turn',
    turn_order: 0,
    end_of_turn: false,
    turn_is_formatted: false,
    transcript: 'we raised four million',
    words: [
      { text: 'we', start: 100, end: 300, confidence: 0.9, speaker: 'A' },
      { text: 'raised', start: 300, end: 600, confidence: 0.9, speaker: 'A' },
      { text: 'four', start: 600, end: 800, confidence: 0.9, speaker: 'A' },
      { text: 'million', start: 800, end: 1200, confidence: 0.9, speaker: 'A' },
    ],
    ...over,
  });

  it('treats an unformatted end of turn as a partial when formatting is on', () => {
    expect(assemblyaiEvents(turn({ end_of_turn: true }), 'system', true)[0]?.type).toBe('partial');
    const final = assemblyaiEvents(
      turn({ end_of_turn: true, turn_is_formatted: true, transcript: 'We raised four million.' }),
      'system',
      true,
    );
    expect(final).toEqual([
      expect.objectContaining({
        type: 'final',
        speakerLabel: 'A',
        startMs: 100,
        endMs: 1200,
        text: 'We raised four million.',
      }),
    ]);
  });

  it('splits a finished turn by voice when the words disagree', () => {
    const events = assemblyaiEvents(
      turn({
        end_of_turn: true,
        turn_is_formatted: true,
        words: [
          { text: 'Yes.', start: 0, end: 300, speaker: 'A' },
          { text: 'Agreed.', start: 400, end: 800, speaker: 'B' },
        ],
      }),
      'system',
      true,
    );
    expect(events.map((e) => [e.speakerLabel, e.text])).toEqual([
      ['A', 'Yes.'],
      ['B', 'Agreed.'],
    ]);
  });

  it('opens with the token in the address, finishes turns once, and terminates', async () => {
    const { events, closes, h } = handlers();
    const socket = new AssemblyAISocket(aaiSession, h, { baseMs: 0, webSocket: factory });
    const opening = socket.open();
    const ws = FakeWebSocket.last!;
    expect(ws.url).toContain('token=temporary-token');
    expect(ws.url).toContain('sample_rate=16000');
    ws.serverOpen();
    ws.serverSend({ type: 'Begin', id: 'session-1' });
    await opening;
    socket.sendAudio(new Int16Array(1600));
    expect(ws.binarySent()).toBe(1);
    const formatted = turn({
      end_of_turn: true,
      turn_is_formatted: true,
      transcript: 'We raised four million.',
    });
    ws.serverSend(formatted);
    ws.serverSend(formatted); // a repeat of the same turn is ignored
    expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
    const finishing = socket.finish(1000);
    expect(ws.jsonSent().at(-1)).toEqual({ type: 'Terminate' });
    ws.serverSend({ type: 'Termination' });
    await finishing;
    expect(closes.at(-1)).toMatchObject({ expected: true });
  });
});

describe('the mock vendor (demo mode)', () => {
  const mockSession = (track: 'mic' | 'system' | 'mixed'): SttSession => ({
    track,
    provider: 'mock',
    wsUrl: null,
    token: 'mock_token',
    expiresAt: '2026-10-22T12:00:00.000Z',
    sessionConfig: { script: 'acme-intro', track },
    audio: { sampleRate: 16000, encoding: 'pcm_s16le', channels: 1 },
  });

  it('is what the factory gives for a mock session', () => {
    const { h } = handlers();
    expect(createSpeechSocket(mockSession('mic'), h, { baseMs: 0 })).toBeInstanceOf(
      MockSpeechSocket,
    );
    expect(createSpeechSocket(smSession, h, { baseMs: 0, webSocket: factory })).toBeInstanceOf(
      SpeechmaticsSocket,
    );
  });

  it('hears lines by audio: a line comes back once the audio passes its end', async () => {
    const { events, h } = handlers();
    const socket = new MockSpeechSocket(mockSession('system'), h, { baseMs: 0 });
    await socket.open();
    const second = new Int16Array(16_000);
    socket.sendAudio(second); // 1 s
    expect(events).toHaveLength(0);
    for (let i = 0; i < 9; i += 1) socket.sendAudio(second); // 10 s: Dana's first line ended at 9.5 s
    const finals = events.filter((e) => e.type === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      track: 'system',
      speakerLabel: 'S1',
      startMs: 4800,
      endMs: 9500,
    });
    expect(events.some((e) => e.type === 'partial')).toBe(true);
  });

  it('plays faster with speed, and starts where a reconnect resumes', async () => {
    const a = handlers();
    const fast = new MockSpeechSocket(mockSession('mic'), a.h, { baseMs: 0, mockSpeed: 10 });
    await fast.open();
    fast.sendAudio(new Int16Array(16_000 * 14)); // 14 s of audio = 140 s of call
    const ownerLines = mockTranscriptEvents(['mic']);
    expect(a.events.filter((e) => e.type === 'final')).toHaveLength(ownerLines.length);

    const b = handlers();
    // A socket opened 4 s into a 10x call starts at call time 40 s.
    const resumed = new MockSpeechSocket(mockSession('mic'), b.h, { baseMs: 4000, mockSpeed: 10 });
    await resumed.open();
    resumed.sendAudio(new Int16Array(16_000 * 10));
    const texts = b.events.filter((e) => e.type === 'final').map((e) => e.text);
    expect(texts[0]).toBe(ownerLines.find((l) => l.endMs > 40_000)?.text);
    // Times come back relative to the socket's first audio, as a vendor's do.
    const first = b.events.find((e) => e.type === 'final');
    expect(first!.endMs).toBe(
      Math.round(ownerLines.find((l) => l.endMs > 40_000)!.endMs / 10 - 4000),
    );
  });

  it('drops like a lost connection', async () => {
    const { closes, h } = handlers();
    const socket = new MockSpeechSocket(mockSession('system'), h, { baseMs: 0 });
    await socket.open();
    socket.drop();
    expect(closes).toEqual([expect.objectContaining({ expected: false, retryable: true })]);
    expect(socket.isOpen).toBe(false);
  });
});
