import { getSpeakersMessage, openingMessageFor, socketUrlFor } from '@/lib/transcribe/socket-url';
import type { SttSession, TranscriptEvent, TranscriptTrack } from '@/lib/types/notes';
import {
  OPEN_TIMEOUT_MS,
  WS_OPEN,
  browserWebSocket,
  chunkBytes,
  normaliseSpeakerLabel,
  parseJson,
  type SpeechSocket,
  type SpeechSocketHandlers,
  type SpeechSocketOptions,
  type WebSocketLike,
} from './speech-socket';
import { joinText } from './lines';

/**
 * Speechmatics realtime from the browser (D-076).
 *
 * Protocol (https://docs.speechmatics.com/api-ref/realtime-transcription-websocket):
 *   open wss://<region>.rt.speechmatics.com/v2?jwt=<60 s key>
 *   → StartRecognition (the session config the server chose)
 *   ← RecognitionStarted
 *   → binary audio frames (AddAudio), each acknowledged by AudioAdded {seq_no}
 *   ← AddPartialTranscript / AddTranscript {results: [{type, start_time,
 *      end_time, alternatives: [{content, confidence, speaker}], attaches_to}]}
 *   → EndOfStream {last_seq_no}
 *   ← EndOfTranscript
 *   ← Error {type, reason} / Warning / Info
 * Times are seconds from the first audio frame. One AddTranscript can hold
 * words from several voices; it becomes one event per run of one voice.
 */

interface SmResult {
  type?: string;
  start_time?: number;
  end_time?: number;
  attaches_to?: string;
  alternatives?: { content?: string; confidence?: number; speaker?: string }[];
}

/** Errors a fresh key will not fix. */
const FATAL_ERRORS = new Set([
  'not_authorised',
  'invalid_model',
  'invalid_config',
  'invalid_audio_type',
  'not_allowed',
  'protocol_error',
  'invalid_message',
]);

/** Turn one AddTranscript/AddPartialTranscript into events, one per run of one voice. */
export function speechmaticsEvents(
  message: Record<string, unknown>,
  track: TranscriptTrack,
): TranscriptEvent[] {
  const kind = message.message === 'AddTranscript' ? 'final' : 'partial';
  const results = Array.isArray(message.results) ? (message.results as SmResult[]) : [];
  const out: TranscriptEvent[] = [];
  let current: {
    speaker: string | null;
    start: number;
    end: number;
    text: string;
    conf: number;
    n: number;
  } | null = null;
  let prefix = '';
  const push = () => {
    if (current && current.text.trim()) {
      out.push({
        type: kind,
        track,
        speakerLabel: track === 'mic' ? null : current.speaker,
        startMs: Math.max(0, Math.round(current.start * 1000)),
        endMs: Math.max(0, Math.round(current.end * 1000)),
        text: current.text.trim(),
        confidence: current.n > 0 ? current.conf / current.n : null,
      });
    }
  };
  for (const r of results) {
    const alt = r.alternatives?.[0];
    const content = typeof alt?.content === 'string' ? alt.content : '';
    if (!content) continue;
    const start: number = typeof r.start_time === 'number' ? r.start_time : (current?.end ?? 0);
    const end: number = typeof r.end_time === 'number' ? r.end_time : start;
    if (r.type === 'punctuation') {
      const attaches = r.attaches_to ?? 'previous';
      if (attaches === 'next') {
        prefix += content;
        continue;
      }
      if (current) {
        current.text =
          attaches === 'none' || attaches === 'both'
            ? joinText(current.text, content)
            : current.text + content;
        current.end = Math.max(current.end, end);
      }
      continue;
    }
    const speaker = normaliseSpeakerLabel(alt?.speaker);
    if (!current || current.speaker !== speaker) {
      push();
      current = { speaker, start, end, text: '', conf: 0, n: 0 };
    }
    current.text = joinText(current.text, prefix + content);
    prefix = '';
    current.end = Math.max(current.end, end);
    if (typeof alt?.confidence === 'number') {
      current.conf += alt.confidence;
      current.n += 1;
    }
  }
  push();
  return out;
}

export class SpeechmaticsSocket implements SpeechSocket {
  private ws: WebSocketLike | null = null;
  private ready = false;
  private finishing = false;
  private closedByUs = false;
  private sentFrames = 0;
  private endOfTranscript: (() => void) | null = null;
  private speakersResult: ((message: Record<string, unknown>) => void) | null = null;
  private fatal: { type: string; reason: string } | null = null;

  constructor(
    private readonly session: SttSession,
    private readonly handlers: SpeechSocketHandlers,
    private readonly options: SpeechSocketOptions,
  ) {}

  get isOpen(): boolean {
    return this.ready && this.ws?.readyState === WS_OPEN && !this.finishing;
  }

  open(): Promise<void> {
    const url = socketUrlFor(this.session);
    const opening = openingMessageFor(this.session);
    if (!url || !opening) return Promise.reject(new Error('This speech session cannot be opened.'));
    const ws = (this.options.webSocket ?? browserWebSocket)(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.closedByUs = true;
        ws.close(1000, 'open timeout');
        reject(new Error('The speech service did not get ready in time.'));
      }, OPEN_TIMEOUT_MS);
      ws.onopen = () => ws.send(opening);
      ws.onmessage = (event) => {
        const msg = parseJson(event.data);
        if (!msg) return;
        switch (msg.message) {
          case 'RecognitionStarted':
            this.ready = true;
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
            break;
          case 'AddTranscript':
          case 'AddPartialTranscript':
            for (const e of speechmaticsEvents(msg, this.session.track)) this.handlers.onEvent(e);
            break;
          case 'EndOfTranscript':
            this.endOfTranscript?.();
            break;
          case 'SpeakersResult':
            this.speakersResult?.(msg);
            break;
          case 'Error': {
            const type = typeof msg.type === 'string' ? msg.type : 'error';
            const reason =
              typeof msg.reason === 'string' ? msg.reason : 'The speech service failed.';
            this.fatal = { type, reason };
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(new Error(reason));
            }
            break;
          }
          default:
            // AudioAdded, Info, Warning: nothing to do.
            break;
        }
      };
      ws.onerror = () => {
        // onclose follows with the code.
      };
      ws.onclose = (event) => {
        this.ready = false;
        clearTimeout(timer);
        this.endOfTranscript?.();
        if (!settled) {
          settled = true;
          reject(new Error(this.fatal?.reason ?? 'The speech service closed the connection.'));
          return;
        }
        const fatal = this.fatal && FATAL_ERRORS.has(this.fatal.type);
        this.handlers.onClose({
          expected: this.closedByUs,
          code: event.code,
          reason: this.fatal?.reason ?? event.reason ?? '',
          retryable: !fatal && event.code !== 4001 && event.code !== 1008,
        });
      };
    });
  }

  sendAudio(samples: Int16Array): void {
    if (!this.isOpen || !this.ws) return;
    this.ws.send(chunkBytes(samples));
    this.sentFrames += 1;
  }

  /** GetSpeakers on the live session: the identifiers of the voices heard so far. */
  requestSpeakers(timeoutMs: number): Promise<Record<string, unknown> | null> {
    const ws = this.ws;
    if (!this.isOpen || !ws) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.speakersResult = null;
        resolve(null);
      }, timeoutMs);
      this.speakersResult = (message) => {
        clearTimeout(timer);
        this.speakersResult = null;
        resolve(message);
      };
      ws.send(getSpeakersMessage(false));
    });
  }

  async finish(timeoutMs: number): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN || !this.ready) {
      this.close();
      return;
    }
    this.finishing = true;
    this.closedByUs = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.endOfTranscript = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: this.sentFrames }));
    });
    this.endOfTranscript = null;
    this.close();
  }

  close(): void {
    this.closedByUs = true;
    this.ready = false;
    const ws = this.ws;
    if (ws && ws.readyState <= WS_OPEN) ws.close(1000, 'done');
  }
}
