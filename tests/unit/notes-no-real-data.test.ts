import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The repository is public. Kraken Notes' fixtures, scripted call and tests
 * use invented people and companies only, on addresses that cannot belong to
 * anyone: every email address in them is on a reserved or demo domain.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const FILES = [
  'src/lib/demo/notes-fixtures.ts',
  'src/lib/transcribe/mock-script.ts',
  'src/lib/types/notes.ts',
  'src/lib/mcp/meeting-tools.ts',
  'docs/NOTES_ROUTINE.md',
  // Everything Kraken Notes owns under lib/ (never-record.ts among them).
  ...['src/lib/notes', 'src/lib/speakers', 'src/lib/transcribe'].flatMap((dir) =>
    readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `${dir}/${f}`),
  ),
  ...readdirSync(path.join(ROOT, 'tests/unit'))
    .filter((f) => f.startsWith('notes-'))
    .map((f) => `tests/unit/${f}`),
  ...readdirSync(path.join(ROOT, 'tests/integration'))
    .filter((f) => f.startsWith('notes-'))
    .map((f) => `tests/integration/${f}`),
];

const ALLOWED_DOMAIN = /\.(example|demo|test|invalid)$/i;

describe('Kraken Notes has no real data in the repository', () => {
  it('uses only reserved or demo email domains', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
        const domain = m[1] ?? '';
        // Calendar ids look like addresses; Google's own domains are not people.
        if (/(^|\.)google\.com$/i.test(domain)) continue;
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
});
