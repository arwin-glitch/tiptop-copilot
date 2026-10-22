/**
 * Dropping the words two overlapping chunks share (D-076). Pure.
 *
 * When the voice-activity chunker has to cut mid-sentence (vad.ts), the next
 * chunk starts a second early, so a word cut in half is heard whole. Whisper
 * then hears the overlap twice: "...the robot arm ships in" and "ships in
 * March with...". This finds the longest run of words that ends the previous
 * line and starts the next one, and drops it from the next.
 */

/** A word as compared: lower case, letters and digits only. */
function norm(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export interface DedupeResult {
  text: string;
  /** Words dropped from the start of the next text. */
  dropped: number;
}

/**
 * The next text without the words that repeat the end of the previous one.
 * Only a run of at least `minWords` words counts (one short word repeating is
 * usually just speech: "and… and"), unless it is a long word.
 */
export function dropRepeatedLead(
  previous: string,
  next: string,
  maxWords = 10,
  minWords = 2,
): DedupeResult {
  const prevWords = previous.trim().split(/\s+/).filter(Boolean);
  const nextWords = next.trim().split(/\s+/).filter(Boolean);
  if (prevWords.length === 0 || nextWords.length === 0) return { text: next.trim(), dropped: 0 };
  const tail = prevWords.slice(-maxWords).map(norm);
  const head = nextWords.slice(0, maxWords).map(norm);
  for (let n = Math.min(tail.length, head.length); n >= 1; n -= 1) {
    const a = tail.slice(tail.length - n);
    const b = head.slice(0, n);
    if (a.some((w) => !w)) continue;
    if (a.every((w, i) => w === b[i])) {
      const longWord = n === 1 && (a[0]?.length ?? 0) >= 6;
      if (n < minWords && !longWord) break;
      return { text: nextWords.slice(n).join(' '), dropped: n };
    }
  }
  return { text: nextWords.join(' '), dropped: 0 };
}

/** Whisper's stock phrases for silence and noise, which are never speech worth keeping. */
const HALLUCINATIONS = new Set([
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'you',
  'bye',
  'please subscribe',
  'subtitles by the amaraorg community',
]);

/** The text without noise markers ("[Music]", "(laughs)", "♪"). */
export function stripNoiseMarkers(text: string): string {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)|♪/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True for text with no words once the noise markers are gone. */
export function isNoiseText(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(stripNoiseMarkers(text));
}

/**
 * True for one of Whisper's stock phrases. Only a sign of an invented line
 * when the audio held almost no speech (the caller checks); "Thank you." is
 * also something people say.
 */
export function isSilencePhrase(text: string): boolean {
  const key = stripNoiseMarkers(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
  return HALLUCINATIONS.has(key);
}
