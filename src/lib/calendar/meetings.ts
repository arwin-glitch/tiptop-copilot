import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { getAccessToken } from '@/lib/google/oauth';
import type { CalendarEvent, Integration } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Is this calendar entry a real meeting? Drives the "meeting in 5 minutes"
 * phone alert, so it has to tell a call with someone from a block Nick or
 * Arwin put on the calendar (Focus, Hold, Lunch, Travel, a flight).
 *
 * A meeting has another person in it: someone else invited and not declined,
 * someone else as organizer, a video link, or a title that names someone
 * ("Coffee w/ Jane", "Intro: X <> Y"). Everything else is a block. An event
 * platform or a no-reply sender is not a person, so an RSVP that Luma or
 * Eventbrite put on the calendar, with nobody else on it, is a block.
 */

const CALENDAR = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export interface MeetingEvent {
  id: string;
  status: string | null;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  eventType: string | null;
  transparent: boolean;
  location: string | null;
  description: string | null;
  joinUrl: string | null;
  /** `name` is Google's display name; synced rows only have the address. */
  organizer: { email: string; self: boolean; name?: string | null } | null;
  attendees: {
    email: string;
    name: string | null;
    response: string | null;
    self: boolean;
    resource: boolean;
  }[];
}

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  eventType?: string;
  transparency?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: {
    email?: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
    resource?: boolean;
  }[];
}

const JOIN_URL =
  /https:\/\/(?:[\w-]+\.)?(?:zoom\.us\/(?:j|my|w)\/[^\s"<>)]+|meet\.google\.com\/[a-z0-9-]+|teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>)]+|teams\.live\.com\/meet\/[^\s"<>)]+|[\w-]+\.webex\.com\/[^\s"<>)]+|whereby\.com\/[^\s"<>)]+|around\.co\/[^\s"<>)]+)/i;

/**
 * A synced calendar row (the Today page, demo mode) shaped like a live event.
 * Synced rows lack Google's event type and self flags, so the classifier
 * leans on titles, attendees and Nick's own addresses for them.
 */
export function meetingFromStoredEvent(e: CalendarEvent): MeetingEvent {
  return {
    id: e.provider_event_id,
    status: null,
    title: e.title,
    startsAt: e.all_day ? null : e.starts_at,
    endsAt: e.ends_at,
    allDay: e.all_day,
    eventType: null,
    transparent: false,
    location: e.location,
    description: e.description,
    joinUrl: JOIN_URL.exec(`${e.location ?? ''} ${e.description ?? ''}`)?.[0] ?? null,
    organizer: e.organizer_email
      ? { email: e.organizer_email.toLowerCase(), self: false, name: null }
      : null,
    attendees: e.attendees.map((a) => ({
      email: a.email.toLowerCase(),
      name: a.name,
      response: a.response,
      self: false,
      resource: /resource\.calendar\.google\.com$/.test(a.email),
    })),
  };
}

export function toMeetingEvent(e: GoogleEvent): MeetingEvent {
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
  const found = JOIN_URL.exec(`${e.location ?? ''} ${e.description ?? ''}`)?.[0];
  return {
    id: e.id,
    status: e.status ?? null,
    title: e.summary?.trim() || '(no title)',
    startsAt: e.start?.dateTime ?? null,
    endsAt: e.end?.dateTime ?? null,
    allDay: Boolean(e.start?.date && !e.start?.dateTime),
    eventType: e.eventType ?? null,
    transparent: e.transparency === 'transparent',
    location: e.location ?? null,
    description: e.description ?? null,
    joinUrl: e.hangoutLink ?? video ?? found ?? null,
    organizer: e.organizer?.email
      ? {
          email: e.organizer.email.toLowerCase(),
          self: Boolean(e.organizer.self),
          name: e.organizer.displayName?.trim() || null,
        }
      : null,
    attendees: (e.attendees ?? [])
      .filter((a) => a.email)
      .map((a) => ({
        email: a.email!.toLowerCase(),
        name: a.displayName ?? null,
        response: a.responseStatus ?? null,
        self: Boolean(a.self),
        resource: Boolean(a.resource) || /resource\.calendar\.google\.com$/.test(a.email!),
      })),
  };
}

/** Calendar entry types that are never a meeting. */
const NOT_MEETING_TYPES = new Set([
  'focusTime',
  'outOfOffice',
  'workingLocation',
  'birthday',
  'fromGmail',
]);

/** Titles of blocks people put on their own calendar. */
const BLOCK_TITLE =
  /\b(hold|holding|block(ed)?|busy|focus|deep work|heads? down|do not (book|schedule)|dnb|ooo|out of (the )?office|lunch|breakfast|gym|workout|run|commute|travel|flight|drive|driving|pick ?up|drop ?off|school|personal|family|kids?|doctor|dentist|errands?|admin|email(s)?( time)?|inbox|prep|buffer|reminder|tentative|placeholder|no meetings?|offline|vacation|pto|leave)\b/i;

/** Titles that say another person is involved even with no one invited. */
const WITH_SOMEONE =
  /(<>|\bw\/\s*\S|\bwith\s+[A-Z]|\bx\s+[A-Z]|\b(call|coffee|intro|meeting|sync|1:1|1-1|one on one|chat|interview|catch ?up|pitch|demo|onsite|office hours)\b)/i;

/** Family and personal time is never a meeting, even when it names someone. */
const PERSONAL_TITLE =
  /\b(mari|date night|anniversary|birthday|bday|family|kids?|baby|wife|husband|nanny|daycare|pediatrician)\b/i;

export const HOLD_TITLE = /^\s*(hold|tentative|placeholder|tbd|pencil(led)?)\b/i;

export interface MeetingVerdict {
  meeting: boolean;
  reason: string;
  /** Other people on it, for the alert body. */
  with: string[];
}

/** Google Calendar's own mails: invites, updates, RSVPs and cancellations. */
const CALENDAR_NOTICE =
  /^\s*(invitation|updated invitation|accepted|declined|tentatively accepted|canceled event|cancelled event|event canceled|event cancelled|new event|updated event)\b.*:/i;

export function isCalendarNotice(subject: string | null | undefined): boolean {
  return CALENDAR_NOTICE.test(subject ?? '');
}

/** Nick's other addresses: they are him, never "someone else on the invite". */
export const NICK_ALIASES = ['nick@tiptop.vc', 'nick@tiptopvc.com', 'ntippman@gmail.com'];

/** Event and RSVP platforms: their invites come from a machine, not a person. */
const EVENT_PLATFORM_DOMAIN =
  /(^|\.)(lu\.ma|luma\.com|luma-mail\.com|eventbrite\.[a-z.]+|partiful\.com|splashthat\.com|hopin\.(com|to)|meetup\.com|cvent\.com|on24\.com|bizzabo\.com|airmeet\.com)$/i;

/** Mailbox names no person uses: invite robots, no-reply and notification senders. */
const MACHINE_LOCAL =
  /^(calendar[-_.]?(invites?|invitations?|notifications?)|calendar|invites?|invitations?|events?|rsvps?|webinars?|no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|notify|mailer[-_.]?daemon)(\+[^@]*)?$/i;

/**
 * Never "someone else": 'platform' for an event platform (Luma, Eventbrite),
 * 'mailbox' for a robot mailbox name on any domain (calendar@, no-reply@).
 */
function machineSender(email: string): 'platform' | 'mailbox' | null {
  const [local = '', domain = ''] = email.toLowerCase().split('@');
  if (EVENT_PLATFORM_DOMAIN.test(domain)) return 'platform';
  return MACHINE_LOCAL.test(local) ? 'mailbox' : null;
}

/**
 * Titles that name the other side outright ("Intro: Pat <> Nick", "Call w/
 * Pat"). Narrower than WITH_SOMEONE, whose "demo", "pitch" and "chat" are
 * common in event names.
 */
const NAMES_SOMEONE = /(<>|\bw\/\s*\S|\b(intro|1:1|1-1|one on one)\b)/i;

const capitalise = (p: string) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();

/**
 * "Jane Doe" (the display name), "Arwin Reyes" from arwin.reyes@…, or "Andrew"
 * from andrew@…; any other handle stays as it is.
 */
function prettyName(a: { name?: string | null; email: string }): string {
  const name = a.name?.trim();
  if (name && !name.includes('@')) return name;
  const local = a.email.split('@')[0]!;
  const parts = local.split(/[._-]+/).filter((p) => /^[a-z]{2,}$/i.test(p));
  if (parts.length >= 2) return parts.map(capitalise).join(' ');
  return /^[a-z]{2,}$/i.test(local) ? capitalise(local) : local;
}

/** One name per person: "Arwin" and "Arwin Reyes" (two addresses) show once. */
function uniqueNames(names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const first = n.split(' ')[0]!.toLowerCase();
    const dup = out.findIndex((o) => o.split(' ')[0]!.toLowerCase() === first);
    if (dup < 0) out.push(n);
    else if (n.length > out[dup]!.length) out[dup] = n;
  }
  return out;
}

export function classifyMeeting(event: MeetingEvent, ownEmails: readonly string[]): MeetingVerdict {
  const own = new Set([...ownEmails, ...NICK_ALIASES].map((e) => e.toLowerCase()));
  const isOwn = (email: string, self: boolean) => self || own.has(email);
  const no = (reason: string): MeetingVerdict => ({ meeting: false, reason, with: [] });

  if (event.status === 'cancelled') return no('Cancelled');
  if (event.allDay || !event.startsAt) return no('All-day entry');
  if (event.eventType && NOT_MEETING_TYPES.has(event.eventType)) {
    return no(
      event.eventType === 'focusTime'
        ? 'Focus time'
        : event.eventType === 'outOfOffice'
          ? 'Out of office'
          : event.eventType === 'fromGmail'
            ? 'Booking from Gmail (flight, hotel, reservation)'
            : 'Not a meeting entry',
    );
  }
  const me = event.attendees.find((a) => isOwn(a.email, a.self));
  if (me?.response === 'declined') return no('Nick declined');

  const others = event.attendees.filter(
    (a) => !a.resource && !isOwn(a.email, a.self) && !machineSender(a.email),
  );
  const active = others.filter((a) => a.response !== 'declined');
  const accepted = others.filter((a) => a.response === 'accepted');
  const names = uniqueNames(active.map(prettyName)).slice(0, 4);
  const blockTitle = BLOCK_TITLE.test(event.title);

  if (HOLD_TITLE.test(event.title) && accepted.length === 0) return no('A hold, not confirmed');
  if (PERSONAL_TITLE.test(event.title) && active.length === 0) return no('Personal or family time');
  if (others.length > 0 && active.length === 0) return no('Everyone else declined');
  if (active.length > 0) {
    return { meeting: true, reason: `With ${names.join(', ')}`, with: names };
  }
  const organizer =
    event.organizer && !isOwn(event.organizer.email, event.organizer.self) ? event.organizer : null;
  const robot = organizer ? machineSender(organizer.email) : null;
  // Luma, Eventbrite and no-reply invites: Nick registered for an event, and
  // nobody he would meet is on the entry. A firm's shared calendar@ or
  // events@ mailbox can still book a real meeting when the title names the
  // other side; it then falls through to the link and title rules below.
  if (robot === 'platform' || (robot === 'mailbox' && !NAMES_SOMEONE.test(event.title))) {
    return no('An event registration, not a meeting');
  }
  // A group invite (other guests hidden) Nick has not accepted, like an open
  // LP pitch session: he may well not go, so it does not ping.
  if (organizer && (!me || me.response === 'needsAction' || me.response === 'tentative')) {
    return no(
      me?.response === 'tentative'
        ? 'Group invite Nick marked maybe'
        : "Group invite Nick hasn't accepted",
    );
  }
  if (organizer && !robot && !blockTitle) {
    const who = prettyName(organizer);
    return { meeting: true, reason: `Invited by ${who}`, with: [who] };
  }
  if (event.transparent) return no('Marked free, no one else on it');
  if (blockTitle && !WITH_SOMEONE.test(event.title)) return no('A block on the calendar');
  if (event.joinUrl) return { meeting: true, reason: 'Has a video call link', with: [] };
  if (WITH_SOMEONE.test(event.title)) {
    return { meeting: true, reason: 'The title says it is with someone', with: [] };
  }
  return no('No one else is on it');
}

/** Timed events starting between timeMin and timeMax, with what the classifier needs. */
export async function listMeetingEvents(
  store: DataStore,
  integration: Integration,
  timeMin: Date,
  timeMax: Date,
): Promise<Result<MeetingEvent[]>> {
  const token = await getAccessToken(store, integration);
  if (!token.ok) return token;
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
  });
  try {
    const res = await fetch(`${CALENDAR}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token.value}` },
    });
    if (!res.ok) return err('provider_unavailable', `Google Calendar returned ${res.status}.`);
    const data = (await res.json()) as { items?: GoogleEvent[] };
    return ok((data.items ?? []).map(toMeetingEvent));
  } catch {
    return err('provider_unavailable', 'Could not reach Google Calendar.');
  }
}

/** One event by id, for the tap-to-join redirect. */
export async function readMeetingEvent(
  store: DataStore,
  integration: Integration,
  id: string,
): Promise<Result<MeetingEvent>> {
  const token = await getAccessToken(store, integration);
  if (!token.ok) return token;
  try {
    const res = await fetch(`${CALENDAR}/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token.value}` },
    });
    if (!res.ok) return err('not_found', 'That meeting is not on the calendar.');
    return ok(toMeetingEvent((await res.json()) as GoogleEvent));
  } catch {
    return err('provider_unavailable', 'Could not reach Google Calendar.');
  }
}

/**
 * Titles that say the meeting is face to face. "Coffee at 3pm" or "lunch at
 * 12" is a time, not a place, so a bare clock time after "at" does not count.
 */
const IN_PERSON_TITLE =
  /\b(irl|in[-\s]person|face[-\s]to[-\s]face)\b|\b(coffee|lunch|dinner|breakfast|drinks)\s+at\s+(?=\S)(?!\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?(?!\w)|noon\b|midnight\b)/i;

/** Titles that say it is a call ("Virtual coffee", "Coffee w/ Pat (Zoom)"). */
const VIDEO_TITLE =
  /\b(zoom|google meet|hangouts?|(ms|microsoft) teams|teams (call|meeting)|(on|via|over) (teams|zoom|meet)|webex|skype|facetime|virtual|online|video call)\b/i;

/** Locations that are a call, not a place. */
const NOT_A_PLACE = new RegExp(
  [
    String.raw`https?:\/\/|\bwww\.`, // a link
    String.raw`\b[\w-]+(?:\.[\w-]+)+\/\S`, // a link without https: teams.microsoft.com/l/…
    String.raw`\b(?:zoom|google meet|meet\.google|hangouts?|teams|webex|whereby|skype|facetime|gotomeeting|bluejeans|jitsi|ringcentral|discord|slack|webinar|livestream|video|virtual|online|phone|call|dial[- ]?in|conference (?:line|call|bridge|number)|meeting id|passcode)\b`,
    String.raw`\bpin\s*[:#]?\s*\d`, // "PIN 4821", not "Pin Oak Dr"
    String.raw`^\s*(?:meet|remote|tbd|tba)\s*$`,
    String.raw`(?:^|[\s,(])\+\d`, // a dial-in: +1 646-555-0100,,845#
    String.raw`\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b`, // a phone number, with or without x204
    String.raw`^[\d\s().,#*;+-]{7,}$`, // nothing but digits
  ].join('|'),
  'i',
);

/** Google Meet: what Nick's calendar (and most Google calendars) attach by default. */
const GOOGLE_MEET = /^https:\/\/meet\.google\.com\//i;

/** A real place (an address, a venue, an office, a room), not a link or a call. */
export function physicalLocation(event: Pick<MeetingEvent, 'location'>): string | null {
  const location = event.location?.trim();
  return location && !NOT_A_PLACE.test(location) ? location : null;
}

/**
 * Google copies a booked room's name into the location. The room says where
 * the organizer will be, not that Nick is there, so on its own it is not a
 * sign of face to face.
 */
function onlyBookedRooms(location: string, attendees: MeetingEvent['attendees']): boolean {
  const rooms = attendees
    .filter((a) => a.resource && a.name?.trim())
    .map((a) => a.name!.trim().toLowerCase());
  if (rooms.length === 0) return false;
  const rest = rooms.reduce((left, room) => left.split(room).join(' '), location.toLowerCase());
  return !/[a-z0-9]/i.test(rest);
}

/**
 * Face to face: the title says so (IRL, in person, coffee at a place) or it
 * is at a real place with no link anyone chose. Nick's calendar attaches a
 * Meet link to everything he creates, so a Meet link next to a place still
 * means in person. A Zoom or Teams link next to a place is a hybrid meeting,
 * so the join stays. A title or location that names a call always wins.
 */
export function isInPerson(
  event: Pick<MeetingEvent, 'title' | 'location'> &
    Partial<Pick<MeetingEvent, 'joinUrl' | 'attendees'>>,
): boolean {
  const location = event.location?.trim() ?? '';
  if (VIDEO_TITLE.test(event.title) || (location && NOT_A_PLACE.test(location))) return false;
  if (IN_PERSON_TITLE.test(event.title)) return true;
  if (!location || onlyBookedRooms(location, event.attendees ?? [])) return false;
  return !event.joinUrl || GOOGLE_MEET.test(event.joinUrl);
}

export const MEETING_LEAD_MINUTES = 5;

export interface MeetingAlert {
  key: string;
  eventId: string;
  title: string;
  body: string;
  /** Face to face: the tap opens the Calendar tab, not the video link. */
  inPerson: boolean;
}

/**
 * Meetings starting within the next ~5 minutes that have not been alerted.
 * The sender checks every minute, so the window is a little wider than five
 * to survive a late run; a meeting already started is never alerted.
 */
export function dueMeetingAlerts(
  events: readonly MeetingEvent[],
  ownEmails: readonly string[],
  alreadySent: ReadonlySet<string>,
  now: Date,
  timeZone: string,
): MeetingAlert[] {
  const out: MeetingAlert[] = [];
  for (const event of events) {
    if (!event.startsAt) continue;
    const startMs = Date.parse(event.startsAt);
    const minutes = (startMs - now.getTime()) / 60_000;
    if (minutes <= 0 || minutes > MEETING_LEAD_MINUTES + 1.5) continue;
    const key = `meeting:${event.id}:${event.startsAt}`;
    if (alreadySent.has(key)) continue;
    const verdict = classifyMeeting(event, ownEmails);
    if (!verdict.meeting) continue;
    const at = new Date(startMs).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    });
    const mins = Math.max(1, Math.round(minutes));
    const inPerson = isInPerson(event);
    const where = inPerson
      ? physicalLocation(event)?.slice(0, 60)
      : event.joinUrl
        ? 'Tap to join'
        : event.location?.slice(0, 60);
    out.push({
      key,
      eventId: event.id,
      title: `${event.title} in ${mins} min`,
      inPerson,
      body: [at, verdict.with.length ? `with ${verdict.with.join(', ')}` : null, where]
        .filter(Boolean)
        .join(' · '),
    });
  }
  return out;
}
