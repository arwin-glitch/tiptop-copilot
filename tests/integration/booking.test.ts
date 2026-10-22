import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BOOKING_CONFIG, parseBookingConfig } from '@/lib/booking/config';
import { WAITING_CLASH } from '@/lib/booking/engine';
import { CLOSED_MESSAGE, dayKeyIn, type PublicSlot } from '@/lib/booking/public';
import { BOOKING_REQUEST_INPUT, type BookingRequestInput } from '@/lib/booking/request';
import {
  createMockCalendarState,
  MOCK_OWN_EMAIL,
  MOCK_PERSONAL_CALENDAR,
  type MockCalendarState,
} from '@/lib/calendar/mock-calendar';
import { MockCalendarProvider } from '@/lib/calendar/provider';
import { resetCalendarRangeCache, type CalendarSource } from '@/lib/calendar/range-reader';
import type { DataStore } from '@/lib/db/store';
import { DEMO_BOOKING_SETTINGS_ID } from '@/lib/demo/booking-fixtures';
import { DEMO_TEAMMATE } from '@/lib/demo/fixtures';
import { CALENDAR_EDIT_SCOPES } from '@/lib/google/send-scopes';
import { resetLimiters } from '@/lib/security/limits';
import { saveCalendarPrefs } from '@/lib/services/calendar-prefs';
import {
  approveBookingRequest,
  BOOKING_NOT_SET_UP,
  BUSY_LINK_MESSAGE,
  MAX_OPEN_PER_ADDRESS,
  readHost,
  countPendingBookingRequests,
  listPendingBookingRequests,
  markBookingRequest,
  publicBookingPage,
  publicSlots,
  readBookingSettings,
  saveBookingSettings,
  submitBookingRequest,
  type ActorContext,
} from '@/lib/services/booking';
import type { AuditEvent, BookingRequest, Integration } from '@/lib/types/domain';
import { err } from '@/lib/util/result';
import { localClock, wallTimeToUtc } from '@/lib/util/time';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The booking link end to end (D-074), on the demo store and the mock
 * calendar, which records every write as Google would receive it. A
 * visitor's request is only ever a pending row; Approve re-checks the time
 * against the live calendar and the rules and only then creates the event on
 * the host's main calendar through the write module, inviting the requester
 * (sendUpdates 'all'); without calendar editing it hands back a filled-in
 * Google Calendar link instead. The off switch and a missing migration both
 * close the page. Every person, address and place is invented.
 */

const NOW = new Date('2026-10-26T15:00:00Z'); // Monday 10:00 Central
const TZ = 'America/Chicago';
const SLUG = 'nick';
const READ_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];

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

function source(scopes: string[] = [...READ_SCOPES, ...CALENDAR_EDIT_SCOPES]): CalendarSource {
  return {
    provider: new MockCalendarProvider(NOW, state),
    integration: integration(scopes),
    ownEmails: [MOCK_OWN_EMAIL],
    demo: false,
  };
}

const deps = (scopes?: string[]) => ({ now: NOW, source: source(scopes) });

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
    deckUrl: 'https://deck.example/acme',
    timeZone: 'America/New_York',
    ...over,
  });
}

async function slots(type: string, kind: string | null = null): Promise<PublicSlot[]> {
  const found = await publicSlots(harness.store, SLUG, { type, kind }, deps());
  expect(found.state).toBe('ok');
  return found.slots;
}

async function submit(over: Record<string, unknown>) {
  return submitBookingRequest(harness.store, SLUG, request(over), {
    ipHash: 'hash-of-an-address',
    now: NOW,
    source: source(),
  });
}

async function saved(over: Record<string, unknown>): Promise<BookingRequest> {
  const result = await submit(over);
  if (!result.ok || result.value.kind !== 'saved') throw new Error(JSON.stringify(result));
  return (await harness.store.get(
    'booking_requests',
    harness.auth.organizationId,
    result.value.id,
  ))!;
}

async function audits(action: string): Promise<AuditEvent[]> {
  return harness.store.list('audit_events', harness.auth.organizationId, { eq: { action } });
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

describe('a visitor’s request', () => {
  it('is kept as pending, and nothing reaches the calendar or a mailbox', async () => {
    const [slot] = await slots('call');
    const row = await saved({ start: slot!.start });
    expect(row).toMatchObject({
      status: 'pending',
      meeting_type: 'call',
      kind: null,
      starts_at: slot!.start,
      ends_at: slot!.end,
      name: 'Pat Lee',
      email: 'pat@acme.example',
      company: 'Acme',
      deck_url: 'https://deck.example/acme',
      visitor_time_zone: 'America/New_York',
      source: 'form',
      ip_hash: 'hash-of-an-address',
      event_id: null,
    });
    expect(state.writes).toEqual([]);
    // Audited by ids and kinds only: never the visitor's name, address or note.
    const [audit] = await audits('booking.requested');
    expect(audit?.metadata).toEqual({ type: 'call', kind: null, source: 'form' });
    expect(JSON.stringify(audit)).not.toMatch(/Pat|acme|clinic/);
  });

  it('refuses a time that is no longer open, or that the page never offered', async () => {
    const busyStart = at('2026-10-27', 13, 30); // inside Tuesday's board meeting
    const busy = await submit({ start: busyStart });
    expect(busy.ok).toBe(false);
    if (!busy.ok) {
      expect(busy.error.code).toBe('conflict');
      expect(busy.error.message).toBe('That time is no longer open. Pick another time.');
    }
    const friday = await submit({ start: at('2026-10-30', 10) });
    expect(friday.ok).toBe(false);
    const late = await submit({ start: at('2026-10-28', 18) });
    expect(late.ok).toBe(false);
    expect(
      await harness.store.count('booking_requests', harness.auth.organizationId, {
        eq: { email: 'pat@acme.example' },
      }),
    ).toBe(0);
  });

  it('takes an in-person coffee at a listed place, or a suggested one', async () => {
    const [slot] = await slots('in_person', 'coffee');
    const listed = await saved({
      type: 'in_person',
      kind: 'coffee',
      start: slot!.start,
      placeId: 'juniper-rye',
    });
    expect(listed).toMatchObject({
      meeting_type: 'in_person',
      kind: 'coffee',
      place_id: 'juniper-rye',
      place_name: 'Juniper & Rye Coffee',
      place_area: 'Riverside',
      place_map_url: 'https://maps.example/juniper-rye',
      place_custom: false,
    });
    expect(Date.parse(listed.ends_at!) - Date.parse(listed.starts_at!)).toBe(3_600_000);
    const [, second] = await slots('in_person', 'lunch');
    const custom = await saved({
      email: 'lee@other.example',
      type: 'in_person',
      kind: 'lunch',
      start: second!.start,
      customPlace: 'Corner Deli, Riverside',
    });
    expect(custom).toMatchObject({
      place_id: null,
      place_name: 'Corner Deli, Riverside',
      place_custom: true,
    });
    const unknown = await submit({
      email: 'x@y.example',
      type: 'in_person',
      kind: 'coffee',
      start: slot!.start,
      placeId: 'nowhere',
    });
    expect(unknown.ok).toBe(false);
  });

  it('never offers in person on a travel day, but offers calls', async () => {
    // Tuesday's board meeting and Wednesday's mixer are in another city.
    const coffee = await slots('in_person', 'coffee');
    expect(
      coffee.some((s) => s.start.startsWith('2026-10-27') || s.start.startsWith('2026-10-28')),
    ).toBe(false);
    const calls = await slots('call');
    expect(calls.some((s) => s.start.startsWith('2026-10-28'))).toBe(true);
  });

  it('counts every instance of a recurring entry as busy', async () => {
    const before = (await slots('call')).map((s) => s.start);
    expect(before).toContain(at('2026-11-10', 12));
    // Tuesdays 12:00-13:00 from 27 October, four times.
    state.series.set(MOCK_PERSONAL_CALENDAR, [
      {
        master: {
          id: 'testweeklylunch',
          status: 'confirmed',
          eventType: 'default',
          summary: 'Weekly lunch block',
          start: { dateTime: at('2026-10-27', 12), timeZone: TZ },
          end: { dateTime: at('2026-10-27', 13), timeZone: TZ },
          recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
          organizer: { email: MOCK_PERSONAL_CALENDAR, self: true },
        },
        exceptions: new Map(),
      },
    ]);
    resetCalendarRangeCache();
    const after = (await slots('call')).map((s) => s.start);
    const day = '2026-11-10';
    expect(after).not.toContain(at(day, 11, 30));
    expect(after).not.toContain(at(day, 12));
    expect(after).not.toContain(at(day, 13));
    expect(after).toContain(at(day, 11));
    expect(after).toContain(at(day, 13, 30));
    // The Wednesday after is untouched.
    expect(after.filter((s) => s.startsWith('2026-10-28'))).toEqual(
      before.filter((s) => s.startsWith('2026-10-28')),
    );
  });

  it('answers the honeypot as if all went well, and keeps nothing', async () => {
    const [slot] = await slots('call');
    const result = await submit({ start: slot!.start, website: 'http://spam.example' });
    expect(result).toEqual({ ok: true, value: { kind: 'ignored' } });
    expect(
      await harness.store.count('booking_requests', harness.auth.organizationId, {
        eq: { email: 'pat@acme.example' },
      }),
    ).toBe(0);
  });

  it('brakes per email address, and holds at most three waiting requests per address', async () => {
    const message = { type: 'message', start: null, note: 'Hello' };
    for (let i = 0; i < 3; i += 1) expect((await submit(message)).ok).toBe(true);
    const fourth = await submit(message);
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      expect(fourth.error.code).toBe('rate_limited');
      expect(fourth.error.message).toMatch(/Too many requests from this email address/);
    }
    // A new hour, the same three still waiting: still no.
    resetLimiters();
    const again = await submit(message);
    expect(again.ok).toBe(false);
    if (!again.ok)
      expect(again.error.message).toBe(
        'You already have 3 requests waiting. Send another once those are answered.',
      );
  });

  it('fills a day with at most two link bookings', async () => {
    const wednesday = (await slots('call')).filter((s) => s.start.startsWith('2026-10-28'));
    expect(wednesday).toHaveLength(18);
    await saved({ start: wednesday[0]!.start, email: 'one@a.example' });
    expect(
      (await slots('call')).filter((s) => s.start.startsWith('2026-10-28')).length,
    ).toBeGreaterThan(0);
    await saved({ start: wednesday.at(-1)!.start, email: 'two@b.example' });
    const left = (await slots('call')).filter((s) => s.start.startsWith('2026-10-28'));
    expect(left).toEqual([]);
  });
});

describe('Approve', () => {
  it('re-checks, then puts the call on the main calendar with Meet, inviting the requester', async () => {
    const [slot] = await slots('call');
    const row = await saved({ start: slot!.start });
    const approved = await approveBookingRequest(actor(), row.id, deps());
    expect(approved.ok).toBe(true);
    if (!approved.ok || approved.value.state !== 'approved') throw new Error('not approved');
    expect(state.writes).toHaveLength(1);
    const write = state.writes[0]!;
    expect(write).toMatchObject({
      op: 'insert',
      calendarId: MOCK_OWN_EMAIL,
      sendUpdates: 'all',
      conferenceDataVersion: 1,
    });
    expect(write.body).toEqual({
      summary: 'Nick <> Pat Lee (Acme)',
      description:
        'Booked through the booking link.\n\nSeed round for a clinic scheduling tool.\n\nDeck: https://deck.example/acme',
      location: '',
      start: { dateTime: slot!.start, timeZone: TZ },
      end: { dateTime: slot!.end, timeZone: TZ },
      // The host first, as the organizer who has accepted; then the requester.
      attendees: [
        { email: MOCK_OWN_EMAIL, organizer: true, responseStatus: 'accepted' },
        { email: 'pat@acme.example' },
      ],
      conferenceData: {
        createRequest: {
          requestId: expect.any(String),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    });
    expect(approved.value.meetUrl).toMatch(/^https:\/\/meet\.google\.com\//);
    const after = await harness.store.get('booking_requests', harness.auth.organizationId, row.id);
    expect(after).toMatchObject({
      status: 'approved',
      calendar_id: MOCK_OWN_EMAIL,
      event_id: approved.value.eventId,
      decided_by: harness.auth.userId,
      claimed_at: null,
    });
    expect((await audits('booking.approved'))[0]?.metadata).toMatchObject({
      type: 'call',
      manual: false,
    });
    expect((await audits('calendar.event_created'))[0]?.metadata).toMatchObject({
      notified: true,
      meet: true,
      guests: 1,
    });
    // Approved once: a second tap changes nothing.
    const again = await approveBookingRequest(actor(), row.id, deps());
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.message).toBe('That request was already approved.');
    expect(state.writes).toHaveLength(1);
  });

  it('puts an in-person coffee there with its kind in the title and the place, no Meet', async () => {
    const [slot] = await slots('in_person', 'coffee');
    const row = await saved({
      name: 'Morgan Ellis',
      email: 'morgan@quarryline.example',
      company: 'Quarryline',
      type: 'in_person',
      kind: 'coffee',
      start: slot!.start,
      placeId: 'juniper-rye',
      deckUrl: '',
      note: '',
    });
    const approved = await approveBookingRequest(actor(), row.id, deps());
    expect(approved.ok).toBe(true);
    const write = state.writes[0]!;
    expect(write).toMatchObject({ op: 'insert', sendUpdates: 'all', conferenceDataVersion: 0 });
    expect(write.body).toEqual({
      summary: 'Coffee: Nick <> Morgan Ellis (Quarryline)',
      description: 'Booked through the booking link.\n\nMap: https://maps.example/juniper-rye',
      location: 'Juniper & Rye Coffee, Riverside',
      start: { dateTime: slot!.start, timeZone: TZ },
      end: { dateTime: slot!.end, timeZone: TZ },
      attendees: [
        { email: MOCK_OWN_EMAIL, organizer: true, responseStatus: 'accepted' },
        { email: 'morgan@quarryline.example' },
      ],
    });
  });

  const ZOOM = 'https://example.zoom.us/j/1234567890?pwd=fictional';

  async function saveCallLink(callLink: string) {
    const current = await readBookingSettings(harness.store, harness.auth.organizationId);
    const savedLink = await saveBookingSettings(
      harness.store,
      harness.auth.organizationId,
      harness.auth.userId,
      { enabled: true, slug: SLUG, config: { ...current.config, callLink } },
    );
    expect(savedLink.ok).toBe(true);
  }

  it('puts a call on the saved video link instead of Google Meet, the host as organizer (hotfix)', async () => {
    await saveCallLink(ZOOM);
    const [slot] = await slots('call');
    const row = await saved({ start: slot!.start });
    const approved = await approveBookingRequest(actor(), row.id, deps());
    expect(approved.ok).toBe(true);
    if (!approved.ok || approved.value.state !== 'approved') throw new Error('not approved');
    expect(state.writes).toHaveLength(1);
    const write = state.writes[0]!;
    expect(write).toMatchObject({ op: 'insert', sendUpdates: 'all', conferenceDataVersion: 0 });
    expect(write.body).toEqual({
      summary: 'Nick <> Pat Lee (Acme)',
      description: `Booked through the booking link.

Join the call: ${ZOOM}

Seed round for a clinic scheduling tool.

Deck: https://deck.example/acme`,
      location: ZOOM,
      start: { dateTime: slot!.start, timeZone: TZ },
      end: { dateTime: slot!.end, timeZone: TZ },
      attendees: [
        { email: MOCK_OWN_EMAIL, organizer: true, responseStatus: 'accepted' },
        { email: 'pat@acme.example' },
      ],
    });
    expect(approved.value.meetUrl).toBeNull();
    expect((await audits('calendar.event_created'))[0]?.metadata).toMatchObject({
      meet: false,
      guests: 1,
    });
  });

  it('carries the saved video link in the Google Calendar page without calendar editing (hotfix)', async () => {
    await saveCallLink(ZOOM);
    const [slot] = await slots('call');
    const row = await saved({ start: slot!.start });
    const result = await approveBookingRequest(actor(), row.id, deps(READ_SCOPES));
    if (!result.ok || result.value.state !== 'needs_grant')
      throw new Error('expected the fallback');
    const url = new URL(result.value.templateUrl);
    expect(url.searchParams.get('location')).toBe(ZOOM);
    expect(url.searchParams.get('details')).toContain(`Join the call: ${ZOOM}`);
    expect(state.writes).toEqual([]);
  });

  it('refuses, and writes nothing, when the time is no longer free', async () => {
    const [slot] = await slots('call');
    const row = await saved({ start: slot!.start });
    // Someone books over it in Google Calendar after the request came in.
    state.events.get(MOCK_OWN_EMAIL)!.push({
      id: 'testclash',
      status: 'confirmed',
      eventType: 'default',
      summary: 'Board call',
      start: { dateTime: slot!.start, timeZone: TZ },
      end: { dateTime: slot!.end, timeZone: TZ },
      organizer: { email: MOCK_OWN_EMAIL, self: true },
    });
    const refused = await approveBookingRequest(actor(), row.id, deps());
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('conflict');
      expect(refused.error.message).toBe(
        'This time is no longer free: That time is too close to another meeting. Nothing was added to the calendar. Decline it, or reply with another time.',
      );
    }
    expect(state.writes).toEqual([]);
    expect(
      (await harness.store.get('booking_requests', harness.auth.organizationId, row.id))?.status,
    ).toBe('pending');
    expect((await audits('booking.approve_refused'))[0]?.metadata).toMatchObject({
      reason: 'no_longer_free',
    });
  });

  it('without calendar editing, offers the filled-in Google Calendar page instead and writes nothing', async () => {
    const [slot] = await slots('call');
    const row = await saved({ start: slot!.start });
    const result = await approveBookingRequest(actor(), row.id, deps(READ_SCOPES));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.state !== 'needs_grant')
      throw new Error('expected the fallback');
    expect(result.value.reason).toMatch(/Calendar editing is off/);
    const url = new URL(result.value.templateUrl);
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('text')).toBe('Nick <> Pat Lee (Acme)');
    expect(url.searchParams.get('add')).toBe(`${MOCK_OWN_EMAIL},pat@acme.example`);
    expect(url.searchParams.get('ctz')).toBe(TZ);
    expect(state.writes).toEqual([]);
    expect(
      (await harness.store.get('booking_requests', harness.auth.organizationId, row.id))?.status,
    ).toBe('pending');
    expect((await audits('booking.approve_refused'))[0]?.metadata).toMatchObject({
      reason: 'needs_calendar_editing',
    });
    // Added there by hand: recorded as approved, still no write here.
    const marked = await markBookingRequest(actor(), row.id, 'added_by_hand', NOW);
    expect(marked.ok && marked.value.status).toBe('approved');
    expect(state.writes).toEqual([]);
  });

  it('has no time to approve on a message', async () => {
    const row = await saved({ type: 'message', start: null, note: 'Sharing our deck.' });
    const result = await approveBookingRequest(actor(), row.id, deps());
    expect(result.ok).toBe(false);
    const handled = await markBookingRequest(actor(), row.id, 'handled', NOW);
    expect(handled.ok && handled.value.status).toBe('handled');
    expect((await audits('booking.handled')).length).toBe(1);
  });
});

describe('Decline', () => {
  it('marks it declined and hands back a decline email to read and send, sending nothing', async () => {
    const [slot] = await slots('call');
    const row = await saved({ start: slot!.start });
    const declined = await markBookingRequest(actor(), row.id, 'decline', NOW);
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;
    expect(declined.value.status).toBe('declined');
    expect(declined.value.draft).toMatchObject({
      to: 'pat@acme.example',
      subject: 'Your meeting request with Nick',
    });
    expect(declined.value.draft?.body).toMatch(
      /^Hi Pat,\n\nThank you for asking to meet with Nick\./,
    );
    expect(state.writes).toEqual([]);
    expect((await audits('booking.declined')).length).toBe(1);
    const twice = await markBookingRequest(actor(), row.id, 'decline', NOW);
    expect(twice.ok).toBe(false);
  });
});

describe('the Copilot side', () => {
  it('lists what waits, soonest first and messages last, and counts it for Today', async () => {
    const list = await listPendingBookingRequests(harness.store, harness.auth.organizationId);
    expect(list.available).toBe(true);
    // The demo's three: a call, a coffee, a message.
    expect(list.requests.map((r) => r.meeting_type)).toEqual(['call', 'in_person', 'message']);
    expect(await countPendingBookingRequests(harness.store, harness.auth.organizationId)).toBe(3);
  });

  it('saves Settings strictly, audits it, and keeps slugs unique', async () => {
    const before = await readBookingSettings(harness.store, harness.auth.organizationId);
    expect(before).toMatchObject({ available: true, enabled: true, slug: 'nick', saved: true });
    const good = await saveBookingSettings(
      harness.store,
      harness.auth.organizationId,
      harness.auth.userId,
      {
        enabled: false,
        slug: 'sam-host',
        config: { ...before.config, horizonDays: 14 },
      },
    );
    expect(good.ok && good.value).toMatchObject({ enabled: false, slug: 'sam-host' });
    expect((await audits('booking.settings_updated'))[0]?.metadata).toMatchObject({
      enabled: false,
    });
    const bad = await saveBookingSettings(
      harness.store,
      harness.auth.organizationId,
      harness.auth.userId,
      {
        enabled: true,
        slug: 'nick',
        config: { ...before.config, callBufferMinutes: 5 },
      },
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toMatch(/^Check callBufferMinutes/);
    const badSlug = await saveBookingSettings(
      harness.store,
      harness.auth.organizationId,
      harness.auth.userId,
      {
        enabled: true,
        slug: 'API',
        config: before.config,
      },
    );
    expect(badSlug.ok).toBe(false);
  });
});

describe('what the page offers', () => {
  async function withConfig(over: Record<string, unknown>) {
    const current = await readBookingSettings(harness.store, harness.auth.organizationId);
    await harness.store.update(
      'booking_settings',
      harness.auth.organizationId,
      DEMO_BOOKING_SETTINGS_ID,
      { settings: { ...current.config, ...over } },
    );
    return publicBookingPage(harness.store, SLUG, deps());
  }

  it('offers calls only without a home city, or with no hours for any kind', async () => {
    const noCity = await withConfig({ homeCity: '' });
    expect(noCity.offers).toEqual({ call: true, inPerson: false });
    expect(noCity.places).toEqual([]);
    const noHours = await withConfig({
      homeCity: 'Harbor City',
      kindWindows: { coffee: [], lunch: [], dinner: [] },
    });
    expect(noHours.offers.inPerson).toBe(false);
    expect(noHours.kinds).toEqual([]);
    const lunchOnly = await withConfig({
      kindWindows: { coffee: [], lunch: [{ from: '12:00', to: '12:30' }], dinner: [] },
    });
    expect(lunchOnly.kinds).toEqual(['lunch']);
  });

  it('never shows an empty name', async () => {
    const page = await withConfig({ displayName: '' });
    expect(page.host?.displayName).toBe('Nick Tippmann');
  });
});

describe('the off switch', () => {
  it('closes the page, its times, its form and its chatbot', async () => {
    await harness.store.update(
      'booking_settings',
      harness.auth.organizationId,
      DEMO_BOOKING_SETTINGS_ID,
      {
        enabled: false,
      },
    );
    const page = await publicBookingPage(harness.store, SLUG, deps());
    expect(page).toMatchObject({ state: 'closed', host: null, places: [], faq: '' });
    const times = await publicSlots(harness.store, SLUG, { type: 'call', kind: null }, deps());
    expect(times).toMatchObject({ state: 'closed', slots: [], message: CLOSED_MESSAGE });
    const sent = await submit({ type: 'message', start: null, note: 'Hello' });
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.error.message).toBe(CLOSED_MESSAGE);
    expect(state.reads.filter((r) => r.op === 'range')).toEqual([]);
  });

  it('closes any other slug', async () => {
    expect((await publicBookingPage(harness.store, 'someone-else', deps())).state).toBe('closed');
    expect((await publicBookingPage(harness.store, '../etc', deps())).state).toBe('closed');
  });

  it('starts off for a new organization: no row, the page closed', async () => {
    await harness.store.remove(
      'booking_settings',
      harness.auth.organizationId,
      DEMO_BOOKING_SETTINGS_ID,
    );
    const view = await readBookingSettings(harness.store, harness.auth.organizationId);
    expect(view).toMatchObject({ available: true, enabled: false, saved: false, slug: 'nick' });
    expect(view.config).toEqual({ ...DEFAULT_BOOKING_CONFIG, displayName: 'Nick Tippmann' });
    expect((await publicBookingPage(harness.store, SLUG, deps())).state).toBe('closed');
  });
});

describe('before the migration is run', () => {
  function withoutBookingTables(store: DataStore): DataStore {
    const missing = () => {
      const error = new Error('relation "booking_requests" does not exist') as Error & {
        code: string;
      };
      error.code = '42P01';
      throw error;
    };
    return new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (typeof args[0] === 'string' && args[0].startsWith('booking_')) return missing();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }

  it('fails safe everywhere: closed page, no panel, no Today line, Settings says what to run', async () => {
    const store = withoutBookingTables(harness.store);
    const { setStoreForTesting } = await import('@/lib/runtime');
    setStoreForTesting(store);
    const page = await publicBookingPage(store, SLUG, deps());
    expect(page.state).toBe('closed');
    const times = await publicSlots(store, SLUG, { type: 'call', kind: null }, deps());
    expect(times.state).toBe('closed');
    const sent = await submitBookingRequest(
      store,
      SLUG,
      request({ type: 'message', start: null }),
      {
        ipHash: null,
        now: NOW,
        source: source(),
      },
    );
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.error.message).toBe(CLOSED_MESSAGE);
    expect(await listPendingBookingRequests(store, harness.auth.organizationId)).toEqual({
      available: false,
      requests: [],
    });
    expect(await countPendingBookingRequests(store, harness.auth.organizationId)).toBeNull();
    const settings = await readBookingSettings(store, harness.auth.organizationId);
    expect(settings).toMatchObject({ available: false, enabled: false });
    const save = await saveBookingSettings(
      store,
      harness.auth.organizationId,
      harness.auth.userId,
      {
        enabled: true,
        slug: 'nick',
        config: DEFAULT_BOOKING_CONFIG,
      },
    );
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.error.message).toBe(BOOKING_NOT_SET_UP);
    const approve = await approveBookingRequest({ ...actor(), store }, 'any', deps());
    expect(approve.ok).toBe(false);
    if (!approve.ok) expect(approve.error.code).toBe('not_configured');
    expect(state.writes).toEqual([]);
  });
});

describe('review fixes', () => {
  /** A request row as an older build (or a race) could have left it: straight into the table. */
  async function rowAt(start: string, over: Partial<BookingRequest> = {}): Promise<BookingRequest> {
    const row: BookingRequest = {
      id: crypto.randomUUID(),
      organization_id: harness.auth.organizationId,
      status: 'pending',
      meeting_type: 'call',
      kind: null,
      starts_at: start,
      ends_at: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
      visitor_time_zone: 'America/New_York',
      name: 'Pat Lee',
      email: `${crypto.randomUUID().slice(0, 8)}@acme.example`,
      company: 'Acme',
      place_id: null,
      place_name: null,
      place_area: null,
      place_map_url: null,
      place_custom: false,
      note: null,
      deck_url: null,
      source: 'form',
      ip_hash: null,
      claimed_at: null,
      calendar_id: null,
      event_id: null,
      decided_by: null,
      decided_at: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      ...over,
    };
    await harness.store.insert('booking_requests', row);
    return row;
  }

  it('holds at most three waiting requests per sender, whatever email they type', async () => {
    const message = (email: string) => ({ type: 'message', start: null, note: 'Hi', email });
    for (const email of ['a@one.example', 'b@two.example', 'c@three.example']) {
      expect((await submit(message(email))).ok).toBe(true);
    }
    const fourth = await submit(message('d@four.example'));
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      expect(fourth.error.code).toBe('rate_limited');
      expect(fourth.error.message).toBe(
        'You already have requests waiting. Send another once those are answered.',
      );
    }
    // Kept in the table, so a restart (fresh limiters) changes nothing.
    resetLimiters();
    expect((await submit(message('e@five.example'))).ok).toBe(false);
    // Another sender is not held back by the first.
    const other = await submitBookingRequest(
      harness.store,
      SLUG,
      request(message('f@six.example')),
      { ipHash: 'another-sender', now: NOW, source: source() },
    );
    expect(other.ok).toBe(true);
    expect(MAX_OPEN_PER_ADDRESS).toBe(3);
  });

  it('takes at most six new meeting requests a day while they wait, then messages only', async () => {
    // The demo already has two waiting from three hours ago.
    const open = (await slots('call')).filter((s, i, all) => {
      const day = s.start.slice(0, 10);
      return all.findIndex((x) => x.start.slice(0, 10) === day) === i;
    });
    for (let i = 0; i < 4; i += 1) {
      const sent = await submitBookingRequest(
        harness.store,
        SLUG,
        request({ start: open[i]!.start, email: `p${i}@a.example` }),
        { ipHash: `sender-${i}`, now: NOW, source: source() },
      );
      expect(sent.ok, `request ${i + 1}`).toBe(true);
    }
    const seventh = await submitBookingRequest(
      harness.store,
      SLUG,
      request({ start: open[4]!.start, email: 'p9@a.example' }),
      { ipHash: 'sender-9', now: NOW, source: source() },
    );
    expect(seventh.ok).toBe(false);
    if (!seventh.ok) expect(seventh.error.message).toBe(BUSY_LINK_MESSAGE);
    const note = await submitBookingRequest(
      harness.store,
      SLUG,
      request({ type: 'message', start: null, email: 'p9@a.example' }),
      { ipHash: 'sender-9', now: NOW, source: source() },
    );
    expect(note.ok).toBe(true);
  });

  it('keeps one of two requests sent for the same time at the same moment', async () => {
    const [slot] = await slots('call');
    const both = await Promise.all(
      ['one@a.example', 'two@b.example'].map((email, i) =>
        submitBookingRequest(harness.store, SLUG, request({ start: slot!.start, email }), {
          ipHash: `racer-${i}`,
          now: NOW,
          source: source(),
        }),
      ),
    );
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.filter((r) => !r.ok && r.error.code === 'conflict')).toHaveLength(1);
    expect(
      await harness.store.count('booking_requests', harness.auth.organizationId, {
        eq: { starts_at: slot!.start },
      }),
    ).toBe(1);
  });

  it('approves the older of two overlapping waiting requests, and says why the newer waits', async () => {
    const [slot] = await slots('call');
    const older = await rowAt(slot!.start, { created_at: '2026-10-26T14:00:00.000Z' });
    const newer = await rowAt(slot!.start, { created_at: '2026-10-26T14:30:00.000Z' });
    const second = await approveBookingRequest(actor(), newer.id, deps());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toContain(WAITING_CLASH);
    expect(state.writes).toEqual([]);
    const first = await approveBookingRequest(actor(), older.id, deps());
    expect(first.ok).toBe(true);
    expect(state.writes).toHaveLength(1);
  });

  it('never declines while an approval holds the claim; a stale claim no longer counts', async () => {
    const [slot] = await slots('call');
    const row = await rowAt(slot!.start, { claimed_at: NOW.toISOString() });
    const blocked = await markBookingRequest(actor(), row.id, 'decline', NOW);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.message).toMatch(/^Someone is approving this request/);
    expect(
      (await harness.store.get('booking_requests', harness.auth.organizationId, row.id))?.status,
    ).toBe('pending');
    const later = new Date(NOW.getTime() + 3 * 60_000);
    const declined = await markBookingRequest(actor(), row.id, 'decline', later);
    expect(declined.ok && declined.value.status).toBe('declined');
  });

  it('keeps the claim when Google may have made the event but its answer was lost', async () => {
    class LostAnswer extends MockCalendarProvider {
      override async insertEvent(...args: Parameters<MockCalendarProvider['insertEvent']>) {
        await super.insertEvent(...args);
        return err('timeout', 'Google took too long.');
      }
    }
    const [slot] = await slots('call');
    const row = await saved({ start: slot!.start });
    const lossy = { ...source(), provider: new LostAnswer(NOW, state) };
    const first = await approveBookingRequest(actor(), row.id, { now: NOW, source: lossy });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.message).toMatch(/^Google did not answer\. Check Nick's/);
    expect(state.writes).toHaveLength(1);
    // A quick second click makes no second event.
    const again = await approveBookingRequest(actor(), row.id, deps());
    expect(again.ok).toBe(false);
    expect(state.writes).toHaveLength(1);
  });

  it('still blocks a calendar hidden on the Calendar tab', async () => {
    const before = (await slots('call')).map((s) => s.start);
    const day = '2026-11-10';
    expect(before).toContain(at(day, 15));
    state.events.get(MOCK_PERSONAL_CALENDAR)!.push({
      id: 'testkidpickup',
      status: 'confirmed',
      eventType: 'default',
      summary: 'Kid pickup',
      start: { dateTime: at(day, 15), timeZone: TZ },
      end: { dateTime: at(day, 15, 30), timeZone: TZ },
      organizer: { email: MOCK_PERSONAL_CALENDAR, self: true },
    });
    resetCalendarRangeCache();
    expect((await slots('call')).map((s) => s.start)).not.toContain(at(day, 15));
    const host = await readHost(harness.store, harness.auth.organizationId);
    const hidden = await saveCalendarPrefs(
      harness.store,
      harness.auth.organizationId,
      host.userId!,
      { shown: { [MOCK_PERSONAL_CALENDAR]: false } },
    );
    expect(hidden.ok).toBe(true);
    resetCalendarRangeCache();
    expect((await slots('call')).map((s) => s.start)).not.toContain(at(day, 15));
  });

  it("never lets a teammate's own calendar block the host's time", async () => {
    const day = '2026-11-10';
    expect((await slots('call')).map((s) => s.start)).toContain(at(day, 15));
    // The assistant's main calendar, shared with the host as owner and ticked in
    // Google, full of the assistant's own day (and an out-of-office).
    state.calendars.push({
      id: DEMO_TEAMMATE.email,
      summary: DEMO_TEAMMATE.email,
      timeZone: TZ,
      colorId: '3',
      backgroundColor: '#7986cb',
      foregroundColor: '#1d1d1d',
      selected: true,
      accessRole: 'owner',
    });
    state.events.set(DEMO_TEAMMATE.email, [
      {
        id: 'teammateemails',
        status: 'confirmed',
        eventType: 'default',
        summary: 'Emails',
        start: { dateTime: at(day, 15), timeZone: TZ },
        end: { dateTime: at(day, 15, 30), timeZone: TZ },
        organizer: { email: DEMO_TEAMMATE.email, self: true },
      },
    ]);
    resetCalendarRangeCache();
    expect((await slots('call')).map((s) => s.start)).toContain(at(day, 15));
  });

  it('counts for Today only messages and meeting requests whose time is ahead', async () => {
    const org = harness.auth.organizationId;
    expect(await countPendingBookingRequests(harness.store, org, NOW)).toBe(3);
    await rowAt('2026-10-20T15:00:00.000Z', { created_at: '2026-10-19T15:00:00.000Z' });
    expect(await countPendingBookingRequests(harness.store, org, NOW)).toBe(3);
    // Still in the drawer, to be declined.
    expect((await listPendingBookingRequests(harness.store, org)).requests).toHaveLength(4);
  });

  it('keeps visitor tags out of the stored note and out of the event Google gets', async () => {
    const [slot, second] = await slots('call');
    const row = await saved({
      start: slot!.start,
      name: 'Pat <b>Lee</b>',
      note: 'See <a href="https://evil.example/x">the Meet link</a>',
    });
    expect(row.name).toBe('Pat bLee/b');
    expect(row.note).not.toMatch(/[<>]/);
    // A row kept before the fix still goes out without a tag.
    const old = await rowAt(second!.start, {
      note: 'See <a href="https://evil.example/x">the Meet link</a>',
      created_at: '2026-10-26T14:00:00.000Z',
    });
    const approved = await approveBookingRequest(actor(), old.id, deps());
    expect(approved.ok).toBe(true);
    const description = String(state.writes[0]!.body?.description ?? '');
    expect(description).toContain('‹a href="https://evil.example/x"›the Meet link‹/a›');
    expect(description).not.toMatch(/[<>]/);
  });

  it('never takes the photo from saved settings: only an upload can set it', async () => {
    const org = harness.auth.organizationId;
    const current = await readBookingSettings(harness.store, org);
    const sneaky = {
      path: `booking/${org}/../../secret-docs/canary.pdf`,
      type: 'image/png' as const,
      version: 'abcd1234',
    };
    const result = await saveBookingSettings(harness.store, org, harness.auth.userId, {
      enabled: true,
      slug: 'nick',
      config: { ...current.config, photo: sneaky },
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.config.photo).toBeNull();
    expect((await readBookingSettings(harness.store, org)).config.photo).toBeNull();
    // A stored path of another shape is not a photo at all.
    expect(parseBookingConfig({ photo: sneaky }).photo).toBeNull();
  });
});

describe('booking hotfix: in person paused per trip', () => {
  /** His main calendar still shows the zone of the city he visited. */
  function awayZone() {
    state.calendars.find((c) => c.primary)!.timeZone = 'America/Los_Angeles';
    // The demo's own red-eye home (Sunday 8 November) is taken away: the
    // journey home here is the one each test adds, or none.
    state.events.set(
      MOCK_PERSONAL_CALENDAR,
      state.events.get(MOCK_PERSONAL_CALENDAR)!.filter((e) => e.id !== 'demobusyredeye'),
    );
    resetCalendarRangeCache();
  }

  /** The red-eye home Google added from a booking email: Tuesday night, landing Wednesday. */
  function flightHome() {
    state.events.get(MOCK_OWN_EMAIL)!.push({
      id: 'testflighthome',
      status: 'confirmed',
      eventType: 'fromGmail',
      summary: 'Flight to Harbor City (HC 400)',
      description: 'Lakeport LKP 9:59pm (local time) - Harbor City HCX 5:46am (local time)',
      transparency: 'transparent',
      start: { dateTime: at('2026-11-10', 23, 59), timeZone: 'America/Los_Angeles' },
      end: { dateTime: at('2026-11-11', 5, 46), timeZone: TZ },
      organizer: { email: MOCK_OWN_EMAIL, self: true },
    });
    resetCalendarRangeCache();
  }

  const hostDays = async (type: string, kind: string | null = null) =>
    new Set((await slots(type, kind)).map((s) => dayKeyIn(s.start, TZ)));

  it('opens in person again from the day after the flight home lands', async () => {
    const before = await hostDays('in_person', 'coffee');
    for (const day of ['2026-11-10', '2026-11-11', '2026-11-12'])
      expect(before.has(day)).toBe(true);
    const wednesdayCoffee = (await slots('in_person', 'coffee')).find(
      (s) => dayKeyIn(s.start, TZ) === '2026-11-11',
    )!;
    const waiting = await saved({
      type: 'in_person',
      kind: 'coffee',
      start: wednesdayCoffee.start,
      placeId: 'juniper-rye',
    });

    awayZone();
    flightHome();
    const coffee = await hostDays('in_person', 'coffee');
    expect(coffee.has('2026-11-10')).toBe(false);
    expect(coffee.has('2026-11-11')).toBe(false);
    expect(coffee.has('2026-11-12')).toBe(true);
    // Calls never pause.
    expect((await hostDays('call')).has('2026-11-10')).toBe(true);

    // The approval re-check says why, and when he is back.
    const refused = await approveBookingRequest(actor(), waiting.id, deps());
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.message).toContain(
        'In person is paused until Nick is back (from Thu 12 Nov).',
      );
    }
    expect(state.writes).toEqual([]);
  });

  it('keeps every day paused when no flight home is on the calendar', async () => {
    awayZone();
    expect(await slots('in_person', 'coffee')).toEqual([]);
    expect((await slots('call')).length).toBeGreaterThan(0);
  });
});

describe('booking hotfix: the hard hours, Central', () => {
  const org = () => harness.auth.organizationId;
  const hostClock = (iso: string) => {
    const c = localClock(new Date(iso), TZ);
    return c.hour * 60 + c.minute;
  };

  it('refuses to save hours outside 8:00 to 18:00, or a dinner off 18:00', async () => {
    const current = await readBookingSettings(harness.store, org());
    const early = await saveBookingSettings(harness.store, org(), harness.auth.userId, {
      enabled: true,
      slug: 'nick',
      config: { ...current.config, callWindow: { from: '07:00', to: '17:00' } },
    });
    expect(early.ok).toBe(false);
    if (!early.ok) {
      expect(early.error.message).toBe(
        'Check callWindow: Calls have to be between 8:00 AM and 6:00 PM Central.',
      );
    }
    const lateDinner = await saveBookingSettings(harness.store, org(), harness.auth.userId, {
      enabled: true,
      slug: 'nick',
      config: {
        ...current.config,
        kindWindows: { ...current.config.kindWindows, dinner: [{ from: '18:00', to: '19:30' }] },
      },
    });
    expect(lateDinner.ok).toBe(false);
  });

  it('offers and takes nothing outside the hours, whatever the stored settings say', async () => {
    const current = await readBookingSettings(harness.store, org());
    await harness.store.update('booking_settings', org(), DEMO_BOOKING_SETTINGS_ID, {
      settings: {
        ...current.config,
        callWindow: { from: '06:00', to: '21:00' },
        kindWindows: {
          coffee: [{ from: '06:00', to: '20:00' }],
          lunch: [{ from: '11:30', to: '13:00' }],
          dinner: [{ from: '17:00', to: '21:00' }],
        },
      },
    });
    const stored = await readBookingSettings(harness.store, org());
    expect(stored.config.callWindow).toEqual({ from: '08:00', to: '18:00' });
    expect(stored.config.kindWindows.dinner).toEqual([{ from: '18:00', to: '18:00' }]);

    const calls = await slots('call');
    expect(calls.length).toBeGreaterThan(0);
    for (const s of calls) {
      expect(hostClock(s.start)).toBeGreaterThanOrEqual(8 * 60);
      expect(hostClock(s.end)).toBeLessThanOrEqual(18 * 60);
    }
    for (const s of await slots('in_person', 'coffee')) {
      expect(hostClock(s.start)).toBeGreaterThanOrEqual(8 * 60);
      expect(hostClock(s.end)).toBeLessThanOrEqual(18 * 60);
    }
    const dinners = await slots('in_person', 'dinner');
    expect(dinners.length).toBeGreaterThan(0);
    for (const s of dinners) {
      expect(hostClock(s.start)).toBe(18 * 60);
      expect(hostClock(s.end)).toBe(19 * 60);
    }

    // The booking-time re-check refuses the same times: the last call of a
    // day (17:30 to 18:00) is taken, 18:00 and 7:30 that day are not.
    const last = calls.find((s) => hostClock(s.start) === 17 * 60 + 30)!;
    const day = dayKeyIn(last.start, TZ);
    expect((await submit({ start: last.start })).ok).toBe(true);
    const sixPm = await submit({ email: 'six@pm.example', start: at(day, 18) });
    expect(sixPm.ok).toBe(false);
    const early = await submit({ email: 'seven@am.example', start: at(day, 7, 30) });
    expect(early.ok).toBe(false);
    const lateDinner = await submit({
      email: 'late@dinner.example',
      type: 'in_person',
      kind: 'dinner',
      start: at(dayKeyIn(dinners[0]!.start, TZ), 18, 30),
      placeId: 'saltgrass-table',
    });
    expect(lateDinner.ok).toBe(false);
  });
});
