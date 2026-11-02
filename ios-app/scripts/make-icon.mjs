// Draws the iPhone app icon from public/brand/kraken-logo-square.png, the
// TipTop Kraken tile (the cream octopus on emerald) the web and desktop apps
// use.
//
//   cd ios-app && npm run icon        (or: node ios-app/scripts/make-icon.mjs)
//
// iOS wants one 1024 x 1024 square with no transparency at all: it rounds the
// corners itself, and App Store Connect refuses an icon with an alpha channel
// (ITMS-90717). The tile is already a full-bleed emerald square; anything
// clear is filled with the same emerald and the result is flattened to plain
// RGB. Uses sharp from the repository's own node_modules (Next.js brings it),
// so run it from a checkout where `npm ci` has run at the root.
//
// It also records the tile's SHA-256 in icon-source.json, which the iOS
// workflow compares with the tile to say when the icon is out of date.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const SOURCE = 'public/brand/kraken-logo-square.png';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const repoDir = join(appDir, '..');
const source = join(repoDir, ...SOURCE.split('/'));
const target = join(appDir, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
const record = join(appDir, 'icon-source.json');

// The tile's emerald background.
const EMERALD = '#0b5d46';
const SIZE = 1024;

const png = readFileSync(source);

await sharp(png)
  .resize(SIZE, SIZE, { fit: 'cover' })
  .flatten({ background: EMERALD })
  .removeAlpha()
  .png({ compressionLevel: 9 })
  .toFile(target);

const meta = await sharp(target).metadata();
if (meta.width !== SIZE || meta.height !== SIZE || meta.channels !== 3 || meta.hasAlpha) {
  console.error(`Unexpected icon: ${meta.width}x${meta.height}, ${meta.channels} channels.`);
  process.exit(1);
}

const sha256 = createHash('sha256').update(png).digest('hex');
writeFileSync(record, JSON.stringify({ source: SOURCE, sha256 }, null, 2) + '\n');
console.log(`Wrote ${relative(repoDir, target)} (${SIZE}x${SIZE} RGB) from ${SOURCE}.`);
