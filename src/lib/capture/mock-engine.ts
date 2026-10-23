import { MOCK_VOICEPRINT_MODEL, mockTranscriptEvents } from '@/lib/transcribe/mock-script';
import { encodeVoiceprint, syntheticVoiceprint } from '@/lib/transcribe/voiceprint';
import type { SpeechSession, TranscriptEvent, TranscriptTrack } from '@/lib/types/notes';
import type { SpeechEngine, SpeechEngineHandlers, SpeechEngineOptions } from './speech-engine';
import { SAMPLES_PER_MS } from './types';

/**
 * Demo mode's speech engine (D-076): no model, no network, the scripted
 * fictional call from lib/transcribe/mock-script.ts.
 *
 * It behaves the way the on-device engine does where the recorder can tell
 * the difference. Lines are heard by audio, not by the wall clock: a line
 * comes back once the audio sent to this engine has passed its end, so
 * pausing, restarting and replaying the in-memory buffer all behave as they
 * would with Whisper. Times come back relative to this engine's first audio.
 * Like the real engine, it carries on when the network goes: only saving
 * lines waits for it.
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

export class MockSpeechEngine implements SpeechEngine {
  private open_ = false;
  private finished = false;
  private closed = false;
  private receivedSamples = 0;
  private readonly queue: Scheduled[];
  private readonly speed: number;
  private readonly baseMs: number;
  private readonly track: TranscriptTrack;
  private readonly heardLabels = new Set<string>();

  constructor(
    session: SpeechSession,
    private readonly handlers: SpeechEngineHandlers,
    options: SpeechEngineOptions,
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
      // An engine only hears what comes after its own first audio.
      .filter((s) => s.finalAtMs > this.baseMs);
  }

  get isOpen(): boolean {
    return this.open_ && !this.finished && !this.closed;
  }

  open(): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.closed) return;
        this.open_ = true;
        this.handlers.onStatus?.({
          phase: 'ready',
          progress: 1,
          loadedMb: 0,
          totalMb: 0,
          device: null,
          model: null,
          backlogMs: 0,
          message: null,
        });
        resolve();
      }, OPEN_DELAY_MS);
    });
  }

  /** The recording-clock position this engine has heard up to. */
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

  /** Call time to this engine's time, as the real engine reports it. */
  private relative(event: TranscriptEvent): TranscriptEvent {
    const toEngine = (callMs: number) => Math.round(callMs / this.speed - this.baseMs);
    return {
      ...event,
      track: this.track,
      startMs: toEngine(event.startMs),
      endMs: toEngine(event.endMs),
    };
  }

  /** Demo: a made-up voiceprint for a voice heard so far (never a real voice). */
  async voiceprint(
    label: string,
    _timeoutMs: number,
  ): Promise<{ voiceprint: string; modelVersion: string } | null> {
    if (!this.isOpen || !this.heardLabels.has(label)) return null;
    return {
      voiceprint: encodeVoiceprint(syntheticVoiceprint(`demo-voice-${label}`)),
      modelVersion: MOCK_VOICEPRINT_MODEL,
    };
  }

  async finish(_timeoutMs: number): Promise<void> {
    if (!this.isOpen) {
      this.close();
      return;
    }
    this.finished = true;
    // Everything heard has been delivered by sendAudio.
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.close();
  }

  close(): void {
    this.end(true, 1000, 'done');
  }

  /** The engine stopping by itself, as a crashed worker looks to the recorder. */
  drop(): void {
    this.end(false, 1006, 'engine stopped');
  }

  private end(expected: boolean, code: number, reason: string): void {
    if (this.closed) return;
    const wasOpen = this.open_;
    this.closed = true;
    this.open_ = false;
    if (wasOpen) this.handlers.onClose({ expected, code, reason, retryable: true });
  }
}
