import { draftFromEvent } from './draft';
import {
  guestEmails,
  isSpecialEntry,
  isWritableRole,
  modifyRule,
  sendUpdatesFor,
  type EventDraft,
  type GuestChoice,
} from './edit-rules';
import type { GCalAttendee, GCalEvent, GCalEventWrite, SendUpdates } from './google-types';
import type { RangeEvent } from './range-types';

/**
 * What a click on an event offers, as Google Calendar's event card does, and
 * the exact requests the quick actions send. Shared by the page (which
 * options to show) and the server (what to refuse), so the two cannot
 * disagree. Pure: no network, no store.
 *
 * - Going? Yes / No / Maybe changes Nick's own answer on an event he is a
 *   guest on, and nothing else on it. Google tells the organizer only when
 *   he chose Send in the question asked every time; nothing defaults to it.
 * - A colour change sends Google's colorId alone and never emails anyone.
 * - Duplicate is a new event with the same details, made through the editor
 *   and saved like any new one (the invitations question if it has guests).
 */

/* ------------------------------------------------------------ answering */

export type RsvpResponse = 'accepted' | 'declined' | 'tentative';

/** Google Calendar's "Going?" answers, in its order. */
export const RSVP_CHOICES: readonly { value: RsvpResponse; label: string }[] = [
  { value: 'accepted', label: 'Yes' },
  { value: 'declined', label: 'No' },
  { value: 'tentative', label: 'Maybe' },
];

export function isRsvpResponse(value: unknown): value is RsvpResponse {
  return value === 'accepted' || value === 'declined' || value === 'tentative';
}

/** Nick's own entry on the guest list: Google's `self`, else one of his addresses. */
export function ownAttendeeIndex(
  attendees: readonly Pick<GCalAttendee, 'email' | 'self'>[] | undefined,
  ownEmails: readonly string[] = [],
): number {
  const list = attendees ?? [];
  const self = list.findIndex((a) => a.self);
  if (self >= 0) return self;
  const own = new Set(ownEmails.map((e) => e.toLowerCase()));
  return list.findIndex((a) => Boolean(a.email && own.has(a.email.toLowerCase())));
}

export interface RespondRule {
  canRespond: boolean;
  reason: string | null;
}

/**
 * Whether Nick can answer an event here: he is on its guest list, someone
 * else organizes it (the organizer has nothing to answer), it sits on a
 * calendar this account can write to, and it is an ordinary event.
 */
export function respondRule(
  event: Pick<GCalEvent, 'organizer' | 'attendees' | 'eventType' | 'status'>,
  accessRole: string | null | undefined,
  ownEmails: readonly string[] = [],
): RespondRule {
  const no = (reason: string): RespondRule => ({ canRespond: false, reason });
  if (!isWritableRole(accessRole)) return no('This calendar is view-only for this account.');
  if (event.status === 'cancelled') return no('This event was cancelled.');
  if (isSpecialEntry(event.eventType)) return no('Answer this kind of entry in Google Calendar.');
  if (event.organizer?.self) return no('You organize this event.');
  if (ownAttendeeIndex(event.attendees, ownEmails) < 0) return no('You are not on the guest list.');
  return { canRespond: true, reason: null };
}

/**
 * The patch that answers an event, in Google's answer-only form: Nick's own
 * guest entry alone, with only its responseStatus changed, and
 * `attendeesOmitted` so Google leaves everyone else on the list as it is
 * (even when the organizer lets guests change the event, or the list moved
 * on since it was read). Google's sendUpdates follows his choice in the
 * question. Null when he is not on the list.
 */
export function rsvpRequest(
  existing: Pick<GCalEvent, 'attendees'>,
  response: RsvpResponse,
  notify: GuestChoice | null | undefined,
  ownEmails: readonly string[] = [],
): { body: GCalEventWrite; sendUpdates: SendUpdates } | null {
  const attendees = existing.attendees ?? [];
  const own = attendees[ownAttendeeIndex(attendees, ownEmails)];
  if (!own) return null;
  return {
    body: { attendees: [{ ...own, responseStatus: response }], attendeesOmitted: true },
    sendUpdates: sendUpdatesFor(notify),
  };
}

/** The event as it will look once Google has Nick's answer, for the page to show at once. */
export function withResponse(
  event: RangeEvent,
  response: RsvpResponse,
  ownEmails: readonly string[] = [],
): RangeEvent {
  const index = ownAttendeeIndex(event.attendees, ownEmails);
  return {
    ...event,
    myResponse: response,
    attendees: event.attendees.map((a, i) => (i === index ? { ...a, response } : a)),
  };
}

/* --------------------------------------------------------------- colour */

/**
 * Whether Nick can pick an event's colour here: on an event he may change,
 * or on his own copy of one he is a guest on (Google keeps a guest's colour
 * on that guest's copy only).
 */
export function colorRule(
  event: Pick<
    GCalEvent,
    | 'organizer'
    | 'attendees'
    | 'guestsCanModify'
    | 'eventType'
    | 'privateCopy'
    | 'locked'
    | 'status'
  >,
  accessRole: string | null | undefined,
  ownEmails: readonly string[] = [],
): { canColor: boolean; reason: string | null } {
  const modify = modifyRule(event, accessRole);
  if (modify.canModify) return { canColor: true, reason: null };
  if (respondRule(event, accessRole, ownEmails).canRespond) return { canColor: true, reason: null };
  return { canColor: false, reason: modify.reason };
}

/**
 * A colour change: Google's colorId alone (null for the calendar's colour),
 * and never an email. A colour is the viewer's own business in Google
 * Calendar too, so there is nothing to ask.
 */
export function colorRequest(colorId: string | null): {
  body: GCalEventWrite;
  sendUpdates: SendUpdates;
  conferenceDataVersion: 0;
} {
  return { body: { colorId }, sendUpdates: 'none', conferenceDataVersion: 0 };
}

/** A change that only recolours the event: no guest is asked about or told. */
export function isColorOnly(changes: Partial<EventDraft>): boolean {
  const keys = Object.keys(changes).filter((k) => changes[k as keyof EventDraft] !== undefined);
  return keys.length === 1 && keys[0] === 'colorId';
}

/* ------------------------------------------------------------ duplicate */

/**
 * Google Calendar's Duplicate: a new event with this one's title, time,
 * place, description, guests and colour (and a fresh Meet link if it had
 * one), opened in the editor so nothing is made until Save.
 */
export function duplicateDraft(
  event: RangeEvent,
  profileTimeZone: string,
  ownEmails: readonly string[],
): EventDraft {
  return { ...draftFromEvent(event, profileTimeZone, ownEmails), meet: Boolean(event.meetUrl) };
}

/* -------------------------------------------------------------- options */

export interface EventOptions {
  edit: boolean;
  delete: boolean;
  duplicate: boolean;
  color: boolean;
  /** Going? Yes / No / Maybe. */
  rsvp: boolean;
  /** Opens the compose window with the guests; nothing sends without its own tap. */
  emailGuests: boolean;
  join: boolean;
  copyLink: boolean;
  openInGoogle: boolean;
}

/**
 * The options an event's card shows. Without calendar editing, or on a
 * calendar this account can only read, only what writes nothing: Join, Copy
 * the link, Email guests, Open in Google Calendar.
 */
export function eventOptions(
  event: Pick<
    RangeEvent,
    'canModify' | 'canRespond' | 'attendees' | 'joinUrl' | 'meetUrl' | 'htmlLink'
  >,
  context: { editing: boolean; calendarWritable: boolean; ownEmails: readonly string[] },
): EventOptions {
  const writes = context.editing && context.calendarWritable;
  const change = writes && event.canModify;
  const answer = writes && event.canRespond;
  return {
    edit: change,
    delete: change,
    duplicate: change || answer,
    color: change || answer,
    rsvp: answer,
    emailGuests: guestEmails(event.attendees, context.ownEmails).length > 0,
    join: Boolean(event.joinUrl),
    copyLink: Boolean(event.meetUrl ?? event.joinUrl),
    openInGoogle: Boolean(event.htmlLink),
  };
}
