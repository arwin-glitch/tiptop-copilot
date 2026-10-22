import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdNextTryAt, holdRetryDelayMs, HOLD_RETRY_MINUTES } from '@/lib/booking/holds';
import { BOOKING_REQUEST_INPUT, type BookingRequestInput } from '@/lib/booking/request';
import type { PublicSlot } from '@/lib/booking/public';
import {
  createMockCalendarState,
  MOCK_OWN_EMAIL,
  type MockCalendarState,
} from '@/lib/calendar/mock-calendar';
import { MockCalendarProvider } from '@/lib/calendar/provider';
import { resetCalendarRangeCache, type CalendarSource } from '@/lib/calendar/range-reader';
import { CALENDAR_EDIT_SCOPES } from '@/lib/google/send-scopes';
import { resetLimiters } from '@/lib/security/limits';
import {
  listPendingBookingRequests,
  publicSlots,
  submitBookingRequest,
} from '@/lib/services/booking';
import { bookingAlertItems } from '@/lib/services/booking-alerts';
import {
  cancelByToken,
  listLinkBookings,
  placeHeldBookings,
  releaseNoticeFor,
  retryHeldBooking,
} from '@/lib/services/booking-manage';
import type { Scheduler } from '@/lib/services/booking-sync';
import type { AuditEvent, BookingRequest, Integration } from '@/lib/types/domain';
import { err } from '@/lib/util/result';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Arwin's rule for instant booking (D-078): a visitor's booking never waits
 * for a person. When it cannot be written at once (calendar editing off,
 * Google down or refusing) its time is HELD, blocked for everyone else, and
 * Copilot books it by itself: at once when editing comes on, and after a
 * Google fault on a backoff of 1, 5, 15 and 60 minutes, then on every pass.
 * Only a time that is truly no longer free releases it (with a notice draft
 * for a person to send). Never two events, never an Approve. Every person
 * and address is invented.
 */

const NOW = new Date('2026-10-26T15:00:00Z'); // Monday 10:00 Central
const TZ = 'America/Chicago';
const SLUG = 'nick';
const READ_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];
const EDIT = [...READ_SCOPES, ...CALENDAR_EDIT_SCOPES];
const MINUTE = 60_000;

let harness: Harness;
let state: MockCalendarState;
/** Every in-process retry the code timed, captured instead of run. */
let timed: { delayMs: number; work: () => Promise<unknown> }[];
const schedule: Scheduler = (work, delayMs) => {
  timed.push({ work, delayMs });
};

function integration(scopes: string[]): Integration {
  return {
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
}

function source(
  scopes: string[] = EDIT,
  now: Date = NOW,
  provider: MockCalendarProvider = new MockCalendarProvider(now, state),
): CalendarSource {
  return { provider, integration: integration(scopes), ownEmails: [MOCK_OWN_EMAIL], demo: false };
}

/** Google answering 500 (provider_unavailable) the first `times` inserts, making nothing. */
function failingInserts(times: number, now: Date = NOW) {
  let left = times;
  class Down extends MockCalendarProvider {
    override async insertEvent(...args: Parameters<MockCalendarProvider['insertEvent']>) {
      if (left > 0) {
        left -= 1;
        return err('provider_unavailable', 'Google answered 500.');
      }
      return super.insertEvent(...args);
    }
  }
  return new Down(now, state);
}

/** Google making the event, then the answer lost (a timeout), the first `times` inserts. */
function lostAnswers(times: number, now: Date = NOW) {
  let left = times;
  class Lossy extends MockCalendarProvider {
    override async insertEvent(...args: Parameters<MockCalendarProvider['insertEvent']>) {
      const made = await super.insertEvent(...args);
      if (left > 0) {
        left -= 1;
        return err('timeout', 'Google took too long.');
      }
      return made;
    }
  }
  return new Lossy(now, state);
}

function request(over: Record<string, unknown>): BookingRequestInput {
  return BOOKING_REQUEST_INPUT.parse({
    name: 'Pat Lee',
    email: 'pat@acme.example',
    company: 'Acme',
    type: 'call',
    note: 'Seed round for a clinic scheduling tool.',
    timeZone: 'America/New_York',
    ...over,
  });
}

async function slots(): Promise<PublicSlot[]> {
  const found = await publicSlots(
    harness.store,
    SLUG,
    { type: 'call', kind: null },
    { now: NOW, source: source() },
  );
  expect(found.state).toBe('ok');
  return found.slots;
}

async function book(over: Record<string, unknown>, src: CalendarSource) {
  const result = await submitBookingRequest(harness.store, SLUG, request(over), {
    ipHash: 'hash-a',
    now: NOW,
    source: src,
    schedule,
  });
  if (!result.ok || result.value.kind !== 'saved') throw new Error(JSON.stringify(result));
  const token = result.value.result.manageUrl!.split('/').pop()!;
  return { result: result.value.result, id: result.value.id, token };
}

const inserts = () => state.writes.filter((w) => w.op === 'insert');

async function rowOf(id: string): Promise<BookingRequest> {
  return (await harness.store.get('booking_requests', harness.auth.organizationId, id))!;
}

async function audits(action: string): Promise<AuditEvent[]> {
  return harness.store.list('audit_events', harness.auth.organizationId, { eq: { action } });
}

/** A pass of the job (or a visit) at `now` with this calendar. */
function pass(now: Date, src: CalendarSource, extra: { force?: boolean; onlyId?: string } = {}) {
  return placeHeldBookings(harness.store, harness.auth.organizationId, {
    now,
    source: src,
    schedule,
    force: true,
    ...extra,
  });
}

/** Nothing an Approve would show or do: no request waiting, no approval recorded. */
async function expectNoApproval() {
  // (The demo store seeds two approve-first requests of its own: ours are never among them.)
  const waiting = await listPendingBookingRequests(harness.store, harness.auth.organizationId);
  expect(waiting.requests.filter((r) => r.email === 'pat@acme.example')).toEqual([]);
  expect(await audits('booking.approved')).toEqual([]);
}

beforeEach(async () => {
  harness = await createHarness({ now: NOW });
  resetCalendarRangeCache();
  resetLimiters();
  state = createMockCalendarState(NOW);
  timed = [];
});

afterEach(async () => {
  await harness.dispose();
});

describe('the backoff', () => {
  it('waits 1, 5, 15 and 60 minutes after each failed try, then tries on every pass', () => {
    expect(HOLD_RETRY_MINUTES).toEqual([1, 5, 15, 60]);
    expect([1, 2, 3, 4, 5, 9].map(holdRetryDelayMs)).toEqual([
      MINUTE,
      5 * MINUTE,
      15 * MINUTE,
      60 * MINUTE,
      0,
      0,
    ]);
    expect(holdNextTryAt(1, NOW)).toBe(new Date(NOW.getTime() + MINUTE).toISOString());
    expect(holdNextTryAt(5, NOW)).toBeNull();
  });
});

describe('a booking that cannot be written at once is held, never left for Approve', () => {
  it('grant missing: held, then booked once the grant appears, with no Approve anywhere', async () => {
    const [slot] = await slots();
    const { result, id, token } = await book({ start: slot!.start }, source(READ_SCOPES));
    expect(result.status).toBe('held');
    expect(result.booking?.status).toBe('held');
    expect(await rowOf(id)).toMatchObject({
      status: 'held',
      hold_reason: 'calendar_editing_off',
      hold_attempts: 0,
      claimed_at: null,
    });
    expect(inserts()).toEqual([]);
    await expectNoApproval();
    // Its time stays blocked for every other visitor meanwhile.
    expect((await slots()).some((s) => s.start === slot!.start)).toBe(false);
    // The Booking tab shows it as booking itself, with why, never as waiting for approval.
    const listed = await listLinkBookings(harness.store, harness.auth.organizationId, 'upcoming', {
      now: NOW,
      source: source(READ_SCOPES),
    });
    expect(listed.bookings.find((b) => b.id === id)).toMatchObject({
      status: 'held',
      holdReason: 'calendar_editing_off',
    });
    expect(listed.calendarEditing).toBe(false);

    // A pass while editing is still off changes nothing.
    expect(await pass(new Date(NOW.getTime() + MINUTE), source(READ_SCOPES))).toEqual({
      placed: 0,
      released: 0,
      waiting: 1,
    });
    expect(inserts()).toEqual([]);

    // Editing comes on: the next pass books it, exactly once.
    const later = new Date(NOW.getTime() + 2 * MINUTE);
    expect(await pass(later, source(EDIT, later))).toEqual({ placed: 1, released: 0, waiting: 0 });
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]).toMatchObject({ calendarId: MOCK_OWN_EMAIL, sendUpdates: 'all' });
    expect(await rowOf(id)).toMatchObject({
      status: 'booked',
      calendar_id: MOCK_OWN_EMAIL,
      event_id: expect.any(String),
      hold_reason: null,
      hold_next_try_at: null,
      claimed_at: null,
    });
    // Another pass makes no second event.
    expect(await pass(new Date(later.getTime() + MINUTE), source(EDIT, later))).toEqual({
      placed: 0,
      released: 0,
      waiting: 0,
    });
    expect(inserts()).toHaveLength(1);
    await expectNoApproval();
    expect(await audits('booking.hold_placed')).toHaveLength(1);
    // The visitor can still cancel it from its page, and the event goes.
    const cancelled = await cancelByToken(harness.store, SLUG, token, '', {
      now: later,
      source: source(EDIT, later),
    });
    expect(cancelled.ok && cancelled.value.status).toBe('cancelled');
    expect(state.writes.filter((w) => w.op === 'delete')).toHaveLength(1);
  });

  it('Google 500, then OK: held with a 1-minute backoff, then booked on the retry', async () => {
    const [slot] = await slots();
    const { result, id } = await book({ start: slot!.start }, source(EDIT, NOW, failingInserts(1)));
    // The visitor sees the neutral held copy; nothing waits for a person.
    expect(result.status).toBe('held');
    expect(inserts()).toEqual([]);
    expect(await rowOf(id)).toMatchObject({
      status: 'held',
      hold_reason: 'calendar_unreachable',
      hold_attempts: 1,
      hold_next_try_at: new Date(NOW.getTime() + MINUTE).toISOString(),
      // Google answered 500: in doubt, so the retry looks for an event first.
      claimed_at: NOW.toISOString(),
    });
    await expectNoApproval();
    // The next try is timed in this process for when its backoff ends.
    expect(timed.map((t) => t.delayMs)).toContain(MINUTE);

    // Thirty seconds on, the backoff is not over: no try at all.
    const early = new Date(NOW.getTime() + 30_000);
    expect(await pass(early, source(EDIT, early))).toEqual({ placed: 0, released: 0, waiting: 1 });
    expect(inserts()).toEqual([]);

    // A minute on: booked, once.
    const due = new Date(NOW.getTime() + MINUTE + 1_000);
    expect(await pass(due, source(EDIT, due))).toEqual({ placed: 1, released: 0, waiting: 0 });
    expect(inserts()).toHaveLength(1);
    expect((await rowOf(id)).status).toBe('booked');
    await expectNoApproval();
  });

  it('keeps backing off (1, 5, 15, 60 minutes) while Google stays down, then tries every pass', async () => {
    const [slot] = await slots();
    const down = failingInserts(99);
    const { id } = await book({ start: slot!.start }, source(EDIT, NOW, down));
    let at = NOW.getTime();
    for (const minutes of [1, 5, 15, 60]) {
      expect((await rowOf(id)).hold_next_try_at).toBe(
        new Date(at + minutes * MINUTE).toISOString(),
      );
      at += minutes * MINUTE;
      const when = new Date(at);
      await pass(when, source(EDIT, when, down));
    }
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: 'held', hold_attempts: 5, hold_next_try_at: null });
    expect(inserts()).toEqual([]);
    // From now on every pass tries; once Google answers, it is booked.
    const next = new Date(at + 1_000);
    const healthy = source(EDIT, next);
    expect(await pass(next, healthy)).toEqual({ placed: 1, released: 0, waiting: 0 });
    expect(inserts()).toHaveLength(1);
  });

  it('a time taken meanwhile is released, with a notice draft for a person to send', async () => {
    const [slot] = await slots();
    const { id } = await book({ start: slot!.start }, source(READ_SCOPES));
    // Someone put a meeting there in Google before editing came on.
    const list = state.events.get(MOCK_OWN_EMAIL) ?? [];
    list.push({
      id: 'plantedclash',
      status: 'confirmed',
      summary: 'Planted meeting',
      start: { dateTime: slot!.start, timeZone: TZ },
      end: { dateTime: slot!.end, timeZone: TZ },
      organizer: { email: MOCK_OWN_EMAIL, self: true },
      attendees: [
        { email: MOCK_OWN_EMAIL, self: true, responseStatus: 'accepted' },
        { email: 'someone@other.example', responseStatus: 'accepted' },
      ],
    });
    state.events.set(MOCK_OWN_EMAIL, list);
    resetCalendarRangeCache();
    const later = new Date(NOW.getTime() + 2 * MINUTE);
    expect(await pass(later, source(EDIT, later))).toEqual({ placed: 0, released: 1, waiting: 0 });
    expect(inserts()).toEqual([]);
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: 'declined', decided_by: null });
    const notice = await releaseNoticeFor(harness.store, harness.auth.organizationId, id);
    expect(notice.ok && notice.value.to).toBe('pat@acme.example');
    expect(notice.ok && notice.value.body).toMatch(/was taken before the invitation could go out/);
    expect(bookingAlertItems([row], later, TZ).map((i) => i.kind)).toContain('released');
    await expectNoApproval();
  });

  it('never two events: an answer lost when booked at once is found on the next try', async () => {
    const [slot] = await slots();
    const { result, id } = await book({ start: slot!.start }, source(EDIT, NOW, lostAnswers(1)));
    expect(result.status).toBe('held');
    // Google did make it.
    expect(inserts()).toHaveLength(1);
    expect((await rowOf(id)).claimed_at).toBe(NOW.toISOString());
    const due = new Date(NOW.getTime() + 2 * MINUTE);
    expect(await pass(due, source(EDIT, due))).toEqual({ placed: 1, released: 0, waiting: 0 });
    // Found by its page link: still one event, now on the booking.
    expect(inserts()).toHaveLength(1);
    const row = await rowOf(id);
    expect(row.status).toBe('booked');
    expect(state.events.get(MOCK_OWN_EMAIL)!.some((e) => e.id === row.event_id)).toBe(true);
  });

  it('never two events: an answer lost while a hold is placed is found by its invitation', async () => {
    const [slot] = await slots();
    const { id } = await book({ start: slot!.start }, source(READ_SCOPES));
    const first = new Date(NOW.getTime() + MINUTE);
    // Editing comes on, Google makes the event but its answer is lost.
    expect(await pass(first, source(EDIT, first, lostAnswers(1, first)))).toMatchObject({
      placed: 0,
      waiting: 1,
    });
    expect(inserts()).toHaveLength(1);
    expect(await rowOf(id)).toMatchObject({
      status: 'held',
      hold_reason: 'calendar_unreachable',
      claimed_at: first.toISOString(),
    });
    const second = new Date(first.getTime() + 2 * MINUTE);
    expect(await pass(second, source(EDIT, second))).toEqual({
      placed: 1,
      released: 0,
      waiting: 0,
    });
    expect(inserts()).toHaveLength(1);
    expect((await rowOf(id)).status).toBe('booked');
  });

  it('a hold in doubt cancelled by the visitor takes the event Google made with it', async () => {
    const [slot] = await slots();
    const { id, token } = await book({ start: slot!.start }, source(EDIT, NOW, lostAnswers(1)));
    expect(inserts()).toHaveLength(1);
    const cancelled = await cancelByToken(harness.store, SLUG, token, '', {
      now: NOW,
      source: source(),
    });
    expect(cancelled.ok && cancelled.value.status).toBe('cancelled');
    expect(state.writes.filter((w) => w.op === 'delete')).toHaveLength(1);
    expect((await rowOf(id)).status).toBe('cancelled');
  });

  it('"Try now" tries at once, past the backoff, and says what it came to', async () => {
    const [slot] = await slots();
    const { id } = await book({ start: slot!.start }, source(EDIT, NOW, failingInserts(1)));
    const soon = new Date(NOW.getTime() + 5_000);
    const tried = await retryHeldBooking(harness.store, harness.auth.organizationId, id, {
      now: soon,
      source: source(EDIT, soon),
    });
    expect(tried).toEqual({ ok: true, value: { status: 'booked', holdReason: null } });
    expect(inserts()).toHaveLength(1);
    // A booking that is not held is only reported.
    const again = await retryHeldBooking(harness.store, harness.auth.organizationId, id, {
      now: soon,
      source: source(EDIT, soon),
    });
    expect(again).toEqual({ ok: true, value: { status: 'booked', holdReason: null } });
    expect(inserts()).toHaveLength(1);
  });

  it('times one retry per failed try, and none while it only waits for calendar editing', async () => {
    const all = await slots();
    const first = all[0]!;
    const second = all.find((s) => s.start.slice(0, 10) !== first.start.slice(0, 10))!;
    await book({ start: first.start }, source(READ_SCOPES));
    expect(timed).toEqual([]);
    await book(
      { start: second.start, email: 'kim@advisor.example' },
      source(EDIT, NOW, failingInserts(1)),
    );
    expect(timed.map((t) => t.delayMs)).toEqual([MINUTE]);
  });
});
