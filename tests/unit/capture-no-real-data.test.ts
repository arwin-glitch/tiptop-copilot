import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The repository is public (D-076). The web recorder, its worklet, the Meet
 * extension and their tests use invented people only, carry no key, and the
 * recorder never stores audio: no MediaRecorder, IndexedDB, Cache Storage or
 * localStorage anywhere in the capture code, except two files that keep
 * something that is not audio (the downloaded-model check and the model
 * choice), which must never touch audio at all.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');

function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  return readdirSync(abs).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
}

const CAPTURE_CODE = [
  ...walk('src/lib/capture'),
  ...walk('src/components/capture'),
  'src/app/(app)/sound-check/page.tsx',
  'public/worklets/pcm16.js',
  ...walk('extension/meet').filter((f) => /\.(js|json|html)$/.test(f)),
];

const FILES = [
  ...CAPTURE_CODE,
  ...readdirSync(path.join(ROOT, 'tests/unit'))
    .filter((f) => f.startsWith('capture-'))
    .map((f) => `tests/unit/${f}`),
  ...readdirSync(path.join(ROOT, 'tests/e2e'))
    .filter((f) => f.startsWith('capture-'))
    .map((f) => `tests/e2e/${f}`),
];

const ALLOWED_DOMAIN = /\.(example|demo|test|invalid)$/i;

describe('the web recorder has no real data and keeps no audio', () => {
  it('uses only reserved or demo email domains', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
        const domain = m[1] ?? '';
        if (!ALLOWED_DOMAIN.test(domain)) offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('carries no API key or token-shaped secret', () => {
    for (const file of FILES) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      expect(text, file).not.toMatch(/sk-ant-[A-Za-z0-9]/);
      expect(text, file).not.toMatch(/xox[bap]-[0-9]/);
      expect(text, file).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
    }
  });

  it('never stores audio in the browser', () => {
    const keepsNoAudio = new Set([
      // Checks and deletes the cached speech models (huggingface.co files).
      'src/lib/capture/model-cache.ts',
      // The chosen Whisper size and device.
      'src/lib/capture/speech-preferences.ts',
    ]);
    for (const file of CAPTURE_CODE) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      expect(text, file).not.toMatch(/new MediaRecorder|indexedDB/);
      if (keepsNoAudio.has(file)) {
        expect(text, file).not.toMatch(/samples|Int16Array|Float32Array|MediaStream|audio/i);
      } else {
        expect(text, file).not.toMatch(/caches\.open|localStorage\.setItem/);
      }
    }
  });
});
