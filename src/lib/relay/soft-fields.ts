import { z } from 'zod';

/**
 * How the relay readers take display text and item lists from a routine's
 * post (D-073). A routine's words run long now and then: a prep note of 300
 * characters where 240 fit, one meeting with an unknown kind. Neither may
 * cost the whole post, which leaves its card on yesterday's copy.
 *
 * - Display text (titles, names, notes, prep, asks) past its limit is cut at
 *   a word with an ellipsis, never refused. It is still trimmed, still bounded
 *   and still plain text; a required field still may not be blank.
 * - An item list is read row by row: a row that fails (a wrong kind, a bad
 *   date or id) is left out, and the reader counts what it left out.
 *
 * Identifiers, keys, enums, dates, URLs and addresses stay strict: those are
 * never cut or guessed at, and a row whose one is wrong is the row dropped.
 *
 * Pure and client-safe.
 */

const ELLIPSIS = '…';
/** What a cut never ends on before its ellipsis. */
const TRAILING = /[\s,;:.–—-]+$/u;
/** Room past the cut a character may need: the longest emoji sequences run to a dozen or so units. */
const GRAPHEME_SLACK = 64;

let segmenter: Intl.Segmenter | null | undefined;

/** The characters of `text` as a reader sees them: an emoji, a flag or an accented letter is one. */
function characters(text: string): string[] {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  // Without a segmenter, code points at least never split a surrogate pair.
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
}

/** The longest start of `text` made of whole characters, at most `room` UTF-16 units long. */
function wholeCharactersWithin(text: string, room: number): string {
  let out = '';
  for (const char of characters(text.slice(0, room + GRAPHEME_SLACK))) {
    if (out.length + char.length > room) break;
    out += char;
  }
  return out;
}

/** Where the last run of whitespace in `text` starts, or -1. */
function lastSpace(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (/\s/u.test(text.charAt(i))) {
      let start = i;
      while (start > 0 && /\s/u.test(text.charAt(start - 1))) start--;
      return start;
    }
  }
  return -1;
}

/**
 * `value` trimmed, and if it is still longer than `max` UTF-16 units (what a
 * schema's `.max()` counts), cut to fit with an ellipsis: at the last word
 * break when one falls in the second half, otherwise mid-word, but never
 * inside a character (an emoji or an accented letter stays whole). The cut
 * text never ends on a space or a comma before its ellipsis. Text that fits,
 * exactly at `max` included, comes back as it is.
 */
export function clipText(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  if (max < ELLIPSIS.length) return '';
  const room = max - ELLIPSIS.length;
  const hard = wholeCharactersWithin(text, room);
  let cut = hard;
  // Cut right before a space already: that is a word break.
  if (!/\s/u.test(text.charAt(hard.length))) {
    const space = lastSpace(hard);
    if (space >= room / 2) cut = hard.slice(0, space);
  }
  const tidy = cut.replace(TRAILING, '') || hard.trimEnd() || hard;
  return `${tidy}${ELLIPSIS}`;
}

/** Required display text: trimmed, never blank, and past `max` cut at a word rather than refused. */
export const softText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? clipText(v, max) : v), z.string().min(1).max(max));

/** Optional display text: blank or missing reads as null, and past `max` it is cut as `softText` cuts. */
export const softOptionalText = (max: number) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const t = clipText(v, max);
    return t === '' ? null : t;
  }, z.string().max(max).nullish());

/**
 * A short list of display texts (names, asks, labels): one text alone reads
 * as a list of one, anything that is not text or is blank is left out, each
 * is cut to `maxChars`, and at most `maxItems` are kept. Missing is empty.
 */
export const softTextList = (maxItems: number, maxChars: number) =>
  z
    .preprocess((v) => (typeof v === 'string' ? [v] : v), z.array(z.unknown()).nullish())
    .transform((list) =>
      (list ?? [])
        .flatMap((v) => {
          if (typeof v !== 'string') return [];
          const t = clipText(v, maxChars);
          return t ? [t] : [];
        })
        .slice(0, maxItems),
    );

/**
 * A post's item list, read row by row: a row that fails `item` is left out,
 * never the whole post, and rows past the first `maxRows` are left out too.
 * The reader counts what was left out by comparing the row counts sent and
 * kept (`rowCount`).
 */
export function softRows<T extends z.ZodType>(item: T, maxRows: number) {
  return z.array(z.unknown()).transform((rows) =>
    rows.slice(0, maxRows).flatMap((row) => {
      const parsed = item.safeParse(row);
      return parsed.success ? [parsed.data as z.output<T>] : [];
    }),
  );
}

/** How many rows of the lists at `keys` are in `value`: what a post sent, or what was kept of it. */
export function rowCount(value: unknown, keys: readonly string[]): number {
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  return keys.reduce((sum, key) => {
    const list = record[key];
    return sum + (Array.isArray(list) ? list.length : 0);
  }, 0);
}
