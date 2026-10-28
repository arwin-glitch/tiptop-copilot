import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOOKING_REQUEST_INPUT, type BookingRequestInput } from '@/lib/booking/request';
import { PICK_GONE_MESSAGE, PICK_MOVE_MESSAGE, PICK_TAKEN_MESSAGE } from '@/lib/booking/picks';
import {
  createMockCalendarState,
  MOCK_OWN_EMAIL,
  type MockCalendarState,
} from '@/lib/calendar/mock-calendar';
import { MockCalendarProvider } from '@/lib/calendar/provider';
import { resetCalendarRangeCache, type CalendarSource } from '@/lib/calendar/range-reader';
import type { DataStore } from '@/lib/db/store';
import { CALENDAR_EDIT_SCOPES } from '@/lib/google/send-scopes';
import { resetLimiters } from '@/lib/security/limits';
import { publicSlots, submitBookingRequest } from '@/lib/services/booking';
import { readBookingAlertItems } from '@/lib/services/booking-alerts';
import {
  manageSlots,
  placeHeldBookings,
  rescheduleByToken,
  cancelByToken,
} from '@/lib/services/booking-manage';
import {
  copyPickAgain,
  createPick,
  listPicks,
  loadPickPage,
  pickSlots,
  revokePick,
  submitPickBooking,
} from '@/lib/services/booking-picks';
import type { Scheduler } from '@/lib/services/booking-sync';
import type { BookingPick, BookingRequest, Integration } from '@/lib/types/domain';
import { wallTimeToUtc } from '@/lib/util/time';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Pick times end to end on the demo store: the host picks ranges on the
 * Calendar, the guest books one start from the link, the booking skips
 * approve first and lands on the calendar, the pick is used once, its holds
 * keep those times off the public link while it is open, and nothing breaks
 * without the table. Every person and address is invented.
 */

const NOW = new Date('2026-10-26T15:00:00Z'); // Monday 10:00 Central
const TZ = 'America/Chicago';
const SLUG = 'nick';
const READ_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];
const EDIT = [...READ_SCOPES, ...CALENDAR_EDIT_SCOPES];
const WED = '2026-10-28';
const TUE_NEXT = '2026-11-03';

let harness: Harness;
let state: MockCalendarState;
const schedule: Scheduler = () => {};

const at = (day: string, h: number, m = 0) => wallTimeToUtc(day, h, m, TZ)!.toISOString();
const range = (day: string, from: number, to: number) => ({
  start: at(day, from),
  end: at(day, to),
});

function source(scopes: string[] = EDIT, now: Date = NOW): CalendarSource {
  const integration: Integration = {
    id: '44444444-4444-4444-8444-444444444444',
    organization_id: harness.auth.organizationId,
    user_id: harness.auth.userId,
    provider: 'google',
    kinds: ['gmail', 'calendar'],
    account_email: MOCK_OWN_EMAIL,
    scopes,
    status: 'connected',
    status_detail: null,
    last_sync_at: null,
    last_sync_error: null,
    sync_cursor: null,
    watch_expires_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
  return {
    provider: new MockCalendarProvider(now, state),
    integration,
    ownEmails: [MOCK_OWN_EMAIL],
    demo: false,
  };
}

const ctx = () => ({
  store: harness.store,
  organizationId: harness.auth.organizationId,
  userId: harness.auth.userId,
});

function guest(over: Record<string, unknown> = {}): BookingRequestInput {
  return BOOKING_REQUEST_INPUT.parse({
    name: 'Pat Lee',
    email: 'pat@acme.example',
    company: 'Acme',
    type: 'call',
    timeZone: 'America/New_York',
    ...over,
  });
}

async function makePick(over: Record<string, unknown> = {}) {
  const made = await createPick(
    ctx(),
    {
      ranges: [range(WED, 10, 11), range(TUE_NEXT, 14, 15)],
      durationMinutes: 30,
      recipientTimeZone: 'America/New_York',
      recipientName: 'Pat',
      ...over,
    },
    { now: NOW, source: source() },
  );
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { ...made.value, token: made.value.url.split('/').pop()! };
}

async function book(
  token: string,
  start: string,
  src = source(),
  store: DataStore = harness.store,
) {
  return submitPickBooking(store, SLUG, token, guest({ start }), {
    ipHash: 'hash-a',
    now: NOW,
    source: src,
    schedule,
  });
}

async function publicCallStarts(store: DataStore = harness.store): Promise<string[]> {
  resetCalendarRangeCache();
  const found = await publicSlots(
    store,
    SLUG,
    { type: 'call', kind: null },
    { now: NOW, source: source() },
  );
  expect(found.state).toBe('ok');
  return found.slots.map((s) => s.start);
}

beforeEach(async () => {
  harness = await createHarness({ now: NOW });
  resetCalendarRangeCache();
  resetLimiters();
  state = createMockCalendarState(NOW);
  // A clear calendar: every time in these tests is free unless a test adds something.
  state.events = new Map();
  state.series = new Map();
});

afterEach(async () => {
  await harness.dispose();
});

describe('making a pick', () => {
  it('keeps only the hash, gives an absolute link and the copy text, and lists it', async () => {
    const made = await makePick();
    expect(made.url).toMatch(/^https?:\/\/[^/]+\/meet\/nick\/p\/[A-Za-z0-9_-]{43}$/);
    expect(made.text).toContain('Wed, Oct 28: 11:00 AM – 12:00 PM');
    expect(made.text).toContain('(Eastern Time)');
    expect(made.text).toContain(`Book one here: ${made.url}`);
    const row = (await harness.store.get('booking_picks', harness.auth.organizationId, made.id))!;
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(made.token);
    // Held 48 hours by default.
    expect(row.expires_at).toBe(new Date(NOW.getTime() + 48 * 3_600_000).toISOString());
    const list = await listPicks(harness.store, harness.auth.organizationId, { now: NOW });
    expect(list).toMatchObject({ available: true, linkReady: true, slug: SLUG });
    expect(list.picks.map((p) => p.id)).toEqual([made.id]);
    expect(list.picks[0]!.canCopyAgain).toBe(true);
    const again = await copyPickAgain(ctx(), made.id, { now: NOW });
    expect(again.ok && again.value.url).toBe(made.url);
    const audits = await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'booking.pick_created' },
    });
    expect(audits).toHaveLength(1);
  });

  it('refuses times in the past and zones not listed', async () => {
    const past = await createPick(
      ctx(),
      { ranges: [range('2026-10-26', 8, 9)], durationMinutes: 30, recipientTimeZone: TZ },
      { now: NOW },
    );
    expect(past.ok).toBe(false);
    const zone = await createPick(
      ctx(),
      { ranges: [range(WED, 10, 11)], durationMinutes: 30, recipientTimeZone: 'Mars/Base' },
      { now: NOW },
    );
    expect(zone.ok).toBe(false);
  });
});

describe('the guest books one', () => {
  it('offers only free starts inside the ranges, and the public link hides them while held', async () => {
    const before = await publicCallStarts();
    const made = await makePick();
    const slots = await pickSlots(harness.store, SLUG, made.token, { now: NOW, source: source() });
    expect(slots.state).toBe('ok');
    expect(slots.slots.map((s) => s.start)).toEqual([
      at(WED, 10),
      at(WED, 10, 30),
      at(TUE_NEXT, 14),
      at(TUE_NEXT, 14, 30),
    ]);
    expect(slots.recipientTimeZone).toBe('America/New_York');
    const held = await publicCallStarts();
    expect(before).toContain(at(WED, 10));
    expect(held).not.toContain(at(WED, 10));
    expect(held).not.toContain(at(TUE_NEXT, 14));
    // Only the held times close: the rest of Wednesday stays open.
    expect(held.filter((s) => s.startsWith('2026-10-28')).length).toBeGreaterThan(3);
  });

  it('books at once with the pick length, uses the pick once, and releases its holds', async () => {
    const made = await makePick({
      durationMinutes: 45,
      ranges: [range(WED, 10, 11), range(TUE_NEXT, 14, 15)],
    });
    const done = await book(made.token, at(WED, 10));
    if (!done.ok || done.value.kind !== 'saved') throw new Error(JSON.stringify(done));
    expect(done.value.result.status).toBe('booked');
    expect(done.value.result.booking?.picked).toBe(true);
    expect(done.value.result.booking?.canReschedule).toBe(false);
    const row = (await harness.store.get(
      'booking_requests',
      harness.auth.organizationId,
      done.value.id,
    )) as BookingRequest;
    expect(row).toMatchObject({ status: 'booked', pick_id: made.id, ends_at: at(WED, 10, 45) });
    expect(row.event_id).toBeTruthy();
    const pick = (await harness.store.get(
      'booking_picks',
      harness.auth.organizationId,
      made.id,
    )) as BookingPick;
    expect(pick).toMatchObject({ status: 'used', booking_request_id: row.id });

    // The holds are gone: next Tuesday 2 PM is back on the public link.
    expect(await publicCallStarts()).toContain(at(TUE_NEXT, 14));
    // The guest's page is closed now, and a second booking is refused.
    const closed = await pickSlots(harness.store, SLUG, made.token, { now: NOW, source: source() });
    expect(closed).toMatchObject({ state: 'closed', message: PICK_GONE_MESSAGE });
    const second = await book(made.token, at(TUE_NEXT, 14));
    expect(second).toMatchObject({
      ok: false,
      error: { code: 'conflict', message: PICK_TAKEN_MESSAGE },
    });

    // The host hears of it like any booking.
    const alerts = await readBookingAlertItems(harness.store, harness.auth.organizationId, NOW, TZ);
    expect(alerts.some((a) => a.key === `booking:${row.id}:new`)).toBe(true);
  });

  it('refuses a start that is not offered, or became busy', async () => {
    const made = await makePick();
    const off = await book(made.token, at(WED, 10, 15));
    expect(off).toMatchObject({ ok: false, error: { code: 'conflict' } });
    state.events.set(MOCK_OWN_EMAIL, [
      {
        id: 'busy-1',
        status: 'confirmed',
        summary: 'Invented meeting',
        start: { dateTime: at(WED, 10, 30) },
        end: { dateTime: at(WED, 11) },
      },
    ]);
    const busy = await book(made.token, at(WED, 10, 30));
    expect(busy).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const fine = await book(made.token, at(WED, 10));
    expect(fine.ok).toBe(true);
  });

  it('is not moved from its page; cancel works', async () => {
    const made = await makePick();
    const done = await book(made.token, at(WED, 10));
    if (!done.ok || done.value.kind !== 'saved') throw new Error('not booked');
    const token = done.value.result.manageUrl!.split('/').pop()!;
    const moved = await rescheduleByToken(harness.store, SLUG, token, at(WED, 14), {
      now: NOW,
      source: source(),
    });
    expect(moved).toMatchObject({ ok: false, error: { message: PICK_MOVE_MESSAGE } });
    const slots = await manageSlots(harness.store, SLUG, token, { now: NOW, source: source() });
    expect(slots?.slots).toEqual([]);
    const cancelled = await cancelByToken(harness.store, SLUG, token, '', {
      now: NOW,
      source: source(),
    });
    expect(cancelled.ok && cancelled.value.status).toBe('cancelled');
  });

  it('works with the public link turned off', async () => {
    const made = await makePick();
    const settings = (await harness.store.findOne(
      'booking_settings',
      harness.auth.organizationId,
      {},
    ))!;
    await harness.store.update('booking_settings', harness.auth.organizationId, settings.id, {
      enabled: false,
    });
    const page = await loadPickPage(harness.store, SLUG, made.token, 'visitor-a', { now: NOW });
    expect(page.state).toBe('open');
    expect(page.publicPath).toBeNull();
    expect(page.page.instant).toBe(true);
    const done = await book(made.token, at(WED, 10));
    expect(done.ok).toBe(true);
  });
});

describe('closed picks', () => {
  it('closes once past its hold', async () => {
    const made = await makePick({ holdHours: 24 });
    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    const slots = await pickSlots(harness.store, SLUG, made.token, {
      now: later,
      source: source(),
    });
    expect(slots.state).toBe('closed');
    const page = await loadPickPage(harness.store, SLUG, made.token, 'visitor-b', { now: later });
    expect(page).toMatchObject({
      state: 'closed',
      message: PICK_GONE_MESSAGE,
      publicPath: '/meet/nick',
    });
    const late = await submitPickBooking(
      harness.store,
      SLUG,
      made.token,
      guest({ start: at(WED, 10) }),
      {
        ipHash: null,
        now: later,
        source: source(EDIT, later),
      },
    );
    expect(late).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('closes when cancelled, and frees its times on the public link', async () => {
    const made = await makePick();
    const revoked = await revokePick(ctx(), made.id, { now: NOW });
    expect(revoked.ok).toBe(true);
    expect(await publicCallStarts()).toContain(at(WED, 10));
    const slots = await pickSlots(harness.store, SLUG, made.token, { now: NOW, source: source() });
    expect(slots.state).toBe('closed');
    expect((await revokePick(ctx(), made.id, { now: NOW })).ok).toBe(false);
    const audits = await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'booking.pick_revoked' },
    });
    expect(audits).toHaveLength(1);
  });

  it('does not hold when the hold is off', async () => {
    await makePick({ hold: false });
    expect(await publicCallStarts()).toContain(at(WED, 10));
  });

  it('closes for a token nobody made', async () => {
    const page = await loadPickPage(harness.store, SLUG, 'x'.repeat(43), 'visitor-c', { now: NOW });
    expect(page.state).toBe('closed');
  });
});

describe('held pick bookings', () => {
  it('are placed by the pick rules, not released by the public link rules', async () => {
    // Tomorrow 9 AM: inside the link's 24-hour notice, which picks ignore.
    const made = await makePick({ ranges: [range('2026-10-27', 9, 10)] });
    const done = await book(made.token, at('2026-10-27', 9), source(READ_SCOPES));
    if (!done.ok || done.value.kind !== 'saved') throw new Error(JSON.stringify(done));
    expect(done.value.result.status).toBe('held');
    const later = new Date(NOW.getTime() + 60_000);
    const outcome = await placeHeldBookings(harness.store, harness.auth.organizationId, {
      now: later,
      source: source(EDIT, later),
      schedule,
      force: true,
    });
    expect(outcome).toMatchObject({ placed: 1, released: 0 });
    const row = (await harness.store.get(
      'booking_requests',
      harness.auth.organizationId,
      done.value.id,
    ))!;
    expect(row.status).toBe('booked');
  });
});

describe('picks over the same times', () => {
  const starts = async (token: string) =>
    (await pickSlots(harness.store, SLUG, token, { now: NOW, source: source() })).slots.map(
      (s) => s.start,
    );

  it('keeps the older link whole; the newer one gets the rest, and loses what is booked', async () => {
    const pat = await makePick({ ranges: [range(WED, 10, 11)], recipientName: 'Pat' });
    expect(pat.warning).toBeNull();
    // Later, the same morning and more for Sam.
    const made = await createPick(
      ctx(),
      {
        ranges: [range(WED, 10, 12)],
        durationMinutes: 30,
        recipientTimeZone: TZ,
        recipientName: 'Sam',
      },
      { now: new Date(NOW.getTime() + 60_000), source: source() },
    );
    if (!made.ok) throw new Error(JSON.stringify(made));
    const sam = { ...made.value, token: made.value.url.split('/').pop()! };
    expect(sam.warning).toMatch(/held for someone else/);
    // Pat's link, already sent, still offers all of its times.
    expect(await starts(pat.token)).toEqual([at(WED, 10), at(WED, 10, 30)]);
    // Sam's offers only what Pat's does not hold.
    expect(await starts(sam.token)).toEqual([at(WED, 11), at(WED, 11, 30)]);

    const done = await book(pat.token, at(WED, 10));
    expect(done.ok).toBe(true);
    // Pat's holds are released, but the time Pat booked is gone for Sam.
    expect(await starts(sam.token)).toEqual([at(WED, 10, 30), at(WED, 11), at(WED, 11, 30)]);
  });

  it('refuses a pick whose times are all held for someone else, or all busy', async () => {
    await makePick({ ranges: [range(WED, 10, 11)] });
    const again = await createPick(
      ctx(),
      { ranges: [range(WED, 10, 11)], durationMinutes: 30, recipientTimeZone: TZ },
      { now: NOW, source: source() },
    );
    expect(again).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    state.events.set(MOCK_OWN_EMAIL, [
      {
        id: 'busy-2',
        status: 'confirmed',
        summary: 'Invented meeting',
        start: { dateTime: at(WED, 14) },
        end: { dateTime: at(WED, 15) },
      },
    ]);
    resetCalendarRangeCache();
    const busy = await createPick(
      ctx(),
      { ranges: [range(WED, 14, 15)], durationMinutes: 30, recipientTimeZone: TZ },
      { now: NOW, source: source() },
    );
    expect(busy).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });
});

describe('held pick bookings far ahead', () => {
  it('are checked against busy time past the months the link opens', async () => {
    // Thu Dec 10: 45 days out, past the open months (this one and the next).
    const DEC = '2026-12-10';
    const made = await makePick({ ranges: [range(DEC, 10, 11)] });
    const done = await book(made.token, at(DEC, 10), source(READ_SCOPES));
    if (!done.ok || done.value.kind !== 'saved') throw new Error(JSON.stringify(done));
    expect(done.value.result.status).toBe('held');
    // Nick puts something there before Kraken can place it.
    state.events.set(MOCK_OWN_EMAIL, [
      {
        id: 'busy-dec',
        status: 'confirmed',
        summary: 'Invented meeting',
        start: { dateTime: at(DEC, 10) },
        end: { dateTime: at(DEC, 11) },
      },
    ]);
    resetCalendarRangeCache();
    const later = new Date(NOW.getTime() + 60_000);
    const outcome = await placeHeldBookings(harness.store, harness.auth.organizationId, {
      now: later,
      source: source(EDIT, later),
      schedule,
      force: true,
    });
    expect(outcome).toMatchObject({ placed: 0, released: 1 });
    const row = (await harness.store.get(
      'booking_requests',
      harness.auth.organizationId,
      done.value.id,
    ))!;
    expect(row.status).toBe('declined');
  });
});

describe('without the booking_picks table', () => {
  /** The store as before the migration: every booking_picks call fails like Postgres would. */
  function withoutPicks(store: DataStore): DataStore {
    const missing = () => {
      const error = new Error('relation "booking_picks" does not exist') as Error & {
        code: string;
      };
      error.code = '42P01';
      throw error;
    };
    return new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (args[0] === 'booking_picks') return Promise.resolve().then(missing);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }

  it('keeps the public link, booking and the calendar list working', async () => {
    const store = withoutPicks(harness.store);
    const starts = await publicCallStarts(store);
    expect(starts).toContain(at(WED, 10));
    const booked = await submitBookingRequest(store, SLUG, guest({ start: at(WED, 10) }), {
      ipHash: 'hash-z',
      now: NOW,
      source: source(),
      schedule,
    });
    expect(booked.ok).toBe(true);
    const list = await listPicks(store, harness.auth.organizationId, { now: NOW });
    expect(list).toMatchObject({ available: false, picks: [] });
    const made = await createPick(
      { ...ctx(), store },
      { ranges: [range(WED, 14, 15)], durationMinutes: 30, recipientTimeZone: TZ },
      { now: NOW },
    );
    expect(made).toMatchObject({ ok: false, error: { code: 'not_configured' } });
    const page = await loadPickPage(store, SLUG, 'y'.repeat(43), 'visitor-d', { now: NOW });
    expect(page.state).toBe('closed');
    const held = await placeHeldBookings(store, harness.auth.organizationId, {
      now: NOW,
      source: source(),
      schedule,
      force: true,
    });
    expect(held.released).toBe(0);
  });
});
