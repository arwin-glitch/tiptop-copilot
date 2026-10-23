import type { TranscriptTrack } from '@/lib/types/notes';

/**
 * Voice cluster keys: how a transcript line points at a voice (D-076).
 *
 *   'mic'          the microphone: the person at this computer
 *   'sys:A'        a voice in the meeting audio, by the on-device clustering's label
 *   'sys:<uuid>'   a voice the speech worker matched to an enrolled voice profile
 *   'mix:B'        a voice in a single mixed track (in person, phone)
 *   '<key>#2'      a voice split off another ("from here it's someone else")
 *
 * Lines are stored by key, never by name, so renaming a voice is one update
 * to meeting_speakers. Client-safe: the recorder builds keys with this too.
 * The pattern is the same one the migration checks.
 */

export const CLUSTER_KEY_RE = /^(mic|(sys|mix):[A-Za-z0-9_-]{1,64})(#[0-9]{1,3})?$/;

const LABEL_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The cluster key for an engine line. A label the pattern cannot hold falls back to 'unknown'. */
export function clusterKeyFor(track: TranscriptTrack, speakerLabel: string | null): string {
  if (track === 'mic') return 'mic';
  const prefix = track === 'system' ? 'sys' : 'mix';
  const label = speakerLabel && LABEL_RE.test(speakerLabel) ? speakerLabel : 'unknown';
  return `${prefix}:${label}`;
}

export function isClusterKey(value: string): boolean {
  return CLUSTER_KEY_RE.test(value);
}

/** Which track a cluster key belongs to. */
export function trackOfClusterKey(key: string): TranscriptTrack {
  if (key === 'mic' || key.startsWith('mic#')) return 'mic';
  return key.startsWith('sys:') ? 'system' : 'mixed';
}

/** The key without its split suffix: 'sys:S1#2' is a split of 'sys:S1'. */
export function baseClusterKey(key: string): string {
  const hash = key.indexOf('#');
  return hash < 0 ? key : key.slice(0, hash);
}

/** The next free split key for `key`, given the keys already in the meeting. */
export function nextSplitKey(key: string, existing: Iterable<string>): string {
  const base = baseClusterKey(key);
  const taken = new Set(existing);
  for (let n = 2; n <= 999; n += 1) {
    const candidate = `${base}#${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`No split key left for ${base}`);
}
