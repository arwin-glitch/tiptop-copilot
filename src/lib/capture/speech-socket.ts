import type { SttSession, TranscriptEvent } from '@/lib/types/notes';

/**
 * One live speech-to-text connection for one track (D-076). The browser opens
 * it straight to the vendor with the 60-second key from POST /stt-token, so
 * audio never passes through Copilot's server.
 *
 * Every vendor speaks its own protocol; these sockets turn each into the same
 * shape: audio in (16 kHz PCM16 chunks), normalised TranscriptEvents out with
 * times relative to the first audio this socket was sent. The track stream
 * (track-stream.ts) adds the recording-clock offset, replays the reconnect
 * buffer and drops repeats.
 */

export interface SpeechSocketClose {
  /** True when we asked for it (finish or close); false when the connection dropped. */
  expected: boolean;
  code: number;
  reason: string;
  /** A retry with a fresh key can help (false for a refused key or a bad request). */
  retryable: boolean;
}

export interface SpeechSocketHandlers {
  onEvent: (event: TranscriptEvent) => void;
  onClose: (info: SpeechSocketClose) => void;
}

export interface SpeechSocket {
  /** Resolves once the vendor is ready for audio; rejects if it never is. */
  open(): Promise<void>;
  /** One chunk of 16 kHz mono PCM16. Ignored unless open. */
  sendAudio(samples: Int16Array): void;
  /** Tell the vendor the audio is over and wait for its last lines (or the timeout). */
  finish(timeoutMs: number): Promise<void>;
  /** Close at once; the last lines may be lost. */
  close(): void;
  readonly isOpen: boolean;
}

/** The part of the browser's WebSocket the sockets use, so tests can stand in for it. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string; wasClean?: boolean }) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const WS_OPEN = 1;

export const browserWebSocket: WebSocketFactory = (url) =>
  new WebSocket(url) as unknown as WebSocketLike;

/** How long a vendor may take to say it is ready. */
export const OPEN_TIMEOUT_MS = 10_000;

/** Labels vendors use for "not sure who": no voice of their own. */
const UNKNOWN_LABELS = new Set(['UU', 'PENDING', 'UNKNOWN', '']);

export function normaliseSpeakerLabel(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const trimmed = label.trim();
  return UNKNOWN_LABELS.has(trimmed.toUpperCase()) ? null : trimmed;
}

export function messageText(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return null;
}

export function parseJson(data: unknown): Record<string, unknown> | null {
  const text = messageText(data);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The bytes of a chunk, exactly (a typed array may view part of a larger buffer). */
export function chunkBytes(samples: Int16Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = samples;
  if (buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength) {
    return buffer;
  }
  return samples.slice().buffer as ArrayBuffer;
}

export interface SpeechSocketOptions {
  /** Where this socket's audio starts on the recording clock; only the mock needs it. */
  baseMs: number;
  webSocket?: WebSocketFactory;
  /** The mock vendor's playback speed (demo mode). */
  mockSpeed?: number;
}

export type SpeechSocketFactory = (
  session: SttSession,
  handlers: SpeechSocketHandlers,
  options: SpeechSocketOptions,
) => SpeechSocket;
