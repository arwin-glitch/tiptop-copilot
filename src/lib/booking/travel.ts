import { localClock } from '@/lib/util/time';

/**
 * Travel signs: is the host away from home on a day? In-person meetings are
 * offered only on days he is home, so every sign here errs towards "away" —
 * a lost in-person slot costs a visitor a click, a coffee booked while he is
 * on a plane costs a lot more. Pure; reads only an entry's title, place,
 * kind and time zone, on the server, and returns yes or no.
 *
 * The signs (any one is enough):
 * - Google put it there from a booking email (eventType `fromGmail`: a
 *   flight, a hotel, a reservation).
 * - Its title says travel: a flight, an airport, a hotel, a red-eye, a trip.
 * - An all-day entry that reads like being away: a stay, a trip, a
 *   conference, out of office, "in Denver".
 * - It is somewhere outside the home city (an address naming another city,
 *   or an airport).
 * - The host made it himself in another time zone.
 */

export interface HomePlace {
  city: string;
  aliases: readonly string[];
  /** Names and areas of the places on the host's list: always home. */
  places: readonly { name: string; area: string }[];
}

const TRAVEL_TITLE =
  /\b(flights?|airport|hotel|motel|airbnb|red[- ]?eye|layover|travel(?:l?ing)?|trip)\b/i;

const AWAY_ALL_DAY =
  /\b(stay|staying|trip|travel(?:l?ing)?|vacation|ooo|out of (?:the )?office|offsite|off-site|conference|summit|retreat|pto|away)\b/i;

/** "Nick in Denver", "Team at Lakeview": a capitalised place after in/at. */
const IN_PLACE = /\b(?:in|at)\s+([A-Z][\w.'&-]*(?:\s+[A-Z][\w.'&-]*){0,2})/;

const AIRPORT = /\b(airport|terminal\s+[A-Z0-9]+|gate\s+[A-Z]?\d+[A-Z]?)\b/i;

/** Address parts that are not a city: rooms, floors, suites, streets. */
const NOT_A_CITY =
  /\b(floor|fl|suite|ste|room|rm|unit|apt|building|bldg|level|lobby|desk|office|hq|street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl|parkway|pkwy|highway|hwy|square|sq|hall|wing|campus)\b/i;

const COUNTRY =
  /^(usa|u\.s\.a\.|us|u\.s\.|united states(?: of america)?|canada|mexico|uk|united kingdom|england|ireland|germany|france|spain|portugal|italy|netherlands|switzerland|japan|singapore|australia|india|philippines|brazil)$/i;

function words(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/** Whether a piece of text names home: the city, an alias, or one of the listed places. */
export function namesHome(text: string, home: HomePlace): boolean {
  const haystack = words(text);
  const names = [
    home.city,
    ...home.aliases,
    ...home.places.flatMap((p) => [p.name, p.area]),
  ].filter((n) => n.trim().length >= 2);
  return names.some((name) => {
    const needle = words(name).trim();
    return needle.length > 0 && haystack.includes(` ${needle} `);
  });
}

/**
 * A place somewhere other than the home city: an airport, or an address
 * whose city part names some other city. A place with no city in it
 * ("Blue Bottle", "Conference room B") is not a sign either way.
 */
export function locationOutsideHome(location: string | null | undefined, home: HomePlace): boolean {
  const text = location?.trim();
  if (!text || !home.city.trim()) return false;
  if (namesHome(text, home)) return false;
  if (AIRPORT.test(text)) return true;
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return false;
  return parts.slice(1).some((raw) => {
    // "TX 78701", "78701", "TX": a state and a post code are not a city.
    const part = raw
      .replace(/\b\d{5}(?:-\d{4})?\b/g, '')
      .replace(/^\s*[A-Z]{2}\s*$/, '')
      .trim();
    if (!part || COUNTRY.test(part)) return false;
    if (/\d/.test(part) || NOT_A_CITY.test(part)) return false;
    if (/^[A-Z]{2,3}$/.test(part)) return false;
    return /^[A-Z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}$/.test(part);
  });
}

/** Whether two zones show the same wall clock at an instant. */
export function sameClock(instant: Date, a: string, b: string): boolean {
  try {
    const x = localClock(instant, a);
    const y = localClock(instant, b);
    return x.dateKey === y.dateKey && x.hour === y.hour && x.minute === y.minute;
  } catch {
    // An unknown zone name says nothing either way.
    return true;
  }
}

export interface TravelInput {
  title: string;
  allDay: boolean;
  /** A real place (not a link or a dial-in), when it has one. */
  place: string | null;
  eventType: string | null;
  /** The entry's own time zone, when Google has one for it. */
  timeZone: string | null;
  /** The host made it (organizer is him, or nobody). */
  ownEntry: boolean;
  /** When it starts, for the time-zone check. */
  startsAt: string | null;
}

/** Whether one entry says the host is away on the days it covers. */
export function travelSign(entry: TravelInput, home: HomePlace, hostZone: string): boolean {
  if (entry.eventType === 'fromGmail') return true;
  if (TRAVEL_TITLE.test(entry.title)) return true;
  if (entry.allDay) {
    if (AWAY_ALL_DAY.test(entry.title)) return true;
    const named = IN_PLACE.exec(entry.title)?.[1];
    if (named && !namesHome(named, home)) return true;
  }
  if (locationOutsideHome(entry.place, home)) return true;
  if (entry.ownEntry && entry.timeZone && entry.startsAt && !entry.allDay) {
    const at = new Date(entry.startsAt);
    if (Number.isFinite(at.getTime()) && !sameClock(at, entry.timeZone, hostZone)) return true;
  }
  return false;
}
