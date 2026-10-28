/**
 * Generates the web app's icons from the Kraken crest,
 * public/brand/kraken-logo.png (1024x1024, transparent background).
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

/** Forest from globals.css (the dark page colour). */
const FOREST = { r: 0x0e, g: 0x27, b: 0x20, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

const root = process.cwd();
const source = path.join(root, 'public', 'brand', 'kraken-logo.png');
const outDir = path.join(root, 'public');

/** The crest scaled to `size * scale`, centred on a `size` square of `background`. */
async function render(size, scale, background) {
  const inner = Math.round(size * scale);
  const crest = await sharp(source)
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
  // The maskable safe zone is a circle 80% of the width; the crest's corners
  // reach about 0.7 of its box from the centre, so 0.72 keeps them inside.
  { file: 'icon-maskable-512.png', size: 512, scale: 0.72, background: FOREST },
  { file: 'apple-icon.png', size: 180, scale: 0.86, background: FOREST },
];

for (const target of targets) {
  const png = await render(target.size, target.scale, target.background);
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
console.log('wrote public/icon.svg (96x96 crest)');
