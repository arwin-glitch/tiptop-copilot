import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Where calendar writes can come from, read from the source. Changing an
 * event is a person's tap on the Calendar tab and nothing else: no routine,
 * cron job, AI tool, relay reader, the pings or the parity check can reach a
 * write, and nothing anywhere defaults to emailing guests.
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

describe('calendar writes', () => {
  it('only the Calendar tab’s edit route imports the write module', () => {
    const importers = SOURCES.filter((s) => /from ['"][^'"]*calendar\/write['"]/.test(s.text)).map(
      (s) => s.rel,
    );
    expect(importers).toEqual(['app/api/calendar/events/route.ts']);
  });

  it('only the write module calls the provider’s insert, patch, move and delete', () => {
    const callers = SOURCES.filter((s) =>
      /\.(insertEvent|patchEvent|moveEvent|deleteEvent)\(/.test(s.text),
    ).map((s) => s.rel);
    expect(callers).toEqual(['lib/calendar/write.ts']);
  });

  it('sends POST, PATCH or DELETE to Google Calendar from the provider alone', () => {
    const writers = SOURCES.filter(
      (s) => /calendar\/v3/.test(s.text) && /method:\s*'(POST|PATCH|DELETE)'/.test(s.text),
    ).map((s) => s.rel);
    expect(writers).toEqual(['lib/calendar/provider.ts']);
  });

  it('the readers, the pings and the parity check name no write at all', () => {
    for (const rel of [
      'lib/calendar/range-reader.ts',
      'lib/calendar/parity.ts',
      'lib/calendar/meetings.ts',
      'lib/services/calendar-view.ts',
      'lib/services/push-alerts.ts',
      'app/api/calendar/range/route.ts',
      'app/api/calendar/context/route.ts',
    ]) {
      const text = SOURCES.find((s) => s.rel === rel)?.text ?? '';
      expect(text, rel).not.toBe('');
      expect(text, rel).not.toMatch(/insertEvent|patchEvent|moveEvent|deleteEvent|sendUpdates/);
    }
  });

  it('never defaults to emailing guests: "all" comes only from sendUpdatesFor', () => {
    const offenders = SOURCES.filter((s) =>
      /sendUpdates\s*[:=]\s*['"]all['"]|sendUpdates=all/.test(s.text),
    ).map((s) => s.rel);
    expect(offenders).toEqual([]);
    const rules = SOURCES.find((s) => s.rel === 'lib/calendar/edit-rules.ts')!.text;
    expect(rules).toMatch(/return choice === 'send' \? 'all' : 'none';/);
  });

  it('every API route that writes checks where the request came from', () => {
    for (const rel of ['app/api/calendar/events/route.ts', 'app/api/calendar/prefs/route.ts']) {
      const text = SOURCES.find((s) => s.rel === rel)!.text;
      const handlers = text.match(/export async function (POST|PATCH|DELETE)/g) ?? [];
      const gated = text.match(/calendarAuth\(request, \{[^}]*write: true[^}]*\}\)/g) ?? [];
      expect(handlers.length, rel).toBeGreaterThan(0);
      expect(gated.length, rel).toBe(handlers.length);
    }
  });
});
