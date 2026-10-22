/**
 * Voiceprints (D-076): a speaker embedding, made in the recorder's browser by
 * the speech worker's speaker model, carried as base64 of little-endian
 * Float32 values. Client-safe and server-safe: the worker encodes one, the
 * server checks its shape before sealing it with VOICEPRINT_ENC_KEY, and the
 * worker decodes the consented ones its speech setup carries.
 *
 * A voiceprint is biometric data (Texas Bus. & Com. Code 503.001): only a
 * consented person's is ever encoded for upload, and only on "Remember this
 * voice" or an enrolment clip. Everyone else's stays inside the worker, in
 * memory, for the length of the recording.
 */

/** Dimensions a voiceprint may have (WavLM x-vectors are 512). */
export const MIN_VOICEPRINT_DIMS = 64;
export const MAX_VOICEPRINT_DIMS = 2048;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Scale to unit length (cosine similarity is then a dot product). A zero vector stays zero. */
export function normalizeVector(input: ArrayLike<number>): Float32Array {
  const out = new Float32Array(input.length);
  let sum = 0;
  for (let i = 0; i < input.length; i += 1) {
    const v = Number(input[i]) || 0;
    out[i] = v;
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) / norm;
  return out;
}

/** Cosine similarity of two vectors of the same length (0 when either is empty or zero). */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** A voiceprint as base64 (unit length, little-endian Float32). */
export function encodeVoiceprint(vector: ArrayLike<number>): string {
  const unit = normalizeVector(vector);
  const view = new DataView(new ArrayBuffer(unit.length * 4));
  for (let i = 0; i < unit.length; i += 1) view.setFloat32(i * 4, unit[i] ?? 0, true);
  return bytesToBase64(new Uint8Array(view.buffer));
}

/** A voiceprint back to numbers, or null when it is not one (bad base64, odd size, not finite). */
export function decodeVoiceprint(text: string): Float32Array | null {
  const bytes = base64ToBytes(text);
  if (!bytes || bytes.length % 4 !== 0) return null;
  const dims = bytes.length / 4;
  if (dims < MIN_VOICEPRINT_DIMS || dims > MAX_VOICEPRINT_DIMS) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(dims);
  let sum = 0;
  for (let i = 0; i < dims; i += 1) {
    const v = view.getFloat32(i * 4, true);
    if (!Number.isFinite(v)) return null;
    out[i] = v;
    sum += v * v;
  }
  return sum > 0 ? out : null;
}

export function isVoiceprint(text: string): boolean {
  return decodeVoiceprint(text) !== null;
}

/**
 * Demo and tests: a fictional, repeatable voiceprint for a made-up person, so
 * the consent, sealing and matching paths run with no model and no voice.
 */
export function syntheticVoiceprint(seed: string, dims = 512): Float32Array {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i += 1) {
    // xorshift32: deterministic, spread across -1..1.
    h ^= h << 13;
    h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5;
    h >>>= 0;
    out[i] = (h / 0xffffffff) * 2 - 1;
  }
  return normalizeVector(out);
}
