/**
 * What the new Calendar views get from the server: Nick's calendars with
 * Google's own names and colours, and every event in the visible range with
 * Copilot's Meeting/Block verdict on it. Plain data, safe for the browser.
 */

export type CalendarViewKind = 'day' | 'week' | 'month';

export const CALENDAR_VIEWS: readonly CalendarViewKind[] = ['day', 'week', 'month'];

export interface CalendarColor {
  background: string;
  foreground: string;
}

export interface CalendarInfo {
  id: string;
  /** Google's own label: the person's name for it, else the calendar's. */
  name: string;
  primary: boolean;
  accessRole: string;
  /** Owner or writer: events can be added and changed on it. */
  writable: boolean;
  color: CalendarColor;
  /** Google Calendar's own checkbox, the starting point for the toggles here. */
  selectedInGoogle: boolean;
  timeZone: string | null;
}

export interface EventPaletteEntry extends CalendarColor {
  /** Google's colorId, '1' to '11'. */
  id: string;
  /** The name Google Calendar gives this colour in its picker. */
  name: string;
}

export interface RangeAttendee {
  email: string;
  name: string | null;
  response: string | null;
  self: boolean;
  resource: boolean;
  organizer: boolean;
  optional: boolean;
}

export interface RangeAttachment {
  title: string;
  url: string;
  mimeType: string | null;
}

export interface RangeVerdict {
  meeting: boolean;
  reason: string;
  with: string[];
}

export interface RangeEvent {
  /** Unique across calendars: `${calendarId}␟${id}`. */
  key: string;
  id: string;
  calendarId: string;
  /** The series id when this is one instance of a recurring event. */
  recurringEventId: string | null;
  title: string;
  allDay: boolean;
  /** Timed events: instants (RFC 3339). Null for all-day. */
  startsAt: string | null;
  endsAt: string | null;
  /** All-day events: `YYYY-MM-DD`, end exclusive as Google keeps it. Null for timed. */
  startDate: string | null;
  endDate: string | null;
  /** The event's own time zone, when Google has one for it. */
  timeZone: string | null;
  location: string | null;
  /** A real place (not a link or a dial-in), for in-person meetings. */
  place: string | null;
  description: string | null;
  joinUrl: string | null;
  /** The Google Meet link Google created for it, if any. */
  meetUrl: string | null;
  /** Google is still creating the Meet link. */
  meetPending: boolean;
  colorId: string | null;
  /** Google's colour for it: its own colorId's, else its calendar's. */
  color: CalendarColor;
  organizer: { email: string; name: string | null; self: boolean } | null;
  attendees: RangeAttendee[];
  guestsCanModify: boolean;
  /** Nick can change it here (editing turned on is checked apart from this). */
  canModify: boolean;
  /** Why not, in plain words, when canModify is false. */
  readOnlyReason: string | null;
  /**
   * Nick is a guest here (not the organizer) on a calendar he can write to,
   * so he can answer Going? Yes / No / Maybe (calendar editing on is checked
   * apart from this).
   */
  canRespond: boolean;
  /** Nick's own answer on it: accepted, declined, tentative, needsAction, or null. */
  myResponse: string | null;
  /** Files Google lists on it, https links only. */
  attachments: RangeAttachment[];
  verdict: RangeVerdict;
  /** A hold (Hold/Tentative/TBD...) that nobody has confirmed: a block, tagged Hold. */
  hold: boolean;
  inPerson: boolean;
  transparent: boolean;
  eventType: string | null;
  htmlLink: string | null;
}

export interface CalendarRangeData {
  state: 'ok' | 'not_connected' | 'error';
  message?: string;
  /** `YYYY-MM-DD` keys in the profile's time zone; `to` is exclusive. */
  from: string;
  to: string;
  timeZone: string;
  calendars: CalendarInfo[];
  /** The calendar ids the events were read for (the visible ones). */
  loaded: string[];
  /** Calendars that could not be read this time, with a reason. */
  failed: { calendarId: string; message: string }[];
  palette: EventPaletteEntry[];
  events: RangeEvent[];
}

export const EVENT_KEY_SEPARATOR = '␟';

export function eventKey(calendarId: string, id: string): string {
  return `${calendarId}${EVENT_KEY_SEPARATOR}${id}`;
}

/**
 * The calendars shown: each as the person last toggled it here, else as it
 * is ticked in Google Calendar's own list.
 */
export function visibleCalendarIds(
  calendars: readonly Pick<CalendarInfo, 'id' | 'selectedInGoogle'>[],
  shown: Readonly<Record<string, boolean>>,
): string[] {
  return calendars.filter((c) => shown[c.id] ?? c.selectedInGoogle).map((c) => c.id);
}
