import { MAX_RECIPIENTS } from './limits';

/**
 * Per-recipient photos: which files count as one, and which recipient a
 * photo belongs to by its file name. Pure, so the composer can refuse a file
 * before uploading it and the server decides with the same rules.
 *
 * Matching is deliberately strict. A photo is given to someone only when its
 * name (without the extension, lowercased, spaces, underscores, dashes, dots
 * and other punctuation ignored) is exactly that person's email address, the
 * part of it before the @, or their full name, and nobody else on the list
 * matches it as well. Anything else (no match, or two people) is left
 * unmatched for a person to assign by hand: sending someone a photo of
 * somebody else is the one mistake this feature must not make on its own.
 */

/** File endings a photo may have. */
export const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'] as const;

export type PhotoKind = 'jpeg' | 'png' | 'gif' | 'webp' | 'heic';

/** The MIME type a photo goes out with, from what its bytes say it is. */
export const PHOTO_MIME: Record<PhotoKind, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
};

/**
 * One photo's size limit: generous for a phone picture (a few MB), small
 * enough that it leaves room for the campaign's shared attachments under the
 * per-email limit.
 */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Photos one campaign can hold: one per recipient at most. */
export const MAX_PHOTOS = MAX_RECIPIENTS;

/** For a file input: what the picker offers. */
export const PHOTO_ACCEPT = [
  ...PHOTO_EXTENSIONS.map((e) => `.${e}`),
  ...new Set(Object.values(PHOTO_MIME)),
].join(',');

/** The lowercased ending of a file name, without the dot ("" when there is none). */
export function photoExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Whether a file name ends like a photo. */
export function isPhotoName(name: string): boolean {
  return (PHOTO_EXTENSIONS as readonly string[]).includes(photoExtension(name));
}

/**
 * Whether a browser-declared type could be a photo: an image type, or none
 * at all (Windows often sends HEIC with no type). The bytes decide anyway.
 */
export function isPhotoType(type: string): boolean {
  const t = type.trim().toLowerCase();
  return !t || t === 'application/octet-stream' || t.startsWith('image/');
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

/** HEIF brands a phone's .heic photo declares (ISO/IEC 23008-12). */
const HEIC_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

/**
 * What image a file really is, from its first bytes: a renamed document or
 * program is not a photo, whatever its name says. Null when it is none of the
 * kinds a campaign takes.
 */
export function sniffPhoto(bytes: Uint8Array): PhotoKind | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return 'gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP')
    return 'webp';
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp' && HEIC_BRANDS.has(ascii(bytes, 8, 12)))
    return 'heic';
  return null;
}

/** A file name without its last extension: "Jane Doe.jpg" → "Jane Doe". */
export function fileStem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * What a name is compared as: lowercased, accents off, and everything that
 * is not a letter or a digit gone, so "Jane Doe", "jane_doe", "jane-doe" and
 * "Jane.Doe" all read "janedoe", and "jane@acme.example" reads
 * "janeacmeexample".
 */
export function matchKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Someone a photo could belong to. */
export interface PhotoCandidate {
  id: string;
  email: string;
  name: string | null;
  merge?: { name?: string } | null;
}

export type PhotoMatch =
  | { kind: 'one'; recipientId: string }
  | { kind: 'many'; recipientIds: string[] }
  | { kind: 'none' };

/**
 * A matcher over a recipient list, built once and asked per photo. Two tiers:
 * a file named for the full address is matched on that alone; otherwise the
 * part of the address before the @ and the full name are tried together. A
 * key two people share (two Jane Does, jane@ at two firms) matches both, so
 * the photo is left for a person.
 */
export function photoMatcher(
  candidates: readonly PhotoCandidate[],
): (filename: string) => PhotoMatch {
  const byEmail = new Map<string, Set<string>>();
  const byNameOrLocal = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, id: string) => {
    if (!key) return;
    const ids = map.get(key) ?? new Set<string>();
    ids.add(id);
    map.set(key, ids);
  };
  for (const c of candidates) {
    const email = c.email.trim().toLowerCase();
    add(byEmail, matchKey(email), c.id);
    add(byNameOrLocal, matchKey(email.split('@')[0] ?? ''), c.id);
    for (const name of new Set([c.name, c.merge?.name])) {
      if (name) add(byNameOrLocal, matchKey(name), c.id);
    }
  }
  return (filename) => {
    const key = matchKey(fileStem(filename));
    if (!key) return { kind: 'none' };
    for (const map of [byEmail, byNameOrLocal]) {
      const ids = map.get(key);
      if (!ids?.size) continue;
      const list = [...ids];
      return list.length === 1
        ? { kind: 'one', recipientId: list[0] as string }
        : { kind: 'many', recipientIds: list };
    }
    return { kind: 'none' };
  };
}

/** A photo as the composer lists it: who has it, and why nobody does when nobody does. */
export interface CampaignPhotoView {
  id: string;
  name: string;
  size: number;
  type: string;
  recipients: { id: string; label: string }[];
  /** Why the match by file name gave it to nobody; null when somebody has it. */
  unmatched: string | null;
}

/** What happened to a photo when its upload finished. */
export interface PhotoUploadOutcome {
  photoId: string;
  name: string;
  /** Who it was given to by its file name; null when nobody. */
  matchedTo: string | null;
}

/** One photo against a list: photoMatcher for a single file. */
export function matchPhoto(filename: string, candidates: readonly PhotoCandidate[]): PhotoMatch {
  return photoMatcher(candidates)(filename);
}
