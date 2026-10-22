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
  /**
   * The event's colour label: one of its calendar's labelProperties.eventLabels
   * ids. Google processes it only on requests that carry eventLabelVersion=1.
   */
  eventLabelId?: string;
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

/**
 * One of a calendar's named colour labels ("Travel", "Hiring"...), as
 * calendars.get returns them under labelProperties.eventLabels. Only the
 * calendar's owner can change them; the Calendar tab only reads them.
 */
export interface GCalEventLabel {
  id: string;
  /** `#rrggbb`. */
  backgroundColor?: string;
  name?: string;
}

/** The Calendars resource (calendars.get): the fields the Calendar tab reads. */
export interface GCalCalendar {
  id: string;
  summary?: string;
  timeZone?: string;
  labelProperties?: { eventLabels?: GCalEventLabel[] };
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
  /** A label of the event's calendar; `''` clears it. Needs eventLabelVersion=1. */
  eventLabelId?: string;
  start?: GCalDateTimeWrite;
  end?: GCalDateTimeWrite;
  attendees?: GCalAttendee[];
  /**
   * Google's form for answering an invitation: `attendees` holds only the
   * person's own entry, and Google changes that guest's answer alone, leaving
   * everyone else on the list as it is.
   */
  attendeesOmitted?: boolean;
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
  /**
   * 1 to have Google apply eventLabelId: it ignores the label without it.
   * With it Google ignores colorId and removes a label the body leaves out,
   * so only a write that carries eventLabelId sends it (write.ts).
   */
  eventLabelVersion?: 0 | 1;
}
