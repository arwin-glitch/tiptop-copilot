/**
 * Generates the web app's icons from the Kraken tile (the cream octopus on
 * emerald, holding up a gold T): public/brand/kraken-logo.png (1024x1024,
 * rounded corners, transparent outside them) and kraken-logo-square.png (the
 * same art, square and full-bleed, for icons the device rounds itself).
 *
 * The desktop app's icons come from the same file: the desktop workflow runs
 * `tauri icon ../public/brand/kraken-logo.png` (.github/workflows/desktop.yml).
 *
 * - icon-192.png, icon-512.png: the crest on a transparent background
 *   (manifest purpose "any"; /icon-192.png is also what the desktop app's
 *   fallback page loads to see whether the site is up, so keep it served).
 * - icon-maskable-512.png: the crest inset inside the maskable safe zone on
 *   the forest green, so a circular or squircle crop never cuts it.
 * - apple-icon.png: iOS fills transparency with black, so the crest sits on
 *   the forest green there too.
 * - icon.svg: the favicon. An SVG that carries a small PNG of the crest, so
 *   every place that already names /icon.svg (layout, manifest, robots, the
 *   proxy's public list, the jobs board host, the service worker) keeps
 *   working unchanged.
 *
 * Run: node scripts/generate-icons.mjs
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };
/** The tile's own emerald, so a shrunk tile fills its square seamlessly. */
const TILE = { r: 0x0b, g: 0x5d, b: 0x46, alpha: 1 };

const root = process.cwd();
const source = path.join(root, 'public', 'brand', 'kraken-logo.png');
const square = path.join(root, 'public', 'brand', 'kraken-logo-square.png');
const outDir = path.join(root, 'public');

/** The crest scaled to `size * scale`, centred on a `size` square of `background`. */
async function render(size, scale, background, from = source) {
  const inner = Math.round(size * scale);
  const crest = await sharp(from)
    .resize(inner, inner, { fit: 'contain', background: CLEAR })
    .png()
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: crest, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

const targets = [
  { file: 'icon-192.png', size: 192, scale: 1, background: CLEAR },
  { file: 'icon-512.png', size: 512, scale: 1, background: CLEAR },
  // Full-bleed squares the device crops itself. Maskable crops can be a
  // circle 80% of the width, so the art is shrunk to keep the gold T inside;
  // iOS only rounds the corners, so its icon uses the art full size.
  { file: 'icon-maskable-512.png', size: 512, scale: 0.78, background: TILE, from: square },
  { file: 'apple-icon.png', size: 180, scale: 1, background: TILE, from: square },
];

for (const target of targets) {
  const png = await render(target.size, target.scale, target.background, target.from);
  writeFileSync(path.join(outDir, target.file), png);
  console.log(`wrote public/${target.file} (${target.size}x${target.size})`);
}

// The favicon: 96px is sharp at 16, 32 and 48 CSS pixels on a 2x screen and
// keeps the file small.
const favicon = (await render(96, 1, CLEAR)).toString('base64');
const svg = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96" role="img" aria-label="TipTop Kraken">',
  `  <image width="96" height="96" href="data:image/png;base64,${favicon}"/>`,
  '</svg>',
  '',
].join('\n');
writeFileSync(path.join(outDir, 'icon.svg'), svg);
console.log('wrote public/icon.svg (96x96 tile)');
