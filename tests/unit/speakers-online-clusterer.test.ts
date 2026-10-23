import { describe, expect, it } from 'vitest';
import { OnlineClusterer, voiceLabel } from '@/lib/speakers/online-clusterer';
import { cosine, normalizeVector, syntheticVoiceprint } from '@/lib/transcribe/voiceprint';

/**
 * Who's talking, on the device (D-076): voice embeddings clustered online
 * into Speaker A, B, C…, with enrolled voices named from their first turn.
 * Synthetic embeddings stand in for WavLM's: each made-up voice is a fixed
 * direction, and each turn is that direction plus some noise.
 */

/** A turn of `voice` whose embedding is about `similarity` from the voice itself. */
function turn(voice: string, n: number, similarity = 0.93): Float32Array {
  const base = syntheticVoiceprint(voice);
  const noise = syntheticVoiceprint(`${voice}-noise-${n}`);
  // Remove the noise's component along the voice, so the angle is exact.
  const dot = noise.reduce((sum, v, i) => sum + v * (base[i] ?? 0), 0);
  const orth = normalizeVector(noise.map((v, i) => v - dot * (base[i] ?? 0)));
  const sin = Math.sqrt(1 - similarity * similarity);
  return normalizeVector(base.map((v, i) => v * similarity + (orth[i] ?? 0) * sin));
}

describe('voice labels', () => {
  it('go A to Z, then AA', () => {
    expect([0, 1, 25, 26, 27].map(voiceLabel)).toEqual(['A', 'B', 'Z', 'AA', 'AB']);
  });
});

describe('online clustering', () => {
  it('tells two voices apart and keeps each one’s turns together', () => {
    const c = new OnlineClusterer();
    const labels = [];
    for (let i = 0; i < 12; i += 1) {
      const voice = i % 3 === 1 ? 'guest-two' : 'guest-one';
      labels.push([voice, c.assign(turn(voice, i), 3000).label] as const);
    }
    const byVoice = new Map<string, Set<string>>();
    for (const [voice, label] of labels) {
      byVoice.set(voice, new Set([...(byVoice.get(voice) ?? []), label]));
    }
    expect(byVoice.get('guest-one')).toEqual(new Set(['A']));
    expect(byVoice.get('guest-two')).toEqual(new Set(['B']));
    expect(c.labels).toEqual(['A', 'B']);
  });

  it('names an enrolled voice from its first turn, by profile id', () => {
    const profile = '0d000000-0000-4000-8000-000000000042';
    const c = new OnlineClusterer({}, [{ label: profile, vector: syntheticVoiceprint('dana') }]);
    const first = c.assign(turn('dana', 1), 2500);
    expect(first).toMatchObject({ label: profile, known: true, isNew: false });
    expect(c.assign(turn('someone-else', 1), 2500).label).toBe('A');
    expect(c.assign(turn('dana', 2), 2500).label).toBe(profile);
  });

  it('never starts a voice from a short turn: it joins the nearest', () => {
    const c = new OnlineClusterer();
    c.assign(turn('guest-one', 1), 3000);
    const short = c.assign(turn('guest-two', 1), 600);
    expect(short).toMatchObject({ label: 'A', isNew: false });
    // The very first turn of a meeting starts a voice, short or not.
    expect(new OnlineClusterer().assign(turn('guest-one', 1), 300).label).toBe('A');
  });

  it('merges a small voice that turns out to be someone already heard', () => {
    const c = new OnlineClusterer();
    for (let i = 0; i < 4; i += 1) c.assign(turn('guest-one', i), 3000);
    // A noisy turn just under the bar starts a voice of its own…
    const odd = c.assign(turn('guest-one', 99, 0.84), 1500);
    // …which is close enough, being small, to join the voice it belongs to.
    expect(odd.label).toBe('A');
    expect(c.resolve('B')).toBe('A');
    expect(c.labels).toEqual(['A']);
  });

  it('stops making voices at the limit; later turns join the nearest', () => {
    const c = new OnlineClusterer({ maxVoices: 3 });
    for (const v of ['v1', 'v2', 'v3', 'v4', 'v5']) c.assign(turn(v, 1), 3000);
    expect(c.labels).toHaveLength(3);
  });

  it('keeps the adaptive threshold within its bounds', () => {
    const c = new OnlineClusterer();
    for (let i = 0; i < 40; i += 1) c.assign(turn('guest-one', i, 0.97), 3000);
    expect(c.threshold).toBeGreaterThanOrEqual(0.8);
    expect(c.threshold).toBeLessThanOrEqual(0.92);
  });

  it('gives a voice’s centroid (for “Remember this voice”), and nothing for a stranger', () => {
    const c = new OnlineClusterer();
    for (let i = 0; i < 3; i += 1) c.assign(turn('guest-one', i), 3000);
    const centroid = c.centroid('A');
    expect(centroid).not.toBeNull();
    expect(cosine(centroid!, syntheticVoiceprint('guest-one'))).toBeGreaterThan(0.95);
    expect(c.centroid('Z')).toBeNull();
    expect(c.speechMs('A')).toBe(9000);
  });
});
