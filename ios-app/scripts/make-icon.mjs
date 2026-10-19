// Draws the iPhone app icon from public/icon.svg, the web app's own mark.
//
//   cd ios-app && npm run icon        (or: node ios-app/scripts/make-icon.mjs)
//
// iOS wants one 1024 x 1024 square with no transparency at all: it rounds the
// corners itself, and App Store Connect refuses an icon with an alpha channel
// (ITMS-90717). The SVG is a rounded green square, so the corners it leaves
// clear are filled with the same green and the result is flattened to plain
// RGB. Uses sharp from the repository's own node_modules (Next.js brings it),
// so run it from a checkout where `npm ci` has run at the root.
//
// It also records the SVG's SHA-256 in icon-source.json, which the iOS
// workflow compares with public/icon.svg to say when the icon is out of date.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const repoDir = join(appDir, '..');
const source = join(repoDir, 'public', 'icon.svg');
const target = join(appDir, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
const record = join(appDir, 'icon-source.json');

// The fill of the SVG's rounded square.
const GREEN = '#2b6d56';
const SIZE = 1024;

const svg = readFileSync(source);
// The SVG is 32 units wide; render it at 1024 px rather than scaling a bitmap.
const density = Math.round((72 * SIZE) / 32);

await sharp(svg, { density })
  .resize(SIZE, SIZE)
  .flatten({ background: GREEN })
  .removeAlpha()
  .png({ compressionLevel: 9 })
  .toFile(target);

const meta = await sharp(target).metadata();
if (meta.width !== SIZE || meta.height !== SIZE || meta.channels !== 3 || meta.hasAlpha) {
  console.error(`Unexpected icon: ${meta.width}x${meta.height}, ${meta.channels} channels.`);
  process.exit(1);
}

const sha256 = createHash('sha256').update(svg).digest('hex');
writeFileSync(record, JSON.stringify({ source: 'public/icon.svg', sha256 }, null, 2) + '\n');
console.log(`Wrote ${relative(repoDir, target)} (${SIZE}x${SIZE} RGB) from public/icon.svg.`);
