import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMockCalendarState,
  MOCK_DEALS_CALENDAR,
  MOCK_OWN_EMAIL,
  MOCK_TEAM_CALENDAR,
  type MockCalendarState,
} from '@/lib/calendar/mock-calendar';
import { MockCalendarProvider } from '@/lib/calendar/provider';
import { resetCalendarRangeCache, type CalendarSource } from '@/lib/calendar/range-reader';
import { DEMO_BOOKING_SETTINGS_ID } from '@/lib/demo/booking-fixtures';
import { CALENDAR_EDIT_SCOPES } from '@/lib/google/send-scopes';
import { resetLimiters } from '@/lib/security/limits';
import { readBookingSettings } from '@/lib/services/booking';
import {
  bookingCalendars,
  bookingPreview,
  patchBookingSettings,
  PANEL_KEYS,
} from '@/lib/services/booking-planner';
import type { Integration } from '@/lib/types/domain';
import { err } from '@/lib/util/result';
import { wallTimeToUtc } from '@/lib/util/time';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The Booking tab's server side (D-078), on the demo store and the mock
 * calendar: a panel's save changes only its own fields on top of what is
 * stored (never the photo or the chatbot), the planner's lists shed the
 * past, the window never opens past six months; the live preview runs the
 * public page's engine day by day with a rule for every closed day; and the
 * Calendars list adds or drops a calendar from the busy read. Every person,
 * place and value here is invented.
 */

const NOW = new Date('2026-10-26T15:00:00Z'); // Monday 10:00 Central
const TZ = 'America/Chicago';

let harness: Harness;
let state: MockCalendarState;

function integration(): Integration {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    organization_id: harness.auth.organizationId,
    user_id: harness.auth.userId,
    provider: 'google',
    kinds: ['gmail', 'calendar'],
    account_email: MOCK_OWN_EMAIL,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly', ...CALENDAR_EDIT_SCOPES],
    status: 'connected',
    status_detail: null,
    last_sync_at: null,
    last_sync_error: null,
    sync_cursor: null,
    watch_expires_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function source(): CalendarSource {
  return {
    provider: new MockCalendarProvider(NOW, state),
    integration: integration(),
    ownEmails: [MOCK_OWN_EMAIL],
    demo: false,
  };
}

const deps = () => ({ now: NOW, source: source() });
const iso = (day: string, h: number, m = 0) => wallTimeToUtc(day, h, m, TZ)!.toISOString();

async function patch(config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return patchBookingSettings(
    harness.store,
    harness.auth.organizationId,
    harness.auth.userId,
    { config, ...extra },
    NOW,
  );
}

beforeEach(async () => {
  harness = await createHarness({ now: NOW });
  resetCalendarRangeCache();
  resetLimiters();
  state = createMockCalendarState(NOW);
});

afterEach(async () => {
  await harness.dispose();
});

describe('a panel’s save', () => {
  it('changes only the fields it sends, on top of what is stored', async () => {
    const before = await readBookingSettings(harness.store, harness.auth.organizationId);
    const saved = await patch({ title: 'Partner (invented)', closedDates: ['2026-11-04'] });
    expect(saved.ok).toBe(true);
    const after = await readBookingSettings(harness.store, harness.auth.organizationId);
    expect(after.config.title).toBe('Partner (invented)');
    expect(after.config.closedDates).toEqual(['2026-11-04']);
    expect(after.config.places).toEqual(before.config.places);
    expect(after.config.homeCity).toBe(before.config.homeCity);
    expect(after.enabled).toBe(before.enabled);
    expect(after.slug).toBe(before.slug);
  });

  it('saves the video link for calls from the Profile panel (hotfix, moved by D-078)', async () => {
    const saved = await patch({ callLink: 'https://zoom.us/j/1234567890' });
    expect(saved.ok && saved.value.config.callLink).toBe('https://zoom.us/j/1234567890');
    const bad = await patch({ callLink: 'http://zoom.us/j/1234567890' });
    expect(bad.ok).toBe(false);
  });

  it('never takes the photo or the chatbot from a panel', async () => {
    const before = await readBookingSettings(harness.store, harness.auth.organizationId);
    const saved = await patch({
      photo: { path: 'booking/elsewhere.jpg', type: 'image/jpeg', version: 'deadbeef' },
      chatbot: { enabled: false, faqItems: [], aiAnswers: true, dailyAiCap: 500 },
      monthlyAiCapUsd: 400,
      somethingElse: true,
    });
    expect(saved.ok).toBe(true);
    const after = await readBookingSettings(harness.store, harness.auth.organizationId);
    expect(after.config.photo).toEqual(before.config.photo);
    expect(after.config.chatbot).toEqual(before.config.chatbot);
    expect(PANEL_KEYS).not.toContain('photo');
    expect(PANEL_KEYS).not.toContain('chatbot');
  });

  it('turns the link on or off, and switches Approve first, alone', async () => {
    const off = await patch({}, { enabled: false });
    expect(off.ok && off.value.enabled).toBe(false);
    const approve = await patch({ approveFirst: true });
    expect(approve.ok && approve.value.config.approveFirst).toBe(true);
    expect(approve.ok && approve.value.enabled).toBe(false);
  });

  it('drops the planner’s past days and months, and refuses a month past the next eleven', async () => {
    const saved = await patch({
      closedDates: ['2026-10-01', '2026-11-04'],
      openMonths: ['2026-09', '2026-12'],
    });
    expect(saved.ok && saved.value.config.closedDates).toEqual(['2026-11-04']);
    expect(saved.ok && saved.value.config.openMonths).toEqual(['2026-12']);
    const far = await patch({ openMonths: ['2027-10'] });
    expect(far.ok).toBe(false);
    if (!far.ok) {
      expect(far.error.message).toBe('The link can open this month and the next 11, no further.');
    }
    const ok = await patch({ openMonths: ['2027-01', '2027-09'] });
    expect(ok.ok && ok.value.config.openMonths).toEqual(['2027-01', '2027-09']);
    const none = await patch({ openMonths: [] });
    expect(none.ok && none.value.config.openMonths).toEqual([]);
  });

  it('refuses hours outside the hard bounds with the same plain message as before', async () => {
    const bad = await patch({ callWindow: { from: '07:00', to: '18:00' } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toMatch(/8:00 AM and 6:00 PM Central/);
  });

  it('says which file to run when the tables are missing', async () => {
    const store = harness.store;
    const original = store.findOne.bind(store);
    store.findOne = (async (table: string, ...rest: unknown[]) => {
      if (table === 'booking_settings')
        throw new Error('relation "booking_settings" does not exist');
      return (original as (...a: unknown[]) => unknown)(table, ...rest);
    }) as typeof store.findOne;
    const saved = await patch({ title: 'x' });
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.code).toBe('not_configured');
    store.findOne = original;
    expect(DEMO_BOOKING_SETTINGS_ID).toBeTruthy();
  });
});

describe('the live preview', () => {
  it('shows each day of a month through the public page’s rules, with a rule for every closed day', async () => {
    await patch({ closedDates: ['2026-11-04'] });
    const found = await bookingPreview(
      harness.store,
      harness.auth.organizationId,
      { from: '2026-10-25', to: '2026-11-30' },
      deps(),
    );
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const preview = found.value;
    expect(preview).toMatchObject({
      state: 'ok',
      hostZone: TZ,
      today: '2026-10-26',
      openMonths: ['2026-10', '2026-11'],
      lastOpenDay: '2026-11-30',
    });
    const by = Object.fromEntries(preview.days.map((d) => [d.date, d]));
    expect(by['2026-10-25']!.plans.call.code).toBe('past');
    expect(by['2026-10-26']!.plans.call.code).toBe('weekday');
    expect(by['2026-11-04']!.plans.call.code).toBe('date_closed');
    expect(by['2026-11-04']!.plans.coffee.code).toBe('date_closed');
    // Times only, as instants: nothing about any entry on the calendar.
    const open = preview.days.flatMap((d) => d.plans.call.times);
    expect(open.length).toBeGreaterThan(10);
    expect(JSON.stringify(preview)).not.toMatch(/board|Ledgerly|Vetrix|summary/i);
  });

  it('marks a month past the window as not opened', async () => {
    const found = await bookingPreview(
      harness.store,
      harness.auth.organizationId,
      { from: '2026-12-01', to: '2026-12-31' },
      deps(),
    );
    expect(found.ok && found.value.days.every((d) => d.plans.call.times.length === 0)).toBe(true);
    expect(found.ok && found.value.days.find((d) => d.date === '2026-12-01')?.plans.call.code).toBe(
      'not_open',
    );
  });

  it('shows the rules alone, marked, when the calendar cannot be read', async () => {
    const broken: CalendarSource = {
      ...source(),
      provider: {
        ...new MockCalendarProvider(NOW, state),
        kind: 'mock',
        listCalendars: async () => err('provider_unavailable', 'Calendar is down.'),
      } as unknown as CalendarSource['provider'],
    };
    const found = await bookingPreview(
      harness.store,
      harness.auth.organizationId,
      { from: '2026-10-26', to: '2026-11-08' },
      { now: NOW, source: broken },
    );
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.state).toBe('unavailable');
    expect(found.value.message).toMatch(/Visitors see no times until it can be read/);
  });

  it('refuses more than six weeks at once', async () => {
    const found = await bookingPreview(
      harness.store,
      harness.auth.organizationId,
      { from: '2026-10-26', to: '2027-01-31' },
      deps(),
    );
    expect(found.ok).toBe(false);
  });
});

describe('which calendars block his time', () => {
  it('lists his calendars with the defaults, the main one locked on', async () => {
    const found = await bookingCalendars(harness.store, harness.auth.organizationId);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const by = Object.fromEntries(found.value.calendars.map((c) => [c.id, c]));
    expect(by[MOCK_OWN_EMAIL]).toMatchObject({ primary: true, lock: 'main', counts: true });
    expect(by[MOCK_TEAM_CALENDAR]).toMatchObject({ lock: null, defaultCounts: true, counts: true });
    expect(by[MOCK_DEALS_CALENDAR]).toMatchObject({
      lock: null,
      defaultCounts: false,
      counts: false,
    });
  });

  it('a choice adds a calendar to the busy read, or drops one', async () => {
    const wed = '2026-10-28';
    const pitch = iso(wed, 15); // "Pitch" on the shared deal-flow calendar, 15:00 to 15:45.
    const read = async () => {
      resetCalendarRangeCache();
      const found = await bookingPreview(
        harness.store,
        harness.auth.organizationId,
        { from: wed, to: wed },
        deps(),
      );
      if (!found.ok) throw new Error(found.error.message);
      return found.value.days[0]!.plans.call.times;
    };
    expect(await read()).toContain(pitch);
    await patch({ calendarChoices: [{ id: MOCK_DEALS_CALENDAR, counts: true }] });
    expect(await read()).not.toContain(pitch);
    const listed = await bookingCalendars(harness.store, harness.auth.organizationId);
    expect(
      listed.ok && listed.value.calendars.find((c) => c.id === MOCK_DEALS_CALENDAR)?.counts,
    ).toBe(true);
  });
});
