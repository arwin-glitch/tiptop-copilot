import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Where Gmail filters can be made or deleted, read from the source. The
 * filter scope is asked for by the "Turn on filters" opt-in alone; the
 * module that writes filters is reached only from the Inbox's filters route
 * (a person's Create or Delete click); and no filter body ever carries a
 * forward.
 */

const SRC = join(process.cwd(), 'src');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const SOURCES = files(SRC).map((file) => ({
  rel: relative(SRC, file).split(sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

const find = (rel: string) => SOURCES.find((s) => s.rel === rel)!.text;

describe('Gmail filters', () => {
  it('the filter scope is read by the OAuth builder and the check that refuses, nothing else', () => {
    const readers = SOURCES.filter((s) => /\bFILTER_SCOPES\b/.test(s.text)).map((s) => s.rel);
    expect(readers.sort()).toEqual([
      'lib/google/gmail-filters.ts',
      'lib/google/oauth.ts',
      'lib/google/send-scopes.ts',
    ]);
    expect(find('lib/google/oauth.ts')).toMatch(/options\.filters \? FILTER_SCOPES : \[\]/);
    expect(find('app/api/integrations/google/start/route.ts')).toMatch(
      /searchParams\.get\('filters'\) === '1'/,
    );
  });

  it('"Turn on filters" is a link a person clicks: the Inbox dialogs and Settings', () => {
    const linkers = SOURCES.filter((s) => /google\/start\?filters=1/.test(s.text)).map(
      (s) => s.rel,
    );
    expect(linkers.sort()).toEqual([
      'app/(app)/settings/page.tsx',
      'components/inbox/inbox-filters.tsx',
    ]);
  });

  it('only the filters service reaches the module that writes filters, and only the route reaches it', () => {
    const importers = SOURCES.filter((s) =>
      /from ['"][^'"]*google\/gmail-filters['"]/.test(s.text),
    ).map((s) => s.rel);
    // Settings reads `canManageFilters` only, to show On or the button.
    expect(importers.sort()).toEqual([
      'app/(app)/settings/page.tsx',
      'lib/services/inbox-filters.ts',
    ]);
    expect(find('app/(app)/settings/page.tsx')).toMatch(
      /import \{ canManageFilters \} from '@\/lib\/google\/gmail-filters'/,
    );
    const callers = SOURCES.filter((s) => /\b(makeFilter|removeFilter)\(/.test(s.text)).map(
      (s) => s.rel,
    );
    expect(callers.sort()).toEqual([
      'app/api/inbox/filters/route.ts',
      'lib/services/inbox-filters.ts',
    ]);
    // No AI tool, routine, cron job or relay names the filters service.
    const services = SOURCES.filter((s) =>
      /from ['"][^'"]*services\/inbox-filters['"]/.test(s.text),
    ).map((s) => s.rel);
    expect(services.sort()).toEqual([
      'app/api/inbox/block/route.ts',
      'app/api/inbox/filters/count/route.ts',
      'app/api/inbox/filters/route.ts',
    ]);
  });

  it('nothing builds a filter that forwards or deletes', () => {
    for (const rel of [
      'lib/email/inbox-filters.ts',
      'lib/google/gmail-filters.ts',
      'lib/services/inbox-filters.ts',
      'app/api/inbox/filters/route.ts',
      'app/api/inbox/block/route.ts',
    ]) {
      const text = find(rel);
      expect(text, rel).not.toMatch(/forward\s*:/);
      expect(text, rel).not.toMatch(/addLabelIds[^\n]*TRASH/);
    }
    // The route's schema has no field for either.
    expect(find('app/api/inbox/filters/route.ts')).toMatch(/\.strict\(\)/);
  });
});
