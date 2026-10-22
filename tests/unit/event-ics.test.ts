import { describe, expect, it } from 'vitest';
import {
  appleDirectionsUrl,
  googleCalendarUrl,
  googleDirectionsUrl,
  outlookCalendarUrl,
} from '@/lib/events/calendar-links';
import { buildIcs, escapeIcsText, foldIcsLine, icsUid } from '@/lib/events/ics';

/**
 * Calendar files and links (D-075): RFC 5545 with CRLF and 75-octet
 * folding, stable UIDs, SEQUENCE = schedule_version, UTC times. Fictional.
 */

const NOW = new Date('2030-01-01T12:00:00.000Z');
const S1 = '00000000-0000-4000-8000-00000000c001';
const S2 = '00000000-0000-4000-8000-00000000c002';

function ics(overrides: Partial<Parameters<typeof buildIcs>[0]> = {}) {
  return buildIcs({
    eventTitle: 'Harborview Annual Meeting',
    sequence: 3,
    url: 'https://copilot.example.com/e/harborview',
    now: NOW,
    sessions: [
      {
        id: S1,
        name: 'Annual Meeting',
        description: 'Year in review; spotlights, and Q&A',
        startsAt: '2030-01-25T19:00:00.000Z',
        endsAt: '2030-01-25T23:00:00.000Z',
        location: 'The Lantern Hall, 100 Example Avenue',
      },
      {
        id: S2,
        name: 'Evening Reception',
        description: null,
        startsAt: '2030-01-26T00:00:00.000Z',
        endsAt: '2030-01-26T03:00:00.000Z',
        location: null,
      },
    ],
    ...overrides,
  });
}

describe('buildIcs', () => {
  it('publishes one VEVENT per session with UTC times, stable UIDs and the SEQUENCE', () => {
    const text = ics();
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text).toContain('METHOD:PUBLISH');
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(text).toContain(`UID:${S1}@copilot.tiptop.vc`);
    expect(text).toContain('SEQUENCE:3');
    expect(text).toContain('DTSTART:20300125T190000Z');
    expect(text).toContain('DTEND:20300125T230000Z');
    expect(text).toContain('DTSTAMP:20300101T120000Z');
    expect(text).toContain('SUMMARY:Harborview Annual Meeting – Annual Meeting');
    expect(text).toContain('LOCATION:The Lantern Hall\\, 100 Example Avenue');
    // No bare LF anywhere.
    expect(text.replace(/\r\n/g, '')).not.toMatch(/\n/);
  });

  it('makes UIDs per guest for a personal file and carries their link', () => {
    const guest = '00000000-0000-4000-8000-00000000b001';
    const text = ics({
      guestId: guest,
      url: 'https://copilot.example.com/e/harborview/i/TOKEN',
      urlLabel: 'Your RSVP and ticket:',
    });
    const unfolded = text.replace(/\r\n /g, '');
    expect(unfolded).toContain(`UID:${icsUid(S1, guest)}`);
    expect(icsUid(S1, guest)).toBe(`${S1}.${guest}@copilot.tiptop.vc`);
    expect(unfolded).toContain('URL:https://copilot.example.com/e/harborview/i/TOKEN');
    expect(unfolded).toContain(
      'Your RSVP and ticket: https://copilot.example.com/e/harborview/i/TOKEN',
    );
  });

  it('marks a cancelled event and leaves out sessions with no start', () => {
    const text = ics({
      cancelled: true,
      sessions: [
        {
          id: S1,
          name: 'Only',
          description: null,
          startsAt: 'not a date',
          endsAt: null,
          location: null,
        },
      ],
    });
    expect(text).not.toContain('BEGIN:VEVENT');
    expect(ics({ cancelled: true })).toContain('STATUS:CANCELLED');
  });

  it('defaults a missing or backwards end to an hour after the start', () => {
    const text = ics({
      sessions: [
        {
          id: S1,
          name: 'One',
          description: null,
          startsAt: '2030-01-25T19:00:00.000Z',
          endsAt: '2030-01-25T18:00:00.000Z',
          location: null,
        },
      ],
    });
    expect(text).toContain('DTEND:20300125T200000Z');
    expect(text).toContain('SUMMARY:Harborview Annual Meeting\r\n');
  });
});

describe('escaping and folding', () => {
  it('escapes backslashes, semicolons, commas and newlines', () => {
    expect(escapeIcsText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
  });

  it('folds at 75 octets without splitting a multi-byte character', () => {
    const line = `DESCRIPTION:${'é'.repeat(80)}`;
    const folded = foldIcsLine(line);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe(line);
    expect(foldIcsLine('SHORT:line')).toBe('SHORT:line');
  });
});

describe('calendar and directions links', () => {
  const input = {
    title: 'Harborview Annual Meeting',
    startsAt: '2030-01-25T19:00:00.000Z',
    endsAt: '2030-01-25T23:00:00.000Z',
    details: 'Event page: https://copilot.example.com/e/harborview',
    location: 'The Lantern Hall, 100 Example Avenue',
  };

  it('builds Google and Outlook links in UTC', () => {
    const google = new URL(googleCalendarUrl(input));
    expect(google.hostname).toBe('calendar.google.com');
    expect(google.searchParams.get('dates')).toBe('20300125T190000Z/20300125T230000Z');
    expect(google.searchParams.get('location')).toBe(input.location);
    const outlook = new URL(outlookCalendarUrl(input));
    expect(outlook.searchParams.get('startdt')).toBe('2030-01-25T19:00:00.000Z');
    expect(outlook.searchParams.get('subject')).toBe(input.title);
  });

  it('gives directions by address or coordinates, nothing without either', () => {
    const byAddress = {
      address: '100 Example Avenue',
      name: 'The Lantern Hall',
      lat: null,
      lng: null,
    };
    expect(new URL(googleDirectionsUrl(byAddress)!).searchParams.get('destination')).toBe(
      'The Lantern Hall, 100 Example Avenue',
    );
    expect(
      new URL(appleDirectionsUrl({ ...byAddress, lat: 1.5, lng: 2.5 })!).searchParams.get('daddr'),
    ).toBe('1.5,2.5');
    expect(googleDirectionsUrl({ address: null, name: null, lat: null, lng: null })).toBeNull();
  });
});
