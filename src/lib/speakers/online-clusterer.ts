import { cosine, normalizeVector } from '@/lib/transcribe/voiceprint';

/**
 * Who's talking, on the device (D-076): online clustering of voice embeddings.
 * Pure and client-safe; the speech worker runs it on the meeting-audio (or
 * mixed) track, one embedding per speaker turn, and the tests drive it with
 * synthetic vectors.
 *
 * Each turn's embedding joins the nearest voice when it is close enough
 * (cosine similarity at or above the threshold), or starts a new voice
 * ('A', 'B', 'C'… in order of appearance). The threshold adapts to the
 * meeting: as voices settle, it follows how alike one voice's own turns are,
 * within fixed bounds, so a noisy line does not split one person in two and
 * two similar voices are still told apart.
 *
 * Voiceprints of consented, enrolled people come in as voices of their own,
 * labelled with their profile id, so a turn that matches one is named from
 * its first word. A short turn (a "yes", a laugh) never starts a voice: its
 * embedding is too unreliable, so it joins the nearest voice instead.
 *
 * Small voices are merged: when a voice with little speech turns out to be
 * close to another (its centroid moved as it grew), it becomes an alias of
 * that one and every later turn goes there. Lines already sent keep their
 * label; one tap on Merge joins those (the server already supports it).
 *
 * Nothing here leaves the worker except a label, or, on "Remember this
 * voice" for a consented person, that one voice's centroid.
 */

export interface ClustererOptions {
  /** Starting similarity for "same voice". WavLM x-vectors: about 0.86. */
  threshold: number;
  /** The adaptive threshold stays within these bounds. */
  minThreshold: number;
  maxThreshold: number;
  /** An enrolled voice matches only at this similarity or above (stricter: it names someone). */
  knownThreshold: number;
  /** A turn shorter than this never starts a new voice. */
  minNewVoiceMs: number;
  /** A voice with less speech than this is "small" and may be merged into a near one. */
  smallVoiceMs: number;
  /** Small voices merge at the threshold minus this. */
  smallMergeSlack: number;
  /** New voices stop here; later turns join the nearest. */
  maxVoices: number;
}

export const DEFAULT_CLUSTERER_OPTIONS: ClustererOptions = {
  threshold: 0.86,
  minThreshold: 0.8,
  maxThreshold: 0.92,
  knownThreshold: 0.88,
  minNewVoiceMs: 1200,
  smallVoiceMs: 4000,
  smallMergeSlack: 0.04,
  maxVoices: 8,
};

export interface KnownVoiceVector {
  label: string;
  vector: Float32Array;
}

interface Voice {
  label: string;
  /** Running sum of unit embeddings, weighted by speech time. */
  sum: Float32Array;
  centroid: Float32Array;
  speechMs: number;
  turns: number;
  known: boolean;
}

export interface Assignment {
  label: string;
  similarity: number;
  /** This turn started a new voice. */
  isNew: boolean;
  /** The voice is an enrolled person's. */
  known: boolean;
}

/** 'A'…'Z', then 'AA', 'AB'… */
export function voiceLabel(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

export class OnlineClusterer {
  private readonly o: ClustererOptions;
  private readonly voices: Voice[] = [];
  /** Merged-away label → the label it joined. */
  private readonly aliases = new Map<string, string>();
  private nextIndex = 0;
  private threshold_: number;
  /** Similarities of turns that joined an existing voice (for the adaptive threshold). */
  private readonly joinScores: number[] = [];

  constructor(options: Partial<ClustererOptions> = {}, known: readonly KnownVoiceVector[] = []) {
    this.o = { ...DEFAULT_CLUSTERER_OPTIONS, ...options };
    this.threshold_ = this.o.threshold;
    const seen = new Set<string>();
    for (const k of known) {
      if (seen.has(k.label) || k.vector.length === 0) continue;
      seen.add(k.label);
      const unit = normalizeVector(k.vector);
      this.voices.push({
        label: k.label,
        sum: Float32Array.from(unit),
        centroid: unit,
        speechMs: 0,
        turns: 0,
        known: true,
      });
    }
  }

  get threshold(): number {
    return this.threshold_;
  }

  /** Every label a turn has gone to, in order of appearance (enrolled voices only once heard). */
  get labels(): string[] {
    return this.voices.filter((v) => v.turns > 0 && !this.aliases.has(v.label)).map((v) => v.label);
  }

  /** Where a label's turns go now (itself, or the voice it merged into). */
  resolve(label: string): string {
    let current = label;
    for (let i = 0; i < 16; i += 1) {
      const next = this.aliases.get(current);
      if (!next) return current;
      current = next;
    }
    return current;
  }

  /** A voice's centroid (unit length), or null for a label never heard. */
  centroid(label: string): Float32Array | null {
    const voice = this.voices.find((v) => v.label === this.resolve(label));
    return voice && voice.turns > 0 ? Float32Array.from(voice.centroid) : null;
  }

  /** Speech heard from a voice, in ms. */
  speechMs(label: string): number {
    return this.voices.find((v) => v.label === this.resolve(label))?.speechMs ?? 0;
  }

  /** Place one speaker turn's embedding; `durationMs` is how much speech it covers. */
  assign(embedding: ArrayLike<number>, durationMs: number): Assignment {
    const unit = normalizeVector(embedding);
    const live = this.voices.filter((v) => !this.aliases.has(v.label));
    let best: Voice | null = null;
    let bestScore = -1;
    for (const v of live) {
      // An enrolled voice nobody has matched yet competes at its stricter bar.
      const score = cosine(unit, v.centroid);
      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    const bar = best?.known ? this.o.knownThreshold : this.threshold_;
    const heard = live.filter((v) => v.turns > 0);
    const canStart =
      durationMs >= this.o.minNewVoiceMs && heard.filter((v) => !v.known).length < this.o.maxVoices;

    let target: Voice;
    let isNew = false;
    if (best && bestScore >= bar) {
      target = best;
      if (best.turns > 0) this.recordJoin(bestScore);
    } else if (canStart || heard.length === 0) {
      target = {
        label: voiceLabel(this.nextIndex++),
        sum: new Float32Array(unit.length),
        centroid: unit,
        speechMs: 0,
        turns: 0,
        known: false,
      };
      this.voices.push(target);
      isNew = true;
    } else {
      // Too short to trust, or too many voices: the nearest voice someone has spoken in.
      let nearest = heard[0] as Voice;
      let nearestScore = -1;
      for (const v of heard) {
        const s = cosine(unit, v.centroid);
        if (s > nearestScore) {
          nearest = v;
          nearestScore = s;
        }
      }
      target = nearest;
      bestScore = nearestScore;
    }
    this.absorb(target, unit, durationMs);
    const merged = this.mergeSmall(target);
    const final = merged ?? target;
    return {
      label: final.label,
      similarity: bestScore,
      isNew: isNew && !merged,
      known: final.known,
    };
  }

  private absorb(voice: Voice, unit: Float32Array, durationMs: number): void {
    const weight = Math.max(0.25, durationMs / 1000);
    // An enrolled voice keeps its voiceprint as an anchor: what it hears moves it only a little.
    const anchor = voice.known ? 4 : 0;
    if (voice.turns === 0 && !voice.known) voice.sum.fill(0);
    if (voice.known && voice.turns === 0) {
      for (let i = 0; i < voice.sum.length; i += 1)
        voice.sum[i] = (voice.centroid[i] ?? 0) * anchor;
    }
    for (let i = 0; i < voice.sum.length; i += 1) {
      voice.sum[i] = (voice.sum[i] ?? 0) + (unit[i] ?? 0) * weight;
    }
    voice.centroid = normalizeVector(voice.sum);
    voice.speechMs += durationMs;
    voice.turns += 1;
  }

  /** A small voice close to another joins it; returns the voice it joined, if it merged. */
  private mergeSmall(changed: Voice): Voice | null {
    const live = this.voices.filter((v) => !this.aliases.has(v.label) && v.turns > 0);
    for (const small of live) {
      if (small.known || small.speechMs >= this.o.smallVoiceMs) continue;
      let into: Voice | null = null;
      let intoScore = -1;
      for (const other of live) {
        if (other === small) continue;
        const s = cosine(small.centroid, other.centroid);
        const bar = other.known
          ? this.o.knownThreshold - this.o.smallMergeSlack
          : this.threshold_ - this.o.smallMergeSlack;
        if (s >= bar && s > intoScore && (other.speechMs >= small.speechMs || other.known)) {
          into = other;
          intoScore = s;
        }
      }
      if (!into) continue;
      this.aliases.set(small.label, into.label);
      for (let i = 0; i < into.sum.length; i += 1) {
        into.sum[i] = (into.sum[i] ?? 0) + (small.sum[i] ?? 0);
      }
      into.centroid = normalizeVector(into.sum);
      into.speechMs += small.speechMs;
      into.turns += small.turns;
      if (small === changed) return into;
    }
    return null;
  }

  /** The threshold follows how alike one voice's turns are: mean minus two deviations, bounded. */
  private recordJoin(score: number): void {
    this.joinScores.push(score);
    if (this.joinScores.length > 200) this.joinScores.shift();
    if (this.joinScores.length < 8) return;
    const mean = this.joinScores.reduce((a, b) => a + b, 0) / this.joinScores.length;
    const variance =
      this.joinScores.reduce((a, b) => a + (b - mean) * (b - mean), 0) / this.joinScores.length;
    const adaptive = mean - 2 * Math.sqrt(variance);
    this.threshold_ = Math.min(this.o.maxThreshold, Math.max(this.o.minThreshold, adaptive));
  }
}
