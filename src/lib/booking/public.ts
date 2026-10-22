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
  chatbot: { enabled: boolean; mode: 'live' | 'guided' };
  /** The public FAQ text, for the guided helper's "About TipTop". */
  faq: string;
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
  'Open times cannot be shown right now. Leave a message instead and Arwin will reply by email.';

/** The confirmation the visitor sees. Copilot sends no email itself. */
export const SENT_MESSAGE = 'Request sent. Arwin will confirm by email.';

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

/** "Central Time" style name for a zone, else the IANA name. */
export function zoneName(zone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'long' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    return part ?? zone;
  } catch {
    return zone;
  }
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
