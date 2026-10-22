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
 * - Its title says he is in transit: a flight, an airport, a red-eye, a
 *   layover, a ✈. Read on any entry, a meeting with others included.
 * - Its title says travel in a weaker way (a hotel, an Airbnb, a trip,
 *   "fly to", a flight number like "UA 1234", a route like "AUS → SFO"), on
 *   an entry that is not a meeting with other people: "Trip planning with
 *   Pat" or "Hotel Tonight founder call" are pitches, not travel.
 * - An all-day entry that reads like being away: a stay, a trip, a
 *   conference, out of office, "in Denver"; or one he made himself, not a
 *   meeting, that says "in Denver".
 * - It is somewhere outside the home city: an airport (the home city's
 *   too: he is flying), or an address whose city part names another city.
 * - The host made it himself in another time zone (UTC and its aliases say
 *   nothing: some scheduling tools write every entry in UTC).
 */

export interface HomePlace {
  city: string;
  aliases: readonly string[];
  /** Names and areas of the places on the host's list: always home. */
  places: readonly { name: string; area: string }[];
}

/** In transit, whoever else is on it. */
const STRONG_TRAVEL_TITLE = /\b(flights?|airport|red[- ]?eye|layover)\b|✈/i;

/** Travel words that are also startup names and meeting topics: read only off meetings. */
const WEAK_TRAVEL_TITLE = /\b(hotel|motel|airbnb|travel(?:l?ing)?|trip|fly|flying)\b/i;

/**
 * "UA 1234", "AA100", "DL 45": two capital letters and a flight number.
 * Not a year ("FY 2026", "H2 2027"), and not the usual "FY", "Q3" or "PR" tags.
 */
const FLIGHT_NUMBER = /\b(?!(?:FY|CY|PR|OK)\s?\d)[A-Z]{2}\s?(?!(?:19|20)\d{2}\b)\d{2,4}\b/;

/** "AUS-SFO", "AUS → SFO", "JFK to LHR": two airport codes and a route between them. */
const AIRPORT_ROUTE = /\b[A-Z]{3}\s*(?:→|->|–|—|-|to)\s*[A-Z]{3}\b/;

const AWAY_ALL_DAY =
  /\b(stay|staying|trip|travel(?:l?ing)?|vacation|ooo|out of (?:the )?office|offsite|off-site|conference|summit|retreat|pto|away)\b/i;

/** "Nick in Denver": a capitalised place after "in". */
const IN_PLACE = /\bin\s+([A-Z][\w.'&-]*(?:\s+[A-Z][\w.'&-]*){0,2})/;

/** What an "in X" names when it is not a city: a room, a call, a channel. */
const IN_NOT_A_PLACE =
  /\b(room|office|hq|person|zoom|meet|teams|slack|google|hangouts|webex|call|town|progress|review|private|library|gym|studio|lab|kitchen|garage|car|lobby|cafe|park|school|class|session|focus|mode)\b/i;

/** An airport, a terminal or a gate. Not an "Airport Blvd" address. */
const AIRPORT =
  /\b(airport(?!\s+(?:blvd|boulevard|rd|road|st|street|dr|drive|way|ave|avenue|pkwy|parkway|hwy|highway|center|centre|plaza|commerce|freeway|fwy)\b)|terminal\s+[A-Z0-9]+|gate\s+[A-Z]?\d+[A-Z]?)\b/i;

/** Address parts that are not a city: rooms, floors, suites, streets. */
const NOT_A_CITY =
  /\b(floor|fl|suite|ste|room|rm|unit|apt|building|bldg|level|lobby|desk|office|hq|street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl|parkway|pkwy|highway|hwy|square|sq|hall|wing|campus)\b/i;

/** A street address part: a house number first, or a street word last. */
const STREET_PART =
  /^\d+[A-Za-z]?\s+\S|\b(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl|parkway|pkwy|highway|hwy|square|sq)\.?$/i;

const COUNTRY =
  /^(usa|u\.s\.a\.|us|u\.s\.|united states(?: of america)?|canada|mexico|uk|u\.k\.|united kingdom|england|scotland|wales|ireland|germany|france|spain|portugal|italy|netherlands|belgium|switzerland|austria|sweden|norway|denmark|finland|poland|japan|china|korea|south korea|taiwan|hong kong|singapore|australia|new zealand|india|philippines|indonesia|vietnam|thailand|malaysia|brazil|argentina|chile|colombia|israel|uae|united arab emirates|south africa|nigeria|kenya)$/i;

const US_STATE =
  /^(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|ontario|quebec|british columbia|alberta)$/i;

/** Zones that name no place: an entry written in one says nothing about where he is. */
const PLACELESS_ZONE = /^(utc|gmt|uct|universal|zulu|etc\/.*)$/i;

function words(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

function namesAny(text: string, names: readonly string[]): boolean {
  const haystack = words(text);
  return names
    .filter((n) => n.trim().length >= 2)
    .some((name) => {
      const needle = words(name).trim();
      return needle.length > 0 && haystack.includes(` ${needle} `);
    });
}

/** Whether a piece of text names home: the city, an alias, or one of the listed places. */
export function namesHome(text: string, home: HomePlace): boolean {
  return namesAny(text, [
    home.city,
    ...home.aliases,
    ...home.places.flatMap((p) => [p.name, p.area]),
  ]);
}

/** A state, a province, a post code or a country: what follows a city in an address. */
function isRegionPart(raw: string): boolean {
  const part = raw
    .replace(/\b\d{5}(?:-\d{4})?\b/g, '')
    .replace(/\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/g, '')
    .trim();
  if (!part) return /\d/.test(raw);
  return /^[A-Z]{2}$/.test(part) || COUNTRY.test(part) || US_STATE.test(part);
}

/** A part shaped like a city name: capitalised words, no numbers, no room or street word. */
function looksLikeCity(part: string): boolean {
  if (!part || /\d/.test(part) || NOT_A_CITY.test(part)) return false;
  if (COUNTRY.test(part) || /^[A-Z]{2,3}$/.test(part)) return false;
  return /^[A-Z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}$/.test(part);
}

/**
 * A place somewhere other than the home city: an airport, or an address
 * whose city part names some other city. A city part is one followed by a
 * state, post code or country ("New York, NY", "Lakeport, CA 94000"), or the
 * last part after a street address ("9 Pier Rd, Lakeport"). A venue and its
 * neighbourhood ("Blue Bottle, Downtown") or a place with no city in it
 * ("Conference room B") is not a sign either way.
 */
export function locationOutsideHome(location: string | null | undefined, home: HomePlace): boolean {
  const text = location?.trim();
  if (!text || !home.city.trim()) return false;
  // A listed place is home, whatever else its name says.
  if (
    namesAny(
      text,
      home.places.map((p) => p.name),
    )
  )
    return false;
  // At an airport he is flying, the home city's airport included.
  if (AIRPORT.test(text)) return true;
  if (namesHome(text, home)) return false;
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const followedByRegion = i + 1 < parts.length && isRegionPart(parts[i + 1]!);
    const afterStreet =
      i > 0 && STREET_PART.test(parts[i - 1]!) && (i === parts.length - 1 || followedByRegion);
    if ((followedByRegion || afterStreet) && looksLikeCity(parts[i]!)) return true;
  }
  return false;
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
  /** Copilot's Meeting verdict: a meeting with other people. */
  meeting: boolean;
}

/** "Nick in Denver": names a place that is not home. */
function inSomewhereElse(title: string, home: HomePlace): boolean {
  const named = IN_PLACE.exec(title)?.[1];
  return Boolean(named && !IN_NOT_A_PLACE.test(named) && !namesHome(named, home));
}

/**
 * In transit: a Gmail booking, or a title that says flight, airport,
 * red-eye, layover or a flight number. Such an entry holds the host's time
 * even when it is marked free (lib/booking/busy.ts): he is on a plane.
 */
export function inTransitSign(
  entry: Pick<TravelInput, 'title' | 'eventType' | 'meeting'>,
): boolean {
  if (entry.eventType === 'fromGmail') return true;
  if (STRONG_TRAVEL_TITLE.test(entry.title)) return true;
  return !entry.meeting && FLIGHT_NUMBER.test(entry.title);
}

/** Whether one entry says the host is away on the days it covers. */
export function travelSign(entry: TravelInput, home: HomePlace, hostZone: string): boolean {
  if (inTransitSign(entry)) return true;
  if (!entry.meeting) {
    if (WEAK_TRAVEL_TITLE.test(entry.title) || AIRPORT_ROUTE.test(entry.title)) return true;
  }
  if (entry.allDay) {
    if (AWAY_ALL_DAY.test(entry.title)) return true;
    if (inSomewhereElse(entry.title, home)) return true;
  } else if (entry.ownEntry && !entry.meeting && inSomewhereElse(entry.title, home)) {
    return true;
  }
  if (locationOutsideHome(entry.place, home)) return true;
  if (
    entry.ownEntry &&
    entry.timeZone &&
    !PLACELESS_ZONE.test(entry.timeZone) &&
    entry.startsAt &&
    !entry.allDay
  ) {
    const at = new Date(entry.startsAt);
    if (Number.isFinite(at.getTime()) && !sameClock(at, entry.timeZone, hostZone)) return true;
  }
  return false;
}

/** A title that says he is on his way home, so the days after it are home again. */
const HOMEWARD = /\b(home|homeward|return(?:ing)?|back)\b/i;

/** Whether a travel entry takes the host home: "Flight home", "Flight to Harbor City". */
export function homewardSign(entry: Pick<TravelInput, 'title'>, home: HomePlace): boolean {
  return HOMEWARD.test(entry.title) || namesHome(entry.title, home);
}
