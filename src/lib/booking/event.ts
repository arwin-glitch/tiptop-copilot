import type { EventDraft } from '@/lib/calendar/edit-rules';
import { firstName, KIND_LABEL, type MeetingKind, type MeetingType } from './config';
import { slotLabel } from './public';

/**
 * What an approved booking request becomes on the host's calendar, and the
 * two fallbacks around it: a prefilled Google Calendar link when Copilot may
 * not write to the calendar, and a decline email for the person to read,
 * change and send themselves. Pure: the same request always gives the same
 * event, which the tests pin field by field.
 */

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
  const company = request.company?.trim();
  const name = request.name.trim();
  const who = company ? `${name} (${company})` : name;
  const base = `${firstName(hostName) || 'Meeting'} <> ${who}`;
  return request.type === 'in_person' && request.kind
    ? `${KIND_LABEL[request.kind]}: ${base}`
    : base;
}

/** Where to meet, as one line: the place's name and area, or what the visitor suggested. */
export function bookingLocation(request: ApprovableRequest): string {
  if (request.type !== 'in_person') return '';
  return [request.place_name, request.place_area]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(', ');
}

export function bookingDescription(request: ApprovableRequest): string {
  const lines = ['Booked through the booking link.'];
  if (request.note?.trim()) lines.push('', request.note.trim());
  if (request.deck_url?.trim()) lines.push('', `Deck: ${request.deck_url.trim()}`);
  if (request.type === 'in_person' && request.place_map_url) {
    lines.push('', `Map: ${request.place_map_url}`);
  }
  return lines.join('\n');
}

/** The event to create on the host's main calendar, the requester invited. */
export function bookingEventDraft(
  hostName: string,
  request: ApprovableRequest,
  hostZone: string,
): EventDraft {
  return {
    title: bookingTitle(hostName, request),
    allDay: false,
    start: new Date(request.starts_at).toISOString(),
    end: new Date(request.ends_at).toISOString(),
    timeZone: hostZone,
    description: bookingDescription(request),
    location: bookingLocation(request),
    guests: [request.email.trim().toLowerCase()],
    meet: request.type === 'call',
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
): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: bookingTitle(hostName, request),
    dates: `${compact(request.starts_at)}/${compact(request.ends_at)}`,
    details: bookingDescription(request),
    ctz: hostZone,
    add: request.email.trim().toLowerCase(),
  });
  const location = bookingLocation(request);
  if (location) params.set('location', location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * A short, polite decline for the person to read and send from the compose
 * window. It promises nothing and names no other time.
 */
export function declineDraft(
  hostName: string,
  request: Pick<ApprovableRequest, 'name' | 'email' | 'starts_at'> & { type: string },
  zone: string,
): { to: string; subject: string; body: string } {
  const first = firstName(request.name) || 'there';
  const host = firstName(hostName) || 'Nick';
  const when =
    request.type === 'message' || !request.starts_at ? null : slotLabel(request.starts_at, zone);
  const body = [
    `Hi ${first},`,
    '',
    when
      ? `Thank you for asking to meet with ${host}. He isn't able to take the ${when} time, so I won't be booking it.`
      : `Thank you for your note to ${host}. He has it.`,
    '',
    'Thanks for understanding,',
  ].join('\n');
  return {
    to: request.email,
    subject: when ? `Your meeting request with ${host}` : `Your note to ${host}`,
    body,
  };
}
