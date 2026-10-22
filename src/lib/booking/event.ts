import type { EventDraft } from '@/lib/calendar/edit-rules';
import { firstName, KIND_LABEL, type MeetingKind, type MeetingType } from './config';
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
  return inert(lines.join('\n'));
}

/**
 * The event to create on the host's main calendar: the host on the guest
 * list as its organizer (accepted), the requester invited. A call gets a
 * Google Meet only when no video link is saved.
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
    guests: [request.email.trim().toLowerCase()].filter((email) => email !== host),
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
  const guests = [options.hostEmail, request.email]
    .map((e) => e?.trim().toLowerCase() ?? '')
    .filter((e, i, all) => e && all.indexOf(e) === i);
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
