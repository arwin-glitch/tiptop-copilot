import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { getAccessToken } from '@/lib/google/oauth';
import type { Integration } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Is this calendar entry a real meeting? Drives the "meeting in 5 minutes"
 * phone alert, so it has to tell a call with someone from a block Nick or
 * Arwin put on the calendar (Focus, Hold, Lunch, Travel, a flight).
 *
 * A meeting has another person in it: someone else invited and not declined,
 * someone else as organizer, a video link, or a title that names someone
 * ("Coffee w/ Jane", "Intro: X <> Y"). Everything else is a block.
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
  organizer: { email: string; self: boolean } | null;
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
  organizer?: { email?: string; self?: boolean };
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
      ? { email: e.organizer.email.toLowerCase(), self: Boolean(e.organizer.self) }
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

const HOLD_TITLE = /^\s*(hold|tentative|placeholder|tbd|pencil(led)?)\b/i;

export interface MeetingVerdict {
  meeting: boolean;
  reason: string;
  /** Other people on it, for the alert body. */
  with: string[];
}

const personName = (a: { name: string | null; email: string }) =>
  a.name?.trim() || a.email.split('@')[0]!;

export function classifyMeeting(event: MeetingEvent, ownEmails: readonly string[]): MeetingVerdict {
  const own = new Set(ownEmails.map((e) => e.toLowerCase()));
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

  const others = event.attendees.filter((a) => !a.resource && !isOwn(a.email, a.self));
  const active = others.filter((a) => a.response !== 'declined');
  const accepted = others.filter((a) => a.response === 'accepted');
  const names = active.map(personName).slice(0, 4);
  const blockTitle = BLOCK_TITLE.test(event.title);

  if (HOLD_TITLE.test(event.title) && accepted.length === 0) return no('A hold, not confirmed');
  if (PERSONAL_TITLE.test(event.title) && active.length === 0) return no('Personal or family time');
  if (others.length > 0 && active.length === 0) return no('Everyone else declined');
  if (active.length > 0) {
    return { meeting: true, reason: `With ${names.join(', ')}`, with: names };
  }
  const organizer = event.organizer && !isOwn(event.organizer.email, event.organizer.self);
  if (organizer && !blockTitle) {
    const who = event.organizer!.email.split('@')[0]!;
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

export const MEETING_LEAD_MINUTES = 5;

export interface MeetingAlert {
  key: string;
  eventId: string;
  title: string;
  body: string;
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
    out.push({
      key,
      eventId: event.id,
      title: `${event.title} in ${mins} min`,
      body: [
        at,
        verdict.with.length ? `with ${verdict.with.join(', ')}` : null,
        event.joinUrl ? 'Tap to join' : event.location ? event.location.slice(0, 60) : null,
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  return out;
}
