/**
 * Add-to-calendar and directions links for the ticket (D-075). No API keys:
 * Google Calendar's template URL, Outlook's compose deep link, and Google /
 * Apple Maps directions.
 *
 * The personal link (it carries the guest's token) goes only into the ICS
 * file we serve ourselves, never into a query string sent to a third party;
 * these links carry the public page address instead.
 *
 * Pure: no I/O.
 */

export interface CalendarLinkInput {
  title: string;
  startsAt: string;
  endsAt: string | null;
  details: string;
  /** Already filtered by the reveal rule. */
  location: string | null;
}

function compactUtc(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function endOf(input: CalendarLinkInput): Date {
  const start = new Date(input.startsAt);
  const end = input.endsAt ? new Date(input.endsAt) : null;
  return end && end.getTime() > start.getTime() ? end : new Date(start.getTime() + 3_600_000);
}

export function googleCalendarUrl(input: CalendarLinkInput): string {
  const url = new URL('https://calendar.google.com/calendar/render');
  url.searchParams.set('action', 'TEMPLATE');
  url.searchParams.set('text', input.title);
  url.searchParams.set(
    'dates',
    `${compactUtc(new Date(input.startsAt))}/${compactUtc(endOf(input))}`,
  );
  if (input.details) url.searchParams.set('details', input.details);
  if (input.location) url.searchParams.set('location', input.location);
  return url.toString();
}

export function outlookCalendarUrl(input: CalendarLinkInput): string {
  const url = new URL('https://outlook.office.com/calendar/0/action/compose');
  url.searchParams.set('subject', input.title);
  url.searchParams.set('startdt', new Date(input.startsAt).toISOString());
  url.searchParams.set('enddt', endOf(input).toISOString());
  if (input.details) url.searchParams.set('body', input.details);
  if (input.location) url.searchParams.set('location', input.location);
  return url.toString();
}

export interface DirectionsInput {
  address: string | null;
  name: string | null;
  lat: number | null;
  lng: number | null;
}

function destination(input: DirectionsInput): string | null {
  if (input.lat !== null && input.lng !== null) return `${input.lat},${input.lng}`;
  const text = [input.name, input.address].filter(Boolean).join(', ').trim();
  return text || null;
}

export function googleDirectionsUrl(input: DirectionsInput): string | null {
  const dest = destination(input);
  if (!dest) return null;
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('destination', dest);
  return url.toString();
}

export function appleDirectionsUrl(input: DirectionsInput): string | null {
  const dest = destination(input);
  if (!dest) return null;
  const url = new URL('https://maps.apple.com/');
  url.searchParams.set('daddr', dest);
  return url.toString();
}

/** One line for LOCATION / location=: "The Lantern Hall, 100 Example Avenue". */
export function locationLine(
  venue: { name: string | null; address: string | null } | null,
): string | null {
  if (!venue) return null;
  const text = [venue.name, venue.address].filter(Boolean).join(', ').trim();
  return text || null;
}
