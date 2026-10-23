import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasThirdPartyReschedule } from '@/lib/booking/event';
import type { PublicSlot } from '@/lib/booking/public';
import { BOOKING_REQUEST_INPUT, type BookingRequestInput } from '@/lib/booking/request';
import type { GCalEvent } from '@/lib/calendar/google-types';
import {
  createMockCalendarState,
  MOCK_OWN_EMAIL,
  type MockCalendarState,
} from '@/lib/calendar/mock-calendar';
import { MockCalendarProvider } from '@/lib/calendar/provider';
import { resetCalendarRangeCache, type CalendarSource } from '@/lib/calendar/range-reader';
import { DEMO_BOOKING_SETTINGS_ID } from '@/lib/demo/booking-fixtures';
import { CALENDAR_EDIT_SCOPES } from '@/lib/google/send-scopes';
import { resetLimiters } from '@/lib/security/limits';
import { publicSlots, submitBookingRequest } from '@/lib/services/booking';
import { listLinkBookings, rescheduleByToken } from '@/lib/services/booking-manage';
import { bookingMonthCounts } from '@/lib/services/booking-planner';
import { DESCRIPTION_CHECK_DELAY_MS, type Scheduler } from '@/lib/services/booking-sync';
import type { BookingRequest, Integration } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The booking link kept in line with Google Calendar (D-078), on the demo
 * store and the mock calendar: an event deleted in Google is a cancelled
 * booking that frees its time and its place under the day's cap ("Cancelled
 * in Google"); another scheduling tool's reschedule line (an invented Fyxer
 * link here) is taken back out of a booking event's description, told to
 * nobody, once per change, and never out of any other event; and the month
 * strip's counts. Every person, address, link and place is invented.
 */

const NOW = new Date('2026-10-26T15:00:00Z'); // Monday 10:00 Central
/** An hour later: past the few minutes a new event may take to be listed. */
const LATER = new Date(NOW.getTime() + 3_600_000);
const SLUG = 'nick';
const EDIT = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  ...CALENDAR_EDIT_SCOPES,
];
const FYXER_LINE =
  '\n\nNeed to reschedule? <a href="https://app.fyxer.com/e/fictional-777?rescheduleEventId=abc123">Choose a new time</a>';

let harness: Harness;
let state: MockCalendarState;

function source(now: Date = NOW): CalendarSource {
  const integration: Integration = {
    id: '44444444-4444-4444-8444-444444444444',
    organization_id: harness.auth.organizationId,
    user_id: harness.auth.userId,
    provider: 'google',
    kinds: ['gmail', 'calendar'],
    account_email: MOCK_OWN_EMAIL,
    scopes: EDIT,
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

function request(over: Record<string, unknown>): BookingRequestInput {
  return BOOKING_REQUEST_INPUT.parse({
    name: 'Pat Lee',
    email: 'pat@acme.example',
    company: 'Acme',
    type: 'call',
    timeZone: 'America/New_York',
    ...over,
  });
}

async function slots(now: Date = NOW): Promise<PublicSlot[]> {
  const found = await publicSlots(
    harness.store,
    SLUG,
    { type: 'call', kind: null },
    { now, source: source(now) },
  );
  expect(found.state).toBe('ok');
  return found.slots;
}

/** Book a time at once; the re-read after the event is made is caught, not timed. */
async function book(start: string, scheduled: (() => Promise<unknown>)[] = []) {
  const schedule: Scheduler = (work, delay) => {
    expect(delay).toBe(DESCRIPTION_CHECK_DELAY_MS);
    scheduled.push(work);
  };
  const result = await submitBookingRequest(harness.store, SLUG, request({ start }), {
    ipHash: 'hash-a',
    now: NOW,
    source: source(),
    schedule,
  });
  if (!result.ok || result.value.kind !== 'saved') throw new Error(JSON.stringify(result));
  const token = result.value.result.manageUrl!.split('/').pop()!;
  return { row: await rowOf(result.value.id), token, scheduled };
}

async function rowOf(id: string): Promise<BookingRequest> {
  return (await harness.store.get('booking_requests', harness.auth.organizationId, id))!;
}

async function setConfig(patch: Record<string, unknown>) {
  const org = harness.auth.organizationId;
  const row = await harness.store.get('booking_settings', org, DEMO_BOOKING_SETTINGS_ID);
  await harness.store.update('booking_settings', org, DEMO_BOOKING_SETTINGS_ID, {
    settings: { ...(row!.settings as Record<string, unknown>), ...patch },
  });
}

/** The event as the mock calendar holds it now. */
function eventOf(eventId: string): GCalEvent {
  const found = (state.events.get(MOCK_OWN_EMAIL) ?? []).find((e) => e.id === eventId);
  if (!found) throw new Error('no such event');
  return found;
}

/** What another tool does a few seconds after the event is made: appends its own line. */
function thirdPartyEdits(eventId: string, line = FYXER_LINE) {
  const event = eventOf(eventId);
  event.description = `${event.description ?? ''}${line}`;
  resetCalendarRangeCache();
}

/** Deleted in Google Calendar, by hand. */
function deleteInGoogle(eventId: string) {
  const list = state.events.get(MOCK_OWN_EMAIL) ?? [];
  state.events.set(
    MOCK_OWN_EMAIL,
    list.filter((e) => e.id !== eventId),
  );
  resetCalendarRangeCache();
}

const patches = () => state.writes.filter((w) => w.op === 'patch');

beforeEach(async () => {
  harness = await createHarness({ now: NOW });
  resetCalendarRangeCache();
  resetLimiters();
  state = createMockCalendarState(NOW);
});

afterEach(async () => {
  await harness.dispose();
});

describe('an event deleted in Google is a cancelled booking', () => {
  it('stops holding the day under the link cap, and shows as Cancelled in Google', async () => {
    await setConfig({ maxLinkBookingsPerDay: 1 });
    const first = (await slots())[0]!;
    const day = first.start.slice(0, 10);
    const { row } = await book(first.start);
    expect(row.status).toBe('booked');
    // The day's one link booking is taken: nothing else that day.
    const before = await slots(LATER);
    expect(before.some((s) => s.start.slice(0, 10) === day)).toBe(false);

    deleteInGoogle(row.event_id!);
    const reads = state.reads.filter((r) => r.op === 'get').length;
    const after = await slots(LATER);
    // Free again, the cap too: the deleted booking counts for nothing.
    expect(after.some((s) => s.start.slice(0, 10) === day)).toBe(true);
    expect(await rowOf(row.id)).toMatchObject({ status: 'cancelled', cancelled_by: 'calendar' });
    // One look at the missing event to be sure, never a storm.
    expect(state.reads.filter((r) => r.op === 'get').length - reads).toBe(1);
    await slots(LATER);
    expect(state.reads.filter((r) => r.op === 'get').length - reads).toBe(1);
    // No calendar write of its own, and the Booking tab names it.
    expect(state.writes.filter((w) => w.op !== 'insert')).toEqual([]);
    const list = await listLinkBookings(harness.store, harness.auth.organizationId, 'upcoming', {
      now: LATER,
      source: source(LATER),
    });
    expect(list.bookings.find((b) => b.id === row.id)).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'calendar',
    });
  });

  it('moves a booking moved in Google to its real time', async () => {
    const first = (await slots())[0]!;
    const { row } = await book(first.start);
    const event = eventOf(row.event_id!);
    const moved = new Date(Date.parse(first.start) + 2 * 3_600_000).toISOString();
    const movedEnd = new Date(Date.parse(moved) + 30 * 60_000).toISOString();
    event.start = { dateTime: moved, timeZone: 'America/Chicago' };
    event.end = { dateTime: movedEnd, timeZone: 'America/Chicago' };
    resetCalendarRangeCache();
    await slots(LATER);
    expect(await rowOf(row.id)).toMatchObject({
      status: 'booked',
      starts_at: moved,
      ends_at: movedEnd,
    });
  });

  it('leaves a booking alone while Google may not list it yet', async () => {
    const first = (await slots())[0]!;
    const { row } = await book(first.start);
    deleteInGoogle(row.event_id!);
    // A minute after it was made: not looked at, still booked.
    await slots(new Date(NOW.getTime() + 60_000));
    expect((await rowOf(row.id)).status).toBe('booked');
  });
});

describe('another tool’s reschedule link never stays on a booking event', () => {
  it('puts the booking’s own description back, told to nobody, once per change', async () => {
    const first = (await slots())[0]!;
    const { row, token, scheduled } = await book(first.start);
    expect(scheduled).toHaveLength(1);
    const own = eventOf(row.event_id!).description!;
    expect(own).toContain(
      `Need to reschedule or cancel? http://localhost:3000/meet/${SLUG}/b/${token}`,
    );

    // A few seconds later the other tool appends its line; the timed re-read takes it out.
    thirdPartyEdits(row.event_id!);
    expect(hasThirdPartyReschedule(eventOf(row.event_id!).description)).toBe(true);
    await scheduled[0]!();
    expect(patches()).toHaveLength(1);
    expect(patches()[0]).toMatchObject({ sendUpdates: 'none', eventId: row.event_id });
    expect(patches()[0]!.body).toEqual({ description: own });
    expect(eventOf(row.event_id!).description).toBe(own);
    expect(await rowOf(row.id)).toMatchObject({ description_cleaned_rev: 0 });
    expect((await rowOf(row.id)).description_cleaned_at).toBeTruthy();

    // It adds it again: Copilot does not take turns with it for the same change.
    thirdPartyEdits(row.event_id!);
    await scheduled[0]!();
    await slots(LATER);
    expect(patches()).toHaveLength(1);

    // A move is a change: one more clean-up, from the engine's normal read.
    const later = (await slots(LATER)).find(
      (s) => s.start.slice(0, 10) !== first.start.slice(0, 10),
    )!;
    const moved = await rescheduleByToken(harness.store, SLUG, token, later.start, {
      now: LATER,
      source: source(LATER),
      schedule: () => undefined,
    });
    expect(moved.ok).toBe(true);
    const afterMove = patches().length;
    thirdPartyEdits(
      row.event_id!,
      '\n\nReschedule: https://book.vimcal.com/r/fictional | Cancel: https://book.vimcal.com/c/fictional',
    );
    await slots(new Date(LATER.getTime() + 3_600_000));
    expect(patches()).toHaveLength(afterMove + 1);
    const restored = patches().at(-1)!;
    expect(restored.sendUpdates).toBe('none');
    expect(String(restored.body?.description)).not.toMatch(/vimcal|fyxer/);
    expect(String(restored.body?.description)).toContain(`/meet/${SLUG}/b/${token}`);
    expect(await rowOf(row.id)).toMatchObject({ description_cleaned_rev: 1 });
  });

  it('never touches an event that is not a booking’s', async () => {
    const list = state.events.get(MOCK_OWN_EMAIL) ?? [];
    list.push({
      id: 'planted-fyxer',
      status: 'confirmed',
      summary: 'Partner sync',
      description: `Agenda.${FYXER_LINE}`,
      start: { dateTime: '2026-10-28T15:00:00.000Z', timeZone: 'America/Chicago' },
      end: { dateTime: '2026-10-28T15:30:00.000Z', timeZone: 'America/Chicago' },
      organizer: { email: MOCK_OWN_EMAIL, self: true },
      attendees: [
        { email: MOCK_OWN_EMAIL, self: true, responseStatus: 'accepted' },
        { email: 'someone@other.example', responseStatus: 'accepted' },
      ],
    });
    state.events.set(MOCK_OWN_EMAIL, list);
    resetCalendarRangeCache();
    await slots(LATER);
    expect(state.writes).toEqual([]);
  });

  it('knows the lines Fyxer, Vimcal and Calendly add, and nothing else', () => {
    expect(hasThirdPartyReschedule(FYXER_LINE)).toBe(true);
    expect(hasThirdPartyReschedule('Reschedule: https://book.vimcal.com/r/x')).toBe(true);
    expect(hasThirdPartyReschedule('https://calendly.com/reschedulings/abc')).toBe(true);
    expect(hasThirdPartyReschedule('https://calendly.com/cancellations/abc')).toBe(true);
    expect(hasThirdPartyReschedule('Book me: https://calendly.com/someone')).toBe(false);
    expect(
      hasThirdPartyReschedule(
        'Need to reschedule or cancel? https://copilot.example/meet/nick/b/x',
      ),
    ).toBe(false);
    expect(hasThirdPartyReschedule(null)).toBe(false);
  });
});

describe('the month strip', () => {
  it('counts each month’s open times, and none in a month that is off', async () => {
    await setConfig({ openMonths: ['2026-12'] });
    const counts = await bookingMonthCounts(harness.store, harness.auth.organizationId, {
      now: NOW,
      source: source(),
    });
    expect(counts.ok).toBe(true);
    if (!counts.ok) return;
    expect(counts.value.months).toHaveLength(12);
    const by = Object.fromEntries(counts.value.months.map((m) => [m.month, m]));
    expect(by['2026-12']).toMatchObject({ open: true });
    expect(by['2026-12']!.times).toBeGreaterThan(0);
    expect(by['2026-10']).toEqual({ month: '2026-10', open: false, times: 0 });
    expect(by['2026-11']).toEqual({ month: '2026-11', open: false, times: 0 });
    // And the public page offers December only.
    const offered = await slots();
    expect(new Set(offered.map((s) => s.start.slice(0, 7)))).toEqual(new Set(['2026-12']));
    await setConfig({ openMonths: [] });
    expect(await slots()).toEqual([]);
  });
});
