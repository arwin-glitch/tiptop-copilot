import { describe, expect, it } from 'vitest';
import {
  calendarZoneDiffers,
  daysCovered,
  eveningEnd,
  isBusyEntry,
  toBusyPicture,
} from '@/lib/booking/busy';
import { locationOutsideHome, namesHome, travelSign, type HomePlace } from '@/lib/booking/travel';
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
      ev({ verdict: { meeting: false, reason: 'A hold, not confirmed', with: [] }, hold: true }),
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
    expect(picture([ev({ title: 'Hotel check-in' })]).travelDays.has('2026-10-28')).toBe(true);
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
