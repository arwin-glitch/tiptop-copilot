/**
 * Generates the PWA raster icons from the same geometry as the SVG mark.
 *
 * Written by hand rather than pulled from an image library: the mark is two
 * rounded rectangles inside a rounded square, which is a few lines of raster
 * maths, and it keeps a native-binary dependency (sharp/canvas) out of the
 * install for four static files.
 *
 * Run: node scripts/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const INK = [0x14, 0x16, 0x1a, 0xff];
const PAPER = [0xfa, 0xf8, 0xf4, 0xff];

/** Signed distance to a rounded rectangle; negative inside. */
function roundedRectSdf(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - (halfW - radius);
  const qy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function blend(dst, offset, colour, alpha) {
  for (let c = 0; c < 3; c++) {
    dst[offset + c] = Math.round(dst[offset + c] * (1 - alpha) + colour[c] * alpha);
  }
  dst[offset + 3] = Math.max(dst[offset + 3], Math.round(255 * alpha));
}

function render(size, { maskable }) {
  const raster = Buffer.alloc(size * size * 4, 0);
  const s = size / 32; // the SVG is authored on a 32-unit grid

  // A maskable icon must survive a circular crop, so the artwork is inset and
  // the background fills the whole canvas.
  const pad = maskable ? size * 0.1 : 0;
  const inner = size - pad * 2;
  const innerS = inner / 32;

  const bg = {
    cx: size / 2,
    cy: size / 2,
    halfW: maskable ? size / 2 : inner / 2,
    halfH: maskable ? size / 2 : inner / 2,
    radius: maskable ? size / 2 : 8 * innerS,
  };

  const bars = [
    { x: 12, y: 8, w: 14, h: 4.5, r: 2.25 },
    { x: 6, y: 19.5, w: 14, h: 4.5, r: 2.25 },
  ].map((b) => ({
    cx: pad + (b.x + b.w / 2) * innerS,
    cy: pad + (b.y + b.h / 2) * innerS,
    halfW: (b.w / 2) * innerS,
    halfH: (b.h / 2) * innerS,
    radius: b.r * innerS,
  }));

  const aa = Math.max(1, s * 0.6); // antialias band width in pixels

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const offset = (y * size + x) * 4;

      const dBg = roundedRectSdf(px, py, bg.cx, bg.cy, bg.halfW, bg.halfH, bg.radius);
      const aBg = clamp01(0.5 - dBg / aa);
      if (aBg > 0) blend(raster, offset, INK, aBg);

      for (const bar of bars) {
        const d = roundedRectSdf(px, py, bar.cx, bar.cy, bar.halfW, bar.halfH, bar.radius);
        const a = clamp01(0.5 - d / aa) * aBg;
        if (a > 0) blend(raster, offset, PAPER, a);
      }
    }
  }

  return raster;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/* ------------------------------------------------------------ PNG writer */

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = buildCrcTable());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    crc = (crc >>> 8) ^ table[c];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

function encodePng(raster, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Filter type 0 (None) per scanline.
  const stride = size * 4;
  const rawData = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    rawData[y * (stride + 1)] = 0;
    raster.copy(rawData, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rawData, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ main */

const outDir = path.join(process.cwd(), 'public');
mkdirSync(outDir, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-icon.png', size: 180, maskable: false },
];

for (const target of targets) {
  const raster = render(target.size, { maskable: target.maskable });
  writeFileSync(path.join(outDir, target.file), encodePng(raster, target.size));
  console.log(`wrote public/${target.file} (${target.size}x${target.size})`);
}
