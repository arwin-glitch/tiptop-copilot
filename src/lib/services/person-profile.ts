import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import { isDemoMode } from '@/lib/config/env';
import { DEMO_IDS } from '@/lib/demo/ids';
import { demoRelationshipHistory } from '@/lib/demo/relationship-fixtures';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import { chunk } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { evidenceFor, isPerson, nameFor } from '@/lib/network/evidence';
import { contactStatus, type ContactStatus } from '@/lib/network/contact-status';
import {
  evidenceSummary,
  scoreRelationship,
  type RelationshipEvidence,
  type RelationshipStrength,
} from '@/lib/network/strength';
import { meetingPagePath } from '@/lib/notes/api';
import { notesAccess } from '@/lib/notes/flag';
import type { CalendarEvent, CrmRecord, EmailMessage, MeetingNote, Task } from '@/lib/types/domain';
import type { Meeting, MeetingParticipant } from '@/lib/types/notes';
import { err, ok, type Result } from '@/lib/util/result';
export { parsePersonEmail, personPagePath } from '@/lib/network/person-path';
import { recentTeamNotes } from './meetings';
import { canSeeMeeting } from './notes';
import { getPrimaryIntegration } from './inbox';
import { addressOf } from './network';
import { getRelationshipIndex, relationshipScope } from './relationships';
import { isPersonalDomain, registrableDomain } from './warm-paths';

/**
 * One person from Network → People ("From mail and calendar"), on a page of
 * their own (/network/person/<email>): who they are and how warm, every
 * thread with them, every meeting with them and its notes, plus open tasks
 * naming them and their CRM records.
 *
 * Built from what Kraken already holds: the cached relationship index (the
 * same counts as the Network row), the synced messages for a snippet, the
 * synced calendar for who else was there, and meeting notes. Never a Gmail
 * call. Visibility follows the readers it borrows from exactly: a private
 * calendar event is not in the index at all; meeting notes are the team's
 * (recentTeamNotes: a private Kraken note stays off); a Kraken meeting shows
 * only where canSeeMeeting allows and Kraken Notes is on for the viewer.
 */

/** Threads and meetings the page lists at most. */
const THREADS_MAX = 200;
const MEETINGS_MAX = 100;
const TASKS_MAX = 10;
const SUMMARY_CHARS = 280;
/** A note and a calendar entry of the same title this close are the same meeting. */
const SAME_MEETING_MS = 36 * 3_600_000;

export interface PersonThread {
  key: string;
  /** Gmail's thread id, for ThreadLinks; null when the thread row was not synced. */
  gmailId: string | null;
  subject: string;
  /** The newest message with them on it. */
  at: string;
  /** Who wrote that newest message. */
  direction: 'them' | 'us';
  snippet: string | null;
  flagged: boolean;
  emailsIn: number;
  emailsOut: number;
}

export interface PersonNote {
  id: string;
  source: 'granola' | 'kraken';
  title: string;
  at: string;
  /** The opening of the note, whitespace collapsed. Untrusted: render as text. */
  summary: string;
  /** The whole note, for reading in place. Untrusted: render as text. */
  content: string;
  flagged: boolean;
  /** Where Kraken opens the full note or transcript. */
  href: string;
}

export interface PersonMeeting {
  key: string;
  title: string;
  at: string;
  upcoming: boolean;
  /** Everyone on it who did not decline, rooms left out. */
  attendees: { name: string | null; email: string }[];
  /** The Kraken Notes meeting (notes, transcript, chat), where the viewer may open it. */
  krakenHref: string | null;
  notes: PersonNote[];
}

export interface PersonProfile {
  email: string;
  name: string | null;
  /** The company's domain; null for personal mail. */
  domain: string | null;
  status: ContactStatus;
  strength: RelationshipStrength;
  evidence: RelationshipEvidence;
  /** "5 threads, last Oct 3; 2 meetings". */
  summary: string;
  /** Newest first. */
  threads: PersonThread[];
  /** Newest first, booked ones included; notes matched by attendee or title. */
  meetings: PersonMeeting[];
  /** Whether threads or meetings were cut to the page's limit. */
  truncated: boolean;
  tasks: { id: string; title: string; dueAt: string | null }[];
  records: { id: string; name: string }[];
  /** Whether the notes could be read; false shows a notice, never "no notes". */
  notesRead: boolean;
  /** The connected mailbox, for Gmail's authuser. */
  mailbox: string | null;
}

const normaliseTitle = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const ROOM = /(^|\.)resource\.calendar\.google\.com$/;

function summaryOf(content: string): string {
  const flat = content
    .replace(/[#*_>`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : flat;
}

/** A read that a not-yet-applied migration turns into nothing. */
async function tolerant<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) return [];
    throw error;
  }
}

function noteOf(note: MeetingNote): PersonNote {
  const kraken = note.provider === 'copilot';
  return {
    id: note.id,
    source: kraken ? 'kraken' : 'granola',
    title: note.title,
    at: note.occurred_at,
    summary: summaryOf(note.content),
    content: note.content,
    flagged: note.injection_flagged,
    // A Kraken note opens its meeting; a Granola note opens on Meetings → Notes.
    href: kraken
      ? meetingPagePath(note.meeting_id ?? note.external_id)
      : `/meetings?tab=notes&q=${encodeURIComponent(note.title)}`,
  };
}

/**
 * Everything the person page shows for one address. `not_found` when the
 * address is the fund's own or a machine's, or nothing in mail or calendar
 * has it: the page then says so rather than drawing an empty profile.
 */
export async function buildPersonProfile(
  store: DataStore,
  auth: AuthContext,
  email: string,
  options: { now?: Date } = {},
): Promise<Result<PersonProfile>> {
  const now = options.now ?? new Date();
  const org = auth.organizationId;
  const integration = await getPrimaryIntegration(store, org).catch(() => null);
  const scope = { ...relationshipScope(auth.profile.email, integration), now };
  const loaded = await getRelationshipIndex(store, org, scope);
  if (!loaded.ok) return loaded;
  const index = loaded.value;
  if (!index.byAddress.has(email) || !isPerson(index, email)) {
    return err('not_found', 'Nobody with that address is in synced mail or the calendar.');
  }

  const detail = evidenceFor(index, [email], now);
  const strength = scoreRelationship(detail.evidence, now);
  const host = email.slice(email.lastIndexOf('@') + 1);
  const domain = isPersonalDomain(host) ? null : registrableDomain(host);
  const tz = auth.profile.timezone || 'UTC';

  const touches = detail.threads.slice(0, THREADS_MAX);
  const meetingTouches = detail.meetings.slice(0, MEETINGS_MAX);
  const truncated =
    detail.threads.length > touches.length || detail.meetings.length > meetingTouches.length;

  /* ------------------------------------------------------------ threads */
  const messages: EmailMessage[] = [];
  for (const keys of chunk(
    touches.map((t) => t.key),
    100,
  )) {
    messages.push(
      ...(await tolerant(
        () =>
          store.list(
            'email_messages',
            org,
            { in: { thread_id: keys } },
            { orderBy: [{ field: 'sent_at', direction: 'desc' }], limit: 2000 },
          ) as Promise<EmailMessage[]>,
      )),
    );
  }
  // The demo workspace's older history is added at read time (loadCorrespondence), not stored.
  const demo = isDemoMode() && org === DEMO_IDS.org ? demoRelationshipHistory(now) : null;
  if (demo) {
    const keys = new Set(touches.map((t) => t.key));
    messages.push(...demo.email_messages.filter((m) => keys.has(m.thread_id)));
  }
  const involves = (m: EmailMessage) =>
    [m.from_address, ...m.to_addresses, ...m.cc_addresses].some((a) => addressOf(a) === email);
  const byThread = new Map<string, EmailMessage[]>();
  for (const m of messages) {
    if (Date.parse(m.sent_at) > now.getTime() || !involves(m)) continue;
    byThread.set(m.thread_id, [...(byThread.get(m.thread_id) ?? []), m]);
  }
  /** The newest message with them, from the side the index says wrote last. */
  const newestOf = (key: string, fromUs: boolean): EmailMessage | undefined => {
    const all = byThread.get(key) ?? [];
    const side = all.filter((m) => {
      const from = addressOf(m.from_address);
      return (from !== null && index.own.has(from)) === fromUs;
    });
    return (side.length ? side : all).reduce<EmailMessage | undefined>(
      (best, m) => (!best || m.sent_at > best.sent_at ? m : best),
      undefined,
    );
  };
  const threads: PersonThread[] = touches.map((t) => {
    const m = newestOf(t.key, t.lastFromUs);
    return {
      key: t.key,
      gmailId: t.gmailId,
      subject: t.subject?.trim() || '(no subject)',
      at: new Date(t.lastAt).toISOString(),
      direction: t.lastFromUs ? 'us' : 'them',
      snippet: m?.snippet?.trim() || null,
      flagged: m?.injection_flagged ?? false,
      emailsIn: t.emailsIn,
      emailsOut: t.emailsOut,
    };
  });

  /* ----------------------------------------------------------- meetings */
  const events = (
    await Promise.all(
      chunk(
        meetingTouches.map((m) => m.id),
        100,
      ).map((ids) =>
        tolerant(
          () => store.list('calendar_events', org, { in: { id: ids } }) as Promise<CalendarEvent[]>,
        ),
      ),
    )
  )
    .flat()
    .concat(
      demo ? demo.calendar_events.filter((e) => meetingTouches.some((m) => m.id === e.id)) : [],
    )
    // The index already leaves private events out; checked again here.
    .filter((e) => !e.is_private);
  const eventById = new Map(events.map((e) => [e.id, e]));

  // Kraken Notes meetings, where the viewer has the feature and may see them.
  const access = await notesAccess(store, auth).catch(() => ({ enabled: false }));
  let krakenMeetings: Meeting[] = [];
  if (access.enabled) {
    try {
      const participants = (await store.list('meeting_participants', org, {
        eq: { email },
      })) as MeetingParticipant[];
      const byEvent = events.map((e) => e.provider_event_id).filter(Boolean);
      const [byPerson, byCalendar] = await Promise.all([
        participants.length
          ? (store.list('meetings', org, {
              in: { id: [...new Set(participants.map((p) => p.meeting_id))] },
            }) as Promise<Meeting[]>)
          : Promise.resolve([] as Meeting[]),
        byEvent.length
          ? (store.list('meetings', org, {
              in: { provider_event_id: byEvent },
            }) as Promise<Meeting[]>)
          : Promise.resolve([] as Meeting[]),
      ]);
      const seen = new Map<string, Meeting>();
      for (const m of [...byPerson, ...byCalendar]) {
        if (!m.deleted_at && canSeeMeeting(m, auth.userId)) seen.set(m.id, m);
      }
      krakenMeetings = [...seen.values()];
    } catch (error) {
      if (!isMissingTableError(error) && !isMissingColumnError(error)) throw error;
    }
  }

  // Meeting notes the team may see, with them on it or titled like a meeting with them.
  let notesRead = true;
  let teamNotes: MeetingNote[] = [];
  try {
    teamNotes = await recentTeamNotes(store, org);
  } catch {
    notesRead = false;
  }

  const meetings: PersonMeeting[] = meetingTouches.map((touch) => {
    const event = eventById.get(touch.id);
    const attendees = (event?.attendees ?? [])
      .filter((a) => a.response !== 'declined' && a.email.includes('@'))
      .filter((a) => !ROOM.test(a.email.slice(a.email.lastIndexOf('@') + 1).toLowerCase()))
      .map((a) => ({ name: a.name?.trim() || null, email: a.email.toLowerCase() }));
    const kraken = event?.provider_event_id
      ? krakenMeetings.find((m) => m.provider_event_id === event.provider_event_id)
      : undefined;
    return {
      key: `event-${touch.id}`,
      title: touch.title,
      at: new Date(touch.at).toISOString(),
      upcoming: touch.upcoming,
      attendees,
      krakenHref: kraken ? meetingPagePath(kraken.id) : null,
      notes: [],
    };
  });

  // Kraken meetings with them that no calendar entry above stands for.
  const placed = new Set(meetings.map((m) => m.krakenHref).filter((h): h is string => h !== null));
  for (const k of krakenMeetings) {
    const href = meetingPagePath(k.id);
    if (placed.has(href)) continue;
    const at = k.started_at ?? k.scheduled_start ?? k.created_at;
    meetings.push({
      key: `kraken-${k.id}`,
      title: k.title,
      at,
      upcoming: Date.parse(at) > now.getTime(),
      attendees: [],
      krakenHref: href,
      notes: [],
    });
  }

  // Each note joins its meeting: a Kraken note by its meeting, any note by
  // the same title within a day and a half. The rest stand on their own.
  const krakenHrefOfNote = (n: MeetingNote) =>
    n.provider === 'copilot' ? meetingPagePath(n.meeting_id ?? n.external_id) : null;
  const titled = new Map<string, PersonMeeting[]>();
  for (const m of meetings) {
    const key = normaliseTitle(m.title);
    if (key) titled.set(key, [...(titled.get(key) ?? []), m]);
  }
  const loose: PersonNote[] = [];
  for (const note of teamNotes) {
    const withThem = note.attendees.some((a) => a.email.toLowerCase() === email);
    const href = krakenHrefOfNote(note);
    let home = href ? meetings.find((m) => m.krakenHref === href) : undefined;
    if (!home) {
      const at = Date.parse(note.occurred_at);
      home = (titled.get(normaliseTitle(note.title)) ?? []).find(
        (m) => Math.abs(Date.parse(m.at) - at) <= SAME_MEETING_MS,
      );
    }
    if (home) home.notes.push(noteOf(note));
    else if (withThem) loose.push(noteOf(note));
  }
  for (const note of loose) {
    meetings.push({
      key: `note-${note.id}`,
      title: note.title,
      at: note.at,
      upcoming: false,
      attendees:
        teamNotes
          .find((n) => n.id === note.id)
          ?.attendees.map((a) => ({ name: a.name, email: a.email.toLowerCase() })) ?? [],
      krakenHref: null,
      notes: [note],
    });
  }
  meetings.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));

  /* ------------------------------------------------------------- extras */
  const name = nameFor(index, email);
  const [tasks, records] = await Promise.all([
    name
      ? tolerant(
          () =>
            store.list(
              'tasks',
              org,
              { textSearch: { columns: ['title', 'detail'], query: name } },
              { limit: 50 },
            ) as Promise<Task[]>,
        ).catch(() => [] as Task[])
      : Promise.resolve([] as Task[]),
    tolerant(
      () =>
        store.list(
          'crm_records',
          org,
          { arrayContains: { emails: email } },
          { limit: 5 },
        ) as Promise<CrmRecord[]>,
    ).catch(() => [] as CrmRecord[]),
  ]);

  return ok({
    email,
    name,
    domain,
    status: contactStatus(detail.evidence.lastContactAt, now),
    strength,
    evidence: detail.evidence,
    summary: evidenceSummary(detail.evidence, now, tz),
    threads,
    meetings,
    truncated,
    tasks: tasks
      .filter((t) => t.status === 'open' || t.status === 'snoozed')
      .filter((t) => !t.space_id)
      .slice(0, TASKS_MAX)
      .map((t) => ({ id: t.id, title: t.title, dueAt: t.due_at })),
    records: records.filter((r) => r.kind === 'person').map((r) => ({ id: r.id, name: r.name })),
    notesRead,
    mailbox: integration?.account_email ?? null,
  });
}
