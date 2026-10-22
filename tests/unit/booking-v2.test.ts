import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bookingScope,
  googleEventLink,
  linkStatus,
  toLinkBooking,
  type LinkBooking,
} from '@/lib/booking/bookings';
import { bookingDescription, bookingEventDraft, icsFile, MANAGE_LINE } from '@/lib/booking/event';
import { CANCEL_INPUT, cleanGuests } from '@/lib/booking/request';
import type { BookingRequest } from '@/lib/types/domain';

/**
 * The pure parts of the booking link v2 (D-078): its migration as text (the
 * constraint names that broke the first booking migration), guests, the
 * event a booking becomes, the "Add to calendar" file and the Booking tab's
 * shape. Every address is invented.
 */

const SQL = readFileSync(
  path.resolve(import.meta.dirname, '../../supabase/migrations/20261022200000_booking_v2.sql'),
  'utf8',
);

describe('the v2 migration', () => {
  it('widens the inline status check by its auto name, under a name of its own', () => {
    expect(SQL).toContain(
      'alter table booking_requests drop constraint if exists booking_requests_status_check;',
    );
    expect(SQL).toMatch(/add constraint booking_requests_status_allowed check \(\s*status in \(/);
    for (const status of [
      'pending',
      'approved',
      'declined',
      'handled',
      'booked',
      'held',
      'cancelled',
    ]) {
      expect(SQL).toContain(`'${status}'`);
    }
  });

  it('never names a constraint like Postgres would name a column check', () => {
    const names = [...SQL.matchAll(/add constraint (\w+)/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(3);
    for (const name of names) {
      expect(name, name).not.toMatch(
        /^booking_requests_(guest_emails|manage_token_hash|cancel_note|cancelled_at|cancelled_by|rescheduled_count|previous_starts_at|status)_check$/,
      );
      // Dropped first, so the file runs again.
      expect(SQL).toContain(`drop constraint if exists ${name};`);
    }
  });

  it('is additive: every column if not exists, the token unique by its hash', () => {
    for (const column of [
      'guest_emails',
      'manage_token_hash',
      'cancel_note',
      'cancelled_at',
      'cancelled_by',
      'rescheduled_count',
      'previous_starts_at',
    ]) {
      expect(SQL).toContain(`add column if not exists ${column} `);
    }
    expect(SQL).toMatch(/create unique index if not exists booking_requests_manage_token_idx/);
    expect(SQL).not.toMatch(/drop table|drop column|create policy/i);
  });
});

describe('guests', () => {
  const rules = { booker: 'pat@acme.example', blocked: ['host@fund.example'], max: 3 };

  it('cleans, dedupes and keeps the order', () => {
    expect(
      cleanGuests([' Sam@Partner.example ', 'sam@partner.example', '', 'kim@a.example'], rules),
    ).toEqual({
      ok: true,
      guests: ['sam@partner.example', 'kim@a.example'],
    });
  });

  it('refuses the booker, the host side, junk and too many, saying which', () => {
    expect(cleanGuests(['PAT@acme.example'], rules)).toMatchObject({ ok: false });
    expect(cleanGuests(['host@fund.example'], rules)).toEqual({
      ok: false,
      problem: "host@fund.example is on the host's side already. Leave them out.",
    });
    expect(cleanGuests(['a@b.example?cc=x@y.example'], rules)).toMatchObject({ ok: false });
    expect(
      cleanGuests(['a@x.example', 'b@x.example', 'c@x.example', 'd@x.example'], rules),
    ).toEqual({
      ok: false,
      problem: 'Add at most 3 guests.',
    });
    expect(cleanGuests(['a@x.example'], { ...rules, max: 0 })).toEqual({
      ok: false,
      problem: 'This booking link does not take guests.',
    });
  });

  it('a cancel note is plain text and at most 500 characters', () => {
    expect(CANCEL_INPUT.parse({ note: ' Sorry <b>busy</b>‮ ' })).toEqual({
      note: 'Sorry bbusy/b',
      website: '',
    });
    expect(CANCEL_INPUT.safeParse({ note: 'x'.repeat(501) }).success).toBe(false);
  });
});

const REQUEST = {
  type: 'call' as const,
  kind: null,
  starts_at: '2026-10-27T15:00:00.000Z',
  ends_at: '2026-10-27T15:30:00.000Z',
  name: 'Pat Lee',
  email: 'Pat@Acme.example',
  company: 'Acme',
  place_name: null,
  place_area: null,
  place_map_url: null,
  note: null,
  deck_url: null,
};

describe('the event a booking becomes', () => {
  it('invites the visitor and their guests, never the host twice, with the page link last', () => {
    const draft = bookingEventDraft(
      'Sam Host',
      {
        ...REQUEST,
        guests: ['kim@advisor.example', 'pat@acme.example', 'host@fund.example'],
        manageUrl: 'https://copilot.example/meet/sam/b/AAAA',
      },
      'America/Chicago',
      { hostEmail: 'host@fund.example' },
    );
    expect(draft.guests).toEqual(['pat@acme.example', 'kim@advisor.example']);
    expect(draft.organizerEmail).toBe('host@fund.example');
    expect(draft.description?.split('\n').at(-1)).toBe(
      `${MANAGE_LINE} https://copilot.example/meet/sam/b/AAAA`,
    );
    expect(bookingDescription(REQUEST)).not.toContain(MANAGE_LINE);
  });
});

describe('"Add to calendar"', () => {
  it('writes one event in UTC with escaped text and CRLF lines', () => {
    const text = icsFile(
      {
        uid: 'b1@booking.example',
        title: 'Call with Sam Host; intro, please',
        start: '2026-10-27T15:00:00.000Z',
        end: '2026-10-27T15:30:00.000Z',
        description: 'Reschedule or cancel:\nhttps://copilot.example/meet/sam/b/AAAA',
        location: 'Juniper & Rye, Riverside',
        url: 'https://copilot.example/meet/sam/b/AAAA',
      },
      new Date('2026-10-26T15:00:00Z'),
    );
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text).toContain('DTSTART:20261027T150000Z\r\n');
    expect(text).toContain('DTEND:20261027T153000Z\r\n');
    expect(text).toContain('SUMMARY:Call with Sam Host\\; intro\\, please\r\n');
    expect(text).toContain('LOCATION:Juniper & Rye\\, Riverside\r\n');
    expect(text).toMatch(/DESCRIPTION:Reschedule or cancel:\\nhttps:/);
    for (const line of text.split('\r\n')) expect(line.length).toBeLessThanOrEqual(75);
  });
});

describe('the Booking tab’s shape', () => {
  const row = (over: Partial<BookingRequest>): BookingRequest => ({
    id: '00000000-0000-4000-8000-0000000000b1',
    organization_id: '00000000-0000-4000-8000-000000000001',
    status: 'booked',
    meeting_type: 'call',
    kind: null,
    starts_at: '2026-10-27T15:00:00.000Z',
    ends_at: '2026-10-27T15:30:00.000Z',
    visitor_time_zone: null,
    name: 'Pat Lee',
    email: 'pat@acme.example',
    company: null,
    place_id: null,
    place_name: null,
    place_area: null,
    place_map_url: null,
    place_custom: false,
    note: null,
    deck_url: null,
    source: 'form',
    ip_hash: 'secret-hash',
    claimed_at: null,
    calendar_id: 'host@fund.example',
    event_id: 'evt123',
    decided_by: null,
    decided_at: null,
    created_at: '2026-10-26T15:00:00.000Z',
    updated_at: '2026-10-26T15:00:00.000Z',
    manage_token_hash: 'a'.repeat(64),
    ...over,
  });

  it('maps every stored status to what the tab shows', () => {
    expect(linkStatus(row({ status: 'approved' }))).toBe('booked');
    expect(linkStatus(row({ status: 'held' }))).toBe('held');
    expect(linkStatus(row({ status: 'handled', meeting_type: 'message' }))).toBe('message');
    expect(linkStatus(row({ status: 'declined' }))).toBe('declined');
  });

  it('carries no hash and links the Google event', () => {
    const booking: LinkBooking = toLinkBooking(row({}));
    expect(JSON.stringify(booking)).not.toMatch(/secret-hash|aaaaaaaa/);
    expect(booking.eventLink).toBe(googleEventLink('evt123', 'host@fund.example'));
    expect(Buffer.from(booking.eventLink!.split('eid=')[1]!, 'base64').toString()).toBe(
      'evt123 host@fund.example',
    );
    const now = new Date('2026-10-26T15:00:00Z');
    expect(bookingScope(booking, now)).toBe('upcoming');
    expect(bookingScope(booking, new Date('2026-10-28T00:00:00Z'))).toBe('past');
  });
});
