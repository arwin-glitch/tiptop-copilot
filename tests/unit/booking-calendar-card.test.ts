import { describe, expect, it } from 'vitest';
import {
  calendarMonths,
  countsByDay,
  dayAriaLabel,
  defaultDay,
  fullDayLabel,
  monthDays,
} from '@/components/booking/month-calendar';
import { icsFile } from '@/lib/booking/event';
import { addGuestDraft, cleanGuests, normalizeAddress, ownDomains } from '@/lib/booking/request';

/**
 * The booking page's calendar card and the small rules around it (D-078):
 * days read in the visitor's zone with counts from the open times, booked
 * only where the server says a meeting day is full, the month arrows
 * stopping at the open months, the screen-reader words; plus the guest box
 * counting a typed address, one inbox however it is written, the host
 * side's own domains, and the .ics file's stable UID and SEQUENCE.
 */

const slot = (start: string) => ({
  start,
  end: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
});

describe('the calendar card', () => {
  const slots = [
    slot('2026-11-10T15:00:00Z'), // Tue 10 Nov, 9:00 Chicago
    slot('2026-11-10T16:00:00Z'),
    slot('2026-11-12T23:30:00Z'), // Thu 12 Nov 17:30 Chicago = Fri 13 Nov in Manila
  ];

  it('counts open times per day in the zone the times are shown in', () => {
    expect([...countsByDay(slots, 'America/Chicago')]).toEqual([
      ['2026-11-10', 2],
      ['2026-11-12', 1],
    ]);
    // 23:00 and midnight in Manila: two different days there.
    expect([...countsByDay(slots, 'Asia/Manila')]).toEqual([
      ['2026-11-10', 1],
      ['2026-11-11', 1],
      ['2026-11-13', 1],
    ]);
  });

  it('marks each day open (with its count), booked or not offered, and your meeting', () => {
    const days = monthDays({
      month: '2026-11',
      counts: countsByDay(slots, 'America/Chicago'),
      days: [
        { date: '2026-11-11', state: 'booked' },
        { date: '2026-11-03', state: 'booked' },
      ],
      today: '2026-11-05',
      mine: '2026-11-17',
    });
    expect(days).toHaveLength(30);
    const byKey = new Map(days.map((d) => [d.key, d]));
    expect(byKey.get('2026-11-10')).toEqual({
      key: '2026-11-10',
      state: 'open',
      count: 2,
      mine: false,
    });
    expect(byKey.get('2026-11-11')?.state).toBe('booked');
    // A day before today is never "booked": it has passed.
    expect(byKey.get('2026-11-03')?.state).toBe('off');
    expect(byKey.get('2026-11-14')?.state).toBe('off');
    expect(byKey.get('2026-11-17')?.mine).toBe(true);
  });

  it('speaks each day plainly, and never why a day is off', () => {
    const [open, booked, off, mine] = [
      { key: '2026-11-12', state: 'open' as const, count: 4, mine: false },
      { key: '2026-11-11', state: 'booked' as const, count: 0, mine: false },
      { key: '2026-11-14', state: 'off' as const, count: 0, mine: false },
      { key: '2026-11-17', state: 'off' as const, count: 0, mine: true },
    ];
    expect(fullDayLabel('2026-11-12')).toBe('Thursday 12 November');
    expect(dayAriaLabel(open)).toBe('Thursday 12 November, 4 open times');
    expect(dayAriaLabel({ ...open, count: 1 })).toBe('Thursday 12 November, 1 open time');
    expect(dayAriaLabel(booked)).toBe('Wednesday 11 November, fully booked');
    expect(dayAriaLabel(off)).toBe('Saturday 14 November, not offered');
    expect(dayAriaLabel(mine)).toBe('Tuesday 17 November, your meeting: see, reschedule or cancel');
  });

  it('moves only between the open months (and a month a late time spills into)', () => {
    const counts = countsByDay(slots, 'Asia/Manila');
    expect(calendarMonths(['2026-10', '2026-12'], counts, '2026-10-26')).toEqual([
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
    expect(calendarMonths(['2026-12'], new Map(), '2026-10-26')).toEqual(['2026-12']);
    expect(calendarMonths([], new Map(), '2026-10-26')).toEqual(['2026-10']);
    // A month already past is never offered.
    expect(calendarMonths(['2026-09', '2026-11'], new Map(), '2026-10-26')).toEqual(['2026-11']);
  });

  it('shows the picked time’s day, else the picked day, else the month’s first open day', () => {
    const zone = 'America/Chicago';
    expect(defaultDay({ slots, zone, value: slots[2]!.start, day: null, month: null })).toBe(
      '2026-11-12',
    );
    expect(defaultDay({ slots, zone, value: null, day: '2026-11-12', month: null })).toBe(
      '2026-11-12',
    );
    expect(defaultDay({ slots, zone, value: null, day: '2026-11-11', month: null })).toBe(
      '2026-11-10',
    );
    expect(defaultDay({ slots, zone, value: null, day: null, month: '2026-12' })).toBeNull();
  });
});

describe('the guest box', () => {
  const rules = { max: 3, booker: 'pat@acme.example' };

  it('counts an address typed but not added yet', () => {
    expect(addGuestDraft(['sam@partner.example'], ' Kim@Advisor.example ', rules)).toEqual({
      ok: true,
      guests: ['sam@partner.example', 'kim@advisor.example'],
    });
    expect(addGuestDraft([], 'a@x.example, b@y.example; c@z.example', rules)).toEqual({
      ok: true,
      guests: ['a@x.example', 'b@y.example', 'c@z.example'],
    });
  });

  it('says why it cannot add one, never dropping it silently', () => {
    expect(addGuestDraft([], 'kim@', rules)).toEqual({
      ok: false,
      problem: 'Check kim@: it does not look like an email address.',
    });
    expect(addGuestDraft([], 'PAT@acme.example', rules)).toEqual({
      ok: false,
      problem: 'That is your own address: you are invited already.',
    });
    expect(
      addGuestDraft(['a@x.example', 'b@x.example', 'c@x.example'], 'd@x.example', rules),
    ).toEqual({ ok: false, problem: 'Add at most 3 guests.' });
  });
});

describe('addresses for the brakes', () => {
  it('reads one inbox however it is written', () => {
    expect(normalizeAddress('Pat.Lee+Seed@Gmail.com')).toBe('patlee@gmail.com');
    expect(normalizeAddress('p.a.t.l.e.e@googlemail.com')).toBe('patlee@gmail.com');
    expect(normalizeAddress('pat.lee+x@acme.example')).toBe('pat.lee@acme.example');
    expect(normalizeAddress('+tag@acme.example')).toBe('+tag@acme.example');
  });

  it('knows the host side’s own domains, never a free mail domain', () => {
    expect(ownDomains(['nick@fund.example', 'arwin@fund.example', 'me@gmail.com'])).toEqual([
      'fund.example',
    ]);
    const refused = cleanGuests(['team@fund.example'], {
      booker: 'pat@acme.example',
      blocked: [],
      blockedDomains: ['fund.example'],
      max: 5,
    });
    expect(refused).toEqual({
      ok: false,
      problem: "team@fund.example is on the host's side already. Leave them out.",
    });
  });
});

describe('the .ics file', () => {
  it('keeps one UID for a booking and says which version is newer', () => {
    const file = icsFile(
      {
        uid: 'booking-abc123@copilot.tiptop.vc',
        sequence: 2,
        title: 'Call with Nick',
        start: '2026-11-10T15:00:00Z',
        end: '2026-11-10T15:30:00Z',
      },
      new Date('2026-10-26T15:00:00Z'),
    );
    expect(file).toContain('UID:booking-abc123@copilot.tiptop.vc\r\n');
    expect(file).toContain('SEQUENCE:2\r\n');
  });
});
