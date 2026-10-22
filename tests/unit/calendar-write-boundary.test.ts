import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Where calendar writes can come from, read from the source. Changing an
 * event is a person's tap on the Calendar tab, or the booking link's own
 * module (lib/services/booking-calendar.ts, D-074 and D-078): a person's
 * Approve, a visitor's instant booking, a held time placed once editing is
 * on, and the booking's own page moving or cancelling it, each after the time
 * was checked again. No routine, AI tool, relay reader, the pings or the
 * parity check can reach a write; the push job only places held times; and
 * nothing anywhere defaults to emailing guests. The public pages and the
 * chatbot name no write themselves.
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
  it('only the Calendar tab’s edit route and the booking link’s write module import it', () => {
    const importers = SOURCES.filter((s) => /from ['"][^'"]*calendar\/write['"]/.test(s.text)).map(
      (s) => s.rel,
    );
    expect(importers.sort()).toEqual([
      'app/api/calendar/events/route.ts',
      'lib/services/booking-calendar.ts',
    ]);
    // The booking link's writes (D-078): one create, one move, one delete, each
    // telling the guests through Google (sendUpdates 'all' via notify 'send').
    const writes = SOURCES.find((s) => s.rel === 'lib/services/booking-calendar.ts')!.text;
    expect(writes.match(/createCalendarEvent\(/g)).toHaveLength(1);
    expect(writes.match(/updateCalendarEvent\(/g)).toHaveLength(1);
    expect(writes.match(/deleteCalendarEvent\(/g)).toHaveLength(1);
    expect(writes.match(/notify: 'send'/g)).toHaveLength(3);
    expect(writes).not.toMatch(/recolorCalendarEvent|relabelCalendarEvent|respondToCalendarEvent/);
    // Reached from the booking service (Approve, an instant booking) and the
    // booking's own page and held times (booking-manage) alone.
    const users = SOURCES.filter((s) => /from ['"]\.\/booking-calendar['"]/.test(s.text)).map(
      (s) => s.rel,
    );
    expect(users.sort()).toEqual(['lib/services/booking-manage.ts', 'lib/services/booking.ts']);
    const booking = SOURCES.find((s) => s.rel === 'lib/services/booking.ts')!.text;
    expect(booking.match(/createLinkEvent\(/g)).toHaveLength(2);
    expect(booking).not.toMatch(/moveLinkEvent|deleteLinkEvent/);
    const approve =
      /export async function approveBookingRequest[\s\S]*?\n}\n/.exec(booking)?.[0] ?? '';
    expect(approve).toMatch(/createLinkEvent\(/);
    // Every write there comes after the time was checked again, fresh.
    const submit =
      /export async function submitBookingRequest[\s\S]*?\n}\n/.exec(booking)?.[0] ?? '';
    expect(submit.indexOf('fresh: true')).toBeGreaterThan(0);
    expect(submit.indexOf('slotProblem(')).toBeLessThan(submit.indexOf('createLinkEvent('));
    // Approve is reached from the signed-in panel route alone.
    const approvers = SOURCES.filter((s) => /\bapproveBookingRequest\(/.test(s.text)).map(
      (s) => s.rel,
    );
    expect(approvers.sort()).toEqual([
      'app/api/booking/requests/[id]/route.ts',
      'lib/services/booking.ts',
    ]);
    // The job reaches a write only by placing held times, each checked again.
    const cron = SOURCES.find((s) => s.rel === 'app/api/cron/push/route.ts')!.text;
    expect(cron).toMatch(/placeHeldBookingsForAll\(/);
    expect(cron).not.toMatch(/createLinkEvent|moveLinkEvent|deleteLinkEvent|calendar\/write/);
  });

  it('the public booking page, its routes and its chatbot name no write at all', () => {
    const publicSide = SOURCES.filter(
      (s) =>
        s.rel.startsWith('app/meet/') ||
        s.rel.startsWith('app/api/meet/') ||
        s.rel.startsWith('lib/booking/') ||
        s.rel.startsWith('components/booking/booking-page') ||
        s.rel.startsWith('components/booking/booking-chat') ||
        s.rel.startsWith('components/booking/booking-manage') ||
        s.rel.startsWith('components/booking/booking-confirmation') ||
        s.rel.startsWith('components/booking/booking-details') ||
        s.rel.startsWith('components/booking/slot-picker') ||
        s.rel.startsWith('components/booking/guest-list'),
    );
    expect(publicSide.length).toBeGreaterThan(8);
    for (const { rel, text } of publicSide) {
      expect(text, rel).not.toMatch(
        /calendar\/write|createCalendarEvent|\b(insertEvent|patchEvent|moveEvent|deleteEvent)\b|sendUpdates|approveBookingRequest|gmail-send|sendMessage\(/,
      );
    }
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
    // The "Turn on calendar editing" links: Settings, the Calendar tab's view-only
    // note, and Today's line about held booking times (D-078; the Booking tab's
    // banner reuses its link).
    const linkers = SOURCES.filter((s) => /google\/start\?calendar=1/.test(s.text)).map(
      (s) => s.rel,
    );
    expect(linkers.sort()).toEqual([
      'app/(app)/calendar/page.tsx',
      'app/(app)/settings/page.tsx',
      'components/today/booking-requests-line.tsx',
    ]);
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
