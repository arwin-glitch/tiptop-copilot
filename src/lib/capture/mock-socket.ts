import { mockTranscriptEvents } from '@/lib/transcribe/mock-script';
import type { SttSession, TranscriptEvent, TranscriptTrack } from '@/lib/types/notes';
import type { SpeechSocket, SpeechSocketHandlers, SpeechSocketOptions } from './speech-socket';
import { SAMPLES_PER_MS } from './types';

/**
 * Demo mode's speech "vendor" (D-076): no network, no vendor, the scripted
 * fictional call from lib/transcribe/mock-script.ts.
 *
 * It behaves the way a real socket does where the recorder can tell the
 * difference. Lines are heard by audio, not by the wall clock: a line comes
 * back once the audio sent to this socket has passed its end, so pausing,
 * dropping and replaying the reconnect buffer all behave as they would with
 * Speechmatics. Times come back relative to this socket's first audio.
 * Going offline drops it like a lost connection, and it will not open while
 * offline, so the offline and online tests exercise the real reconnect path.
 *
 * `speed` plays the call faster than real time (each second of audio counts
 * as `speed` seconds of the call), so a test does not wait out the full call.
 */

const OPEN_DELAY_MS = 30;

interface Scheduled {
  event: TranscriptEvent;
  /** Recording-clock ms (call time / speed) at which the partial and final come back. */
  partialAtMs: number;
  finalAtMs: number;
  partialSent: boolean;
}

export class MockSpeechSocket implements SpeechSocket {
  private open_ = false;
  private finished = false;
  private closed = false;
  private receivedSamples = 0;
  private readonly queue: Scheduled[];
  private readonly speed: number;
  private readonly baseMs: number;
  private readonly track: TranscriptTrack;
  private offlineListener: (() => void) | null = null;
  private readonly heardLabels = new Set<string>();

  constructor(
    session: SttSession,
    private readonly handlers: SpeechSocketHandlers,
    options: SpeechSocketOptions,
  ) {
    this.track = session.track;
    this.speed = options.mockSpeed && options.mockSpeed > 0 ? options.mockSpeed : 1;
    this.baseMs = Math.max(0, options.baseMs);
    this.queue = mockTranscriptEvents([session.track])
      .map((event) => {
        const finalAtMs = event.endMs / this.speed;
        const partialAtMs = (event.startMs + event.endMs) / 2 / this.speed;
        return { event, finalAtMs, partialAtMs, partialSent: false };
      })
      // A socket only hears what comes after its own first audio.
      .filter((s) => s.finalAtMs > this.baseMs);
  }

  get isOpen(): boolean {
    return this.open_ && !this.finished && !this.closed;
  }

  open(): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return Promise.reject(new Error('Offline: the speech service cannot be reached.'));
    }
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.closed) return;
        this.open_ = true;
        if (typeof window !== 'undefined') {
          this.offlineListener = () => this.drop();
          window.addEventListener('offline', this.offlineListener);
        }
        resolve();
      }, OPEN_DELAY_MS);
    });
  }

  /** The recording-clock position this socket has heard up to. */
  private heardMs(): number {
    return this.baseMs + this.receivedSamples / SAMPLES_PER_MS;
  }

  sendAudio(samples: Int16Array): void {
    if (!this.isOpen) return;
    this.receivedSamples += samples.length;
    this.deliver();
  }

  private deliver(): void {
    const heard = this.heardMs();
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (!next) break;
      if (!next.partialSent && next.partialAtMs <= heard && next.partialAtMs > this.baseMs) {
        next.partialSent = true;
        const words = next.event.text.split(' ');
        this.handlers.onEvent(
          this.relative({
            ...next.event,
            type: 'partial',
            text: words.slice(0, Math.max(1, Math.ceil(words.length / 2))).join(' '),
          }),
        );
      }
      if (next.finalAtMs > heard) break;
      this.queue.shift();
      if (next.event.speakerLabel) this.heardLabels.add(next.event.speakerLabel);
      this.handlers.onEvent(this.relative(next.event));
    }
  }

  /** Call time to this socket's time, as a vendor reports it. */
  private relative(event: TranscriptEvent): TranscriptEvent {
    const toSocket = (callMs: number) => Math.round(callMs / this.speed - this.baseMs);
    return {
      ...event,
      track: this.track,
      startMs: toSocket(event.startMs),
      endMs: toSocket(event.endMs),
    };
  }

  /** Demo: a made-up identifier per voice heard so far (never a real voiceprint). */
  async requestSpeakers(_timeoutMs: number): Promise<Record<string, unknown> | null> {
    if (!this.isOpen) return null;
    return {
      message: 'SpeakersResult',
      speakers: [...this.heardLabels].map((label) => ({
        label,
        speaker_identifiers: [`demo-voice-${label}`],
      })),
    };
  }

  async finish(_timeoutMs: number): Promise<void> {
    if (!this.isOpen) {
      this.close();
      return;
    }
    this.finished = true;
    // Everything heard has been delivered by sendAudio; a real vendor would
    // flush its last words here.
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.close();
  }

  close(): void {
    this.end(true, 1000, 'done');
  }

  /** A lost connection, as the network going away looks to the recorder. */
  drop(): void {
    this.end(false, 1006, 'connection lost');
  }

  private end(expected: boolean, code: number, reason: string): void {
    if (this.closed) return;
    const wasOpen = this.open_;
    this.closed = true;
    this.open_ = false;
    if (this.offlineListener && typeof window !== 'undefined') {
      window.removeEventListener('offline', this.offlineListener);
    }
    this.offlineListener = null;
    if (wasOpen) this.handlers.onClose({ expected, code, reason, retryable: true });
  }
}
