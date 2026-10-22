import { describe, expect, it } from 'vitest';
import { MockSpeechSocket } from '@/lib/capture/mock-socket';
import type { SpeechSocketHandlers, WebSocketLike } from '@/lib/capture/speech-socket';
import { SpeechmaticsSocket } from '@/lib/capture/speechmatics-socket';
import { speakerIdentifiersFor } from '@/lib/transcribe/socket-url';
import type { SttSession } from '@/lib/types/notes';

/**
 * "Remember this voice" on a live recording (D-076, integration): the
 * recorder asks the open speech session for its voices (Speechmatics'
 * GetSpeakers) and keeps only the one voice it was asked about. No vendor is
 * reached: a fake WebSocket answers in Speechmatics' documented shape, and
 * the demo's mock gives made-up identifiers.
 */

class FakeWebSocket implements WebSocketLike {
  binaryType = 'blob';
  readyState = 0;
  sent: (string | ArrayBufferLike | ArrayBufferView)[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  send(data: string | ArrayBufferLike | ArrayBufferView) {
    this.sent.push(data);
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  serverOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverSend(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  jsonSent(): Record<string, unknown>[] {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }
}

const handlers: SpeechSocketHandlers = { onEvent: () => {}, onClose: () => {} };

const smSession: SttSession = {
  track: 'system',
  provider: 'speechmatics',
  wsUrl: 'wss://us.rt.speechmatics.com/v2',
  token: 'temporary-key',
  expiresAt: '2026-10-22T12:00:00.000Z',
  sessionConfig: { startRecognition: { message: 'StartRecognition', audio_format: {} } },
  audio: { sampleRate: 16000, encoding: 'pcm_s16le', channels: 1 },
};

async function openSpeechmatics() {
  let ws: FakeWebSocket | null = null;
  const socket = new SpeechmaticsSocket(smSession, handlers, {
    baseMs: 0,
    webSocket: () => {
      ws = new FakeWebSocket();
      return ws;
    },
  });
  const opening = socket.open();
  ws!.serverOpen();
  ws!.serverSend({ message: 'RecognitionStarted', id: 'session-1' });
  await opening;
  return { socket, ws: ws! };
}

describe('voice memory on a live Speechmatics session', () => {
  it('asks GetSpeakers (not final) and resolves with the SpeakersResult', async () => {
    const { socket, ws } = await openSpeechmatics();
    const asked = socket.requestSpeakers(1000);
    expect(ws.jsonSent().at(-1)).toEqual({ message: 'GetSpeakers', final: false });
    ws.serverSend({
      message: 'SpeakersResult',
      speakers: [
        { label: 'S1', speaker_identifiers: ['voice-a'] },
        { label: 'S2', speaker_identifiers: ['voice-b1', 'voice-b2'] },
      ],
    });
    const result = await asked;
    // Only the voice asked about is kept; the other is dropped in memory.
    expect(speakerIdentifiersFor(result, 'S2')).toEqual(['voice-b1', 'voice-b2']);
    expect(speakerIdentifiersFor(result, 'S3')).toBeNull();
  });

  it('gives up quietly when the vendor does not answer in time', async () => {
    const { socket } = await openSpeechmatics();
    await expect(socket.requestSpeakers(20)).resolves.toBeNull();
  });

  it('asks nothing of a closed session', async () => {
    const { socket, ws } = await openSpeechmatics();
    socket.close();
    const before = ws.sent.length;
    await expect(socket.requestSpeakers(1000)).resolves.toBeNull();
    expect(ws.sent.length).toBe(before);
  });
});

describe('voice memory in demo mode', () => {
  it('gives made-up identifiers for the voices heard so far, and none before', async () => {
    const socket = new MockSpeechSocket(
      { ...smSession, provider: 'mock', wsUrl: null, sessionConfig: {} },
      handlers,
      { baseMs: 0, mockSpeed: 10 },
    );
    expect(await socket.requestSpeakers(1000)).toBeNull();
    await socket.open();
    socket.sendAudio(new Int16Array(16_000 * 2)); // 20 s of the call: Dana and Priya spoke
    const result = await socket.requestSpeakers(1000);
    expect(speakerIdentifiersFor(result, 'S1')).toEqual(['demo-voice-S1']);
    expect(speakerIdentifiersFor(result, 'S2')).toEqual(['demo-voice-S2']);
    expect(speakerIdentifiersFor(result, 'S3')).toBeNull();
  });
});
