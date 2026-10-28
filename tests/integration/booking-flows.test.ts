import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOOKING_REQUEST_INPUT, type BookingRequestInput } from '@/lib/booking/request';
import type { PublicSlot } from '@/lib/booking/public';
import {
  createMockCalendarState,
  MOCK_OWN_EMAIL,
  type MockCalendarState,
} from '@/lib/calendar/mock-calendar';
import { MockCalendarProvider } from '@/lib/calendar/provider';
import { resetCalendarRangeCache, type CalendarSource } from '@/lib/calendar/range-reader';
import { DEMO_BOOKING_SETTINGS_ID } from '@/lib/demo/booking-fixtures';
import { DEMO_TEAMMATE } from '@/lib/demo/fixtures';
import { CALENDAR_EDIT_SCOPES } from '@/lib/google/send-scopes';
import { resetLimiters } from '@/lib/security/limits';
import {
  approveBookingRequest,
  manageTokenHash,
  publicSlots,
  submitBookingRequest,
  type ActorContext,
} from '@/lib/services/booking';
import { bookingAlertItems } from '@/lib/services/booking-alerts';
import {
  cancelBookingFromCopilot,
  cancelByToken,
  listLinkBookings,
  loadManagePage,
  manageSlots,
  placeHeldBookings,
  releaseNoticeFor,
  rememberedBooking,
  rescheduleByToken,
} from '@/lib/services/booking-manage';
import { computeBookingAlerts } from '@/lib/services/push-alerts';
import type { AuditEvent, BookingRequest, Integration } from '@/lib/types/domain';
import { sha256 } from '@/lib/util/hash';
import { wallTimeToUtc } from '@/lib/util/time';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The booking link v2 (D-078) end to end, on the demo store and the mock
 * calendar, which records every write as Google would receive it: a free
 * time booked at once (exactly one event, the host as organizer, the visitor
 * and their guests invited, sendUpdates 'all'); two visitors racing for one
 * slot; a time held while calendar editing is off, placed once it is on, or
 * released when it was taken; the booking's own page moving the same event
 * and cancelling it with a note that alerts the host; the token kept only as
 * its hash; guests checked; approve first still working. Every person,
 * address and place is invented.
 */

const NOW = new Date('2026-10-26T15:00:00Z'); // Monday 10:00 Central
const TZ = 'America/Chicago';
const SLUG = 'nick';
const READ_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];
const EDIT = [...READ_SCOPES, ...CALENDAR_EDIT_SCOPES];

let harness: Harness;
let state: MockCalendarState;

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

function source(scopes: string[] = EDIT, now: Date = NOW): CalendarSource {
  return {
    provider: new MockCalendarProvider(now, state),
    integration: integration(scopes),
    ownEmails: [MOCK_OWN_EMAIL],
    demo: false,
  };
}

const deps = (scopes: string[] = EDIT, now: Date = NOW) => ({ now, source: source(scopes, now) });

function actor(): ActorContext {
  return {
    store: harness.store,
    organizationId: harness.auth.organizationId,
    userId: harness.auth.userId,
  };
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

async function slots(type = 'call', kind: string | null = null): Promise<PublicSlot[]> {
  const found = await publicSlots(harness.store, SLUG, { type, kind }, deps());
  expect(found.state).toBe('ok');
  return found.slots;
}

async function submit(over: Record<string, unknown>, scopes: string[] = EDIT, ipHash = 'hash-a') {
  return submitBookingRequest(harness.store, SLUG, request(over), {
    ipHash,
    now: NOW,
    source: source(scopes),
  });
}

/** A booking made at once: its row and its page's token. */
async function book(over: Record<string, unknown> = {}, scopes: string[] = EDIT) {
  const result = await submit(over, scopes);
  if (!result.ok || result.value.kind !== 'saved') throw new Error(JSON.stringify(result));
  const token = result.value.result.manageUrl!.split('/').pop()!;
  const row = (await harness.store.get(
    'booking_requests',
    harness.auth.organizationId,
    result.value.id,
  ))!;
  return { result: result.value.result, row, token };
}

async function rowOf(id: string): Promise<BookingRequest> {
  return (await harness.store.get('booking_requests', harness.auth.organizationId, id))!;
}

async function audits(action: string): Promise<AuditEvent[]> {
  return harness.store.list('audit_events', harness.auth.organizationId, { eq: { action } });
}

async function setConfig(patch: Record<string, unknown>) {
  const org = harness.auth.organizationId;
  const row = await harness.store.get('booking_settings', org, DEMO_BOOKING_SETTINGS_ID);
  await harness.store.update('booking_settings', org, DEMO_BOOKING_SETTINGS_ID, {
    settings: { ...(row!.settings as Record<string, unknown>), ...patch },
  });
}

/** Put a meeting on the host's main calendar, straight into the mock (as if made in Google). */
function busyAt(start: string, end: string) {
  const list = state.events.get(MOCK_OWN_EMAIL) ?? [];
  list.push({
    id: `planted${list.length}`,
    status: 'confirmed',
    summary: 'Planted meeting',
    start: { dateTime: start, timeZone: TZ },
    end: { dateTime: end, timeZone: TZ },
    organizer: { email: MOCK_OWN_EMAIL, self: true },
    attendees: [
      { email: MOCK_OWN_EMAIL, self: true, responseStatus: 'accepted' },
      { email: 'someone@other.example', responseStatus: 'accepted' },
    ],
  });
  state.events.set(MOCK_OWN_EMAIL, list);
  resetCalendarRangeCache();
}

const at = (day: string, h: number, m = 0) => wallTimeToUtc(day, h, m, TZ)!.toISOString();

beforeEach(async () => {
  harness = await createHarness({ now: NOW });
  resetCalendarRangeCache();
  resetLimiters();
  state = createMockCalendarState(NOW);
});

afterEach(async () => {
  await harness.dispose();
});

describe('instant booking (the default)', () => {
  it('creates exactly one event, the host as organizer, the visitor and guests invited, sendUpdates all', async () => {
    const [slot] = await slots();
    const { result, row, token } = await book({
      start: slot!.start,
      guests: ['Sam@Partner.example', 'sam@partner.example', 'kim@advisor.example'],
    });
    expect(result.status).toBe('booked');
    expect(result.manageUrl).toBe(`/meet/${SLUG}/b/${token}`);
    expect(state.writes).toHaveLength(1);
    const write = state.writes[0]!;
    expect(write).toMatchObject({ op: 'insert', calendarId: MOCK_OWN_EMAIL, sendUpdates: 'all' });
    expect(write.body?.attendees).toEqual([
      { email: MOCK_OWN_EMAIL, organizer: true, responseStatus: 'accepted' },
      { email: 'pat@acme.example' },
      { email: 'sam@partner.example' },
      { email: 'kim@advisor.example' },
    ]);
    expect(write.body?.start).toEqual({ dateTime: slot!.start, timeZone: TZ });
    // The booking's own page is in the description, and nothing else secret.
    expect(write.body?.description).toContain(
      `Need to reschedule or cancel? http://localhost:3000/meet/${SLUG}/b/${token}`,
    );
    expect(row).toMatchObject({
      status: 'booked',
      calendar_id: MOCK_OWN_EMAIL,
      event_id: expect.any(String),
      guest_emails: ['sam@partner.example', 'kim@advisor.example'],
      rescheduled_count: 0,
    });
    // The confirmation: when, what, who, never the call's link.
    expect(result.booking).toMatchObject({
      status: 'booked',
      type: 'call',
      startsAt: slot!.start,
      guests: ['sam@partner.example', 'kim@advisor.example'],
      video: { label: 'Google Meet', url: null },
      canReschedule: true,
      canCancel: true,
    });
    const [audit] = await audits('booking.booked');
    expect(audit?.metadata).toEqual({ type: 'call', kind: null, source: 'form', guests: 2 });
    expect(JSON.stringify(await audits('booking.booked'))).not.toMatch(/Pat|acme|partner|clinic/);
  });

  it('serializes two visitors racing for one slot: one booked, the other refused', async () => {
    const [slot] = await slots();
    const [a, b] = await Promise.all([
      submit({ start: slot!.start, email: 'first@one.example' }, EDIT, 'hash-1'),
      submit({ start: slot!.start, email: 'second@two.example' }, EDIT, 'hash-2'),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    const refused = outcomes.find((o) => !o.ok);
    expect(refused && !refused.ok && refused.error).toMatchObject({
      code: 'conflict',
      message: 'That time is no longer open. Pick another time.',
    });
    expect(state.writes.filter((w) => w.op === 'insert')).toHaveLength(1);
    // The taken time is off the list now; others remain to offer.
    const after = await slots();
    expect(after.some((s) => s.start === slot!.start)).toBe(false);
    expect(after.length).toBeGreaterThan(0);
  });

  it('never trusts the page: a time that is not open is refused and nothing is written', async () => {
    const friday = await submit({ start: at('2026-10-30', 10) });
    expect(friday.ok).toBe(false);
    const tooSoon = await submit({ start: at('2026-10-26', 15) });
    expect(tooSoon.ok).toBe(false);
    expect(state.writes).toEqual([]);
  });
});

describe('the token', () => {
  it('is kept only as its SHA-256: never in a row, an audit or the answer’s booking', async () => {
    const [slot] = await slots();
    const { row, token, result } = await book({ start: slot!.start });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row.manage_token_hash).toBe(sha256(token));
    expect(manageTokenHash(token)).toBe(row.manage_token_hash);
    const everything = JSON.stringify([
      await harness.store.list('booking_requests', harness.auth.organizationId, {}),
      await harness.store.list('audit_events', harness.auth.organizationId, {}),
      result.booking,
    ]);
    expect(everything).not.toContain(token);
    // A wrong or malformed token finds nothing.
    expect((await loadManagePage(harness.store, SLUG, 'x'.repeat(43), deps())).state).toBe(
      'not_found',
    );
    expect((await loadManagePage(harness.store, SLUG, 'short', deps())).state).toBe('not_found');
    expect((await loadManagePage(harness.store, 'other', token, deps())).state).toBe('not_found');
  });

  it('is what the device remembers: the booking page shows it while ahead', async () => {
    const [slot] = await slots();
    const { token } = await book({ start: slot!.start });
    expect(await rememberedBooking(harness.store, SLUG, token, NOW)).toEqual({
      manageUrl: `/meet/${SLUG}/b/${token}`,
      startsAt: slot!.start,
      type: 'call',
      kind: null,
      status: 'booked',
    });
    expect(await rememberedBooking(harness.store, SLUG, 'nope', NOW)).toBeNull();
  });
});

describe('guests', () => {
  it('refuses the host, a teammate, the booker and more than the link allows', async () => {
    const [slot] = await slots();
    for (const [guests, message] of [
      [[MOCK_OWN_EMAIL], `${MOCK_OWN_EMAIL} is on the host's side already. Leave them out.`],
      [
        [DEMO_TEAMMATE.email],
        `${DEMO_TEAMMATE.email} is on the host's side already. Leave them out.`,
      ],
      [['pat@acme.example'], 'You are invited already: add other people as guests.'],
      [['not-an-address'], 'Check the guest address not-an-address.'],
      [
        ['a@g.example', 'b@g.example', 'c@g.example', 'd@g.example', 'e@g.example', 'f@g.example'],
        'Add at most 5 guests.',
      ],
    ] as [string[], string][]) {
      const result = await submit({ start: slot!.start, guests });
      expect(result.ok, guests.join()).toBe(false);
      if (!result.ok) expect(result.error.message).toBe(message);
    }
    await setConfig({ allowGuests: false });
    const off = await submit({ start: slot!.start, guests: ['a@g.example'] });
    expect(!off.ok && off.error.message).toBe('This booking link does not take guests.');
    expect(state.writes).toEqual([]);
  });

  it('count toward the brakes: a guest already on three meetings is refused', async () => {
    const days = (await slots()).filter(
      (s, i, all) => all.findIndex((x) => x.start.slice(0, 10) === s.start.slice(0, 10)) === i,
    );
    await setConfig({ maxLinkBookingsPerDay: 10 });
    for (let i = 0; i < 3; i += 1) {
      resetLimiters();
      const made = await submit(
        { start: days[i]!.start, email: `booker${i}@x.example`, guests: ['busy@guest.example'] },
        EDIT,
        `hash-${i}`,
      );
      expect(made.ok, `booking ${i + 1}`).toBe(true);
    }
    resetLimiters();
    const fourth = await submit(
      { start: days[3]!.start, email: 'booker9@x.example', guests: ['busy@guest.example'] },
      EDIT,
      'hash-9',
    );
    expect(!fourth.ok && fourth.error).toMatchObject({
      code: 'rate_limited',
      message: 'busy@guest.example already has 3 meetings on this link. Leave them out this time.',
    });
  });
});

describe('held times (calendar editing off)', () => {
  it('is held, then placed exactly once when editing is turned on', async () => {
    const [slot] = await slots();
    const { result, row } = await book(
      { start: slot!.start, guests: ['kim@advisor.example'] },
      READ_SCOPES,
    );
    expect(result.status).toBe('held');
    expect(row.status).toBe('held');
    expect(state.writes).toEqual([]);
    // Still off: nothing placed.
    const waiting = await placeHeldBookings(harness.store, harness.auth.organizationId, {
      ...deps(READ_SCOPES),
      force: true,
    });
    expect(waiting).toEqual({ placed: 0, released: 0, waiting: 1 });
    // The held time keeps its slot for everyone else.
    expect((await slots()).some((s) => s.start === slot!.start)).toBe(false);
    // Editing on: placed once, re-checked, everyone invited.
    const placed = await placeHeldBookings(harness.store, harness.auth.organizationId, {
      ...deps(),
      force: true,
    });
    expect(placed).toMatchObject({ placed: 1, released: 0 });
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({ op: 'insert', sendUpdates: 'all' });
    expect(state.writes[0]!.body?.attendees).toEqual([
      { email: MOCK_OWN_EMAIL, organizer: true, responseStatus: 'accepted' },
      { email: 'pat@acme.example' },
      { email: 'kim@advisor.example' },
    ]);
    expect(await rowOf(row.id)).toMatchObject({ status: 'booked', event_id: expect.any(String) });
    // A second pass makes nothing more.
    await placeHeldBookings(harness.store, harness.auth.organizationId, { ...deps(), force: true });
    expect(state.writes).toHaveLength(1);
    expect(await audits('booking.hold_placed')).toHaveLength(1);
  });

  it('is released with a notice draft when its time was taken meanwhile', async () => {
    const [slot] = await slots();
    const { row } = await book({ start: slot!.start }, READ_SCOPES);
    busyAt(slot!.start, slot!.end);
    const outcome = await placeHeldBookings(harness.store, harness.auth.organizationId, {
      ...deps(),
      force: true,
    });
    expect(outcome).toMatchObject({ placed: 0, released: 1 });
    expect(state.writes).toEqual([]);
    const released = await rowOf(row.id);
    expect(released).toMatchObject({ status: 'declined', decided_by: null });
    const notice = await releaseNoticeFor(harness.store, harness.auth.organizationId, row.id);
    expect(notice.ok && notice.value).toMatchObject({
      to: 'pat@acme.example',
      subject: 'Your time with Nick',
    });
    expect(notice.ok && notice.value.body).toMatch(/was taken before the invitation could go out/);
    expect(notice.ok && notice.value.body).not.toMatch(/Arwin|confirm/i);
    const items = bookingAlertItems([released], NOW, TZ);
    expect(items.map((i) => i.kind)).toContain('released');
  });
});

describe('the booking’s own page', () => {
  it('shows when, where and who, and the call’s link to the token holder', async () => {
    const [slot] = await slots();
    const { token } = await book({ start: slot!.start, guests: ['kim@advisor.example'] });
    const page = await loadManagePage(harness.store, SLUG, token, deps());
    expect(page.state).toBe('ok');
    expect(page.host?.displayName).toBe('Nick Avery');
    expect(page.booking).toMatchObject({
      status: 'booked',
      startsAt: slot!.start,
      guests: ['kim@advisor.example'],
      email: 'pat@acme.example',
      video: { label: 'Google Meet', url: expect.stringMatching(/^https:\/\/meet\.google\.com\//) },
      canReschedule: true,
      canCancel: true,
      reschedulesLeft: 5,
      notice: null,
    });
  });

  it('reschedules by moving the SAME event (never a new one), within every rule', async () => {
    const all = await slots();
    const { row, token } = await book({ start: all[0]!.start });
    const eventId = row.event_id!;
    // The times next to it are offered, not its own.
    const open = await manageSlots(harness.store, SLUG, token, deps());
    expect(open?.state).toBe('ok');
    expect(open!.slots.some((s) => s.start === all[0]!.start)).toBe(false);
    expect(open!.slots.length).toBeGreaterThan(0);
    // A Friday, or a time under the notice, is refused.
    const friday = await rescheduleByToken(
      harness.store,
      SLUG,
      token,
      at('2026-10-30', 10),
      deps(),
    );
    expect(friday.ok).toBe(false);
    const soon = await rescheduleByToken(harness.store, SLUG, token, at('2026-10-27', 9), deps());
    expect(soon.ok).toBe(false);
    const target = open!.slots.at(-1)!;
    const moved = await rescheduleByToken(harness.store, SLUG, token, target.start, deps());
    expect(moved.ok).toBe(true);
    if (moved.ok) expect(moved.value).toMatchObject({ startsAt: target.start, reschedulesLeft: 4 });
    const writes = state.writes.filter((w) => w.op !== 'insert');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ op: 'patch', eventId, sendUpdates: 'all' });
    expect(writes[0]!.body?.start).toMatchObject({ dateTime: target.start });
    expect(state.writes.filter((w) => w.op === 'insert')).toHaveLength(1);
    expect(await rowOf(row.id)).toMatchObject({
      status: 'booked',
      event_id: eventId,
      starts_at: target.start,
      previous_starts_at: all[0]!.start,
      rescheduled_count: 1,
    });
    const items = bookingAlertItems([await rowOf(row.id)], NOW, TZ);
    expect(items.find((i) => i.kind === 'moved')?.line).toMatch(
      /^Pat Lee \(Acme\) moved a 30-minute call to /,
    );
  });

  it('allows at most five moves', async () => {
    const { row, token } = await book({ start: (await slots())[0]!.start });
    await harness.store.update('booking_requests', harness.auth.organizationId, row.id, {
      rescheduled_count: 5,
    });
    const open = await manageSlots(harness.store, SLUG, token, deps());
    const refused = await rescheduleByToken(
      harness.store,
      SLUG,
      token,
      open!.slots[0]!.start,
      deps(),
    );
    expect(!refused.ok && refused.error.message).toMatch(/moved 5 times already/);
    const page = await loadManagePage(harness.store, SLUG, token, deps());
    expect(page.booking).toMatchObject({
      canReschedule: false,
      canCancel: true,
      reschedulesLeft: 0,
    });
  });

  it('cancels by deleting the event with sendUpdates all, and the note reaches the host as an alert', async () => {
    const [slot] = await slots();
    const { row, token } = await book({ start: slot!.start });
    const cancelled = await cancelByToken(
      harness.store,
      SLUG,
      token,
      'Something came up, sorry!',
      deps(),
    );
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok)
      expect(cancelled.value).toMatchObject({ status: 'cancelled', canCancel: false });
    const deleted = state.writes.filter((w) => w.op === 'delete');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ eventId: row.event_id, sendUpdates: 'all' });
    const after = await rowOf(row.id);
    expect(after).toMatchObject({
      status: 'cancelled',
      cancel_note: 'Something came up, sorry!',
      cancelled_by: 'visitor',
      cancelled_at: NOW.toISOString(),
    });
    // The alert: one line, the host's clock, the note in quotes.
    const items = bookingAlertItems([after], NOW, TZ);
    const line = items.find((i) => i.kind === 'cancelled')!;
    expect(line.key).toBe(`booking:${row.id}:cancelled`);
    expect(line.line).toBe(
      'Pat Lee (Acme) cancelled Tue 27 Oct 10:00 AM: "Something came up, sorry!"',
    );
    const alerts = computeBookingAlerts(items, new Set(), NOW, TZ);
    expect(alerts).toEqual([
      expect.objectContaining({ tag: 'booking', url: '/booking', title: expect.any(String) }),
    ]);
    // Each change alerts once.
    expect(computeBookingAlerts(items, new Set(items.map((i) => i.key)), NOW, TZ)).toEqual([]);
    // Audited without the note.
    const [audit] = await audits('booking.cancelled');
    expect(audit?.metadata).toMatchObject({ by: 'visitor', note: true });
    expect(JSON.stringify(audit)).not.toContain('Something came up');
    // Once cancelled, nothing more.
    const again = await cancelByToken(harness.store, SLUG, token, '', deps());
    expect(!again.ok && again.error.message).toBe('This meeting was cancelled already.');
    expect(await rememberedBooking(harness.store, SLUG, token, NOW)).toBeNull();
  });

  it('cannot be changed once the meeting has started', async () => {
    const [slot] = await slots();
    const { token } = await book({ start: slot!.start });
    const later = new Date(Date.parse(slot!.start) + 60_000);
    const refused = await cancelByToken(harness.store, SLUG, token, '', deps(EDIT, later));
    expect(!refused.ok && refused.error.message).toMatch(/has started/);
  });

  it('shows the live state when the event was deleted or moved in Google meanwhile', async () => {
    const all = await slots();
    const first = await book({ start: all[0]!.start });
    // Deleted in Google Calendar: the page says so, and the row follows (no alert).
    state.events.set(
      MOCK_OWN_EMAIL,
      (state.events.get(MOCK_OWN_EMAIL) ?? []).filter((e) => e.id !== first.row.event_id),
    );
    const gone = await loadManagePage(harness.store, SLUG, first.token, deps());
    expect(gone.booking).toMatchObject({
      status: 'cancelled',
      notice: 'This meeting was cancelled.',
    });
    const row = await rowOf(first.row.id);
    expect(row).toMatchObject({ status: 'cancelled', cancelled_by: 'calendar' });
    expect(bookingAlertItems([row], NOW, TZ).some((i) => i.kind === 'cancelled')).toBe(false);

    // Moved in Google Calendar: the page shows the new time.
    resetLimiters();
    const second = await book({ start: all.at(-1)!.start, email: 'two@b.example' });
    const event = (state.events.get(MOCK_OWN_EMAIL) ?? []).find(
      (e) => e.id === second.row.event_id,
    )!;
    const newStart = new Date(Date.parse(all.at(-1)!.start) - 60 * 60_000).toISOString();
    const newEnd = new Date(Date.parse(newStart) + 30 * 60_000).toISOString();
    event.start = { dateTime: newStart, timeZone: TZ };
    event.end = { dateTime: newEnd, timeZone: TZ };
    const moved = await loadManagePage(harness.store, SLUG, second.token, deps());
    expect(moved.booking).toMatchObject({
      status: 'booked',
      startsAt: newStart,
      notice: 'The time of this meeting changed in the calendar.',
    });
    expect((await rowOf(second.row.id)).starts_at).toBe(newStart);
  });

  it('moves and releases a held time without touching the calendar', async () => {
    const all = await slots();
    const { row, token } = await book({ start: all[0]!.start }, READ_SCOPES);
    const open = await manageSlots(harness.store, SLUG, token, deps(READ_SCOPES));
    const moved = await rescheduleByToken(
      harness.store,
      SLUG,
      token,
      open!.slots[0]!.start,
      deps(READ_SCOPES),
    );
    expect(moved.ok && moved.value.status).toBe('held');
    const cancelled = await cancelByToken(harness.store, SLUG, token, '', deps(READ_SCOPES));
    expect(cancelled.ok && cancelled.value.status).toBe('cancelled');
    expect(state.writes).toEqual([]);
    expect((await rowOf(row.id)).status).toBe('cancelled');
  });
});

describe('the Booking tab', () => {
  it('lists upcoming bookings, past ones and messages in the shared shape', async () => {
    const [slot] = await slots();
    const { row } = await book({ start: slot!.start, guests: ['kim@advisor.example'] });
    const upcoming = await listLinkBookings(
      harness.store,
      harness.auth.organizationId,
      'upcoming',
      deps(),
    );
    const mine = upcoming.bookings.find((b) => b.id === row.id)!;
    expect(mine).toEqual({
      id: row.id,
      status: 'booked',
      type: 'call',
      kind: null,
      startsAt: slot!.start,
      endsAt: slot!.end,
      name: 'Pat Lee',
      email: 'pat@acme.example',
      company: 'Acme',
      guests: ['kim@advisor.example'],
      placeName: null,
      placeArea: null,
      note: 'Seed round for a clinic scheduling tool.',
      deckUrl: null,
      cancelNote: null,
      source: 'form',
      createdAt: NOW.toISOString(),
      rescheduledCount: 0,
      eventLink: expect.stringMatching(/^https:\/\/www\.google\.com\/calendar\/event\?eid=/),
      visitorTimeZone: 'America/New_York',
      cancelledBy: null,
      holdReason: null,
      nextTryAt: null,
    });
    expect(JSON.stringify(upcoming)).not.toMatch(/manage_token|ip_hash|hash-a/);
    expect(upcoming.calendarEditing).toBe(true);
    const messages = await listLinkBookings(
      harness.store,
      harness.auth.organizationId,
      'messages',
      deps(),
    );
    expect(messages.bookings.every((b) => b.type === 'message')).toBe(true);
    expect(messages.bookings.length).toBeGreaterThan(0);
  });

  it('cancels from Kraken as the team: the event deleted, no visitor alert', async () => {
    const [slot] = await slots();
    const { row } = await book({ start: slot!.start });
    const done = await cancelBookingFromCopilot(actor(), row.id, 'Travel came up.', deps());
    expect(done.ok).toBe(true);
    expect(state.writes.filter((w) => w.op === 'delete')[0]).toMatchObject({ sendUpdates: 'all' });
    const after = await rowOf(row.id);
    expect(after).toMatchObject({
      status: 'cancelled',
      cancelled_by: 'team',
      decided_by: harness.auth.userId,
    });
    expect(bookingAlertItems([after], NOW, TZ).some((i) => i.kind === 'cancelled')).toBe(false);
  });
});

describe('approve first (the option)', () => {
  it('still waits as a request, and Approve invites the visitor and their guests', async () => {
    await setConfig({ approveFirst: true });
    const [slot] = await slots();
    const { result, row } = await book({ start: slot!.start, guests: ['kim@advisor.example'] });
    expect(result.status).toBe('pending');
    expect(result.manageUrl).toMatch(/^\/meet\/nick\/b\//);
    expect(row.status).toBe('pending');
    expect(state.writes).toEqual([]);
    const approved = await approveBookingRequest(actor(), row.id, deps());
    expect(approved.ok && approved.value.state).toBe('approved');
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]!.body?.attendees).toEqual([
      { email: MOCK_OWN_EMAIL, organizer: true, responseStatus: 'accepted' },
      { email: 'pat@acme.example' },
      { email: 'kim@advisor.example' },
    ]);
  });
});

describe('before the v2 migration is run', () => {
  /** The store as it is before 20261022200000_booking_v2.sql: no v2 columns. */
  function withoutV2Columns() {
    const insert = harness.store.insert.bind(harness.store);
    harness.store.insert = (async (table: string, row: Record<string, unknown>) => {
      if (table === 'booking_requests' && 'manage_token_hash' in row) {
        throw Object.assign(new Error("Could not find the 'guest_emails' column"), {
          code: 'PGRST204',
        });
      }
      return insert(table as never, row as never);
    }) as typeof harness.store.insert;
  }

  it('still books a free time at once (kept as approved), with no page to manage', async () => {
    const [slot] = await slots();
    withoutV2Columns();
    const result = await submit({ start: slot!.start });
    expect(result.ok && result.value.kind === 'saved' && result.value.result.status).toBe('booked');
    if (result.ok) expect(result.value.result.manageUrl).toBeNull();
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]!.sendUpdates).toBe('all');
    const rows = await harness.store.list('booking_requests', harness.auth.organizationId, {
      eq: { email: 'pat@acme.example' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'approved', decided_by: null });
    expect(rows[0]!.event_id).toBeTruthy();
    expect('manage_token_hash' in rows[0]!).toBe(false);
    expect(await audits('booking.v2_missing')).toHaveLength(1);
  });

  it('without calendar editing it can only wait as a request', async () => {
    const [slot] = await slots();
    withoutV2Columns();
    const result = await submit({ start: slot!.start }, READ_SCOPES);
    expect(result.ok && result.value.kind === 'saved' && result.value.result).toEqual({
      status: 'pending',
      manageUrl: null,
      booking: null,
    });
    expect(state.writes).toEqual([]);
    const rows = await harness.store.list('booking_requests', harness.auth.organizationId, {
      eq: { email: 'pat@acme.example' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending' });
  });

  it('reads only the old status check as not migrated: any other check fails loudly', async () => {
    const [slot] = await slots();
    const insert = harness.store.insert.bind(harness.store);
    harness.store.insert = (async (table: string, row: Record<string, unknown>) => {
      if (table === 'booking_requests') {
        throw Object.assign(
          new Error(
            'new row for relation "booking_requests" violates check constraint "booking_requests_guests_allowed"',
          ),
          { code: '23514' },
        );
      }
      return insert(table as never, row as never);
    }) as typeof harness.store.insert;
    await expect(submit({ start: slot!.start })).rejects.toThrow(/booking_requests_guests_allowed/);
    expect(state.writes).toEqual([]);
  });
});
