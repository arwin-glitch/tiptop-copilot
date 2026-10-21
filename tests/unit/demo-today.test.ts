import { describe, expect, it } from 'vitest';
import { buildDemoDb } from '@/lib/demo/fixtures';
import type { RoutineBriefing } from '@/lib/types/domain';
import { localDateKey } from '@/lib/util/time';

/**
 * The demo's meetings and morning brief are "today" in the demo profile's
 * timezone (Central), at whatever hour the demo is opened. UTC turns over at
 * 7 PM Central (6 PM in winter); before the fix every evening put them on
 * tomorrow, so Today and Calendar showed no meetings.
 */

const CENTRAL = 'America/Chicago';

describe("the demo's today", () => {
  it.each([
    ['7 AM Central', '2026-10-18T12:00:00Z'],
    ['6:59 PM Central', '2026-10-18T23:59:00Z'],
    ['9 PM Central, already tomorrow in UTC', '2026-10-19T02:00:00Z'],
    ['11:30 PM Central in winter time', '2026-12-03T05:30:00Z'],
  ])('keeps the meetings and the morning brief on Central’s today at %s', (_, iso) => {
    const now = new Date(iso);
    const today = localDateKey(now, CENTRAL);
    const db = buildDemoDb(now);

    expect(db.calendar_events.length).toBeGreaterThan(0);
    for (const event of db.calendar_events) {
      expect(localDateKey(new Date(event.starts_at), CENTRAL), event.title).toBe(today);
      expect(localDateKey(new Date(event.ends_at), CENTRAL), event.title).toBe(today);
    }
    const briefs = (db.routine_briefings ?? []) as RoutineBriefing[];
    expect(briefs.length).toBeGreaterThan(0);
    for (const brief of briefs) {
      expect(brief.date_key).toBe(today);
      expect(localDateKey(new Date(brief.posted_at), CENTRAL)).toBe(today);
    }
  });
});
