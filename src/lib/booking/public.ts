import type { MeetingKind, MeetingType, Place } from './config';

/**
 * Exactly what the public booking page and its chatbot are given: the host's
 * public card, the meeting types on offer, the listed places, and open times.
 * Plain data, safe for any browser. Nothing in these shapes can hold a
 * calendar title, a guest, a description or an address book entry, and a
 * unit test walks every value the server returns to prove it.
 */

export interface PublicHost {
  displayName: string;
  title: string;
  bio: string;
  firmName: string;
  /** The app route that serves the uploaded photo, or null for initials. */
  photoUrl: string | null;
}

export interface PublicBookingPage {
  state: 'open' | 'closed';
  slug: string;
  host: PublicHost | null;
  hostTimeZone: string;
  offers: { call: boolean; inPerson: boolean };
  places: Place[];
  allowCustomPlace: boolean;
  kinds: MeetingKind[];
  /**
   * What a call is on, as a label ("Zoom call", "Google Meet"): never the
   * saved video link itself, which only goes in the invite (videoProviderLabel).
   */
  callProvider: string;
  chatbot: { enabled: boolean; mode: 'live' | 'guided' };
  /** The public FAQ text, for the guided helper's "About TipTop". */
  faq: string;
  /** A free time is booked at once (D-078); false when each waits for approval. */
  instant: boolean;
  /** "Add guests": whether a visitor may, and how many. */
  guests: { allowed: boolean; max: number };
}

export interface PublicSlot {
  start: string;
  end: string;
}

export interface PublicSlots {
  state: 'ok' | 'closed' | 'unavailable';
  type: MeetingType;
  kind: MeetingKind | null;
  hostTimeZone: string;
  slots: PublicSlot[];
  message?: string;
}

export const CLOSED_MESSAGE = 'This booking link is not taking bookings right now.';

export const UNAVAILABLE_MESSAGE =
  'Open times cannot be shown right now. You can leave a message instead.';

/**
 * What the visitor sees once a request is in. Copilot sends no email itself:
 * the calendar invitation comes from Google when the time is booked. No
 * person is named as confirming it.
 */
export const SENT_MESSAGE =
  "Request sent. You'll get a calendar invitation once the time is booked.";

/** A message left on the link. */
export const MESSAGE_SENT = 'Message sent.';

/** A booking made at once while calendar editing is off (D-078): the time is kept. */
export const HELD_MESSAGE = 'Your time is held. The calendar invitation is on its way.';

/** "You're booked with Nick". */
export function bookedTitle(hostName: string): string {
  const first = hostName.trim().split(/\s+/)[0];
  return first ? `You're booked with ${first}` : "You're booked";
}

/** What a visitor's booking came to (POST /api/meet/<slug>/request). */
export type BookingOutcomeStatus = 'booked' | 'held' | 'pending' | 'message';

/**
 * One booking as the visitor sees it, on the confirmation and on the
 * booking's own page (/meet/<slug>/b/<token>): what, when, where and who.
 * Only what the visitor typed or picked, the place, and the video link they
 * are invited to; never the host's calendar.
 */
export interface PublicBookingView {
  status: 'booked' | 'held' | 'pending' | 'cancelled' | 'declined';
  type: MeetingType;
  kind: MeetingKind | null;
  startsAt: string;
  endsAt: string;
  hostTimeZone: string;
  /** The zone the visitor booked in, when it named a real one. */
  visitorTimeZone: string | null;
  name: string;
  email: string;
  guests: string[];
  place: { name: string; area: string | null; mapUrl: string | null } | null;
  /** A call: how it is held ("Google Meet", "Zoom") and its link once there is one. */
  video: { label: string; url: string | null } | null;
  canReschedule: boolean;
  canCancel: boolean;
  reschedulesLeft: number;
  /** Something the calendar changed meanwhile, in plain words, or null. */
  notice: string | null;
}

/** The booking's own page: the host's card and the booking, or nothing at all. */
export interface PublicManagePage {
  state: 'ok' | 'not_found';
  slug: string;
  host: PublicHost | null;
  booking: PublicBookingView | null;
}

/** The answer to a booking: its status, and the booking's own page for a meeting. */
export interface PublicBookingResult {
  status: BookingOutcomeStatus;
  /** The booking's own page, a path on this site (`/meet/<slug>/b/<token>`). */
  manageUrl: string | null;
  booking: PublicBookingView | null;
}

/**
 * The cookie a visitor's device keeps its latest booking on a link in
 * (D-078): the booking page's token, httpOnly, sent only to that link's own
 * pages, so revisiting /meet/<slug> can say "You have a meeting with Nick".
 * Page scripts never read it.
 */
export function rememberCookieName(slug: string): string {
  return `tiptop_booking_${slug.replace(/[^a-z0-9]/g, '_')}`;
}

/** What the booking page shows for a remembered booking: when, and its own page. */
export interface RememberedBooking {
  manageUrl: string;
  startsAt: string;
  type: MeetingType;
  kind: MeetingKind | null;
}

/* ------------------------------------------------------------ video calls */

/**
 * What a saved video link is, as words for the public page, its routes and
 * its chatbot, which never see the link itself (it goes only in the invite):
 * "Zoom call" for zoom.us and its subdomains, "Google Meet",
 * "Microsoft Teams call", else "Video call". No link means Google Meet, the
 * invite's own.
 */
export function videoProviderLabel(url: string | null | undefined): string {
  const raw = (url ?? '').trim();
  if (!raw) return 'Google Meet';
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return 'Video call';
  }
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'Zoom call';
  if (host === 'meet.google.com') return 'Google Meet';
  if (host === 'teams.microsoft.com' || host === 'teams.live.com') return 'Microsoft Teams call';
  return 'Video call';
}

/** The call option's name: "30-min Zoom call", "30-min Google Meet". */
export function callOptionLabel(provider: string): string {
  return `30-min ${provider || 'Google Meet'}`;
}

/* ------------------------------------------------------------- formatting */

function partsIn(iso: string, zone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone, ...options }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(new Date(iso));
  }
}

/** "Tue, Oct 27". */
export function dayLabel(iso: string, zone: string): string {
  return partsIn(iso, zone, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "9:30 AM". */
export function timeLabel(iso: string, zone: string): string {
  return partsIn(iso, zone, { hour: 'numeric', minute: '2-digit' });
}

/** "Tue, Oct 27, 9:30 AM". */
export function slotLabel(iso: string, zone: string): string {
  return `${dayLabel(iso, zone)}, ${timeLabel(iso, zone)}`;
}

/** The day key a slot falls on in a zone, for grouping by the visitor's days. */
export function dayKeyIn(iso: string, zone: string): string {
  return partsIn(iso, zone, { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(
    /^(\d{2})\/(\d{2})\/(\d{4})$/,
    '$3-$1-$2',
  );
}

/** "Chicago" from "America/Chicago", "Port Moresby" from "Pacific/Port_Moresby". */
function zoneCity(zone: string): string | null {
  const last = zone.split('/').pop();
  return zone.includes('/') && last ? last.replace(/_/g, ' ') : null;
}

/**
 * "Central Time (Chicago)": the zone's generic name, which is right in summer
 * and winter alike (never "Daylight" for a November slot), and its city, so
 * two zones with the same generic name can be told apart. Else the IANA name.
 */
export function zoneName(zone: string, at: Date = new Date()): string {
  if (/^(utc|etc\/utc|etc\/gmt|gmt)$/i.test(zone)) return 'UTC';
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    if (!part) return zone;
    const city = zoneCity(zone);
    return city && !part.toLowerCase().includes(city.toLowerCase()) ? `${part} (${city})` : part;
  } catch {
    return zone;
  }
}

/** Zones for a picker, one per label: two names for the same place are offered once. */
export function distinctZones(zones: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const zone of zones) {
    if (!knownZone(zone)) continue;
    const label = zoneName(zone);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(zone);
  }
  return out;
}

/** Whether a zone name is one this browser or server knows. */
export function knownZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
