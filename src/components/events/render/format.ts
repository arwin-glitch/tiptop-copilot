import { isAllowedHref } from '@/lib/campaigns/template';
import type {
  EventPublicFacts,
  EventSessionPublic,
  EventVenuePublic,
} from '@/lib/events/contracts';

/**
 * Dates, times and places as guests read them: always in the VENUE's time
 * zone (a "your time" hint is added on the client when the viewer is
 * elsewhere). Fixed 'en-US' so the server and Studio print the same thing.
 */

const LOCALE = 'en-US';

function safeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone }).format(0);
    return timeZone;
  } catch {
    return 'UTC';
  }
}

function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(
  iso: string | null | undefined,
  timeZone: string,
  style: 'long' | 'short' = 'long',
): string {
  const d = toDate(iso);
  if (!d) return '';
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: safeZone(timeZone),
    weekday: style === 'long' ? 'long' : 'short',
    month: style === 'long' ? 'long' : 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

export function formatTime(iso: string | null | undefined, timeZone: string): string {
  const d = toDate(iso);
  if (!d) return '';
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: safeZone(timeZone),
    hour: 'numeric',
    minute: '2-digit',
  })
    .format(d)
    .replace(':00', '');
}

/** "EST", "CST", "GMT+1": the zone's short name at that moment. */
export function zoneAbbrev(iso: string | null | undefined, timeZone: string): string {
  const d = toDate(iso) ?? new Date(0);
  const part = new Intl.DateTimeFormat(LOCALE, {
    timeZone: safeZone(timeZone),
    timeZoneName: 'short',
  })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? '';
}

/** "1–5 PM CST", "6 PM – 1 AM CST" or "1 PM CST". */
export function formatTimeRange(
  start: string | null | undefined,
  end: string | null | undefined,
  timeZone: string,
): string {
  const a = formatTime(start, timeZone);
  if (!a) return '';
  const zone = zoneAbbrev(start, timeZone);
  const b = formatTime(end, timeZone);
  if (!b) return `${a} ${zone}`.trim();
  const ap = a.slice(-2);
  const bp = b.slice(-2);
  const left = ap === bp ? a.slice(0, -3) : a;
  return `${left}–${b} ${zone}`.trim();
}

/** A compact date for chips and cards: "Mon, Jan 25". */
export function formatShortDate(iso: string | null | undefined, timeZone: string): string {
  const d = toDate(iso);
  if (!d) return '';
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: safeZone(timeZone),
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

/** Month + day parts for calendar-style badges. */
export function dateParts(
  iso: string | null | undefined,
  timeZone: string,
): { month: string; day: string; weekday: string; year: string } | null {
  const d = toDate(iso);
  if (!d) return null;
  const parts = new Intl.DateTimeFormat(LOCALE, {
    timeZone: safeZone(timeZone),
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    year: 'numeric',
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { month: get('month'), day: get('day'), weekday: get('weekday'), year: get('year') };
}

/** The event's overall when: "Monday, January 25, 2027 · 1–9 PM CST". */
export function eventWhen(facts: EventPublicFacts): { date: string; time: string } {
  return {
    date: formatDate(facts.startsAt, facts.timeZone),
    time: formatTimeRange(facts.startsAt, facts.endsAt, facts.timeZone),
  };
}

/** A session's when, in the venue zone. */
export function sessionWhen(session: EventSessionPublic, timeZone: string): string {
  const date = formatShortDate(session.startsAt, timeZone);
  const time = formatTimeRange(session.startsAt, session.endsAt, timeZone);
  return [date, time].filter(Boolean).join(' · ');
}

/** The venue's city-ish line for a postmark: the last comma part of the address, else its name. */
export function venueCity(venue: EventVenuePublic | null): string {
  if (!venue) return '';
  if (venue.address) {
    const parts = venue.address
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const city = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    return (city ?? '').replace(/\d{5}(-\d{4})?/, '').trim();
  }
  return venue.name ?? '';
}

/** Directions links that need no API key. Null when the address is not revealed. */
export function directionsLinks(
  venue: EventVenuePublic | null,
): { google: string; apple: string } | null {
  if (!venue || !venue.revealed) return null;
  const target =
    venue.lat !== null && venue.lng !== null ? `${venue.lat},${venue.lng}` : venue.address;
  if (!target) return null;
  const q = encodeURIComponent(target);
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${q}`,
    apple: `https://maps.apple.com/?daddr=${q}`,
  };
}

/** A facts-supplied URL, only when it is a link a guest may click. */
export function safeHref(href: string | null | undefined): string | null {
  return href && isAllowedHref(href) ? href : null;
}

/** The Maps embed URL for a revealed venue (loaded only on tap; frame-src allows google.com). */
export function mapEmbedUrl(venue: EventVenuePublic | null): string | null {
  if (!venue || !venue.revealed) return null;
  const target =
    venue.lat !== null && venue.lng !== null ? `${venue.lat},${venue.lng}` : venue.address;
  if (!target) return null;
  return `https://www.google.com/maps?q=${encodeURIComponent(target)}&output=embed`;
}

/** Access in plain words, for Key details. */
export function accessLabel(facts: EventPublicFacts): string {
  if (facts.access === 'invite_only') return 'By invitation';
  if (facts.access === 'approval') return 'Request to attend';
  return 'Open registration';
}
