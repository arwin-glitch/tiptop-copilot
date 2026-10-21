/**
 * Google Calendar API v3 shapes, as JSON comes back from Google: the fields
 * the Calendar tab reads and writes, nothing more. Both providers speak this
 * shape (the mock keeps its events in it), so one mapping serves both.
 */

export interface GCalDateTime {
  /** A timed event's instant, RFC 3339 with an offset. */
  dateTime?: string;
  /** An all-day event's date, `YYYY-MM-DD`; an end date is exclusive. */
  date?: string;
  timeZone?: string;
}

export interface GCalAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  resource?: boolean;
  organizer?: boolean;
  optional?: boolean;
  comment?: string;
  additionalGuests?: number;
}

export interface GCalConferenceData {
  createRequest?: {
    requestId?: string;
    conferenceSolutionKey?: { type?: string };
    status?: { statusCode?: string };
  };
  entryPoints?: { entryPointType?: string; uri?: string; label?: string }[];
  conferenceSolution?: { key?: { type?: string }; name?: string };
  conferenceId?: string;
}

export interface GCalEvent {
  id: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  eventType?: string;
  transparency?: string;
  visibility?: string;
  hangoutLink?: string;
  conferenceData?: GCalConferenceData;
  start?: GCalDateTime;
  end?: GCalDateTime;
  /** Set on an instance of a recurring event: the series' own id. */
  recurringEventId?: string;
  originalStartTime?: GCalDateTime;
  /** Set on a series (never on its instances). */
  recurrence?: string[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  creator?: { email?: string; displayName?: string; self?: boolean };
  attendees?: GCalAttendee[];
  guestsCanModify?: boolean;
  guestsCanInviteOthers?: boolean;
  guestsCanSeeOtherGuests?: boolean;
  privateCopy?: boolean;
  locked?: boolean;
  /** Files Google lists on the event (Drive links), when it has any. */
  attachments?: GCalAttachment[];
  updated?: string;
  etag?: string;
}

export interface GCalAttachment {
  fileUrl?: string;
  title?: string;
  mimeType?: string;
  iconLink?: string;
  fileId?: string;
}

export type GCalAccessRole = 'owner' | 'writer' | 'reader' | 'freeBusyReader';

/** One row of the account's calendar list (users/me/calendarList). */
export interface GCalListEntry {
  id: string;
  summary?: string;
  /** The name the person gave the calendar for themselves; wins over summary. */
  summaryOverride?: string;
  description?: string;
  timeZone?: string;
  colorId?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  /** Shown in Google Calendar's own list (its checkbox). */
  selected?: boolean;
  /** Hidden from Google Calendar's list altogether. */
  hidden?: boolean;
  deleted?: boolean;
  primary?: boolean;
  accessRole?: GCalAccessRole | string;
}

export interface GCalColor {
  background: string;
  foreground: string;
}

/** The colors endpoint: calendar colours and the event colorId palette. */
export interface GCalColors {
  calendar?: Record<string, GCalColor>;
  event?: Record<string, GCalColor>;
}

/** A start or end as a change sends it: `null` clears the other kind's field. */
export interface GCalDateTimeWrite {
  dateTime?: string | null;
  date?: string | null;
  timeZone?: string | null;
}

/** What a create or a change sends. `null` clears a field on a patch. */
export interface GCalEventWrite {
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string | null;
  start?: GCalDateTimeWrite;
  end?: GCalDateTimeWrite;
  attendees?: GCalAttendee[];
  conferenceData?: GCalConferenceData;
}

/**
 * How Google tells guests. 'none' unless the person chose Send in the prompt
 * the Calendar tab shows every time guests are involved; nothing defaults to
 * 'all' (see lib/calendar/edit-rules.ts, sendUpdatesFor).
 */
export type SendUpdates = 'all' | 'none';

export interface GCalWriteOptions {
  sendUpdates: SendUpdates;
  /** 1 when the body creates (or carries) a Google Meet conference. */
  conferenceDataVersion?: 0 | 1;
}
