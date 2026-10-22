/**
 * Metadata scrubbing for uploaded videos (D-075). Images are re-encoded by
 * sharp, which drops EXIF/GPS; videos are stored as uploaded (there is no
 * transcoder on the server), so their metadata is wiped IN PLACE before they
 * reach the public bucket: phones write the recording location and device
 * details into MP4 `udta` / `meta` boxes (©xyz, com.apple.quicktime.location
 * .ISO6709) and editors add XMP in `uuid` boxes; WebM keeps them in Tags and
 * Attachments.
 *
 * In place means sizes never change: an MP4 box keeps its length, becomes a
 * `free` box (which players skip) and has its payload zeroed, so no chunk
 * offset (stco/co64) moves. A WebM element is overwritten by a Void element
 * of the same length. A file that cannot be walked to its end is refused
 * rather than stored with metadata we could not see. Pure; no Node APIs.
 */

export type ScrubResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

/* ------------------------------------------------------------------ MP4 */

/** Boxes that carry location, device or editing metadata. */
const MP4_META = new Set(['udta', 'meta', 'uuid']);
/** Containers whose children may hold those boxes. */
const MP4_WALK = new Set(['moov', 'trak']);

function type4(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

export function scrubMp4(input: Uint8Array): ScrubResult {
  const out = new Uint8Array(input);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const walk = (start: number, end: number, depth: number): boolean => {
    let pos = start;
    while (pos < end) {
      // A few trailing bytes that cannot even hold a box header: padding.
      if (pos + 8 > end) return true;
      let size = view.getUint32(pos);
      let header = 8;
      if (size === 1) {
        if (pos + 16 > end) return false;
        size = view.getUint32(pos + 8) * 2 ** 32 + view.getUint32(pos + 12);
        header = 16;
      } else if (size === 0) {
        size = end - pos; // to the end of the enclosing box (or file)
      }
      if (size < header || pos + size > end) return false;
      const type = type4(out, pos + 4);
      if (MP4_META.has(type)) {
        out.set([0x66, 0x72, 0x65, 0x65], pos + 4); // 'free'
        out.fill(0, pos + header, pos + size);
      } else if (MP4_WALK.has(type) && depth < 3) {
        if (!walk(pos + header, pos + size, depth + 1)) return false;
      }
      pos += size;
    }
    return true;
  };
  return walk(0, out.byteLength, 0)
    ? { ok: true, bytes: out }
    : { ok: false, reason: 'That video could not be read to the end. Export it again as MP4.' };
}

/* ----------------------------------------------------------------- WebM */

const SEGMENT = 0x18538067;
const EBML_HEADER = 0x1a45dfa3;
const CLUSTER = 0x1f43b675;
/** Segment children that end an unknown-size cluster. */
const LEVEL1 = new Set([
  0x114d9b74, // SeekHead
  0x1549a966, // Info
  0x1654ae6b, // Tracks
  CLUSTER,
  0x1c53bb6b, // Cues
  0x1043a770, // Chapters
  0x1254c367, // Tags
  0x1941a469, // Attachments
]);
/** Segment children wiped: tags (titles, GPS, device) and attached files (cover art). */
const WEBM_WIPE = new Set([0x1254c367, 0x1941a469]);
const VOID = 0xec;

interface Vint {
  value: number;
  length: number;
  unknown: boolean;
}

function readId(bytes: Uint8Array, at: number): Vint | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23; // leading zero bits within the byte, plus one
  if (length < 1 || length > 4 || at + length > bytes.length) return null;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[at + i]!;
  return { value, length, unknown: false };
}

function readSize(bytes: Uint8Array, at: number): Vint | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length < 1 || length > 8 || at + length > bytes.length) return null;
  let value = first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const b = bytes[at + i]!;
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { value, length, unknown: allOnes };
}

/** Overwrite [at, at + total) with one Void element of the same length. */
function voidOut(out: Uint8Array, at: number, total: number): boolean {
  if (total < 9) return false;
  out.fill(0, at, at + total);
  out[at] = VOID;
  out[at + 1] = 0x01; // an 8-byte size
  let rest = total - 9;
  for (let i = 8; i >= 2; i--) {
    out[at + i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return true;
}

export function scrubWebm(input: Uint8Array): ScrubResult {
  const out = new Uint8Array(input);
  const fail = { ok: false as const, reason: 'That video could not be read. Export it as MP4.' };
  let pos = 0;
  while (pos < out.length) {
    const id = readId(out, pos);
    const size = id ? readSize(out, pos + id.length) : null;
    if (!id || !size) return fail;
    const head = id.length + size.length;
    if (id.value === EBML_HEADER) {
      if (size.unknown) return fail;
      pos += head + size.value;
      continue;
    }
    if (id.value !== SEGMENT) return fail;
    const segEnd = size.unknown ? out.length : Math.min(out.length, pos + head + size.value);
    let p = pos + head;
    while (p < segEnd) {
      const cid = readId(out, p);
      const csize = cid ? readSize(out, p + cid.length) : null;
      if (!cid || !csize) return fail;
      const chead = cid.length + csize.length;
      if (csize.unknown) {
        // Only a cluster may run on (live recordings): its children have
        // sizes, and the next level-1 element ends it.
        if (cid.value !== CLUSTER) return fail;
        let q = p + chead;
        while (q < segEnd) {
          const gid = readId(out, q);
          if (!gid) return fail;
          if (LEVEL1.has(gid.value)) break;
          const gsize = readSize(out, q + gid.length);
          if (!gsize || gsize.unknown) return fail;
          q += gid.length + gsize.length + gsize.value;
        }
        if (q > segEnd) return fail;
        p = q;
        continue;
      }
      const total = chead + csize.value;
      if (p + total > segEnd) return fail;
      if (WEBM_WIPE.has(cid.value) && !voidOut(out, p, total)) return fail;
      p += total;
    }
    pos = segEnd;
  }
  return { ok: true, bytes: out };
}

/** Wipe a video's metadata in place (sizes unchanged), or say why it cannot be. */
export function scrubVideoMetadata(bytes: Uint8Array, type: 'mp4' | 'webm'): ScrubResult {
  return type === 'mp4' ? scrubMp4(bytes) : scrubWebm(bytes);
}
