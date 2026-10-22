import type { KnownVoice, TranscriptEvent, TranscriptTrack } from '@/lib/types/notes';
import { OnlineClusterer, type ClustererOptions } from '@/lib/speakers/online-clusterer';
import type { SpeechDevice, SpeechModelChoice } from '@/lib/transcribe/models';
import { prepareVocabulary, applyVocabulary } from '@/lib/transcribe/vocabulary';
import { decodeVoiceprint, encodeVoiceprint } from '@/lib/transcribe/voiceprint';
import type { FromWorker, LoadStatus, ToWorker, WorkerConfig } from './speech-protocol';
import { dropRepeatedLead, isNoiseText, isSilencePhrase, stripNoiseMarkers } from './text-dedupe';
import { VAD_RATE, VadChunker, int16ToFloat, type SpeechChunk, type VadOptions } from './vad';

/**
 * The speech worker's pipeline (D-076), framework-free so the tests run it
 * with a fake model in place of Whisper. src/workers/speech.worker.ts wires it
 * to a real Web Worker and the real models (transformers-adapter.ts).
 *
 * Per stream (one per track):
 *   audio (16 kHz PCM16) → voice-activity chunks (vad.ts) → a queue →
 *   Whisper (text with timestamps) → on the meeting-audio and mixed tracks,
 *   speaker turns (pyannote) and one voice embedding per turn's speaker
 *   (WavLM), clustered across the meeting (online-clusterer.ts) → finished
 *   lines with a speaker label, on the stream's own clock.
 *
 * Keeping up: chunks wait in a queue when Whisper is slower than speech, and
 * nothing is ever dropped. On finish, everything left is transcribed before
 * 'finished' is sent (the page shows "Finishing transcript…"). Audio lives
 * only in memory and is let go once transcribed.
 */

export interface AsrSegment {
  /** Seconds from the start of the audio given. */
  startS: number;
  endS: number;
  text: string;
}

export interface AsrResult {
  text: string;
  segments: AsrSegment[];
}

export interface SpeakerTurn {
  startS: number;
  endS: number;
  /** The segmentation model's local speaker (0, 1, 2): consistent within one call only. */
  speaker: number;
}

export interface LoadProgress {
  loadedBytes: number;
  totalBytes: number;
}

export interface LoadedAsr {
  device: SpeechDevice;
  model: SpeechModelChoice;
  /** Why it runs differently from the choice, in plain words; null when it does not. */
  message: string | null;
}

/** Thrown by a load that cannot work, with whether trying again can help. */
export class ModelLoadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ModelLoadError';
  }
}

/** The models behind the pipeline. The real one is transformers.js; tests use a fake. */
export interface ModelAdapter {
  loadAsr(config: WorkerConfig, onProgress: (p: LoadProgress) => void): Promise<LoadedAsr>;
  loadSpeakers(onProgress: (p: LoadProgress) => void): Promise<void>;
  transcribe(audio: Float32Array, language: string): Promise<AsrResult>;
  segment(audio: Float32Array): Promise<SpeakerTurn[]>;
  embed(audio: Float32Array): Promise<Float32Array>;
  /** The embedding model's version, stored with a voiceprint. */
  readonly voiceprintModel: string;
}

export interface PipelineOptions {
  vad?: Partial<VadOptions>;
  clusterer?: Partial<ClustererOptions>;
  /** Live partials while someone is mid-sentence (only when the queue is empty). */
  partials?: boolean;
  /** How often a partial may run per stream. */
  partialEveryMs?: number;
  now?: () => number;
}

interface StreamState {
  id: string;
  track: TranscriptTrack;
  diarize: boolean;
  vad: VadChunker;
  clusterer: OnlineClusterer | null;
  vocabulary: string[];
  /** Samples queued for Whisper and not done yet. */
  queuedSamples: number;
  /** Stream-clock ms transcribed (or skipped as silence) so far. */
  doneMs: number;
  lastText: string;
  lastEndMs: number;
  lastLabel: string | null;
  lastPartialAt: number;
  partialRunning: boolean;
  finishing: boolean;
  lastProgress: string;
}

type Job =
  | { kind: 'chunk'; streamId: string; chunk: SpeechChunk }
  | { kind: 'finish'; streamId: string }
  | { kind: 'test'; requestId: number; audio: Float32Array };

/** Turns shorter than this are too unreliable to embed on their own. */
const MIN_TURN_EMBED_S = 0.4;
/** At most this much of one speaker's audio goes into an embedding. */
const MAX_EMBED_S = 8;
/** A chunk with less speech than this may be an invented line when Whisper says a stock phrase. */
const LOW_SPEECH_MS = 800;
/** Lines must end after the last one by this much, or the recorder takes them for repeats. */
const MIN_ADVANCE_MS = 25;

export class SpeechPipeline {
  private config: WorkerConfig | null = null;
  private asrReady: Promise<LoadedAsr | null> | null = null;
  private speakersReady: Promise<boolean> | null = null;
  private loaded: LoadedAsr | null = null;
  private readonly streams = new Map<string, StreamState>();
  private queue: Job[] = [];
  private running = false;
  private dead = false;
  private readonly o: Required<Omit<PipelineOptions, 'vad' | 'clusterer'>> &
    Pick<PipelineOptions, 'vad' | 'clusterer'>;
  private asrProgress: LoadProgress = { loadedBytes: 0, totalBytes: 0 };
  private speakerProgress: LoadProgress = { loadedBytes: 0, totalBytes: 0 };
  private phase: LoadStatus['phase'] = 'loading';
  private failMessage: string | null = null;

  constructor(
    private readonly adapter: ModelAdapter,
    private readonly post: (message: FromWorker) => void,
    options: PipelineOptions = {},
  ) {
    this.o = {
      partials: options.partials ?? true,
      partialEveryMs: options.partialEveryMs ?? 2500,
      now: options.now ?? (() => Date.now()),
      vad: options.vad,
      clusterer: options.clusterer,
    };
  }

  /** One message from the page. */
  handle(message: ToWorker): void {
    if (this.dead && message.type !== 'close') return;
    switch (message.type) {
      case 'init':
        this.init(message.config);
        return;
      case 'start':
        this.start(message);
        return;
      case 'audio':
        this.audio(message.streamId, message.samples);
        return;
      case 'finish':
        this.finish(message.streamId);
        return;
      case 'close':
        this.close(message.streamId);
        return;
      case 'voiceprint':
        this.voiceprint(message.streamId, message.requestId, message.label);
        return;
      case 'test':
        this.queue.push({
          kind: 'test',
          requestId: message.requestId,
          audio: int16ToFloat(message.samples),
        });
        void this.pump();
        return;
    }
  }

  /* ------------------------------------------------------------ loading */

  private init(config: WorkerConfig): void {
    if (this.config) return;
    this.config = config;
    this.sendStatus();
    this.asrReady = this.adapter
      .loadAsr(config, (p) => {
        this.asrProgress = p;
        this.sendStatus();
      })
      .then((loaded) => {
        this.loaded = loaded;
        this.updatePhase();
        return loaded;
      })
      .catch((error: unknown) => {
        this.die(error);
        return null;
      });
  }

  private ensureSpeakers(): Promise<boolean> {
    if (!this.speakersReady) {
      this.speakersReady = this.adapter
        .loadSpeakers((p) => {
          this.speakerProgress = p;
          this.sendStatus();
        })
        .then(() => {
          this.speakersLoaded = true;
          this.updatePhase();
          return true;
        })
        .catch((error: unknown) => {
          this.die(error);
          return false;
        });
    }
    return this.speakersReady;
  }

  private speakersLoaded = false;

  /** Ready once Whisper is loaded, and the speaker models too when a stream tells voices apart. */
  private updatePhase(): void {
    if (this.phase === 'failed') return;
    const needSpeakers = [...this.streams.values()].some((s) => s.diarize);
    this.phase = this.loaded && (!needSpeakers || this.speakersLoaded) ? 'ready' : 'loading';
    this.sendStatus();
  }

  private sendStatus(): void {
    const loaded = this.asrProgress.loadedBytes + this.speakerProgress.loadedBytes;
    const total = this.asrProgress.totalBytes + this.speakerProgress.totalBytes;
    const status: LoadStatus = {
      phase: this.phase,
      progress: total > 0 ? Math.min(1, loaded / total) : null,
      loadedMb: loaded / 1e6,
      totalMb: total / 1e6,
      device: this.loaded?.device ?? null,
      model: this.loaded?.model ?? null,
      message: this.failMessage ?? this.loaded?.message ?? null,
    };
    this.post({ type: 'status', status });
  }

  private die(error: unknown): void {
    if (this.dead) return;
    this.dead = true;
    this.phase = 'failed';
    const retryable = error instanceof ModelLoadError ? error.retryable : true;
    this.failMessage =
      error instanceof Error && error.message
        ? error.message
        : 'Speech could not start on this computer.';
    this.queue = [];
    this.sendStatus();
    this.post({ type: 'fatal', message: this.failMessage, retryable });
  }

  /* ------------------------------------------------------------ streams */

  private start(message: Extract<ToWorker, { type: 'start' }>): void {
    if (this.streams.has(message.streamId)) return;
    const known = message.diarize ? this.knownVectors(message.knownVoices) : [];
    const state: StreamState = {
      id: message.streamId,
      track: message.track,
      diarize: message.diarize,
      vad: new VadChunker(this.o.vad),
      clusterer: message.diarize ? new OnlineClusterer(this.o.clusterer, known) : null,
      vocabulary: prepareVocabulary(message.vocabulary),
      queuedSamples: 0,
      doneMs: 0,
      lastText: '',
      lastEndMs: Number.NEGATIVE_INFINITY,
      lastLabel: null,
      lastPartialAt: 0,
      partialRunning: false,
      finishing: false,
      lastProgress: '',
    };
    this.streams.set(message.streamId, state);
    if (message.diarize) void this.ensureSpeakers();
    this.updatePhase();
    this.post({ type: 'started', streamId: message.streamId });
  }

  /** Voiceprints from the same embedding model only; anything else could never match. */
  private knownVectors(voices: readonly KnownVoice[]): { label: string; vector: Float32Array }[] {
    const out: { label: string; vector: Float32Array }[] = [];
    for (const v of voices) {
      if (v.modelVersion !== this.adapter.voiceprintModel) continue;
      const vector = decodeVoiceprint(v.voiceprint);
      if (vector) out.push({ label: v.label, vector });
    }
    return out;
  }

  private audio(streamId: string, samples: Int16Array): void {
    const s = this.streams.get(streamId);
    if (!s || s.finishing) return;
    const chunks = s.vad.push(int16ToFloat(samples));
    for (const chunk of chunks) this.enqueue(s, chunk);
    this.sendProgress(s);
    void this.pump();
  }

  private enqueue(s: StreamState, chunk: SpeechChunk): void {
    s.queuedSamples += chunk.audio.length;
    this.queue.push({ kind: 'chunk', streamId: s.id, chunk });
  }

  private finish(streamId: string): void {
    const s = this.streams.get(streamId);
    if (!s) {
      this.post({ type: 'finished', streamId });
      return;
    }
    if (!s.finishing) {
      s.finishing = true;
      for (const chunk of s.vad.flush()) this.enqueue(s, chunk);
      this.queue.push({ kind: 'finish', streamId });
    }
    this.sendProgress(s);
    void this.pump();
  }

  private close(streamId: string): void {
    this.streams.delete(streamId);
    this.queue = this.queue.filter((j) => j.kind === 'test' || j.streamId !== streamId);
  }

  private voiceprint(streamId: string, requestId: number, label: string): void {
    const s = this.streams.get(streamId);
    const centroid = s?.clusterer?.centroid(label) ?? null;
    this.post({
      type: 'voiceprint',
      requestId,
      voiceprint: centroid ? encodeVoiceprint(centroid) : null,
      modelVersion: centroid ? this.adapter.voiceprintModel : null,
    });
  }

  private sendProgress(s: StreamState, force = false): void {
    // Silence that never became a chunk is done too: there was nothing to transcribe.
    if (s.queuedSamples === 0 && !s.vad.open) {
      s.doneMs = Math.max(s.doneMs, (s.vad.receivedSamples / VAD_RATE) * 1000);
    }
    const backlogMs = Math.round(((s.queuedSamples + s.vad.pendingSamples) / VAD_RATE) * 1000);
    const doneMs = Math.round(s.doneMs);
    const key = `${Math.round(backlogMs / 250)}:${Math.round(doneMs / 250)}`;
    if (!force && key === s.lastProgress) return;
    s.lastProgress = key;
    this.post({ type: 'progress', streamId: s.id, backlogMs, doneMs });
  }

  /* ------------------------------------------------------------- the queue */

  private async pump(): Promise<void> {
    if (this.running || this.dead) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && !this.dead) {
        const loaded = await this.asrReady;
        if (!loaded || this.dead) return;
        const job = this.queue.shift();
        if (!job) break;
        try {
          if (job.kind === 'chunk') await this.processChunk(job.streamId, job.chunk);
          else if (job.kind === 'finish') this.finished(job.streamId);
          else await this.runTest(job.requestId, job.audio);
        } catch (error) {
          this.die(error);
          return;
        }
      }
    } finally {
      this.running = false;
    }
    if (!this.dead) void this.maybePartials();
  }

  private finished(streamId: string): void {
    const s = this.streams.get(streamId);
    if (s) {
      s.doneMs = Math.max(s.doneMs, (s.vad.receivedSamples / VAD_RATE) * 1000);
      this.sendProgress(s, true);
    }
    this.post({ type: 'finished', streamId });
  }

  private async runTest(requestId: number, audio: Float32Array): Promise<void> {
    const startedAt = this.o.now();
    const result = await this.adapter.transcribe(audio, this.config?.language ?? 'en');
    this.post({
      type: 'test-result',
      requestId,
      text: stripNoiseMarkers(result.text),
      audioMs: Math.round((audio.length / VAD_RATE) * 1000),
      elapsedMs: Math.max(0, this.o.now() - startedAt),
      device: this.loaded?.device ?? null,
      model: this.loaded?.model ?? null,
    });
  }

  private async processChunk(streamId: string, chunk: SpeechChunk): Promise<void> {
    const s = this.streams.get(streamId);
    if (!s) return;
    const language = this.config?.language ?? 'en';
    const result = await this.adapter.transcribe(chunk.audio, language);
    const durationS = chunk.audio.length / VAD_RATE;
    let segments = (
      result.segments.length ? result.segments : [{ startS: 0, endS: durationS, text: result.text }]
    )
      .map((seg) => ({ ...seg, text: stripNoiseMarkers(seg.text) }))
      .filter((seg) => !isNoiseText(seg.text));
    if (chunk.speechMs < LOW_SPEECH_MS)
      segments = segments.filter((seg) => !isSilencePhrase(seg.text));

    const labels = s.diarize
      ? await this.labelSegments(s, chunk, segments)
      : segments.map(() => null);
    if (!this.streams.has(streamId)) return;

    // The words an overlapping chunk repeats from the last line go once.
    const overlapS = chunk.overlapSamples / VAD_RATE;
    if (chunk.overlapSamples > 0 && s.lastText) {
      let lead = segments.findIndex((seg) => seg.startS >= overlapS);
      if (lead < 0) lead = segments.length;
      const head = segments.slice(0, Math.max(1, lead));
      const joined = head.map((seg) => seg.text).join(' ');
      const { dropped } = dropRepeatedLead(s.lastText, joined);
      let toDrop = dropped;
      for (const seg of head) {
        if (toDrop <= 0) break;
        const words = seg.text.split(/\s+/).filter(Boolean);
        const take = Math.min(words.length, toDrop);
        seg.text = words.slice(take).join(' ');
        toDrop -= take;
      }
    }

    const baseMs = (chunk.startSample / VAD_RATE) * 1000;
    segments.forEach((seg, i) => {
      const text = applyVocabulary(seg.text.trim(), s.vocabulary);
      if (!text || isNoiseText(text)) return;
      let startMs = baseMs + Math.max(0, seg.startS) * 1000;
      let endMs = baseMs + Math.min(durationS, Math.max(seg.endS, seg.startS)) * 1000;
      if (endMs <= s.lastEndMs + MIN_ADVANCE_MS) endMs = s.lastEndMs + MIN_ADVANCE_MS;
      startMs = Math.min(Math.max(startMs, Number.isFinite(s.lastEndMs) ? s.lastEndMs : 0), endMs);
      const label = labels[i] ?? null;
      const event: TranscriptEvent = {
        type: 'final',
        track: s.track,
        speakerLabel: label,
        startMs: Math.round(startMs),
        endMs: Math.round(endMs),
        text,
        confidence: null,
      };
      s.lastText = text;
      s.lastEndMs = event.endMs;
      if (label) s.lastLabel = label;
      this.post({ type: 'event', streamId, event });
    });

    s.queuedSamples = Math.max(0, s.queuedSamples - chunk.audio.length);
    s.doneMs = Math.max(s.doneMs, baseMs + durationS * 1000);
    this.sendProgress(s);
  }

  /**
   * Who said each segment: the chunk's speaker turns, one embedding per
   * local speaker, each placed among the meeting's voices.
   */
  private async labelSegments(
    s: StreamState,
    chunk: SpeechChunk,
    segments: AsrSegment[],
  ): Promise<(string | null)[]> {
    const clusterer = s.clusterer;
    if (!clusterer || segments.length === 0) return segments.map(() => s.lastLabel);
    const ok = await this.ensureSpeakers();
    if (!ok) return segments.map(() => s.lastLabel);
    const audio = chunk.audio;
    const durationS = audio.length / VAD_RATE;
    let turns = (await this.adapter.segment(audio)).filter((t) => t.endS > t.startS);
    if (turns.length === 0) turns = [{ startS: 0, endS: durationS, speaker: 0 }];

    // One embedding per local speaker, from their longest turns.
    const bySpeaker = new Map<number, SpeakerTurn[]>();
    for (const t of turns) bySpeaker.set(t.speaker, [...(bySpeaker.get(t.speaker) ?? []), t]);
    const global = new Map<number, string>();
    const speakers = [...bySpeaker.entries()].sort((a, b) => total(b[1]) - total(a[1]));
    for (const [speaker, list] of speakers) {
      const spoken = total(list);
      if (spoken < MIN_TURN_EMBED_S && global.size > 0) continue;
      const clip = gather(audio, list);
      if (clip.length < VAD_RATE * 0.25) continue;
      const embedding = await this.adapter.embed(clip);
      const placed = clusterer.assign(embedding, spoken * 1000);
      global.set(speaker, placed.label);
    }
    // A local speaker too short to embed takes the chunk's main voice.
    const main = speakers[0] ? global.get(speakers[0][0]) : undefined;
    return segments.map((seg) => {
      let best: number | null = null;
      let bestOverlap = 0;
      for (const t of turns) {
        const overlap = Math.min(seg.endS, t.endS) - Math.max(seg.startS, t.startS);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = t.speaker;
        }
      }
      const label = (best !== null ? global.get(best) : undefined) ?? main ?? s.lastLabel;
      return label ? clusterer.resolve(label) : null;
    });
  }

  /* ------------------------------------------------------------ partials */

  private async maybePartials(): Promise<void> {
    if (!this.o.partials || this.running || this.queue.length > 0 || !this.loaded) return;
    // Partials only where they are cheap: a graphics chip, or a fake model.
    if (this.loaded.device !== 'webgpu' && this.config?.adapter !== 'fake') return;
    const now = this.o.now();
    for (const s of this.streams.values()) {
      if (s.finishing || s.partialRunning || now - s.lastPartialAt < this.o.partialEveryMs)
        continue;
      const current = s.vad.current();
      if (!current || current.speechMs < 1500) continue;
      s.partialRunning = true;
      s.lastPartialAt = now;
      // The queue waits for the preview: one model call at a time.
      this.running = true;
      try {
        const result = await this.adapter.transcribe(current.audio, this.config?.language ?? 'en');
        const text = applyVocabulary(stripNoiseMarkers(result.text), s.vocabulary);
        if (!text || isNoiseText(text) || !this.streams.has(s.id)) continue;
        const baseMs = (current.startSample / VAD_RATE) * 1000;
        this.post({
          type: 'event',
          streamId: s.id,
          event: {
            type: 'partial',
            track: s.track,
            speakerLabel: s.diarize ? s.lastLabel : null,
            startMs: Math.round(baseMs),
            endMs: Math.round(baseMs + (current.audio.length / VAD_RATE) * 1000),
            text,
            confidence: null,
          },
        });
      } catch {
        // A partial is only a preview; the finished line still comes.
      } finally {
        s.partialRunning = false;
        this.running = false;
      }
      if (this.queue.length > 0) {
        void this.pump();
        return;
      }
    }
  }
}

function total(turns: readonly SpeakerTurn[]): number {
  return turns.reduce((sum, t) => sum + Math.max(0, t.endS - t.startS), 0);
}

/** One speaker's audio from their longest turns, at most MAX_EMBED_S. */
function gather(audio: Float32Array, turns: readonly SpeakerTurn[]): Float32Array {
  const sorted = [...turns].sort((a, b) => b.endS - b.startS - (a.endS - a.startS));
  const pieces: Float32Array[] = [];
  let length = 0;
  const max = MAX_EMBED_S * VAD_RATE;
  for (const t of sorted) {
    if (length >= max) break;
    const from = Math.max(0, Math.floor(t.startS * VAD_RATE));
    const to = Math.min(audio.length, Math.ceil(t.endS * VAD_RATE), from + (max - length));
    if (to <= from) continue;
    pieces.push(audio.subarray(from, to));
    length += to - from;
  }
  const out = new Float32Array(length);
  let offset = 0;
  for (const p of pieces) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
