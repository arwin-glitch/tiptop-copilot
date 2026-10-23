import { NOTES_LIMITS } from '@/lib/types/notes';

/**
 * Echo removal on the server (D-076). When the person recording uses
 * speakers instead of headphones, the other side's voices leak into the mic
 * and come back as mic lines. The browser's echo cancellation catches most of
 * it; this drops what is left: a mic line whose words mostly repeat a
 * meeting-audio line said at the same moment (within ±1.5 s).
 *
 * Only lines already on hand are compared, so a mic line stored before the
 * meeting-audio line that it echoes is left for the finalize pass.
 */

export interface TimedText {
  startMs: number;
  endMs: number;
  text: string;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** Share of the mic line's words that the other line also has. */
export function overlapShare(mic: string, other: string): number {
  const a = words(mic);
  if (a.length === 0) return 0;
  const b = new Set(words(other));
  return a.filter((w) => b.has(w)).length / a.length;
}

/** Whether a mic line is an echo of one of the meeting-audio lines. */
export function isEcho(
  mic: TimedText,
  meetingAudio: readonly TimedText[],
  windowMs: number = NOTES_LIMITS.echoDedupeWindowMs,
  threshold = 0.8,
): boolean {
  if (words(mic.text).length < 3) return false;
  return meetingAudio.some(
    (other) =>
      other.startMs <= mic.endMs + windowMs &&
      other.endMs >= mic.startMs - windowMs &&
      overlapShare(mic.text, other.text) >= threshold,
  );
}
