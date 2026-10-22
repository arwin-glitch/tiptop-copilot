import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FONT_LIBRARY, FONT_PAIRINGS, fontFaceCss, fontStack } from '@/lib/events/fonts';
import { FONT_IDS } from '@/lib/events/schema';
import { THEME_PRESETS } from '@/lib/events/themes';

const ROOT = process.cwd();
const squash = (css: string) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();

describe('self-hosted event fonts', () => {
  it('describes every schema font id', () => {
    expect(Object.keys(FONT_LIBRARY).sort()).toEqual([...FONT_IDS].sort());
    for (const id of FONT_IDS) {
      expect(FONT_LIBRARY[id].files.length).toBeGreaterThan(0);
      expect(fontStack(id)).toMatch(new RegExp(`^'ev-${id}', `));
    }
  });

  it('has every web file, share-card file and licence on disk', () => {
    for (const id of FONT_IDS) {
      const family = FONT_LIBRARY[id];
      for (const f of family.files) {
        const file = path.join(ROOT, 'public', 'event-fonts', f.file);
        expect(existsSync(file), file).toBe(true);
        expect(statSync(file).size).toBeGreaterThan(1000);
      }
      expect(existsSync(path.join(ROOT, 'public', 'event-fonts', id, 'LICENSE.txt'))).toBe(true);
      for (const w of family.og) {
        expect(existsSync(path.join(ROOT, 'assets', 'og-fonts', `${id}-${w}.woff`))).toBe(true);
      }
    }
  });

  it('keeps event-fonts.css in step with the table', () => {
    const css = readFileSync(
      path.join(ROOT, 'src/components/events/render/event-fonts.css'),
      'utf8',
    );
    expect(squash(css)).toBe(squash(fontFaceCss()));
    expect(css).not.toMatch(/fonts\.(googleapis|gstatic)\.com|https?:\/\//);
  });

  it('only pairs and presets fonts the library has', () => {
    for (const pair of FONT_PAIRINGS) {
      expect(FONT_IDS).toContain(pair.display);
      expect(FONT_IDS).toContain(pair.body);
    }
    for (const p of THEME_PRESETS) {
      expect(FONT_LIBRARY[p.theme.typography.display]).toBeDefined();
    }
  });
});
