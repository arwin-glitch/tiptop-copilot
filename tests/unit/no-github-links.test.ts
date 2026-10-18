import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Nothing in the app sends a person to where the code or the desktop
 * installers are hosted. Installers download through Copilot's own
 * /api/desktop/download route, which streams the file; lib/desktop/
 * releases.ts is the one module that talks to the host, server-side.
 */

const SRC = path.resolve(import.meta.dirname, '../../src');
const SERVER_SIDE_FETCHER = path.join(SRC, 'lib', 'desktop', 'releases.ts');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe('no links to the code host', () => {
  const files = walk(SRC).filter((file) => file !== SERVER_SIDE_FETCHER);

  it('finds the source files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no URL on the code host anywhere in src', () => {
    const offenders = files.filter((file) =>
      /https?:\/\/([\w-]+\.)*github\.com/i.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('never names the code host in a page or component', () => {
    const ui = files.filter((file) => {
      const rel = path.relative(SRC, file).split(path.sep);
      return rel[0] === 'app' || rel[0] === 'components';
    });
    expect(ui.length).toBeGreaterThan(50);
    const offenders = ui.filter((file) => /github\.com/i.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
