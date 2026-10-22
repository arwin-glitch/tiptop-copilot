import 'server-only';
import sharp from 'sharp';
import { rgbaToThumbHash } from 'thumbhash';

/**
 * The image pipeline for event media (D-075). Node only (sharp).
 *
 * Every image is RE-ENCODED, never stored as uploaded where guests can see
 * it: `rotate()` applies the EXIF orientation, and sharp writes no metadata
 * unless asked, so EXIF, GPS, XMP and camera serials are gone from every
 * derivative (Partiful leaked photo GPS this way in Oct 2025). Output:
 * AVIF and WebP at 640/1080/1920 wide (never enlarged), one JPEG (PNG for
 * logos, which keep their transparency) for share cards and old clients, a
 * thumbhash placeholder and the top five colours.
 *
 * What a file IS comes from its bytes (sniff), never from its name or the
 * Content-Type the browser declared. SVG and HEIC are refused: SVG can carry
 * script, and HEIC is converted in the browser before upload.
 */

export const IMAGE_WIDTHS = [640, 1080, 1920] as const;
/** Width of the single JPEG/PNG fallback (or the image's own width when smaller). */
export const FALLBACK_WIDTH = 1080;
/** Decompression-bomb brake: 10,000 × 8,000 is the most we decode. */
export const MAX_INPUT_PIXELS = 80_000_000;

export type SniffedType =
  | 'jpeg'
  | 'png'
  | 'gif'
  | 'webp'
  | 'avif'
  | 'heic'
  | 'svg'
  | 'mp4'
  | 'quicktime'
  | 'webm'
  | 'pdf'
  | 'zip'
  | 'unknown';

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < Math.min(end, bytes.length); i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

/** What a file is, from its first bytes. */
export function sniff(bytes: Uint8Array): SniffedType {
  if (bytes.length < 4) return 'unknown';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 4) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  const head6 = ascii(bytes, 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'pdf';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return 'zip';
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    // EBML: WebM when the DocType says so (Matroska otherwise, refused).
    return ascii(bytes, 0, 64).includes('webm') ? 'webm' : 'unknown';
  }
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const major = ascii(bytes, 8, 12);
    const boxSize = Math.min(
      ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0,
      64,
    );
    const brands = [major];
    for (let i = 16; i + 4 <= boxSize; i += 4) brands.push(ascii(bytes, i, i + 4));
    if (brands.includes('avif') || brands.includes('avis')) return 'avif';
    if (brands.some((b) => HEIC_BRANDS.has(b)) || major === 'mif1' || major === 'msf1') {
      return 'heic';
    }
    if (major === 'qt  ') return 'quicktime';
    return 'mp4';
  }
  // Text that starts like markup (after a BOM / whitespace): SVG or HTML.
  const text = ascii(bytes, 0, 256)
    .replace(/^﻿|^ï»¿/, '')
    .trimStart();
  if (text.startsWith('<')) return 'svg';
  return 'unknown';
}

export const RASTER_TYPES = ['jpeg', 'png', 'gif', 'webp', 'avif'] as const;
export type RasterType = (typeof RASTER_TYPES)[number];

export function isRaster(type: SniffedType): type is RasterType {
  return (RASTER_TYPES as readonly string[]).includes(type);
}

export interface ImageVariantOut {
  w: number;
  format: 'avif' | 'webp' | 'jpg' | 'png';
  contentType: string;
  data: Uint8Array;
}

export interface ProcessedImage {
  width: number;
  height: number;
  variants: ImageVariantOut[];
  thumbhash: string;
  colors: string[];
}

export class ImageRefused extends Error {}

function pipeline(bytes: Uint8Array) {
  return sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
}

/**
 * Re-encode an uploaded image. Throws ImageRefused (safe to show) for files
 * that are not a raster image we accept, or that sharp cannot decode.
 */
export async function processImage(
  bytes: Uint8Array,
  options: { logo?: boolean } = {},
): Promise<ProcessedImage> {
  const type = sniff(bytes);
  if (type === 'svg') throw new ImageRefused('SVG files are not accepted. Upload a PNG instead.');
  if (type === 'heic') {
    throw new ImageRefused('HEIC photos are not accepted here. Save it as JPEG and try again.');
  }
  if (!isRaster(type)) throw new ImageRefused('That file is not a JPEG, PNG, WebP, GIF or AVIF.');

  let width: number;
  let height: number;
  try {
    const meta = await sharp(bytes, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: 'error',
    }).metadata();
    if (!meta.width || !meta.height) throw new Error('no dimensions');
    const swap = (meta.orientation ?? 1) >= 5;
    width = swap ? meta.height : meta.width;
    height = swap ? meta.width : meta.height;
  } catch {
    throw new ImageRefused('That image could not be read. It may be damaged or too large.');
  }

  const widths: number[] = IMAGE_WIDTHS.filter((w) => w <= width);
  if (widths.length === 0) widths.push(width);
  const variants: ImageVariantOut[] = [];
  try {
    for (const w of widths) {
      const resized = () => pipeline(bytes).resize({ width: w, withoutEnlargement: true });
      variants.push({
        w,
        format: 'avif',
        contentType: 'image/avif',
        data: new Uint8Array(await resized().avif({ quality: 55, effort: 2 }).toBuffer()),
      });
      variants.push({
        w,
        format: 'webp',
        contentType: 'image/webp',
        data: new Uint8Array(await resized().webp({ quality: 80 }).toBuffer()),
      });
    }
    const fw = Math.min(FALLBACK_WIDTH, width);
    const fallback = pipeline(bytes).resize({ width: fw, withoutEnlargement: true });
    variants.push(
      options.logo
        ? {
            w: fw,
            format: 'png',
            contentType: 'image/png',
            data: new Uint8Array(await fallback.png({ compressionLevel: 9 }).toBuffer()),
          }
        : {
            w: fw,
            format: 'jpg',
            contentType: 'image/jpeg',
            data: new Uint8Array(
              await fallback
                .flatten({ background: '#ffffff' })
                .jpeg({ quality: 82, mozjpeg: true })
                .toBuffer(),
            ),
          },
    );
  } catch {
    throw new ImageRefused('That image could not be processed. Try exporting it again.');
  }

  return {
    width,
    height,
    variants,
    thumbhash: await thumbhashOf(bytes),
    colors: await topColors(bytes),
  };
}

/** A thumbhash (base64) of the oriented image: the blurred placeholder while it loads. */
export async function thumbhashOf(bytes: Uint8Array): Promise<string> {
  const { data, info } = await pipeline(bytes)
    .resize(100, 100, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hash = rgbaToThumbHash(info.width, info.height, new Uint8Array(data));
  return Buffer.from(hash).toString('base64');
}

function hex(r: number, g: number, b: number): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

/**
 * The five most common colours (Studio's "theme from logo", the hero scrim
 * tint). A 4-bit-per-channel histogram over a small copy, each bucket
 * reported as the average of its pixels, near-duplicates skipped.
 */
export async function topColors(bytes: Uint8Array, count = 5): Promise<string[]> {
  const { data, info } = await pipeline(bytes)
    .resize(64, 64, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < data.length; i += info.channels) {
    if (data[i + 3]! < 128) continue; // transparent pixels say nothing about the colour
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n++;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  const ranked = [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .map((x) => [x.r / x.n, x.g / x.n, x.b / x.n] as const);
  const chosen: (readonly [number, number, number])[] = [];
  for (const c of ranked) {
    if (chosen.length >= count) break;
    const close = chosen.some(
      (d) => Math.abs(d[0] - c[0]) + Math.abs(d[1] - c[1]) + Math.abs(d[2] - c[2]) < 48,
    );
    if (!close) chosen.push(c);
  }
  return chosen.map((c) => hex(c[0], c[1], c[2]));
}
