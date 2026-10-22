import { addDaysToKey, localClock, wallTimeToUtc } from '@/lib/util/time';
import type {
  GCalAttendee,
  GCalDateTime,
  GCalDateTimeWrite,
  GCalEvent,
  GCalEventWrite,
  SendUpdates,
} from './google-types';

/**
 * The rules for changing an event from the Calendar tab, shared by the page
 * (what to ask, what to offer) and the server (what to refuse), so the two
 * cannot disagree. Pure: no network, no store.
 */

/* ------------------------------------------------------------ who may */

const WRITABLE_ROLES = new Set(['owner', 'writer']);

/** Owner or writer: Google lets this account add and change events there. */
export function isWritableRole(accessRole: string | null | undefined): boolean {
  return WRITABLE_ROLES.has(accessRole ?? '');
}

/** Entry kinds Google keeps special properties for; changed in Google Calendar only. */
const SPECIAL_TYPES = new Set([
  'focusTime',
  'outOfOffice',
  'workingLocation',
  'birthday',
  'fromGmail',
]);

/** Focus time, out of office, a birthday, a Gmail booking: changed in Google Calendar only. */
export function isSpecialEntry(eventType: string | null | undefined): boolean {
  return Boolean(eventType && eventType !== 'default' && SPECIAL_TYPES.has(eventType));
}

export interface ModifyRule {
  canModify: boolean;
  reason: string | null;
}

/**
 * Whether this account can change an event, by Google's own rules: the
 * calendar must be one it can write to, and the event its own (its organizer
 * is this calendar) or one whose organizer lets guests change it. Special
 * entries (focus time, out of office, a Gmail booking) and private copies
 * stay view-only here.
 */
export function modifyRule(
  event: Pick<
    GCalEvent,
    'organizer' | 'guestsCanModify' | 'eventType' | 'privateCopy' | 'locked' | 'status'
  >,
  accessRole: string | null | undefined,
): ModifyRule {
  const no = (reason: string): ModifyRule => ({ canModify: false, reason });
  if (!isWritableRole(accessRole)) {
    return no(
      accessRole === 'freeBusyReader'
        ? 'This calendar only shares when it is busy, so its events are view-only.'
        : 'This calendar is view-only for this account.',
    );
  }
  if (event.status === 'cancelled') return no('This event was cancelled.');
  if (isSpecialEntry(event.eventType)) {
    return no('Change this kind of entry in Google Calendar.');
  }
  if (event.locked) return no('Google keeps this event locked.');
  if (event.privateCopy) return no('This is a private copy; change it in Google Calendar.');
  if (event.organizer?.self) return { canModify: true, reason: null };
  if (event.guestsCanModify) return { canModify: true, reason: null };
  const who = event.organizer?.displayName?.trim() || event.organizer?.email;
  return no(`Only the organizer${who ? ` (${who})` : ''} can change this event.`);
}

/* ------------------------------------------------------------ guests */

const EMAIL = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]+$/;

export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

/** Lower-cased, trimmed, valid and once each. */
export function cleanGuestList(emails: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (isEmailAddress(email) && !out.includes(email)) out.push(email);
  }
  return out;
}

/**
 * The guests a change would email: everyone on it except this account
 * itself, its other addresses, and rooms.
 */
export function guestEmails(
  attendees: readonly Pick<GCalAttendee, 'email' | 'self' | 'resource'>[] | undefined,
  ownEmails: readonly string[] = [],
): string[] {
  const own = new Set(ownEmails.map((e) => e.toLowerCase()));
  return cleanGuestList(
    (attendees ?? [])
      .filter((a) => a.email && !a.self && !a.resource && !own.has(a.email.toLowerCase()))
      .map((a) => a.email!),
  );
}

/**
 * The attendee list after a guest edit: people kept keep their whole entry
 * (their answer, optional flag), new people are added, removed people go.
 * This account's own entry and booked rooms are never dropped by a guest edit.
 */
export function mergeGuests(
  existing: readonly GCalAttendee[] | undefined,
  guests: readonly string[],
  ownEmails: readonly string[] = [],
): GCalAttendee[] {
  const own = new Set(ownEmails.map((e) => e.toLowerCase()));
  const wanted = cleanGuestList(guests);
  const kept = (existing ?? []).filter((a) => {
    const email = a.email?.toLowerCase() ?? '';
    if (a.self || a.resource || own.has(email)) return true;
    return wanted.includes(email);
  });
  const have = new Set(kept.map((a) => a.email?.toLowerCase()));
  return [...kept, ...wanted.filter((e) => !have.has(e)).map((email) => ({ email }))];
}

/**
 * The attendee list with the organizer first, as Google lists an organizer
 * who is attending: their own entry (accepted), and once only, whatever the
 * case of the address. An address that is not one leaves the list as it is.
 */
export function withOrganizer(
  attendees: readonly GCalAttendee[],
  organizerEmail: string,
): GCalAttendee[] {
  const email = organizerEmail.trim().toLowerCase();
  if (!isEmailAddress(email)) return [...attendees];
  return [
    { email, organizer: true, responseStatus: 'accepted' },
    ...attendees.filter((a) => a.email?.trim().toLowerCase() !== email),
  ];
}

export type GuestChoice = 'send' | 'dont_send';

/**
 * Google's sendUpdates for the person's answer. Only an explicit Send emails
 * anyone; no answer, or anything else, is 'none'. There is no default-send.
 */
export function sendUpdatesFor(choice: GuestChoice | null | undefined): SendUpdates {
  return choice === 'send' ? 'all' : 'none';
}

export type ChangeKind = 'create' | 'update' | 'delete';

export interface GuestPrompt {
  kind: 'invite' | 'update' | 'cancel';
  title: string;
  description: string;
  added: string[];
  removed: string[];
}

/**
 * The question Google Calendar asks before a change reaches guests, asked
 * here every time: adding guests to a new event, any change to an event with
 * guests (a move, a resize, an edit, guests added or removed), and deleting
 * one. Null when nobody but this account is involved, before or after.
 */
export function guestPrompt(
  kind: ChangeKind,
  before: readonly string[],
  after: readonly string[],
): GuestPrompt | null {
  const added = after.filter((e) => !before.includes(e));
  const removed = before.filter((e) => !after.includes(e));
  if (kind === 'create') {
    if (after.length === 0) return null;
    return {
      kind: 'invite',
      title: 'Send invitation emails to guests?',
      description: `Google Calendar can email an invitation to ${count(after)}.`,
      added,
      removed: [],
    };
  }
  if (kind === 'delete') {
    if (before.length === 0) return null;
    return {
      kind: 'cancel',
      title: 'Send cancellation emails to guests?',
      description: `Google Calendar can tell ${count(before)} the event is cancelled.`,
      added: [],
      removed: [...before],
    };
  }
  if (before.length === 0 && after.length === 0) return null;
  if (before.length === 0) {
    return {
      kind: 'invite',
      title: 'Send invitation emails to guests?',
      description: `Google Calendar can email an invitation to ${count(after)}.`,
      added,
      removed,
    };
  }
  const parts = [
    added.length ? `${count(added)} added` : null,
    removed.length ? `${count(removed)} removed` : null,
  ].filter(Boolean);
  return {
    kind: 'update',
    title: 'Send update emails to guests?',
    description: `Google Calendar can email the change to the guests${
      parts.length ? ` (${parts.join(', ')})` : ''
    }.`,
    added,
    removed,
  };
}

function count(emails: readonly string[]): string {
  return emails.length === 1 ? emails[0]! : `${emails.length} guests`;
}

/* ----------------------------------------------------- recurring events */

export type RecurringScope = 'this' | 'all';

/**
 * What a change to one instance of a recurring event can apply to. "This
 * and following events" is left to Google Calendar: splitting a series
 * correctly (its rule, exceptions, counts) is easy to get wrong on a real
 * calendar, so it is not offered here.
 */
export const RECURRING_SCOPES: readonly { value: RecurringScope; label: string }[] = [
  { value: 'this', label: 'This event' },
  { value: 'all', label: 'All events' },
];

/** The event a change goes to: the instance itself, or its whole series. */
export function scopeTarget(
  event: { id: string; recurringEventId?: string | null },
  scope: RecurringScope | null | undefined,
): { eventId: string; series: boolean } {
  if (event.recurringEventId && scope === 'all') {
    return { eventId: event.recurringEventId, series: true };
  }
  return { eventId: event.id, series: false };
}

/**
 * A series' new start and end when one of its instances changes time for
 * "All events": every event takes the instance's new time of day (on the
 * series' own first date, in the series' own time zone, so a daylight-saving
 * change between the two cannot shift it by an hour) and its new length.
 *
 * Refused (null), to be done in Google Calendar instead:
 * - a move to another day, which would need the series' repeat rule rewritten
 *   (its weekday, its day of the month); moving only the start leaves the
 *   rule and the first date out of step, which Google does not define;
 * - a switch between all-day and timed, which changes every instance's shape.
 */
export function shiftSeries(
  series: { start: GCalDateTime; end: GCalDateTime },
  before: { start: GCalDateTime; end: GCalDateTime },
  after: { start: GCalDateTime; end: GCalDateTime },
  fallbackTimeZone?: string | null,
): { start: GCalDateTime; end: GCalDateTime } | null {
  const timed = (d: GCalDateTime) => Boolean(d.dateTime);
  if (timed(series.start) !== timed(after.start) || timed(before.start) !== timed(after.start)) {
    return null;
  }
  if (timed(after.start)) {
    const zone =
      series.start.timeZone || before.start.timeZone || after.start.timeZone || fallbackTimeZone;
    const seriesStart = Date.parse(series.start.dateTime!);
    const was = Date.parse(before.start.dateTime!);
    const startAt = Date.parse(after.start.dateTime!);
    const length = Date.parse(after.end.dateTime!) - startAt;
    if (!zone || ![seriesStart, was, startAt, length].every(Number.isFinite) || length <= 0) {
      return null;
    }
    const wasClock = localClock(new Date(was), zone);
    const nowClock = localClock(new Date(startAt), zone);
    if (wasClock.dateKey !== nowClock.dateKey) return null;
    const first = localClock(new Date(seriesStart), zone).dateKey;
    const start = wallTimeToUtc(first, nowClock.hour, nowClock.minute, zone);
    if (!start) return null;
    const timeZone = series.start.timeZone || zone;
    return {
      start: { dateTime: start.toISOString(), timeZone },
      end: {
        dateTime: new Date(start.getTime() + length).toISOString(),
        timeZone: series.end.timeZone || timeZone,
      },
    };
  }
  if (!series.start.date || !before.start.date || before.start.date !== after.start.date) {
    return null;
  }
  const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  const length = days(after.start.date!, after.end.date!);
  if (!Number.isFinite(length) || length < 1) return null;
  return {
    start: { date: series.start.date },
    end: { date: addDaysToKey(series.start.date, length) },
  };
}

/**
 * The guests of a whole series after a guest edit made on one of its events
 * for "All events": the series gains the people added there and loses the
 * people removed there, and nobody else. The guests prompt names exactly
 * those people, so a guest the series has but this one event does not (an
 * event changed on its own before) is never dropped without being named.
 */
export function seriesGuestList(
  seriesAttendees: readonly Pick<GCalAttendee, 'email' | 'self' | 'resource'>[] | undefined,
  instanceAttendees: readonly Pick<GCalAttendee, 'email' | 'self' | 'resource'>[] | undefined,
  guests: readonly string[],
  ownEmails: readonly string[] = [],
): string[] {
  const before = guestEmails(instanceAttendees, ownEmails);
  const after = cleanGuestList(guests);
  const removed = new Set(before.filter((e) => !after.includes(e)));
  const kept = guestEmails(seriesAttendees, ownEmails).filter((e) => !removed.has(e));
  return [...kept, ...after.filter((e) => !before.includes(e) && !kept.includes(e))];
}

/* ----------------------------------------------------------- the draft */

/** What the editor sends: one event's fields, as the person set them. */
export interface EventDraft {
  title: string;
  allDay: boolean;
  /** Timed: an instant (RFC 3339). All-day: `YYYY-MM-DD`. */
  start: string;
  /** Timed: an instant. All-day: `YYYY-MM-DD`, exclusive, as Google keeps it. */
  end: string;
  /** The zone a timed event is kept in (the profile's for a new one). */
  timeZone: string;
  description?: string;
  location?: string;
  /** Guests' addresses, without this account or rooms. */
  guests?: string[];
  /**
   * A new event only: this calendar's own address, put first on the guest
   * list as its organizer who has accepted, so the invite shows the host
   * (Google does not email an organizer their own invitation). Not taken
   * from the Calendar tab's editor; ignored on a change.
   */
  organizerEmail?: string;
  /** Add a Google Meet link. */
  meet?: boolean;
  /** Google's event colorId, or null for the calendar's colour. */
  colorId?: string | null;
  /**
   * One of the calendar's colour labels, or null for none (calendars that
   * have labels pick a label instead of a colour, as in Google).
   */
  labelId?: string | null;
}

/** Why a draft's times cannot be saved, or null when they can. */
export function timesProblem(draft: Pick<EventDraft, 'allDay' | 'start' | 'end'>): string | null {
  if (draft.allDay) {
    const ok = (k: string) => /^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(Date.parse(k));
    if (!ok(draft.start) || !ok(draft.end)) return 'Pick the dates again.';
    return draft.end > draft.start ? null : 'The event has to end after it starts.';
  }
  const start = Date.parse(draft.start);
  const end = Date.parse(draft.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Pick the times again.';
  if (end <= start) return 'The event has to end after it starts.';
  if (end - start > 31 * 86_400_000) return 'An event here can last up to 31 days.';
  return null;
}

/** Google's start/end for a draft's times; the other kind's field is cleared on a change. */
export function draftTimes(draft: Pick<EventDraft, 'allDay' | 'start' | 'end' | 'timeZone'>): {
  start: GCalDateTimeWrite;
  end: GCalDateTimeWrite;
} {
  if (draft.allDay) {
    return {
      start: { date: draft.start, dateTime: null, timeZone: null },
      end: { date: draft.end, dateTime: null, timeZone: null },
    };
  }
  return {
    start: { dateTime: new Date(draft.start).toISOString(), timeZone: draft.timeZone, date: null },
    end: { dateTime: new Date(draft.end).toISOString(), timeZone: draft.timeZone, date: null },
  };
}

/** A Google Meet request, as Google wants it on a create or a change. */
export function meetRequest(requestId: string): GCalEventWrite['conferenceData'] {
  return {
    createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } },
  };
}

/** The Meet link Google made for an event, if it has one. */
export function meetLinkOf(
  event: Pick<GCalEvent, 'hangoutLink' | 'conferenceData'>,
): string | null {
  const video = event.conferenceData?.entryPoints?.find(
    (p) => p.entryPointType === 'video' && p.uri?.startsWith('https://meet.google.com/'),
  )?.uri;
  return event.hangoutLink ?? video ?? null;
}

/**
 * The body for a new event, or for the fields of a change. Guests are merged
 * against the event's existing attendees so nobody kept loses their answer.
 * A Meet link is only ever added; removing one is left to Google Calendar.
 */
export function draftToWrite(
  draft: Partial<EventDraft>,
  context: { existing?: GCalEvent | null; ownEmails?: readonly string[]; requestId: string },
): { body: GCalEventWrite; conferenceDataVersion: 0 | 1 } {
  const body: GCalEventWrite = {};
  if (draft.title !== undefined) body.summary = draft.title.trim();
  if (draft.description !== undefined) body.description = draft.description;
  if (draft.location !== undefined) body.location = draft.location.trim();
  if (draft.colorId !== undefined) body.colorId = draft.colorId;
  // Google clears a label with an empty eventLabelId.
  if (draft.labelId !== undefined) body.eventLabelId = draft.labelId ?? '';
  if (
    draft.start !== undefined &&
    draft.end !== undefined &&
    draft.allDay !== undefined &&
    draft.timeZone !== undefined
  ) {
    Object.assign(
      body,
      draftTimes({
        allDay: draft.allDay,
        start: draft.start,
        end: draft.end,
        timeZone: draft.timeZone,
      }),
    );
  }
  const organizer = context.existing ? undefined : draft.organizerEmail;
  if (draft.guests !== undefined || organizer) {
    const merged = mergeGuests(context.existing?.attendees, draft.guests ?? [], context.ownEmails);
    body.attendees = organizer ? withOrganizer(merged, organizer) : merged;
  }
  let conferenceDataVersion: 0 | 1 = 0;
  if (draft.meet && !(context.existing && meetLinkOf(context.existing))) {
    body.conferenceData = meetRequest(context.requestId);
    conferenceDataVersion = 1;
  }
  return { body, conferenceDataVersion };
}

/** The end of an all-day draft the editor shows inclusively, as Google stores it. */
export function exclusiveEnd(inclusiveLastDay: string): string {
  return addDaysToKey(inclusiveLastDay, 1);
}
