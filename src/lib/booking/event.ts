import type { EventDraft } from '@/lib/calendar/edit-rules';
import { firstName, KIND_LABEL, type MeetingKind, type MeetingType } from './config';
import type { BookingRequest } from '@/lib/types/domain';
import { slotLabel, zoneName } from './public';

/**
 * What an approved booking request becomes on the host's calendar, and the
 * two fallbacks around it: a prefilled Google Calendar link when Copilot may
 * not write to the calendar, and a decline email for the person to read,
 * change and send themselves. Pure: the same request always gives the same
 * event, which the tests pin field by field.
 *
 * A call goes on the host's saved video link (Settings > Booking link) when
 * there is one, in the location and the description, and on Google Meet
 * otherwise. The link appears only here, in the invite.
 */

export interface BookingEventOptions {
  /** The host's saved video link for calls; '' (or none) for Google Meet. */
  callLink?: string | null;
  /** The host's main calendar address: on the guest list as the organizer. */
  hostEmail?: string | null;
}

/** The video link a request's event uses: a call's saved link, else none. */
function videoLinkFor(request: Pick<ApprovableRequest, 'type'>, callLink?: string | null): string {
  return request.type === 'call' ? (callLink ?? '').trim() : '';
}

/**
 * Visitor text as it goes into the event: angle brackets turned into their
 * look-alikes, so no tag a visitor typed is ever HTML in Google Calendar
 * (which reads a description as HTML). Request text is stripped of them when
 * it is sent; this also covers a row kept before that.
 */
export function inert(text: string): string {
  return text.replace(/</g, '‹').replace(/>/g, '›');
}

export interface ApprovableRequest {
  type: MeetingType;
  kind: MeetingKind | null;
  starts_at: string;
  ends_at: string;
  name: string;
  email: string;
  company: string | null;
  place_name: string | null;
  place_area: string | null;
  place_map_url: string | null;
  note: string | null;
  deck_url: string | null;
  /** Guests the visitor added (D-078), invited with them. */
  guests?: readonly string[];
  /**
   * The booking's own page (D-078), where the visitor can reschedule or
   * cancel: its URL carries the token, so it goes in the description alone
   * (the people invited are the people the page is for) and nowhere else.
   */
  manageUrl?: string | null;
}

/**
 * The line every booked event's description ends with, before the booking's
 * own page (D-078): the link guests use to move or cancel it. Another tool's
 * reschedule line (Fyxer's, say) is taken back out (lib/services/booking-sync.ts).
 */
export const MANAGE_LINE = 'Need to reschedule or cancel?';

/**
 * Another scheduling tool's reschedule or cancel link in an event's
 * description: Fyxer edits events its user organizes a few seconds after
 * they are made ("Need to reschedule? Choose a new time" on app.fyxer.com),
 * and Vimcal and Calendly add their own. On a booking-link event the only
 * such line is the booking's own page.
 */
export const THIRD_PARTY_RESCHEDULE =
  /https?:\/\/[^\s"'<>]*(?:fyxer\.com|vimcal\.com|calendly\.com\/(?:reschedulings|cancellations))/i;

/** Whether a description carries another tool's reschedule or cancel link. */
export function hasThirdPartyReschedule(description: string | null | undefined): boolean {
  return Boolean(description && THIRD_PARTY_RESCHEDULE.test(description));
}

/** The booking pages a description links to, by token (`/meet/<slug>/b/<token>`). */
export function manageTokensIn(description: string | null | undefined): string[] {
  if (!description) return [];
  return [...description.matchAll(/\/meet\/[a-z0-9-]+\/b\/([A-Za-z0-9_-]{43})/g)].map((m) => m[1]!);
}

/** A stored booking as the event is built from it (D-078), with its page's link. */
export function linkRequestFromRow(
  row: Pick<
    BookingRequest,
    | 'meeting_type'
    | 'kind'
    | 'starts_at'
    | 'ends_at'
    | 'name'
    | 'email'
    | 'company'
    | 'place_name'
    | 'place_area'
    | 'place_map_url'
    | 'note'
    | 'deck_url'
    | 'guest_emails'
  >,
  manageUrl: string | null,
): ApprovableRequest {
  return {
    type: row.meeting_type === 'in_person' ? 'in_person' : 'call',
    kind: row.kind,
    starts_at: row.starts_at ?? '',
    ends_at: row.ends_at ?? '',
    name: row.name,
    email: row.email,
    company: row.company,
    place_name: row.place_name,
    place_area: row.place_area,
    place_map_url: row.place_map_url,
    note: row.note,
    deck_url: row.deck_url,
    guests: row.guest_emails ?? [],
    manageUrl,
  };
}

/**
 * "Sam <> Pat Lee (Acme)": the host's first name, the requester and their
 * company, with "Coffee: " (or "Lunch: ", "Dinner: ") in front for an
 * in-person meeting.
 */
export function bookingTitle(hostName: string, request: ApprovableRequest): string {
  const company = inert(request.company?.trim() ?? '');
  const name = inert(request.name.trim());
  const who = company ? `${name} (${company})` : name;
  const base = `${firstName(hostName) || 'Meeting'} <> ${who}`;
  return request.type === 'in_person' && request.kind
    ? `${KIND_LABEL[request.kind]}: ${base}`
    : base;
}

/**
 * Where to meet, as one line: the place's name and area, or what the visitor
 * suggested; for a call, the saved video link (none for Google Meet).
 */
export function bookingLocation(request: ApprovableRequest, callLink?: string | null): string {
  if (request.type !== 'in_person') return inert(videoLinkFor(request, callLink));
  return inert(
    [request.place_name, request.place_area]
      .map((p) => p?.trim())
      .filter(Boolean)
      .join(', '),
  );
}

export function bookingDescription(request: ApprovableRequest, callLink?: string | null): string {
  const lines = ['Booked through the booking link.'];
  const video = videoLinkFor(request, callLink);
  if (video) lines.push('', `Join the call: ${video}`);
  if (request.note?.trim()) lines.push('', request.note.trim());
  if (request.deck_url?.trim()) lines.push('', `Deck: ${request.deck_url.trim()}`);
  if (request.type === 'in_person' && request.place_map_url) {
    lines.push('', `Map: ${request.place_map_url}`);
  }
  if (request.manageUrl) lines.push('', `${MANAGE_LINE} ${request.manageUrl}`);
  return inert(lines.join('\n'));
}

/**
 * Everyone the event invites besides the host: the visitor first, then their
 * guests, lower-cased and once each (never the host's own address, who is on
 * it as the organizer).
 */
export function bookingGuests(
  request: Pick<ApprovableRequest, 'email' | 'guests'>,
  hostEmail?: string | null,
): string[] {
  const host = hostEmail?.trim().toLowerCase() ?? '';
  const out: string[] = [];
  for (const raw of [request.email, ...(request.guests ?? [])]) {
    const email = raw.trim().toLowerCase();
    if (email && email !== host && !out.includes(email)) out.push(email);
  }
  return out;
}

/**
 * The event to create on the host's main calendar: the host on the guest
 * list as its organizer (accepted), the requester and their guests invited.
 * A call gets a Google Meet only when no video link is saved.
 */
export function bookingEventDraft(
  hostName: string,
  request: ApprovableRequest,
  hostZone: string,
  options: BookingEventOptions = {},
): EventDraft {
  const video = videoLinkFor(request, options.callLink);
  const host = options.hostEmail?.trim().toLowerCase();
  return {
    title: bookingTitle(hostName, request),
    allDay: false,
    start: new Date(request.starts_at).toISOString(),
    end: new Date(request.ends_at).toISOString(),
    timeZone: hostZone,
    description: bookingDescription(request, video),
    location: bookingLocation(request, video),
    guests: bookingGuests(request, host),
    ...(host ? { organizerEmail: host } : {}),
    meet: request.type === 'call' && !video,
  };
}

const compact = (iso: string) =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/**
 * Google Calendar's "create event" page, filled in: what to open when
 * Copilot may not write to the calendar itself. Nothing is saved until the
 * person saves it there.
 */
export function googleCalendarTemplateUrl(
  hostName: string,
  request: ApprovableRequest,
  hostZone: string,
  options: BookingEventOptions = {},
): string {
  const video = videoLinkFor(request, options.callLink);
  // The host too, so the event names them whoever's calendar it is saved in.
  const guests = [options.hostEmail?.trim().toLowerCase() ?? '', ...bookingGuests(request)].filter(
    (e, i, all) => e && all.indexOf(e) === i,
  );
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: bookingTitle(hostName, request),
    dates: `${compact(request.starts_at)}/${compact(request.ends_at)}`,
    details: bookingDescription(request, video),
    ctz: hostZone,
    add: guests.join(','),
  });
  const location = bookingLocation(request, video);
  if (location) params.set('location', location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * A short, polite decline for the person to read and send from the compose
 * window, written as Arwin (the compose window opens on Arwin's signature).
 * It promises nothing and names no other time. The time is said in the
 * visitor's own zone, with the zone named.
 */
export function declineDraft(
  hostName: string,
  request: Pick<ApprovableRequest, 'name' | 'email' | 'starts_at'> & { type: string },
  zone: string,
): { to: string; subject: string; body: string } {
  const first = firstName(request.name) || 'there';
  const host = firstName(hostName);
  const withHost = host ? ` with ${host}` : '';
  const toHost = host ? ` to ${host}` : '';
  const when =
    request.type === 'message' || !request.starts_at
      ? null
      : `${slotLabel(request.starts_at, zone)} (${zoneName(zone)})`;
  const body = [
    `Hi ${first},`,
    '',
    when
      ? `Thank you for asking to meet${withHost}. The ${when} time doesn't work, so I won't be booking it.`
      : `Thank you for your note${toHost}. I've passed it on.`,
    '',
    'Thanks for understanding,',
  ].join('\n');
  return {
    to: request.email,
    subject: when ? `Your meeting request${withHost}` : `Your note${toHost}`,
    body,
  };
}

/* ------------------------------------------------------------- .ics file */

export interface IcsEvent {
  /** Stable for one booking, so a second download updates the first. */
  uid: string;
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  url?: string | null;
}

/** RFC 5545 text: backslash, semicolon, comma and line breaks escaped. */
function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Lines folded at 75 octets (here characters, a safe reading), as the format asks. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  for (let i = 0; i < line.length; i += 74) parts.push((i ? ' ' : '') + line.slice(i, i + 74));
  return parts.join('\r\n');
}

/**
 * An "Add to calendar" file for the visitor: one event, in UTC, with the
 * booking page's link. Pure, so the page builds it in the browser and
 * nothing is fetched for it.
 */
export function icsFile(event: IcsEvent, stamp: Date = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TipTop Copilot//Booking link//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsText(event.uid)}`,
    `DTSTAMP:${compact(stamp.toISOString())}`,
    `DTSTART:${compact(event.start)}`,
    `DTEND:${compact(event.end)}`,
    `SUMMARY:${icsText(event.title)}`,
    ...(event.description ? [`DESCRIPTION:${icsText(event.description)}`] : []),
    ...(event.location ? [`LOCATION:${icsText(event.location)}`] : []),
    ...(event.url ? [`URL:${event.url.replace(/[\r\n]/g, '')}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
