import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dayKeyIn } from '@/lib/booking/public';
import {
  createMockCalendarState,
  MOCK_OWN_EMAIL,
  type MockCalendarState,
} from '@/lib/calendar/mock-calendar';
import { MockCalendarProvider } from '@/lib/calendar/provider';
import { resetCalendarRangeCache, type CalendarSource } from '@/lib/calendar/range-reader';
import { DEMO_BOOKING_SETTINGS_ID } from '@/lib/demo/booking-fixtures';
import { resetLimiters } from '@/lib/security/limits';
import { publicSlots } from '@/lib/services/booking';
import { wallTimeToUtc } from '@/lib/util/time';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The booking page's calendar card (D-078), from the public slots API: for
 * every day of the months open on the link, open (it has times), booked (a
 * meeting day with every time taken) or off (not offered), and the open
 * months for the card's arrows. Only those words: never a title, a guest, a
 * place or why a day is closed. Everything on the calendar is invented.
 */

const NOW = new Date('2026-10-26T15:00:00Z'); // Monday 10:00 Central
const TZ = 'America/Chicago';
const SLUG = 'nick';

let harness: Harness;
let state: MockCalendarState;

function source(): CalendarSource {
  return {
    provider: new MockCalendarProvider(NOW, state),
    integration: null,
    ownEmails: [MOCK_OWN_EMAIL],
    demo: false,
  };
}

async function setConfig(patch: Record<string, unknown>) {
  const org = harness.auth.organizationId;
  const row = await harness.store.get('booking_settings', org, DEMO_BOOKING_SETTINGS_ID);
  await harness.store.update('booking_settings', org, DEMO_BOOKING_SETTINGS_ID, {
    settings: { ...(row!.settings as Record<string, unknown>), ...patch },
  });
}

const at = (day: string, h: number, m = 0) => wallTimeToUtc(day, h, m, TZ)!.toISOString();

beforeEach(async () => {
  harness = await createHarness({ now: NOW });
  resetCalendarRangeCache();
  resetLimiters();
  state = createMockCalendarState(NOW);
  await setConfig({ openMonths: ['2026-10', '2026-11'] });
});

afterEach(async () => {
  await harness.dispose();
});

describe('the calendar card’s days', () => {
  it('gives every day of the open months a state, and the open months', async () => {
    const found = await publicSlots(
      harness.store,
      SLUG,
      { type: 'call', kind: null },
      { now: NOW, source: source() },
    );
    expect(found.state).toBe('ok');
    expect(found.months).toEqual(['2026-10', '2026-11']);
    const days = found.days!;
    // Today through the last day of November.
    expect(days[0]!.date).toBe('2026-10-26');
    expect(days.at(-1)!.date).toBe('2026-11-30');
    expect(days).toHaveLength(36);
    // Open exactly where the times are (the host's days).
    const withTimes = new Set(found.slots.map((s) => dayKeyIn(s.start, TZ)));
    for (const d of days) expect(d.state === 'open').toBe(withTimes.has(d.date));
    // A Saturday, a Monday, today (inside the notice): not offered.
    for (const date of ['2026-10-31', '2026-11-02', '2026-10-26']) {
      expect(days.find((d) => d.date === date)?.state).toBe('off');
    }
    // Nothing but a date and one of three words.
    for (const d of days) {
      expect(Object.keys(d).sort()).toEqual(['date', 'state']);
      expect(['open', 'booked', 'off']).toContain(d.state);
    }
  });

  it('says a meeting day with every time taken is booked, never why', async () => {
    await setConfig({ maxMeetingsPerDay: 1 });
    const day = '2026-11-10';
    const list = state.events.get(MOCK_OWN_EMAIL) ?? [];
    list.push({
      id: 'plantedboardmeeting',
      status: 'confirmed',
      summary: 'Secret board meeting at Hidden Place',
      location: 'Hidden Place',
      start: { dateTime: at(day, 9), timeZone: TZ },
      end: { dateTime: at(day, 10), timeZone: TZ },
      organizer: { email: MOCK_OWN_EMAIL, self: true },
      attendees: [
        { email: MOCK_OWN_EMAIL, self: true, responseStatus: 'accepted' },
        { email: 'board.member@other.example', responseStatus: 'accepted' },
      ],
    });
    state.events.set(MOCK_OWN_EMAIL, list);
    resetCalendarRangeCache();
    const found = await publicSlots(
      harness.store,
      SLUG,
      { type: 'call', kind: null },
      { now: NOW, source: source() },
    );
    expect(found.days!.find((d) => d.date === day)?.state).toBe('booked');
    const text = JSON.stringify(found);
    for (const secret of ['Secret', 'Hidden', 'board.member', 'meeting_cap', 'meetings']) {
      expect(text).not.toContain(secret);
    }
  });

  it('a month switched off has no days at all, and its arrows skip it', async () => {
    await setConfig({ openMonths: ['2026-10', '2026-12'] });
    const found = await publicSlots(
      harness.store,
      SLUG,
      { type: 'call', kind: null },
      { now: NOW, source: source() },
    );
    expect(found.months).toEqual(['2026-10', '2026-12']);
    expect(found.days!.some((d) => d.date.startsWith('2026-11'))).toBe(false);
    expect(found.slots.some((s) => s.start.startsWith('2026-11'))).toBe(false);
  });
});
