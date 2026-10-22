import { describe, expect, it } from 'vitest';
import {
  BOOKING_CONFIG_SCHEMA,
  DEFAULT_BOOKING_CONFIG,
  inPersonOffered,
  parseBookingConfig,
  SLUG,
} from '@/lib/booking/config';
import {
  bookingDescription,
  bookingEventDraft,
  bookingLocation,
  bookingTitle,
  declineDraft,
  googleCalendarTemplateUrl,
  type ApprovableRequest,
} from '@/lib/booking/event';
import {
  applyFill,
  BOOKING_REQUEST_INPUT,
  CHAT_FORM_FILL,
  EMPTY_FORM,
  firstProblem,
  patchForm,
} from '@/lib/booking/request';

/**
 * The booking link's forms (D-074): the Settings document (lenient on read,
 * strict and bounded on save, never looser than the standing rules), what a
 * visitor may send (caps, http(s) deck links only, the honeypot field, no
 * unknown fields), and what an approved request becomes on the calendar,
 * field by field. Every name, address and link here is invented.
 */

describe('Settings > Booking link', () => {
  it('starts off with the standing rules as defaults', () => {
    expect(DEFAULT_BOOKING_CONFIG).toMatchObject({
      weekdays: [2, 3, 4],
      callWindow: { from: '09:00', to: '17:00' },
      kindWindows: {
        coffee: [
          { from: '08:30', to: '11:00' },
          { from: '14:00', to: '16:00' },
        ],
        lunch: [{ from: '11:30', to: '13:00' }],
        dinner: [{ from: '18:00', to: '19:30' }],
      },
      callBufferMinutes: 15,
      inPersonBufferMinutes: 30,
      stackSize: 3,
      stackGapMinutes: 15,
      stackCooldownMinutes: 60,
      stackLeadMinutes: 30,
      noticeHours: 24,
      horizonDays: 21,
      maxLinkBookingsPerDay: 2,
      maxMeetingsPerDay: 5,
      instant: false,
      chatbotEnabled: true,
      monthlyAiCapUsd: 20,
      photo: null,
      displayName: '',
      homeCity: '',
      places: [],
      faq: '',
    });
    expect(BOOKING_CONFIG_SCHEMA.safeParse(DEFAULT_BOOKING_CONFIG).success).toBe(true);
  });

  it('reads a stored document field by field, defaulting only what is missing or wrong', () => {
    const parsed = parseBookingConfig({
      displayName: 'Sam Host',
      callBufferMinutes: 5, // looser than the standing 15: refused, so the default stands
      noticeHours: 2,
      weekdays: [1, 2],
      horizonDays: 14,
      somethingNew: true,
    });
    expect(parsed.displayName).toBe('Sam Host');
    expect(parsed.horizonDays).toBe(14);
    expect(parsed.callBufferMinutes).toBe(15);
    expect(parsed.noticeHours).toBe(24);
    expect(parsed.weekdays).toEqual([2, 3, 4]);
    expect('somethingNew' in parsed).toBe(false);
    expect(parseBookingConfig(null)).toEqual(DEFAULT_BOOKING_CONFIG);
    expect(parseBookingConfig('nonsense')).toEqual(DEFAULT_BOOKING_CONFIG);
  });

  it('refuses on save anything looser than the standing rules', () => {
    const ok = { ...structuredClone(DEFAULT_BOOKING_CONFIG) };
    const bad = (over: Record<string, unknown>) =>
      BOOKING_CONFIG_SCHEMA.safeParse({ ...ok, ...over }).success;
    expect(bad({ weekdays: [1] })).toBe(false);
    expect(bad({ weekdays: [5] })).toBe(false);
    expect(bad({ callBufferMinutes: 10 })).toBe(false);
    expect(bad({ inPersonBufferMinutes: 20 })).toBe(false);
    expect(bad({ noticeHours: 12 })).toBe(false);
    expect(bad({ stackLeadMinutes: 0 })).toBe(false);
    expect(bad({ callWindow: { from: '17:00', to: '09:00' } })).toBe(false);
    expect(bad({ callWindow: { from: '9am', to: '17:00' } })).toBe(false);
    expect(bad({ monthlyAiCapUsd: 10_000 })).toBe(false);
    expect(bad({ faq: 'x'.repeat(4001) })).toBe(false);
    expect(bad({ extra: 1 })).toBe(false);
    expect(
      bad({
        places: [{ id: 'a', name: 'Cafe', area: '', mapUrl: 'javascript:alert(1)' }],
      }),
    ).toBe(false);
    expect(
      bad({
        places: [
          { id: 'a', name: 'Cafe', area: '', mapUrl: null },
          { id: 'a', name: 'Bar', area: '', mapUrl: null },
        ],
      }),
    ).toBe(false);
    expect(bad({ weekdays: [2, 4], callBufferMinutes: 30, noticeHours: 48 })).toBe(true);
  });

  it('keeps link names short, plain and clear of the app’s own words', () => {
    expect(SLUG.safeParse('nick').success).toBe(true);
    expect(SLUG.parse(' Sam-Host ')).toBe('sam-host');
    expect(SLUG.safeParse('-nick').success).toBe(false);
    expect(SLUG.safeParse('a/b').success).toBe(false);
    expect(SLUG.safeParse('api').success).toBe(false);
    expect(SLUG.safeParse('x'.repeat(41)).success).toBe(false);
  });

  it('offers in person only with a home city and somewhere to meet', () => {
    expect(inPersonOffered({ homeCity: '', places: [], allowCustomPlace: true })).toBe(false);
    expect(inPersonOffered({ homeCity: 'Harbor City', places: [], allowCustomPlace: true })).toBe(
      true,
    );
    expect(inPersonOffered({ homeCity: 'Harbor City', places: [], allowCustomPlace: false })).toBe(
      false,
    );
  });
});

describe('what a visitor may send', () => {
  const call = {
    name: 'Pat Lee',
    email: 'Pat@Acme.example',
    type: 'call',
    start: '2026-10-28T15:00:00.000Z',
  };

  it('takes a call request, trimming and lowercasing the address', () => {
    const parsed = BOOKING_REQUEST_INPUT.parse(call);
    expect(parsed).toMatchObject({
      email: 'pat@acme.example',
      company: '',
      kind: null,
      deckUrl: '',
      source: 'form',
      website: '',
    });
  });

  it('wants a time, and for in person a kind and a place', () => {
    const problem = (value: unknown) => {
      const parsed = BOOKING_REQUEST_INPUT.safeParse(value);
      return parsed.success ? null : firstProblem(parsed.error);
    };
    expect(problem({ ...call, start: null })).toBe('Pick a time.');
    expect(problem({ ...call, type: 'in_person', placeId: 'a' })).toBe(
      'Pick coffee, lunch or dinner.',
    );
    expect(problem({ ...call, type: 'in_person', kind: 'coffee' })).toBe(
      'Pick or suggest a place.',
    );
    expect(problem({ ...call, type: 'message', start: null })).toBe('Write your message.');
    expect(problem({ ...call, type: 'message', start: null, note: 'Hello' })).toBeNull();
    expect(problem({ ...call, email: 'not an email' })).toBe('Check your email address.');
    expect(problem({ ...call, name: '   ' })).toBe('Add your name.');
  });

  it('caps every text and takes only http or https deck links', () => {
    const fails = (over: Record<string, unknown>) =>
      !BOOKING_REQUEST_INPUT.safeParse({ ...call, ...over }).success;
    expect(fails({ name: 'x'.repeat(121) })).toBe(true);
    expect(fails({ note: 'x'.repeat(2001) })).toBe(true);
    expect(fails({ company: 'x'.repeat(121) })).toBe(true);
    expect(fails({ email: `${'x'.repeat(250)}@a.example` })).toBe(true);
    expect(fails({ deckUrl: 'javascript:alert(1)' })).toBe(true);
    expect(fails({ deckUrl: 'ftp://deck.example/file' })).toBe(true);
    expect(fails({ deckUrl: 'https://deck.example/seed' })).toBe(false);
    expect(fails({ deckUrl: 'http://deck.example/seed' })).toBe(false);
    expect(fails({ admin: true })).toBe(true);
    expect(fails({ status: 'approved' })).toBe(true);
  });

  it('strips control characters from what it keeps', () => {
    const parsed = BOOKING_REQUEST_INPUT.parse({ ...call, note: 'Hi\u0000 there\u0007' });
    expect(parsed.note).toBe('Hi there');
  });

  it('accepts the honeypot field, so the server can answer it as if all went well', () => {
    expect(BOOKING_REQUEST_INPUT.parse({ ...call, website: 'spam.example' }).website).toBe(
      'spam.example',
    );
  });
});

describe('the form the page keeps', () => {
  it('clears a time picked for another kind of meeting', () => {
    const picked = patchForm(EMPTY_FORM, { start: '2026-10-28T15:00:00.000Z' });
    expect(patchForm(picked, { type: 'in_person', kind: 'coffee' }).start).toBeNull();
    const coffee = patchForm(EMPTY_FORM, { type: 'in_person', kind: 'coffee', start: 'x' });
    expect(coffee.start).toBe('x');
    expect(patchForm(coffee, { kind: 'lunch' }).start).toBeNull();
    expect(patchForm(coffee, { type: 'call' }).kind).toBeNull();
  });

  it('merges a chatbot fill without sending anything', () => {
    const filled = applyFill(EMPTY_FORM, {
      name: 'Pat',
      type: 'in_person',
      kind: 'dinner',
      start: 's',
    });
    expect(filled).toMatchObject({ name: 'Pat', type: 'in_person', kind: 'dinner', start: 's' });
    expect(CHAT_FORM_FILL.safeParse({ status: 'approved' }).success).toBe(false);
    expect(CHAT_FORM_FILL.safeParse({ deckUrl: 'javascript:x' }).success).toBe(false);
  });
});

describe('what an approved request becomes', () => {
  const call: ApprovableRequest = {
    type: 'call',
    kind: null,
    starts_at: '2026-10-28T15:00:00.000Z',
    ends_at: '2026-10-28T15:30:00.000Z',
    name: ' Pat Lee ',
    email: 'Pat@Acme.example',
    company: 'Acme',
    place_name: null,
    place_area: null,
    place_map_url: null,
    note: 'Seed round for a clinic tool.',
    deck_url: 'https://deck.example/acme',
  };
  const coffee: ApprovableRequest = {
    ...call,
    type: 'in_person',
    kind: 'coffee',
    ends_at: '2026-10-28T16:00:00.000Z',
    company: null,
    place_name: 'Juniper & Rye Coffee',
    place_area: 'Riverside',
    place_map_url: 'https://maps.example/juniper',
    deck_url: null,
  };

  it('titles it "<Host> <> <Name> (<Company>)", with the kind in front in person', () => {
    expect(bookingTitle('Sam Host', call)).toBe('Sam <> Pat Lee (Acme)');
    expect(bookingTitle('Sam Host', coffee)).toBe('Coffee: Sam <> Pat Lee');
    expect(bookingTitle('Sam Host', { ...coffee, kind: 'dinner' })).toBe('Dinner: Sam <> Pat Lee');
    expect(bookingTitle('', call)).toBe('Meeting <> Pat Lee (Acme)');
  });

  it('puts the note, the deck and the map in the description, the place in the location', () => {
    expect(bookingDescription(call)).toBe(
      'Booked through the booking link.\n\nSeed round for a clinic tool.\n\nDeck: https://deck.example/acme',
    );
    expect(bookingDescription(coffee)).toBe(
      'Booked through the booking link.\n\nSeed round for a clinic tool.\n\nMap: https://maps.example/juniper',
    );
    expect(bookingLocation(coffee)).toBe('Juniper & Rye Coffee, Riverside');
    expect(bookingLocation(call)).toBe('');
  });

  it('invites the requester, with Google Meet for a call and none in person', () => {
    expect(bookingEventDraft('Sam Host', call, 'America/Chicago')).toEqual({
      title: 'Sam <> Pat Lee (Acme)',
      allDay: false,
      start: '2026-10-28T15:00:00.000Z',
      end: '2026-10-28T15:30:00.000Z',
      timeZone: 'America/Chicago',
      description:
        'Booked through the booking link.\n\nSeed round for a clinic tool.\n\nDeck: https://deck.example/acme',
      location: '',
      guests: ['pat@acme.example'],
      meet: true,
    });
    expect(bookingEventDraft('Sam Host', coffee, 'America/Chicago')).toMatchObject({
      title: 'Coffee: Sam <> Pat Lee',
      location: 'Juniper & Rye Coffee, Riverside',
      meet: false,
    });
  });

  it('fills Google Calendar’s own page when Copilot may not write', () => {
    const url = new URL(googleCalendarTemplateUrl('Sam Host', coffee, 'America/Chicago'));
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      action: 'TEMPLATE',
      text: 'Coffee: Sam <> Pat Lee',
      dates: '20261028T150000Z/20261028T160000Z',
      details:
        'Booked through the booking link.\n\nSeed round for a clinic tool.\n\nMap: https://maps.example/juniper',
      ctz: 'America/Chicago',
      add: 'pat@acme.example',
      location: 'Juniper & Rye Coffee, Riverside',
    });
  });

  it('drafts a short decline that promises nothing, for a person to send', () => {
    expect(declineDraft('Sam Host', { ...call, type: 'call' }, 'America/New_York')).toEqual({
      to: 'Pat@Acme.example',
      subject: 'Your meeting request with Sam',
      body: "Hi Pat,\n\nThank you for asking to meet with Sam. He isn't able to take the Wed, Oct 28, 11:00 AM time, so I won't be booking it.\n\nThanks for understanding,",
    });
    expect(
      declineDraft(
        'Sam Host',
        { name: 'Pat', email: 'p@a.example', starts_at: '', type: 'message' },
        'UTC',
      ).subject,
    ).toBe('Your note to Sam');
  });
});
