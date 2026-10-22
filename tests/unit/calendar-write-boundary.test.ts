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
      'app/api/calendar/series/route.ts',
      'lib/calendar/event-text.ts',
      // Colour labels: read, suggested, filtered, reported; only a tap writes one.
      'lib/calendar/labels.ts',
      'lib/calendar/label-suggest.ts',
      'lib/calendar/origin.ts',
      'lib/calendar/event-look.ts',
      'lib/services/calendar-labels.ts',
      'lib/services/calendar-origin.ts',
      'components/calendar/label-report.tsx',
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

  it('the calendar-editing scope is asked for by the opt-in flow alone', () => {
    // The scope list is read by the OAuth URL builder (only when the start
    // route was opened with ?calendar=1) and by the check that refuses writes.
    const readers = SOURCES.filter((s) => /\bCALENDAR_EDIT_SCOPES\b/.test(s.text)).map(
      (s) => s.rel,
    );
    expect(readers.sort()).toEqual([
      'lib/calendar/edit-access.ts',
      'lib/google/oauth.ts',
      'lib/google/send-scopes.ts',
    ]);
    const builders = SOURCES.filter((s) => /\bbuildAuthorizationUrl\(/.test(s.text)).map(
      (s) => s.rel,
    );
    expect(builders.sort()).toEqual([
      'app/api/integrations/google/start/route.ts',
      'lib/google/oauth.ts',
    ]);
    const start = SOURCES.find((s) => s.rel === 'app/api/integrations/google/start/route.ts')!;
    expect(start.text).toMatch(/searchParams\.get\('calendar'\) === '1'/);
    // The "Turn on calendar editing" links: Settings and the Calendar tab's view-only note.
    const linkers = SOURCES.filter((s) => /google\/start\?calendar=1/.test(s.text)).map(
      (s) => s.rel,
    );
    expect(linkers.sort()).toEqual(['app/(app)/calendar/page.tsx', 'app/(app)/settings/page.tsx']);
  });

  it('a colour from the event card can never carry a request to email anyone', () => {
    // The route's colour body has no `notify` at all, and the request built
    // for it is always sendUpdates 'none'.
    const route = SOURCES.find((s) => s.rel === 'app/api/calendar/events/route.ts')!.text;
    const color = /const COLOR = z[\s\S]*?\.strict\(\);/.exec(route)?.[0] ?? '';
    expect(color).toMatch(/kind: z\.literal\('color'\)/);
    expect(color).not.toMatch(/notify/);
    const actions = SOURCES.find((s) => s.rel === 'lib/calendar/event-actions.ts')!.text;
    expect(actions).toMatch(
      /return \{ body: \{ colorId \}, sendUpdates: 'none', conferenceDataVersion: 0 \};/,
    );
  });

  it('a label from the event card can never carry a request to email anyone', () => {
    // The route's label body has no `notify`, the request built for it is
    // sendUpdates 'none', and only it and the write module name the label
    // switch Google needs. Only a write carrying eventLabelId sends it: with
    // it, Google drops a label a write leaves out, so an edit, an answer or a
    // colour never carries it.
    const route = SOURCES.find((s) => s.rel === 'app/api/calendar/events/route.ts')!.text;
    const label = /const LABEL = z[\s\S]*?\.strict\(\);/.exec(route)?.[0] ?? '';
    expect(label).toMatch(/kind: z\.literal\('label'\)/);
    expect(label).not.toMatch(/notify/);
    const actions = SOURCES.find((s) => s.rel === 'lib/calendar/event-actions.ts')!.text;
    expect(actions).toMatch(
      /return \{ body: \{ eventLabelId: labelId \?\? '' \}, sendUpdates: 'none', eventLabelVersion: 1 \};/,
    );
    const setters = SOURCES.filter((s) =>
      /eventLabelVersion:\s*(1|request\.|labelVersion)/.test(s.text),
    ).map((s) => s.rel);
    expect(setters.sort()).toEqual(['lib/calendar/event-actions.ts', 'lib/calendar/write.ts']);
    const write = SOURCES.find((s) => s.rel === 'lib/calendar/write.ts')!.text;
    expect(write).toMatch(/return body\.eventLabelId !== undefined \? 1 : 0;/);
    // The colour from the card is sent with its own options, never the label switch.
    const recolor =
      /export async function recolorCalendarEvent[\s\S]*?\n}\n/.exec(write)?.[0] ?? '';
    expect(recolor).toMatch(/conferenceDataVersion: request\.conferenceDataVersion/);
    expect(recolor).not.toMatch(/eventLabelVersion/);
    // Nor does an answer: it changes Nick's response and nothing else.
    const respond =
      /export async function respondToCalendarEvent[\s\S]*?\n}\n/.exec(write)?.[0] ?? '';
    expect(respond).toMatch(/sendUpdates: request\.sendUpdates/);
    expect(respond).not.toMatch(/eventLabelVersion/);
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
