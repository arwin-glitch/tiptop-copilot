import { describe, expect, it } from 'vitest';
import {
  calendarZoneDiffers,
  daysCovered,
  eveningEnd,
  inPersonPausedThrough,
  isBusyEntry,
  toBusyPicture,
} from '@/lib/booking/busy';
import { DEFAULT_BOOKING_CONFIG } from '@/lib/booking/config';
import { openSlots } from '@/lib/booking/engine';
import {
  arrivesHome,
  locationOutsideHome,
  namesHome,
  travelSign,
  type HomePlace,
} from '@/lib/booking/travel';
import type { RangeEvent } from '@/lib/calendar/range-types';
import { wallTimeToUtc } from '@/lib/util/time';

/**
 * The host's calendar reduced to what the booking link may know (D-074):
 * busy intervals and days away. Which entries are busy (declined and free
 * ones are not; holds always are; an all-day one only when opaque), which
 * days are travel days, and that nothing else — no title, guest, place or
 * description — survives into what the engine and the public page get.
 * Every name, place and address here is invented.
 */

const TZ = 'America/Chicago';
const HOME: HomePlace = {
  city: 'Harbor City',
  aliases: ['Riverside'],
  places: [{ name: 'Juniper & Rye Coffee', area: 'Old Mill District' }],
};
const OWN = ['host@fund.example'];

const at = (day: string, h: number, m = 0) => wallTimeToUtc(day, h, m, TZ)!.toISOString();

let n = 0;
function ev(over: Partial<RangeEvent> = {}): RangeEvent {
  n += 1;
  const id = `ev${n}`;
  return {
    key: `cal␟${id}`,
    id,
    calendarId: 'cal',
    recurringEventId: null,
    title: 'Secret project sync',
    allDay: false,
    startsAt: at('2026-10-28', 10),
    endsAt: at('2026-10-28', 11),
    startDate: null,
    endDate: null,
    timeZone: TZ,
    location: null,
    place: null,
    description: 'Private agenda: acquisition talks',
    joinUrl: null,
    meetUrl: null,
    meetPending: false,
    colorId: null,
    labelId: null,
    label: null,
    color: { background: '#000000', foreground: '#ffffff' },
    organizer: { email: OWN[0]!, name: 'Host', self: true },
    attendees: [
      {
        email: 'guest@private.example',
        name: 'Confidential Guest',
        response: 'accepted',
        self: false,
        resource: false,
        organizer: false,
        optional: false,
      },
    ],
    guestsCanModify: false,
    canModify: true,
    readOnlyReason: null,
    canRespond: false,
    myResponse: 'accepted',
    attachments: [],
    verdict: { meeting: true, reason: 'With Confidential Guest', with: ['Confidential Guest'] },
    hold: false,
    inPerson: false,
    transparent: false,
    eventType: 'default',
    htmlLink: 'https://calendar.example/event?eid=secret',
    ...over,
  };
}

/** An entry the host put on his own calendar for himself: no guests, not a meeting. */
const solo = (over: Partial<RangeEvent> = {}) =>
  ev({
    attendees: [],
    verdict: { meeting: false, reason: 'A block', with: [] },
    ...over,
  });

const allDayEv = (start: string, end: string, over: Partial<RangeEvent> = {}) =>
  ev({ allDay: true, startsAt: null, endsAt: null, startDate: start, endDate: end, ...over });

const picture = (events: RangeEvent[]) =>
  toBusyPicture(events, { hostZone: TZ, home: HOME, ownEmails: OWN });

describe('what counts as busy', () => {
  it('counts meetings, blocks and tentative or unanswered invitations', () => {
    expect(isBusyEntry(ev())).toBe(true);
    expect(isBusyEntry(ev({ verdict: { meeting: false, reason: 'A block', with: [] } }))).toBe(
      true,
    );
    expect(isBusyEntry(ev({ myResponse: 'tentative' }))).toBe(true);
    expect(isBusyEntry(ev({ myResponse: 'needsAction' }))).toBe(true);
  });

  it('never counts what the host declined, or what is marked free', () => {
    expect(isBusyEntry(ev({ myResponse: 'declined' }))).toBe(false);
    expect(
      isBusyEntry(
        ev({ myResponse: null, verdict: { meeting: false, reason: 'Nick declined', with: [] } }),
      ),
    ).toBe(false);
    expect(isBusyEntry(ev({ transparent: true }))).toBe(false);
    expect(isBusyEntry(ev({ eventType: 'workingLocation' }))).toBe(false);
  });

  it('counts a hold even when it is marked free', () => {
    expect(isBusyEntry(ev({ hold: true, transparent: true }))).toBe(true);
    expect(isBusyEntry(ev({ hold: true, transparent: false }))).toBe(true);
  });

  it('counts an all-day entry only when it is opaque, and then the whole day', () => {
    expect(isBusyEntry(allDayEv('2026-10-28', '2026-10-29'))).toBe(true);
    expect(isBusyEntry(allDayEv('2026-10-28', '2026-10-29', { transparent: true }))).toBe(false);
    const { busy } = picture([allDayEv('2026-10-28', '2026-10-29')]);
    expect(busy).toEqual([
      {
        start: Date.parse(at('2026-10-28', 0)),
        end: Date.parse(at('2026-10-29', 0)),
        meeting: false,
        inPerson: false,
        allDay: true,
      },
    ]);
  });

  it('counts every instance of a recurring series', () => {
    const weekly = ['2026-10-27', '2026-11-03', '2026-11-10'].map((day) =>
      ev({ recurringEventId: 'series1', startsAt: at(day, 9), endsAt: at(day, 9, 30) }),
    );
    const { busy } = picture(weekly);
    expect(busy.map((b) => new Date(b.start).toISOString())).toEqual([
      '2026-10-27T14:00:00.000Z',
      '2026-11-03T15:00:00.000Z',
      '2026-11-10T15:00:00.000Z',
    ]);
  });

  it('keeps the Meeting verdict and in-person flag, for the daily cap and travel time', () => {
    const { busy } = picture([
      ev({ inPerson: true }),
      ev({
        title: 'Hold',
        verdict: { meeting: false, reason: 'A hold, not confirmed', with: [] },
        hold: true,
      }),
    ]);
    expect(busy.map((b) => [b.meeting, b.inPerson])).toEqual([
      [true, true],
      [false, false],
    ]);
  });
});

describe('nothing private leaves', () => {
  it('reduces entries to times and flags only', () => {
    const events = [
      ev({ location: '12 Hidden Lane, Harbor City', place: '12 Hidden Lane, Harbor City' }),
      ev({ title: 'Flight to Lakeport', place: 'Lakeport Airport' }),
      allDayEv('2026-10-29', '2026-10-30', { title: 'Staying with family in Lakeport' }),
    ];
    const result = picture(events);
    for (const block of result.busy) {
      expect(Object.keys(block).sort()).toEqual(['allDay', 'end', 'inPerson', 'meeting', 'start']);
    }
    const text = JSON.stringify({ busy: result.busy, travel: [...result.travelDays] });
    for (const secret of [
      'Secret project',
      'acquisition',
      'Confidential',
      'guest@private.example',
      'Hidden Lane',
      'Lakeport',
      'Flight',
      'calendar.example',
      'cal',
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('travel days', () => {
  it('reads flights, hotels and Gmail bookings as away', () => {
    expect(picture([ev({ eventType: 'fromGmail', title: 'Reservation' })]).travelDays).toEqual(
      new Set(['2026-10-28']),
    );
    expect(picture([ev({ title: 'Flight to Lakeport' })]).travelDays.has('2026-10-28')).toBe(true);
    expect(picture([solo({ title: 'Hotel check-in' })]).travelDays.has('2026-10-28')).toBe(true);
    expect(picture([ev({ title: 'Team sync' })]).travelDays.size).toBe(0);
  });

  it('reads all-day stays and trips as away for every day they cover', () => {
    const trip = picture([
      allDayEv('2026-10-27', '2026-10-30', { title: 'Family trip', transparent: true }),
    ]);
    expect([...trip.travelDays]).toEqual(['2026-10-27', '2026-10-28', '2026-10-29']);
    expect(
      picture([allDayEv('2026-10-28', '2026-10-29', { title: 'Host in Lakeport' })]).travelDays
        .size,
    ).toBe(1);
    expect(
      picture([allDayEv('2026-10-28', '2026-10-29', { title: 'Host in Harbor City' })]).travelDays
        .size,
    ).toBe(0);
    expect(
      picture([allDayEv('2026-10-28', '2026-10-29', { title: 'Founders Day' })]).travelDays.size,
    ).toBe(0);
  });

  it('reads a place outside the home city as away, and home or a listed place as home', () => {
    expect(locationOutsideHome('500 Example Blvd, Lakeport, TX 78701', HOME)).toBe(true);
    expect(locationOutsideHome('Lakeport International Airport', HOME)).toBe(true);
    expect(locationOutsideHome('500 Example Blvd, Harbor City, TX 78701', HOME)).toBe(false);
    expect(locationOutsideHome('Corner table, Riverside', HOME)).toBe(false);
    expect(locationOutsideHome('Juniper & Rye Coffee', HOME)).toBe(false);
    expect(locationOutsideHome('Conference room B', HOME)).toBe(false);
    expect(locationOutsideHome('Suite 400, Floor 4', HOME)).toBe(false);
    expect(namesHome('Dinner in harbor city', HOME)).toBe(true);
    expect(picture([ev({ place: '9 Pier Rd, Lakeport' })]).travelDays.size).toBe(1);
  });

  it('reads an entry the host made in another time zone as away', () => {
    const away = ev({ timeZone: 'America/Los_Angeles' });
    expect(picture([away]).travelDays.has('2026-10-28')).toBe(true);
    // Someone else's invitation in their own zone says nothing about where he is.
    const theirs = ev({
      timeZone: 'America/Los_Angeles',
      organizer: { email: 'pat@other.example', name: 'Pat', self: false },
    });
    expect(picture([theirs]).travelDays.size).toBe(0);
    expect(
      travelSign(
        {
          title: 'x',
          allDay: false,
          place: null,
          eventType: null,
          timeZone: 'Not/AZone',
          ownEntry: true,
          startsAt: at('2026-10-28', 10),
          meeting: false,
        },
        HOME,
        TZ,
      ),
    ).toBe(false);
  });

  it('marks the next day too after an evening of travel, and covers a red-eye’s two days', () => {
    const lateFlight = ev({
      title: 'Flight home',
      startsAt: at('2026-10-27', 18),
      endsAt: at('2026-10-27', 21),
    });
    expect([...picture([lateFlight]).travelDays].sort()).toEqual(['2026-10-27', '2026-10-28']);
    const morningFlight = ev({
      title: 'Flight out',
      startsAt: at('2026-10-27', 7),
      endsAt: at('2026-10-27', 9),
    });
    expect([...picture([morningFlight]).travelDays]).toEqual(['2026-10-27']);
    const redEye = ev({
      title: 'Red-eye home',
      startsAt: at('2026-10-27', 22),
      endsAt: at('2026-10-28', 6, 30),
    });
    expect([...picture([redEye]).travelDays].sort()).toEqual(['2026-10-27', '2026-10-28']);
    expect(eveningEnd({ allDay: false, endsAt: at('2026-10-28', 0) }, TZ)).toBe('2026-10-27');
    expect(eveningEnd({ allDay: false, endsAt: at('2026-10-27', 19, 59) }, TZ)).toBeNull();
    expect(eveningEnd({ allDay: true, endsAt: null }, TZ)).toBeNull();
  });

  it('ignores travel the host declined', () => {
    expect(
      picture([ev({ title: 'Flight to Lakeport', myResponse: 'declined' })]).travelDays.size,
    ).toBe(0);
  });

  it('counts the days an entry covers in the host’s zone', () => {
    expect(
      daysCovered(ev({ startsAt: at('2026-10-27', 23), endsAt: at('2026-10-28', 0) }), TZ),
    ).toEqual(['2026-10-27']);
    expect(daysCovered(allDayEv('2026-10-27', '2026-10-29'), TZ)).toEqual([
      '2026-10-27',
      '2026-10-28',
    ]);
  });
});

describe('the calendar’s own time zone', () => {
  const now = new Date('2026-10-26T15:00:00Z');
  it('pauses in person when the main calendar is set to a zone with another clock', () => {
    expect(calendarZoneDiffers([{ primary: true, timeZone: 'America/Denver' }], TZ, now)).toBe(
      true,
    );
    expect(calendarZoneDiffers([{ primary: true, timeZone: TZ }], TZ, now)).toBe(false);
    // Another name for the same clock is the same; a zone that only differs in summer differs then.
    expect(calendarZoneDiffers([{ primary: true, timeZone: 'America/Winnipeg' }], TZ, now)).toBe(
      false,
    );
    const july = new Date('2026-07-01T15:00:00Z');
    expect(
      calendarZoneDiffers([{ primary: true, timeZone: 'America/Mexico_City' }], TZ, july),
    ).toBe(true);
    expect(calendarZoneDiffers([{ primary: false, timeZone: 'Asia/Tokyo' }], TZ, now)).toBe(false);
  });
});

describe('the in-person pause, per trip (hotfix)', () => {
  // Monday 26 October 2026, 10:00 Central. His main calendar still shows the
  // zone of the city he visited; home is Harbor City (alias Riverside).
  const NOW = new Date('2026-10-26T15:00:00Z');
  const AWAY = [{ primary: true, timeZone: 'America/Los_Angeles' }];
  const HOME_ZONE = [{ primary: true, timeZone: TZ }];
  const pause = (events: RangeEvent[], calendars = AWAY) =>
    inPersonPausedThrough(calendars, picture(events).homeLandings, {
      hostZone: TZ,
      now: NOW,
      horizonDays: 21,
    });
  /** The red-eye home: leaves Thursday night, lands Friday morning (host time). */
  const flightHome = (over: Partial<RangeEvent> = {}) =>
    ev({
      title: 'Flight to Harbor City (HC 400)',
      description: 'Lakeport LKP 9:59pm (local time) - Harbor City HCX 5:46am (local time)',
      startsAt: at('2026-10-29', 23, 59),
      endsAt: at('2026-10-30', 5, 46),
      eventType: 'fromGmail',
      transparent: true,
      attendees: [],
      verdict: { meeting: false, reason: 'A booking', with: [] },
      ...over,
    });
  const coffeeOn = (events: RangeEvent[], day: string, calendars = AWAY) => {
    const p = picture(events);
    return openSlots(
      {
        now: NOW,
        hostZone: TZ,
        config: {
          ...structuredClone(DEFAULT_BOOKING_CONFIG),
          openMonths: ['2026-10', '2026-11'],
          homeCity: HOME.city,
        },
        busy: p.busy,
        travelDays: p.travelDays,
        inPersonPausedThrough: pause(events, calendars),
        linkBookings: [],
      },
      { type: 'in_person', kind: 'coffee' },
    ).filter((s) => s.date === day);
  };

  it('pauses through the day his flight home lands, then opens the next Tuesday', () => {
    expect(pause([flightHome()])).toBe('2026-10-30');
    expect(coffeeOn([flightHome()], '2026-10-27')).toEqual([]);
    expect(coffeeOn([flightHome()], '2026-10-29')).toEqual([]);
    expect(coffeeOn([flightHome()], '2026-10-30')).toEqual([]);
    expect(coffeeOn([flightHome()], '2026-11-03').length).toBeGreaterThan(0);
  });

  it('counts a red-eye for the day it lands, after midnight', () => {
    const redEye = flightHome({
      title: 'Red-eye home',
      description: null,
      startsAt: at('2026-10-28', 22, 30),
      endsAt: at('2026-10-29', 0, 40),
    });
    expect(pause([redEye])).toBe('2026-10-29');
    // Only the route line names home: the title says nothing of where it goes.
    expect(pause([flightHome({ title: 'Flight HC 400' })])).toBe('2026-10-30');
  });

  it('keeps every day paused with no flight home on the calendar', () => {
    expect(pause([])).toBe('all');
    const elsewhere = flightHome({
      title: 'Flight to Lakeport (HC 401)',
      description: 'Harbor City HCX 9:00am (local time) - Lakeport LKP 11:00am (local time)',
    });
    expect(pause([elsewhere])).toBe('all');
    expect(coffeeOn([elsewhere], '2026-11-03')).toEqual([]);
    expect(coffeeOn([elsewhere], '2026-11-11')).toEqual([]);
  });

  it('pauses nothing when his calendar shows his own zone', () => {
    expect(pause([flightHome()], HOME_ZONE)).toBeNull();
    expect(pause([], HOME_ZONE)).toBeNull();
    expect(coffeeOn([], '2026-10-27', HOME_ZONE).length).toBeGreaterThan(0);
  });

  it('ignores a flight home that landed before today, at the end of an earlier trip', () => {
    const earlier = flightHome({
      startsAt: at('2026-10-24', 23, 59),
      endsAt: at('2026-10-25', 5, 46),
    });
    expect(pause([earlier])).toBe('all');
    expect(pause([earlier, flightHome()])).toBe('2026-10-30');
  });

  it('ignores a flight home past the horizon, and a declined one', () => {
    const late = flightHome({
      startsAt: at('2026-11-20', 9),
      endsAt: at('2026-11-20', 11),
    });
    expect(pause([late])).toBe('all');
    expect(pause([flightHome({ myResponse: 'declined' })])).toBe('all');
  });

  it('reads where a journey ends from its title, else its route line', () => {
    const home = { city: HOME.city, aliases: ['Riverside', 'HCX'] };
    expect(arrivesHome({ title: 'Flight to Harbor City (HC 400)' }, home)).toBe(true);
    expect(arrivesHome({ title: 'Flight from Lakeport to Harbor City' }, home)).toBe(true);
    expect(arrivesHome({ title: 'Flight to Lakeport from Harbor City' }, home)).toBe(false);
    expect(arrivesHome({ title: 'LKP → HCX' }, home)).toBe(true);
    expect(arrivesHome({ title: 'HCX-LKP' }, home)).toBe(false);
    expect(arrivesHome({ title: 'Red-eye home' }, home)).toBe(true);
    expect(arrivesHome({ title: 'Flight home to Lakeport' }, home)).toBe(false);
    expect(arrivesHome({ title: 'Flight to Riverside' }, home)).toBe(true);
    expect(
      arrivesHome(
        {
          title: 'Flight HC 400',
          description: 'Lakeport LKP 9:59pm (local time) - Harbor City HCX 5:46am (local time)',
        },
        home,
      ),
    ).toBe(true);
    expect(arrivesHome({ title: 'Flight HC 400', description: 'Seat 12A' }, home)).toBe(false);
    expect(arrivesHome({ title: 'Flight home' }, { city: '', aliases: [] })).toBe(false);
  });
});

describe('a journey marked free (review fix)', () => {
  const NOW = new Date('2026-10-26T15:00:00Z');
  const callStarts = (events: RangeEvent[], day: string) => {
    const p = picture(events);
    return openSlots(
      {
        now: NOW,
        hostZone: TZ,
        config: {
          ...structuredClone(DEFAULT_BOOKING_CONFIG),
          openMonths: ['2026-10', '2026-11'],
          homeCity: HOME.city,
        },
        busy: p.busy,
        travelDays: p.travelDays,
        linkBookings: [],
      },
      { type: 'call' },
    )
      .filter((s) => s.date === day)
      .map((s) => s.start);
  };

  it('holds a flight’s time with travel time around it, so no call is offered in the air', () => {
    const flight = solo({
      title: 'Flight to Port Ellis',
      eventType: 'fromGmail',
      transparent: true,
      startsAt: at('2026-10-28', 10),
      endsAt: at('2026-10-28', 13),
    });
    const { busy } = picture([flight]);
    expect(busy).toEqual([
      {
        start: Date.parse(at('2026-10-28', 10)),
        end: Date.parse(at('2026-10-28', 13)),
        meeting: false,
        inPerson: true,
        allDay: false,
      },
    ]);
    const starts = callStarts([flight], '2026-10-28');
    expect(starts).toContain(at('2026-10-28', 9));
    expect(starts).not.toContain(at('2026-10-28', 9, 30));
    expect(starts).not.toContain(at('2026-10-28', 12, 30));
    expect(starts).not.toContain(at('2026-10-28', 13));
    expect(starts).toContain(at('2026-10-28', 13, 30));
  });

  it('holds a free-marked flight by its title too, but not a long free hotel stay', () => {
    const titled = solo({
      title: 'Flight UA 1234',
      transparent: true,
      startsAt: at('2026-10-28', 10),
      endsAt: at('2026-10-28', 12),
    });
    expect(picture([titled]).busy).toHaveLength(1);
    const stay = solo({
      title: 'Hotel Lakeport',
      eventType: 'fromGmail',
      transparent: true,
      startsAt: at('2026-10-27', 15),
      endsAt: at('2026-10-29', 11),
    });
    const p = picture([stay]);
    expect(p.busy).toEqual([]);
    expect([...p.travelDays].sort()).toEqual(['2026-10-27', '2026-10-28', '2026-10-29']);
  });
});

describe('a trip with no stay on the calendar (review fix)', () => {
  const out = (day: string, over: Partial<RangeEvent> = {}) =>
    solo({ title: 'Flight to Port Ellis', startsAt: at(day, 8), endsAt: at(day, 10), ...over });

  it('reads the days between an outbound and a return flight as away', () => {
    const p = picture([
      out('2026-10-27'),
      out('2026-10-29', {
        title: 'Flight to Harbor City',
        startsAt: at('2026-10-29', 17),
        endsAt: at('2026-10-29', 19),
      }),
    ]);
    expect(p.travelDays.has('2026-10-28')).toBe(true);
  });

  it('keeps the days home after a flight home, after a day trip, and on a day at a home place', () => {
    const back = picture([out('2026-10-27', { title: 'Flight home' }), out('2026-10-30')]);
    expect(back.travelDays.has('2026-10-28')).toBe(false);
    expect(back.travelDays.has('2026-10-29')).toBe(false);
    const dayTrip = picture([
      out('2026-10-27'),
      out('2026-10-27', { title: 'Flight home', startsAt: at('2026-10-27', 17) }),
    ]);
    expect(dayTrip.travelDays.has('2026-10-28')).toBe(false);
    const coffeeAtHome = picture([
      out('2026-10-27'),
      solo({
        title: 'Coffee',
        location: 'Juniper & Rye Coffee',
        startsAt: at('2026-10-28', 9),
        endsAt: at('2026-10-28', 10),
      }),
      out('2026-10-29', { title: 'Flight to Lakeport' }),
    ]);
    expect(coffeeAtHome.travelDays.has('2026-10-28')).toBe(false);
    // Too far apart to be one trip.
    const apart = picture([out('2026-10-26'), out('2026-10-30')]);
    expect(apart.travelDays.has('2026-10-28')).toBe(false);
  });
});

describe('travel signs the first version missed (review fix)', () => {
  it('reads a city with only a state, country or post code after it as another city', () => {
    expect(locationOutsideHome('New York, NY', HOME)).toBe(true);
    expect(locationOutsideHome('Port Ellis, CA', HOME)).toBe(true);
    expect(locationOutsideHome('Port Ellis, CA 94000', HOME)).toBe(true);
    expect(locationOutsideHome('Lakeport, Texas', HOME)).toBe(true);
    expect(locationOutsideHome('Lisbon, Portugal', HOME)).toBe(true);
    expect(locationOutsideHome('Harbor City, TX', HOME)).toBe(false);
  });

  it('reads the home city’s own airport as away, but not an Airport Blvd address', () => {
    expect(locationOutsideHome('Harbor City International Airport', HOME)).toBe(true);
    expect(locationOutsideHome('500 Airport Blvd, Harbor City', HOME)).toBe(false);
  });

  it('reads flight titles without the word flight, on entries that are not meetings', () => {
    for (const title of [
      'UA 1234 AUS-SFO',
      'UA1234 to San Francisco',
      '✈ Denver',
      'Fly to NYC',
      'Flying home',
      'AUS → SFO',
    ]) {
      expect(picture([solo({ title })]).travelDays.size, title).toBe(1);
    }
    // Years, quarters and planning tags are not flight numbers.
    for (const title of ['FY 2026 budget', 'H2 2027 planning', 'PR 1234 review', 'Q3 board prep']) {
      expect(picture([solo({ title })]).travelDays.size, title).toBe(0);
    }
  });

  it('reads the entry’s own location, not only a place Copilot judged in person', () => {
    const lp = ev({
      title: 'LP meetings',
      location: '200 Main St, Port Ellis, CA',
      place: null,
      joinUrl: 'https://zoom.example/j/1',
    });
    expect(picture([lp]).travelDays.has('2026-10-28')).toBe(true);
  });

  it('reads a timed "in Port Ellis" the host made for himself', () => {
    expect(picture([solo({ title: 'Nick in Port Ellis' })]).travelDays.size).toBe(1);
    expect(picture([solo({ title: 'Lunch in Riverside' })]).travelDays.size).toBe(0);
    expect(picture([solo({ title: 'Prep in Conference Room B' })]).travelDays.size).toBe(0);
    expect(picture([solo({ title: 'Deep work in Library' })]).travelDays.size).toBe(0);
  });
});

describe('travel false alarms (review fix)', () => {
  it('does not read a venue and its neighbourhood as another city', () => {
    for (const place of [
      'Blue Bottle, Downtown',
      'Fig Cafe, Westside',
      'Uchiko, North Loop',
      'Capital Grille, Omni Hotel',
    ]) {
      expect(locationOutsideHome(place, HOME), place).toBe(false);
    }
  });

  it('ignores entries written in UTC, and all-day entries "at" a venue', () => {
    expect(picture([solo({ timeZone: 'UTC' })]).travelDays.size).toBe(0);
    expect(picture([solo({ timeZone: 'Etc/UTC' })]).travelDays.size).toBe(0);
    expect(
      picture([allDayEv('2026-10-28', '2026-10-29', { title: 'Investor Day at Capital Factory' })])
        .travelDays.size,
    ).toBe(0);
    expect(
      picture([allDayEv('2026-10-28', '2026-10-29', { title: 'Kids at School' })]).travelDays.size,
    ).toBe(0);
  });

  it('does not read a pitch from a travel startup as travel', () => {
    for (const title of [
      'Trip planning with Pat',
      'Airbnb alumni coffee',
      'Hotel Tonight founder call',
    ]) {
      // Meetings with other people: the default entry has a guest.
      expect(picture([ev({ title })]).travelDays.size, title).toBe(0);
    }
    // A flight is still a flight with someone else on it.
    expect(picture([ev({ title: 'Flight to Lakeport' })]).travelDays.size).toBe(1);
  });
});

describe('the same invite on two calendars (review fix)', () => {
  it('counts once toward stacks and the meeting cap', () => {
    const one = ev({ id: 'shared1', calendarId: 'primary', key: 'primary␟shared1' });
    const copy = { ...one, calendarId: 'family', key: 'family␟shared1' };
    expect(picture([one, copy]).busy).toHaveLength(1);
    // A copy under another id with the same time and title is the same entry too.
    expect(picture([one, { ...copy, id: 'other-id' }]).busy).toHaveLength(1);
    // Two different entries at the same time are two.
    expect(picture([one, ev({ title: 'Another sync' })]).busy).toHaveLength(2);
  });
});
