import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import manifest from '@/app/manifest';

/**
 * The web app's icons come from the Kraken crest, public/brand/kraken-logo.png
 * (scripts/generate-icons.mjs). /icon-192.png must stay: the desktop app's
 * fallback page loads it to see whether the site is up.
 */
const pub = (file: string) => join(process.cwd(), 'public', file);

const PNGS = [
  { file: 'icon-192.png', size: 192, opaque: false },
  { file: 'icon-512.png', size: 512, opaque: false },
  { file: 'icon-maskable-512.png', size: 512, opaque: true },
  { file: 'apple-icon.png', size: 180, opaque: true },
];

describe('web icons', () => {
  it('the source crest is a 1024 square PNG with transparency', async () => {
    const meta = await sharp(pub('brand/kraken-logo.png')).metadata();
    expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual([
      'png',
      1024,
      1024,
      true,
    ]);
  });

  for (const { file, size, opaque } of PNGS) {
    it(`${file} is the crest at ${size}px`, async () => {
      const image = sharp(pub(file));
      const meta = await image.metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['png', size, size]);
      const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const corner = data[3];
      // Maskable and Apple icons fill the square; the others keep the
      // transparent background around the crest.
      expect(corner).toBe(opaque ? 255 : 0);
      // The crest itself: plenty of green, and some gold, in the middle.
      let green = 0;
      let gold = 0;
      for (let i = 0; i < info.width * info.height * 4; i += 4) {
        const [r, g, b, a] = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0];
        if (a < 200) continue;
        if (g > r + 15 && g > b + 15 && g > 60) green++;
        if (r > 150 && g > 120 && b < 110 && r >= g) gold++;
      }
      const pixels = info.width * info.height;
      expect(green / pixels).toBeGreaterThan(0.1);
      expect(gold / pixels).toBeGreaterThan(0.01);
    });
  }

  it('icon.svg is the favicon carrying the crest', async () => {
    const svg = readFileSync(pub('icon.svg'), 'utf8');
    expect(svg).toContain('aria-label="TipTop Kraken"');
    const base64 = /href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/.exec(svg)?.[1];
    expect(base64).toBeTruthy();
    const meta = await sharp(Buffer.from(base64 ?? '', 'base64')).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 96, 96]);
  });

  it('the manifest lists every icon, with a maskable one', () => {
    const icons = manifest().icons ?? [];
    expect(icons.map((i) => i.src)).toEqual([
      '/icon.svg',
      '/icon-192.png',
      '/icon-512.png',
      '/icon-maskable-512.png',
    ]);
    expect(icons.find((i) => i.src === '/icon-maskable-512.png')?.purpose).toBe('maskable');
    expect(manifest().name).toBe('TipTop Kraken');
  });

  it('the desktop fallback page still checks the site with /icon-192.png', () => {
    const fallback = readFileSync(join(process.cwd(), 'desktop/fallback/index.html'), 'utf8');
    expect(fallback).toContain("'/icon-192.png?wake='");
  });
});
