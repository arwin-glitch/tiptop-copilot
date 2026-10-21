import { addDaysToKey } from '@/lib/util/time';
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
  if (event.eventType && event.eventType !== 'default' && SPECIAL_TYPES.has(event.eventType)) {
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
 * A series' new start and end when one of its instances moves for "All
 * events": the series shifts by the same amount and takes the new length.
 * Timed and all-day both; a switch between the two is refused, as that
 * changes every instance's shape and is clearer to make in Google Calendar.
 */
export function shiftSeries(
  series: { start: GCalDateTime; end: GCalDateTime },
  before: { start: GCalDateTime; end: GCalDateTime },
  after: { start: GCalDateTime; end: GCalDateTime },
): { start: GCalDateTime; end: GCalDateTime } | null {
  const timed = (d: GCalDateTime) => Boolean(d.dateTime);
  if (timed(series.start) !== timed(after.start) || timed(before.start) !== timed(after.start)) {
    return null;
  }
  if (timed(after.start)) {
    const delta = Date.parse(after.start.dateTime!) - Date.parse(before.start.dateTime!);
    const length = Date.parse(after.end.dateTime!) - Date.parse(after.start.dateTime!);
    const start = Date.parse(series.start.dateTime!) + delta;
    if (!Number.isFinite(start) || !Number.isFinite(length) || length < 0) return null;
    return {
      start: { dateTime: new Date(start).toISOString(), timeZone: series.start.timeZone },
      end: {
        dateTime: new Date(start + length).toISOString(),
        timeZone: series.end.timeZone ?? series.start.timeZone,
      },
    };
  }
  const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  const delta = days(before.start.date!, after.start.date!);
  const length = days(after.start.date!, after.end.date!);
  if (!Number.isFinite(delta) || !Number.isFinite(length) || length < 1) return null;
  const start = addDaysToKey(series.start.date!, delta);
  return { start: { date: start }, end: { date: addDaysToKey(start, length) } };
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
  /** Add a Google Meet link. */
  meet?: boolean;
  /** Google's event colorId, or null for the calendar's colour. */
  colorId?: string | null;
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
  if (draft.guests !== undefined) {
    body.attendees = mergeGuests(context.existing?.attendees, draft.guests, context.ownEmails);
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
