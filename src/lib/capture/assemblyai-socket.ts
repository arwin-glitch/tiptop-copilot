import { socketUrlFor } from '@/lib/transcribe/socket-url';
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
 * AssemblyAI Universal-Streaming v3 from the browser (D-076).
 *
 * Protocol (https://www.assemblyai.com/docs/speech-to-text/universal-streaming):
 *   open wss://streaming.assemblyai.com/v3/ws?token=<temporary token>&sample_rate=16000&…
 *   ← Begin {id, expires_at}
 *   → binary audio frames, 50 to 1000 ms each
 *   ← Turn {turn_order, transcript, end_of_turn, turn_is_formatted,
 *      words: [{text, start, end, confidence, word_is_final, speaker}], speaker_label}
 *   → Terminate
 *   ← Termination
 * Times are milliseconds from the first audio frame. With format_turns on, a
 * finished turn arrives twice, unformatted then formatted; only the
 * formatted one is final. SpeakerRevision messages (labels corrected later)
 * are not applied in v1: names come from the naming ladder and a person's tap.
 */

interface AaiWord {
  text?: string;
  start?: number;
  end?: number;
  confidence?: number;
  speaker?: string;
}

/**
 * Close codes a fresh token will not fix: policy (a refused token), not
 * authorised, out of credit. Anything else is retried with backoff, which is
 * the safe side; the human smoke test with a real key confirms the codes.
 */
const FATAL_CODES = new Set([1008, 4001, 4002, 4003]);

/** Turn one Turn message into events: one per run of one voice; partials stay whole. */
export function assemblyaiEvents(
  message: Record<string, unknown>,
  track: TranscriptTrack,
  formatted: boolean,
): TranscriptEvent[] {
  if (message.type !== 'Turn') return [];
  const words = Array.isArray(message.words) ? (message.words as AaiWord[]) : [];
  const endOfTurn = message.end_of_turn === true;
  const final = endOfTurn && (!formatted || message.turn_is_formatted === true);
  const turnLabel = normaliseSpeakerLabel(message.speaker_label);
  const transcript = typeof message.transcript === 'string' ? message.transcript.trim() : '';
  const label = (w?: AaiWord) =>
    track === 'mic' ? null : (normaliseSpeakerLabel(w?.speaker) ?? turnLabel);
  if (!final) {
    const text =
      transcript ||
      words
        .map((w) => w.text ?? '')
        .join(' ')
        .trim();
    if (!text) return [];
    const first = words[0];
    const last = words[words.length - 1];
    return [
      {
        type: 'partial',
        track,
        speakerLabel: track === 'mic' ? null : (turnLabel ?? label(first)),
        startMs: Math.max(0, Math.round(first?.start ?? 0)),
        endMs: Math.max(0, Math.round(last?.end ?? first?.start ?? 0)),
        text,
        confidence: null,
      },
    ];
  }
  if (words.length === 0) {
    return transcript
      ? [
          {
            type: 'final',
            track,
            speakerLabel: track === 'mic' ? null : turnLabel,
            startMs: 0,
            endMs: 0,
            text: transcript,
            confidence: null,
          },
        ]
      : [];
  }
  // A formatted turn's words carry the punctuation and casing; group by voice.
  const out: TranscriptEvent[] = [];
  let run: { speaker: string | null; words: AaiWord[] } | null = null;
  const pushRun = () => {
    if (!run || run.words.length === 0) return;
    const text = run.words.reduce((acc, w) => joinText(acc, w.text ?? ''), '').trim();
    if (!text) return;
    const confs = run.words
      .map((w) => w.confidence)
      .filter((c): c is number => typeof c === 'number');
    out.push({
      type: 'final',
      track,
      speakerLabel: run.speaker,
      startMs: Math.max(0, Math.round(run.words[0]?.start ?? 0)),
      endMs: Math.max(0, Math.round(run.words[run.words.length - 1]?.end ?? 0)),
      text,
      confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
    });
  };
  for (const w of words) {
    const speaker = label(w);
    if (!run || run.speaker !== speaker) {
      pushRun();
      run = { speaker, words: [] };
    }
    run.words.push(w);
  }
  pushRun();
  // One voice: prefer the turn's own transcript, which is formatted as a whole.
  const only = out[0];
  if (out.length === 1 && only && transcript) only.text = transcript;
  return out;
}

export class AssemblyAISocket implements SpeechSocket {
  private ws: WebSocketLike | null = null;
  private ready = false;
  private finishing = false;
  private closedByUs = false;
  private terminated: (() => void) | null = null;
  private errorText: string | null = null;
  private readonly finishedTurns = new Set<number>();
  private readonly formatted: boolean;

  constructor(
    private readonly session: SttSession,
    private readonly handlers: SpeechSocketHandlers,
    private readonly options: SpeechSocketOptions,
  ) {
    const query = (session.sessionConfig as { query?: Record<string, string> }).query ?? {};
    this.formatted = query.format_turns === 'true';
  }

  get isOpen(): boolean {
    return this.ready && this.ws?.readyState === WS_OPEN && !this.finishing;
  }

  open(): Promise<void> {
    const url = socketUrlFor(this.session);
    if (!url) return Promise.reject(new Error('This speech session cannot be opened.'));
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
      ws.onmessage = (event) => {
        const msg = parseJson(event.data);
        if (!msg) return;
        if (msg.type === 'Begin') {
          this.ready = true;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        if (msg.type === 'Turn') {
          const order = typeof msg.turn_order === 'number' ? msg.turn_order : null;
          const events = assemblyaiEvents(msg, this.session.track, this.formatted);
          const isFinal = events.some((e) => e.type === 'final');
          if (isFinal && order !== null) {
            if (this.finishedTurns.has(order)) return;
            this.finishedTurns.add(order);
          }
          for (const e of events) this.handlers.onEvent(e);
          return;
        }
        if (msg.type === 'Termination') {
          this.terminated?.();
          return;
        }
        if (typeof msg.error === 'string') this.errorText = msg.error;
      };
      ws.onerror = () => {
        // onclose follows with the code.
      };
      ws.onclose = (event) => {
        this.ready = false;
        clearTimeout(timer);
        this.terminated?.();
        if (!settled) {
          settled = true;
          reject(new Error(this.errorText ?? (event.reason || 'The speech service refused.')));
          return;
        }
        this.handlers.onClose({
          expected: this.closedByUs,
          code: event.code,
          reason: this.errorText ?? event.reason ?? '',
          retryable: !FATAL_CODES.has(event.code),
        });
      };
    });
  }

  sendAudio(samples: Int16Array): void {
    if (!this.isOpen || !this.ws) return;
    this.ws.send(chunkBytes(samples));
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
      this.terminated = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.send(JSON.stringify({ type: 'Terminate' }));
    });
    this.terminated = null;
    this.close();
  }

  close(): void {
    this.closedByUs = true;
    this.ready = false;
    const ws = this.ws;
    if (ws && ws.readyState <= WS_OPEN) ws.close(1000, 'done');
  }
}
