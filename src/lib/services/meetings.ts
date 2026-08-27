import 'server-only';
import { z } from 'zod';
import type { DataStore } from '@/lib/db/store';
import { scanForInjection } from '@/lib/security/injection';
import { err, ok, type Result } from '@/lib/util/result';
import type { CalendarEvent, Deal, MeetingNote, PortfolioCompany } from '@/lib/types/domain';

/**
 * Meeting notes from Granola.
 *
 * Granola's Zapier trigger fires when a note lands in a watched folder and
 * POSTs whatever field mapping the Zap defines. The shape below is *ours*:
 * the Zap is configured to map Granola's fields onto these names, which keeps
 * this endpoint independent of Zapier's own payload conventions — a Zapier
 * rename cannot silently break ingestion, only an explicit Zap edit can.
 *
 * Everything is stored verbatim and linked to nothing at write time. The
 * associations a reader sees — this note belongs to that deal, that company,
 * those people — are derived from attendee addresses when the page renders,
 * against records that exist. A wrong guess therefore cannot be persisted,
 * and deleting a deal never strands a pointer.
 */

export const GRANOLA_NOTE_SCHEMA = z.object({
  /** Granola's note id. Zapier retries deliveries; ingestion upserts on this. */
  external_id: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(500),
  /** ISO timestamp of the meeting, from the calendar event Granola attaches. */
  occurred_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'occurred_at must be an ISO date-time',
  }),
  /**
   * Zapier flattens arrays into comma-joined strings depending on how the Zap
   * is built, so both shapes are accepted and normalised.
   */
  attendee_emails: z.union([z.array(z.string()), z.string()]).default([]),
  attendee_names: z.union([z.array(z.string()), z.string()]).default([]),
  content: z.string().min(1).max(200_000),
  source_url: z.string().url().max(2000).nullish(),
});

export type GranolaNotePayload = z.infer<typeof GRANOLA_NOTE_SCHEMA>;

function asList(value: string[] | string): string[] {
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter(Boolean);
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Pairs names with emails by position; unmatched names are dropped, not guessed. */
export function normaliseAttendees(
  emails: string[] | string,
  names: string[] | string,
): { name: string | null; email: string }[] {
  const emailList = asList(emails);
  const nameList = asList(names);

  const seen = new Set<string>();
  const attendees: { name: string | null; email: string }[] = [];

  for (let i = 0; i < emailList.length; i++) {
    const email = emailList[i]!.toLowerCase();
    if (!email.includes('@') || seen.has(email)) continue;
    seen.add(email);
    const name = nameList[i]?.trim();
    attendees.push({ name: name && !name.includes('@') ? name : null, email });
  }

  return attendees;
}

/** Lowercased letters and digits only, so formatting differences cannot block a match. */
function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const CALENDAR_MATCH_WINDOW_MS = 3 * 86_400_000;

/**
 * The synced calendar event a note is about, or null. Exact normalised-title
 * equality within a three-day window — never similarity, because "matched to
 * the wrong meeting" would attribute a conversation to the wrong company,
 * which is worse than no attribution at all.
 */
async function matchCalendarEvent(
  store: DataStore,
  organizationId: string,
  title: string,
  occurredAt: string,
): Promise<CalendarEvent | null> {
  const target = normaliseTitle(title);
  if (!target) return null;
  const time = Date.parse(occurredAt);

  const events = (await store.list(
    'calendar_events',
    organizationId,
    {},
    { orderBy: [{ field: 'starts_at', direction: 'desc' }], limit: 500 },
  )) as CalendarEvent[];

  const candidates = events.filter(
    (event) =>
      !event.is_private &&
      normaliseTitle(event.title) === target &&
      Math.abs(Date.parse(event.starts_at) - time) <= CALENDAR_MATCH_WINDOW_MS,
  );

  // Two same-titled events in the window (a recurring series) is ambiguity,
  // and ambiguity recovers nothing rather than guessing an occurrence.
  if (candidates.length !== 1) return null;
  return candidates[0] ?? null;
}

export async function ingestGranolaNote(
  store: DataStore,
  organizationId: string,
  payload: GranolaNotePayload,
  now: Date = new Date(),
): Promise<Result<{ id: string; created: boolean; flagged: boolean }>> {
  let attendees = normaliseAttendees(payload.attendee_emails, payload.attendee_names);
  let occurredAt = new Date(payload.occurred_at).toISOString();

  // A note that arrives without attendees — a Slack summary post carries none —
  // can often be completed from the calendar the app already syncs: an event
  // whose title matches the note's exactly, near the note's time, is the
  // meeting the note is about. This is copying from our own record on an exact
  // match, not inference; a near-miss title recovers nothing.
  if (attendees.length === 0) {
    const match = await matchCalendarEvent(store, organizationId, payload.title, occurredAt);
    if (match) {
      attendees = match.attendees
        .filter((a) => a.email && a.email.includes('@'))
        .map((a) => ({ name: a.name ?? null, email: a.email.toLowerCase() }));
      // The event's start is when the meeting happened; a Slack post's
      // timestamp is merely when the summary was shared.
      occurredAt = match.starts_at;
    }
  }

  // Notes are prose someone else controls the content of, which makes them the
  // same class of input as email bodies: scan, annotate, never hide.
  const scan = scanForInjection(`${payload.title}\n${payload.content}`);

  const existing = (await store.findOne('meeting_notes', organizationId, {
    eq: { provider: 'granola', external_id: payload.external_id },
  })) as MeetingNote | null;

  if (existing) {
    // Granola notes keep being edited after the meeting, so a redelivery with
    // newer content updates in place rather than being dropped as a duplicate.
    const updated = await store.update('meeting_notes', organizationId, existing.id, {
      title: payload.title,
      occurred_at: occurredAt,
      attendees,
      content: payload.content,
      source_url: payload.source_url ?? null,
      injection_flagged: scan.flagged,
      updated_at: now.toISOString(),
    } as Partial<MeetingNote>);
    if (!updated) return err('internal', 'The existing note could not be updated.');
    return ok({ id: existing.id, created: false, flagged: scan.flagged });
  }

  const note: MeetingNote = {
    id: crypto.randomUUID(),
    organization_id: organizationId,
    provider: 'granola',
    external_id: payload.external_id,
    title: payload.title,
    occurred_at: occurredAt,
    attendees,
    content: payload.content,
    source_url: payload.source_url ?? null,
    injection_flagged: scan.flagged,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  await store.insert('meeting_notes', note);
  return ok({ id: note.id, created: true, flagged: scan.flagged });
}

/* ------------------------------------------------------- read-time linking */

const NOTE_LIMIT = 200;

async function recentNotes(store: DataStore, organizationId: string): Promise<MeetingNote[]> {
  return (await store.list(
    'meeting_notes',
    organizationId,
    {},
    { orderBy: [{ field: 'occurred_at', direction: 'desc' }], limit: NOTE_LIMIT },
  )) as MeetingNote[];
}

function attendeeDomains(note: MeetingNote): Set<string> {
  const domains = new Set<string>();
  for (const attendee of note.attendees) {
    const at = attendee.email.lastIndexOf('@');
    if (at > 0) domains.add(attendee.email.slice(at + 1).toLowerCase());
  }
  return domains;
}

/**
 * Notes for one deal: any note with an attendee at the deal's domain, or at
 * the address of a person already recorded on the deal. The same rule the
 * Inbox uses to link email — domain matching against a record that exists is
 * a lookup, not an inference.
 */
export async function notesForDeal(
  store: DataStore,
  organizationId: string,
  deal: Pick<Deal, 'id' | 'domain'>,
  peopleEmails: string[],
): Promise<MeetingNote[]> {
  const notes = await recentNotes(store, organizationId);
  const domain = deal.domain?.toLowerCase() ?? null;
  const people = new Set(peopleEmails.map((e) => e.toLowerCase()));

  return notes.filter((note) => {
    if (domain && attendeeDomains(note).has(domain)) return true;
    return note.attendees.some((a) => people.has(a.email.toLowerCase()));
  });
}

/** Notes for one portfolio company, by its domain and recorded contacts. */
export async function notesForCompany(
  store: DataStore,
  organizationId: string,
  company: Pick<PortfolioCompany, 'id' | 'domain'>,
  contactEmails: string[],
): Promise<MeetingNote[]> {
  const notes = await recentNotes(store, organizationId);
  const domain = company.domain?.toLowerCase() ?? null;
  const contacts = new Set(contactEmails.map((e) => e.toLowerCase()));

  return notes.filter((note) => {
    if (domain && attendeeDomains(note).has(domain)) return true;
    return note.attendees.some((a) => contacts.has(a.email.toLowerCase()));
  });
}

/** Note counts per attendee address, for the relationship list. */
export async function noteCountsByEmail(
  store: DataStore,
  organizationId: string,
): Promise<Map<string, number>> {
  const notes = await recentNotes(store, organizationId);
  const counts = new Map<string, number>();
  for (const note of notes) {
    for (const attendee of note.attendees) {
      const email = attendee.email.toLowerCase();
      counts.set(email, (counts.get(email) ?? 0) + 1);
    }
  }
  return counts;
}

/* ------------------------------------------------------- email transport */

/**
 * Granola notes can also arrive as email, sent by a free Zapier Gmail action
 * into the synced mailbox. The email is pure transport: its body is a
 * line-oriented envelope this module defines, the Zap template fills in, and
 * this parser reads back. Controlling both ends is the point — no guessing at
 * someone else's email formatting, and a change to Granola's own emails can
 * never break this path because Granola's own emails are not involved.
 *
 * Format (plain text):
 *
 *   granola-note-v1
 *   external_id: <granola note id>
 *   occurred_at: <ISO date-time>
 *   attendee_emails: a@x.com, b@y.com
 *   attendee_names: Alice, Bob
 *   ---
 *   <the note, verbatim, to the end>
 */

export const GRANOLA_EMAIL_SUBJECT_PREFIX = '[granola]';
const GRANOLA_EMAIL_MARKER = 'granola-note-v1';

export function isGranolaNoteEmail(subject: string | null): boolean {
  return (subject ?? '').trim().toLowerCase().startsWith(GRANOLA_EMAIL_SUBJECT_PREFIX);
}

export function parseGranolaEmail(
  subject: string | null,
  bodyText: string | null,
): GranolaNotePayload | null {
  if (!bodyText || !isGranolaNoteEmail(subject)) return null;

  const lines = bodyText.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && lines[index]!.trim() === '') index++;
  if (lines[index]?.trim().toLowerCase() !== GRANOLA_EMAIL_MARKER) return null;
  index++;

  const fields: Record<string, string> = {};
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === '---') {
      index++;
      break;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    fields[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }

  // Everything after the divider is the note. A trailing "sent via Zapier"
  // footer is stripped; anything else stays verbatim.
  const content = lines
    .slice(index)
    .join('\n')
    .replace(/\n+-*\s*sent (from|by|via) zapier[\s\S]*$/i, '')
    .trim();

  const title = (subject ?? '').trim().slice(GRANOLA_EMAIL_SUBJECT_PREFIX.length).trim();

  const candidate = {
    external_id: fields['external_id'] ?? '',
    title: title || 'Untitled meeting',
    occurred_at: fields['occurred_at'] ?? '',
    attendee_emails: fields['attendee_emails'] ?? '',
    attendee_names: fields['attendee_names'] ?? '',
    content,
  };

  const parsed = GRANOLA_NOTE_SCHEMA.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/* ------------------------------------------------------------- the catch-up */

/**
 * How far back a catch-up looks beyond the newest meeting it already holds.
 *
 * Granola publishes a note only once the AI summary and transcript exist, so a
 * note's arrival lags its meeting — by minutes usually, by longer if the app
 * was offline when the call ended. The window has to cover that lag or the
 * note that was late is the note that is missed permanently. Three days is
 * comfortably more than the observed lag and still small enough that a routine
 * catch-up is one request.
 */
export const CATCH_UP_OVERLAP_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The instant a catch-up should ask Granola about, or null to walk everything.
 *
 * Derived from the newest meeting we hold rather than stored as a watermark,
 * because a stored watermark can advance past a note that failed to ingest and
 * strand it for ever. This cannot: the window is always anchored to data that
 * actually landed.
 *
 * Clamped to the present because `occurred_at` comes from the calendar event,
 * and a note attached to a scheduled future meeting would otherwise push the
 * window past now and hide everything behind it.
 */
export async function catchUpSince(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const newest = (await store.list(
    'meeting_notes',
    organizationId,
    {},
    { orderBy: [{ field: 'occurred_at', direction: 'desc' }], limit: 1 },
  )) as MeetingNote[];

  const latest = newest[0]?.occurred_at;
  if (!latest) return null; // nothing here yet: this is a first import, not a catch-up

  const at = Date.parse(latest);
  if (Number.isNaN(at)) return null;

  return new Date(Math.min(at, now.getTime()) - CATCH_UP_OVERLAP_MS).toISOString();
}

/**
 * What we already hold, keyed by Granola's note id.
 *
 * One query per page rather than one per note. The value is our row's
 * `updated_at`, which is the moment we last wrote it: compare it against the
 * note's `updated_at` at Granola and a note untouched since we stored it needs
 * no content fetch at all. That comparison is what turned a full import from
 * nine hundred fetches into a few dozen — and the volume of those fetches was
 * what made the host answer 502 partway through every run.
 */
export async function existingNoteVersions(
  store: DataStore,
  organizationId: string,
  externalIds: string[],
): Promise<Map<string, string>> {
  if (externalIds.length === 0) return new Map();

  const rows = (await store.list('meeting_notes', organizationId, {
    eq: { provider: 'granola' },
    in: { external_id: externalIds },
  })) as MeetingNote[];

  return new Map(rows.map((row) => [row.external_id, row.updated_at]));
}

/**
 * Is the copy we hold already current?
 *
 * Only when we know both sides. An unparseable or absent timestamp means fetch
 * it — being wrong here costs one request, and the opposite mistake silently
 * keeps a stale note for ever.
 */
export function isNoteUnchanged(ourUpdatedAt: string | undefined, theirUpdatedAt: string | null) {
  if (!ourUpdatedAt || !theirUpdatedAt) return false;
  const ours = Date.parse(ourUpdatedAt);
  const theirs = Date.parse(theirUpdatedAt);
  if (Number.isNaN(ours) || Number.isNaN(theirs)) return false;
  return ours >= theirs;
}

/* ---------------------------------------------------------- the index page */

export interface MeetingListOptions {
  search?: string;
  limit?: number;
}

/**
 * Every meeting note, newest first.
 *
 * The deal and company pages only show a note once an attendee's domain
 * matches a record that exists, which is the right rule there and a trap
 * everywhere else: a meeting with a company the fund has never opened a file
 * on would be stored and invisible. This is the view that always has it.
 */
export async function listMeetingNotes(
  store: DataStore,
  organizationId: string,
  options: MeetingListOptions = {},
): Promise<MeetingNote[]> {
  const search = options.search?.trim();

  // The match happens in the database, not here.
  //
  // This used to fetch a page of notes and filter it in memory, which quietly
  // searched only that page: with 2,232 notes and a limit of 500, three out of
  // four were unreachable no matter what you typed, and the result looked like
  // a confident "no matches". Pushing the predicate down means a search sees
  // every note and still returns one page of them.
  //
  // Substring rather than full-text because `meeting_notes` has no
  // `search_vector` column — every other searchable table has one, and adding
  // it here is the better long-term fix. ILIKE over title and content is
  // correct, just not index-assisted.
  //
  // Title and content only. Attendees are `jsonb` and cannot join an ILIKE
  // over text columns, so searching a person whose name appears nowhere in the
  // note itself no longer matches. That is a deliberate trade: it used to work
  // across a page of 500 notes and now does not work at all, in exchange for
  // title and body search working across all of them. Restoring it properly
  // means the `search_vector` column above, generated from title, content and
  // the attendee text together.
  const filter = search
    ? { textSearch: { columns: ['title', 'content'], query: search } }
    : undefined;

  const notes = (await store.list('meeting_notes', organizationId, filter, {
    orderBy: [{ field: 'occurred_at', direction: 'desc' }],
    limit: options.limit ?? 500,
  })) as MeetingNote[];

  return notes;
}
