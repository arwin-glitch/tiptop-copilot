import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BookingSettings } from '@/components/booking/booking-settings';
import {
  BOOKING_CONFIG_SCHEMA,
  BOOKING_EARLIEST_START,
  BOOKING_HOURS_HINT,
  BOOKING_LATEST_END,
  DEFAULT_BOOKING_CONFIG,
  DINNER_WINDOW,
  inPersonOffered,
  KIND_START_BOUNDS,
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
import { distinctZones, zoneName } from '@/lib/booking/public';
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
      callWindow: { from: '08:00', to: '18:00' },
      kindWindows: {
        coffee: [
          { from: '08:00', to: '11:00' },
          { from: '14:00', to: '17:00' },
        ],
        lunch: [{ from: '11:30', to: '13:00' }],
        dinner: [{ from: '18:00', to: '18:00' }],
      },
      callBufferMinutes: 15,
      inPersonBufferMinutes: 30,
      stackSize: 3,
      stackGapMinutes: 15,
      stackCooldownMinutes: 60,
      stackLeadMinutes: 30,
      noticeHours: 24,
      openThrough: null,
      rollingMonths: 1,
      maxLinkBookingsPerDay: 2,
      maxMeetingsPerDay: 5,
      // D-078: booked at once by default; approving each first is the option.
      approveFirst: false,
      allowGuests: true,
      maxGuests: 5,
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
      rollingMonths: 3,
      somethingNew: true,
    });
    expect(parsed.displayName).toBe('Sam Host');
    expect(parsed.rollingMonths).toBe(3);
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

  it('holds the hours to 8:00 to 18:00 Central, dinner 18:00 to 19:00 (hotfix)', () => {
    expect(BOOKING_EARLIEST_START).toBe('08:00');
    expect(BOOKING_LATEST_END).toBe('18:00');
    expect(DINNER_WINDOW).toEqual({ from: '18:00', to: '19:00' });
    // An hour in person: coffee and lunch start by 17:00, dinner starts at 18:00.
    expect(KIND_START_BOUNDS).toEqual({
      coffee: { from: '08:00', to: '17:00' },
      lunch: { from: '08:00', to: '17:00' },
      dinner: { from: '18:00', to: '18:00' },
    });
    const ok = structuredClone(DEFAULT_BOOKING_CONFIG);
    const check = (over: Record<string, unknown>) =>
      BOOKING_CONFIG_SCHEMA.safeParse({ ...ok, ...over });
    const message = (over: Record<string, unknown>) => check(over).error?.issues[0]?.message;
    // A start window that holds one start (dinner at 18:00) is a window.
    expect(check({}).success).toBe(true);
    expect(message({ callWindow: { from: '07:30', to: '17:00' } })).toBe(
      'Calls have to be between 8:00 AM and 6:00 PM Central',
    );
    expect(check({ callWindow: { from: '09:00', to: '18:30' } }).success).toBe(false);
    expect(check({ callWindow: { from: '08:00', to: '18:00' } }).success).toBe(true);
    const kinds = (over: Record<string, unknown>) => ({
      kindWindows: { ...ok.kindWindows, ...over },
    });
    expect(message(kinds({ coffee: [{ from: '16:00', to: '17:30' }] }))).toBe(
      'Coffee has to start between 8:00 AM and 5:00 PM Central, so it ends by 6:00 PM',
    );
    expect(message(kinds({ lunch: [{ from: '07:00', to: '12:00' }] }))).toBe(
      'Lunch has to start between 8:00 AM and 5:00 PM Central, so it ends by 6:00 PM',
    );
    expect(message(kinds({ dinner: [{ from: '18:00', to: '19:30' }] }))).toBe(
      'Dinner is 6:00 to 7:00 PM Central, so it starts at 6:00 PM',
    );
    expect(check(kinds({ dinner: [{ from: '17:00', to: '18:00' }] })).success).toBe(false);
    expect(check(kinds({ coffee: [{ from: '16:00', to: '17:00' }] })).success).toBe(true);
  });

  it('clamps stored hours into the bounds when it reads them (hotfix)', () => {
    const parsed = parseBookingConfig({
      callWindow: { from: '06:00', to: '20:00' },
      kindWindows: {
        coffee: [
          { from: '07:00', to: '09:00' },
          { from: '16:00', to: '19:00' },
          { from: '19:00', to: '20:00' }, // wholly outside: dropped
        ],
        lunch: [{ from: '11:00', to: '12:00' }],
        dinner: [{ from: '17:00', to: '20:00' }],
      },
    });
    expect(parsed.callWindow).toEqual({ from: '08:00', to: '18:00' });
    expect(parsed.kindWindows).toEqual({
      coffee: [
        { from: '08:00', to: '09:00' },
        { from: '16:00', to: '17:00' },
      ],
      lunch: [{ from: '11:00', to: '12:00' }],
      dinner: [{ from: '18:00', to: '18:00' }],
    });
    // A dinner window wholly off 18:00 is dropped; a call window wholly outside takes the default.
    const off = parseBookingConfig({
      callWindow: { from: '19:00', to: '21:00' },
      kindWindows: { coffee: [], lunch: [], dinner: [{ from: '19:00', to: '20:00' }] },
    });
    expect(off.callWindow).toEqual({ from: '08:00', to: '18:00' });
    expect(off.kindWindows.dinner).toEqual([]);
    expect(off.kindWindows.coffee).toEqual([]);
    // What a strict save takes, the lenient read gives back unchanged.
    const chosen = parseBookingConfig({
      callWindow: { from: '10:00', to: '16:00' },
      kindWindows: { coffee: [{ from: '09:00', to: '10:00' }], lunch: [], dinner: [] },
    });
    expect(chosen.callWindow).toEqual({ from: '10:00', to: '16:00' });
    expect(chosen.kindWindows.coffee).toEqual([{ from: '09:00', to: '10:00' }]);
    expect(BOOKING_CONFIG_SCHEMA.safeParse(parsed).success).toBe(true);
  });

  it('reads hours saved as the earlier defaults as today’s defaults (hotfix)', () => {
    // Saved with the rest of Settings before the bounds: 9 to 5 calls, coffee to 16:00,
    // dinner to 19:30. Never chosen, so they follow the new defaults (last call 17:30).
    const parsed = parseBookingConfig({
      callWindow: { from: '09:00', to: '17:00' },
      kindWindows: {
        coffee: [
          { from: '08:30', to: '11:00' },
          { from: '14:00', to: '16:00' },
        ],
        lunch: [{ from: '11:30', to: '13:00' }],
        dinner: [{ from: '18:00', to: '19:30' }],
      },
    });
    expect(parsed.callWindow).toEqual(DEFAULT_BOOKING_CONFIG.callWindow);
    expect(parsed.kindWindows).toEqual(DEFAULT_BOOKING_CONFIG.kindWindows);
  });

  it('says the bounds over the Times section in Settings (hotfix)', () => {
    expect(BOOKING_HOURS_HINT).toBe('8:00 AM to 6:00 PM Central; dinner 6-7 PM.');
    const markup = renderToStaticMarkup(
      createElement(BookingSettings, {
        available: true,
        enabled: true,
        slug: 'sam',
        config: structuredClone(DEFAULT_BOOKING_CONFIG),
        linkBase: 'https://copilot.example/meet/',
        canEdit: true,
        hostZone: 'America/Chicago',
        demo: false,
        notSetUpMessage: '',
        initialSection: 'times',
      }),
    );
    expect(markup).toContain('8:00 AM to 6:00 PM Central; dinner 6-7 PM.');
    // The time inputs carry the bounds too: calls 08:00 to 18:00, dinner 18:00.
    expect(markup).toContain('min="08:00" max="18:00"');
    expect(markup).toContain('min="18:00" max="18:00"');
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

  it('takes only a plain email address (review fix)', () => {
    const fails = (email: string) => !BOOKING_REQUEST_INPUT.safeParse({ ...call, email }).success;
    for (const email of [
      'victim@example.com?cc=attacker%40evil.example&body=Please%20wire',
      'a@b..co',
      'a@b.c\u202eom',
      'a\u200b@example.com',
      'a..b@example.com',
      '.a@example.com',
      'a@-example.com',
      'a@example',
      'a b@example.com',
    ]) {
      expect(fails(email), JSON.stringify(email)).toBe(true);
    }
    for (const email of ['pat@acme.example', "o'neil+deals@sub.acme.co.uk", 'a_b-c@x-y.io']) {
      expect(fails(email), email).toBe(false);
    }
  });

  it('strips invisible, direction-changing and tag characters, and line breaks from one-line fields (review fix)', () => {
    const parsed = BOOKING_REQUEST_INPUT.parse({
      ...call,
      name: 'Pat\u202e eeL\n\tLee\u200b',
      company: '<b>Acme</b>\r\nLabs',
      note: 'Line one\nLine <i>two</i>',
    });
    expect(parsed.name).toBe('Pat eeL Lee');
    expect(parsed.company).toBe('bAcme/b Labs');
    expect(parsed.note).toBe('Line one\nLine itwo/i');
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
      body: "Hi Pat,\n\nThank you for asking to meet with Sam. The Wed, Oct 28, 11:00 AM (Eastern Time (New York)) time doesn't work, so I won't be booking it.\n\nThanks for understanding,",
    });
    expect(
      declineDraft(
        'Sam Host',
        { name: 'Pat', email: 'p@a.example', starts_at: '', type: 'message' },
        'UTC',
      ).subject,
    ).toBe('Your note to Sam');
  });

  it('names the zone, assumes no one’s gender, and needs no host name (review fix)', () => {
    const draft = declineDraft('', { ...call, type: 'call' }, 'Asia/Manila');
    expect(draft.subject).toBe('Your meeting request');
    expect(draft.body).toContain('Thank you for asking to meet. The Wed, Oct 28, 11:00 PM');
    expect(draft.body).toContain('(Philippine Standard Time (Manila))');
    expect(draft.body).not.toMatch(/\b(He|She|Nick)\b/);
  });

  it('turns any tag a visitor typed into look-alikes in the event (review fix)', () => {
    const tagged: ApprovableRequest = {
      ...call,
      name: 'Pat <b>Lee</b>',
      company: 'Acme <i>Labs</i>',
      note: 'See <a href="https://evil.example/x">the Meet link</a>',
    };
    expect(bookingTitle('Sam Host', tagged)).toBe('Sam <> Pat ‹b›Lee‹/b› (Acme ‹i›Labs‹/i›)');
    expect(bookingDescription(tagged)).not.toMatch(/[<>]/);
    expect(bookingDescription(tagged)).toContain('‹a href="https://evil.example/x"›');
  });
});

describe('time zone names (review fix)', () => {
  it('names a zone the same in summer and winter, with its city to tell zones apart', () => {
    const november = new Date('2026-11-05T15:00:00Z');
    const july = new Date('2026-07-05T15:00:00Z');
    expect(zoneName('America/Chicago', november)).toBe('Central Time (Chicago)');
    expect(zoneName('America/Chicago', july)).toBe('Central Time (Chicago)');
    expect(zoneName('Europe/London', new Date('2026-10-22T12:00:00Z'))).not.toMatch(
      /Summer|Daylight/,
    );
    expect(zoneName('Europe/Paris')).not.toBe(zoneName('Europe/Berlin'));
    expect(zoneName('UTC')).toBe('UTC');
  });

  it('offers each zone once in a picker, and only zones that exist', () => {
    expect(
      distinctZones([
        'America/Chicago',
        'America/Chicago',
        'America/New_York',
        'Not/AZone',
        null,
        'Europe/Paris',
      ]),
    ).toEqual(['America/Chicago', 'America/New_York', 'Europe/Paris']);
  });
});
