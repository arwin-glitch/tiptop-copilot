import 'server-only';
import { chunk } from '@/lib/db/paging';
import type { MeetingNote } from '@/lib/types/domain';
import type {
  ListMeetingsQuery,
  Meeting,
  MeetingListItem,
  MeetingParticipant,
  MeetingView,
  NotesSearchHit,
  TranscriptSegment,
} from '@/lib/types/notes';
import { ok, type Result } from '@/lib/util/result';
import { canSeeMeeting, guard, meetingView, type NotesContext } from './notes';
import { readTeamInfo } from './notes-context';

/**
 * The Notes tab's list and search (D-076): Kraken meetings and Granola notes
 * in one list, newest first, each with its source. A Kraken meeting paired
 * with a Granola note of the same conversation (meetings.granola_external_id)
 * shows once, as the Kraken row, with the Granola row named in `pairedWith`.
 *
 * Search matches titles, notes and transcript lines through the tsvector
 * columns on Supabase (a ranked substring match in demo mode), so it reaches
 * every note, not a page of them. Transcript hits carry the line's time, so a
 * result opens the transcript at that moment.
 */

export const PAGE = 50;
const SCAN = 500;

function occurredAt(m: Meeting): string {
  return m.started_at ?? m.scheduled_start ?? m.created_at;
}

function domainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  return at < 0 ? null : email.slice(at + 1).toLowerCase();
}

function snippetAround(text: string, query: string, radius = 80): string {
  const lower = text.toLowerCase();
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  const at = [query.toLowerCase(), ...words].map((w) => lower.indexOf(w)).find((i) => i >= 0) ?? -1;
  if (at < 0) return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + query.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

interface Loaded {
  meetings: Meeting[];
  peopleOf: Map<string, MeetingParticipant[]>;
  noteOf: Map<string, MeetingNote>;
}

/** Meetings this person may see, with their participants and Kraken notes. */
async function loadMeetings(
  ctx: NotesContext,
  filter: { folder?: string; eventId?: string } = {},
): Promise<Loaded> {
  const org = ctx.auth.organizationId;
  const eq: Record<string, string> = {};
  if (filter.folder) eq.folder_id = filter.folder;
  if (filter.eventId) eq.provider_event_id = filter.eventId;
  const meetings = (
    (await ctx.store.list(
      'meetings',
      org,
      { isNull: ['deleted_at'], ...(Object.keys(eq).length ? { eq } : {}) },
      { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: SCAN },
    )) as Meeting[]
  ).filter((m) => canSeeMeeting(m, ctx.auth.userId));
  const ids = meetings.map((m) => m.id);
  const participants: MeetingParticipant[] = [];
  const copilotNotes: MeetingNote[] = [];
  for (const part of chunk(ids, 100)) {
    participants.push(
      ...((await ctx.store.list('meeting_participants', org, {
        in: { meeting_id: part },
      })) as MeetingParticipant[]),
    );
    copilotNotes.push(
      ...((await ctx.store.list('meeting_notes', org, {
        eq: { provider: 'copilot' },
        in: { external_id: part },
      })) as MeetingNote[]),
    );
  }
  const peopleOf = new Map<string, MeetingParticipant[]>();
  for (const p of participants)
    peopleOf.set(p.meeting_id, [...(peopleOf.get(p.meeting_id) ?? []), p]);
  return { meetings, peopleOf, noteOf: new Map(copilotNotes.map((n) => [n.external_id, n])) };
}

function copilotItem(m: Meeting, loaded: Loaded, granola: readonly MeetingNote[]): MeetingListItem {
  const people = loaded.peopleOf.get(m.id) ?? [];
  const note = loaded.noteOf.get(m.id);
  const twin = m.granola_external_id
    ? granola.find((n) => n.external_id === m.granola_external_id)
    : undefined;
  return {
    source: 'copilot',
    qualifiedId: `copilot:${m.id}`,
    meetingId: m.id,
    noteId: note?.id ?? null,
    title: m.title,
    occurredAt: occurredAt(m),
    status: m.status,
    attendees: people
      .filter((p): p is MeetingParticipant & { email: string } => Boolean(p.email))
      .map((p) => ({ name: p.name, email: p.email })),
    hasActionItems: (note?.action_items ?? []).length > 0,
    folderId: m.folder_id,
    visibility: m.visibility,
    recordedMs: m.recorded_ms,
    pairedWith: twin ? `granola:${twin.id}` : null,
  };
}

function granolaItem(n: MeetingNote): MeetingListItem {
  return {
    source: 'granola',
    qualifiedId: `granola:${n.id}`,
    meetingId: null,
    noteId: n.id,
    title: n.title,
    occurredAt: n.occurred_at,
    status: null,
    attendees: n.attendees,
    hasActionItems: false,
    folderId: null,
    visibility: 'team',
    recordedMs: null,
    pairedWith: null,
  };
}

const byNewest = (a: MeetingListItem, b: MeetingListItem) =>
  a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0;

export async function listMeetings(
  ctx: NotesContext,
  query: ListMeetingsQuery,
): Promise<
  Result<{ meetings: MeetingListItem[]; hits: NotesSearchHit[]; nextCursor: string | null }>
> {
  return guard('read the meetings', async () => {
    const org = ctx.auth.organizationId;
    const source = query.source ?? 'all';
    const q = query.q?.trim() ?? '';

    const loaded: Loaded =
      source === 'granola'
        ? { meetings: [], peopleOf: new Map(), noteOf: new Map() }
        : await loadMeetings(ctx, { folder: query.folder, eventId: query.eventId });
    const meetings = loaded.meetings;
    const ids = meetings.map((m) => m.id);
    const visible = new Set(ids);
    // A folder or a calendar event narrows to Kraken meetings: Granola rows have neither.
    const withGranola = source !== 'copilot' && !query.folder && !query.eventId;
    let granola = withGranola
      ? ((await ctx.store.list(
          'meeting_notes',
          org,
          { eq: { provider: 'granola' } },
          { orderBy: [{ field: 'occurred_at', direction: 'desc' }], limit: SCAN },
        )) as MeetingNote[])
      : [];
    const paired = new Set(
      meetings.map((m) => m.granola_external_id).filter((x): x is string => Boolean(x)),
    );

    const hits: NotesSearchHit[] = [];
    const matched = new Set<string>();
    if (q) {
      const lower = q.toLowerCase();
      for (const m of meetings) {
        if (!m.title.toLowerCase().includes(lower)) continue;
        matched.add(`copilot:${m.id}`);
        hits.push({
          qualifiedId: `copilot:${m.id}`,
          meetingId: m.id,
          source: 'copilot',
          title: m.title,
          occurredAt: occurredAt(m),
          field: 'title',
          snippet: m.title,
          seq: null,
          startMs: null,
        });
      }
      if (ids.length) {
        const byId = new Map(meetings.map((m) => [m.id, m]));
        for (const part of chunk(ids, 200)) {
          const lines = (await ctx.store.search(
            'transcript_segments',
            org,
            q,
            ['text', 'edited_text'],
            { in: { meeting_id: part } },
            30,
          )) as { row: TranscriptSegment }[];
          for (const { row } of lines) {
            const m = byId.get(row.meeting_id);
            if (!m) continue;
            matched.add(`copilot:${m.id}`);
            hits.push({
              qualifiedId: `copilot:${m.id}`,
              meetingId: m.id,
              source: 'copilot',
              title: m.title,
              occurredAt: occurredAt(m),
              field: 'transcript',
              snippet: snippetAround(row.edited_text ?? row.text, q),
              seq: row.seq,
              startMs: row.start_ms,
            });
          }
        }
      }
      // Notes: full-text over title, typed notes and content, across every
      // note rather than the newest page.
      const noteHits = (await ctx.store.search(
        'meeting_notes',
        org,
        q,
        ['title', 'content', 'user_notes'],
        undefined,
        80,
      )) as { row: MeetingNote }[];
      for (const { row: n } of noteHits) {
        const isCopilot = n.provider === 'copilot';
        if (isCopilot && !visible.has(n.external_id)) continue;
        if (!isCopilot && !withGranola) continue;
        if (!isCopilot && !granola.some((g) => g.id === n.id)) granola = [...granola, n];
        const key = isCopilot ? `copilot:${n.external_id}` : `granola:${n.id}`;
        matched.add(key);
        const text = `${n.user_notes ?? ''}\n${n.content}`.trim();
        hits.push({
          qualifiedId: key,
          meetingId: isCopilot ? n.external_id : null,
          source: isCopilot ? 'copilot' : 'granola',
          title: n.title,
          occurredAt: n.occurred_at,
          field: n.title.toLowerCase().includes(lower) ? 'title' : 'notes',
          snippet: snippetAround(text, q),
          seq: null,
          startMs: null,
        });
      }
    }

    const personMatch = (emails: (string | null)[]) =>
      (!query.person || emails.includes(query.person)) &&
      (!query.company || emails.some((e) => domainOf(e) === query.company));

    const items: MeetingListItem[] = [];
    for (const m of meetings) {
      if (q && !matched.has(`copilot:${m.id}`)) continue;
      const item = copilotItem(m, loaded, granola);
      if (!personMatch((loaded.peopleOf.get(m.id) ?? []).map((p) => p.email))) continue;
      if (query.hasActionItems !== undefined && item.hasActionItems !== query.hasActionItems)
        continue;
      items.push(item);
    }
    for (const n of granola) {
      if (paired.has(n.external_id)) continue;
      if (q && !matched.has(`granola:${n.id}`)) continue;
      if (!personMatch(n.attendees.map((a) => a.email))) continue;
      if (query.hasActionItems === true) continue;
      items.push(granolaItem(n));
    }
    items.sort(byNewest);
    const offset = Math.max(0, Number.parseInt(query.cursor ?? '0', 10) || 0);
    const page = items.slice(offset, offset + PAGE);
    return ok({
      meetings: page,
      hits: hits.slice(0, 50),
      nextCursor: offset + PAGE < items.length ? String(offset + PAGE) : null,
    });
  });
}

/* ======================================================= event card == */

const PAST_NOTES = 5;

/**
 * What the calendar's event card shows (D-076): this person's meeting for the
 * event (null before "Take notes"), earlier meetings of the same recurring
 * series, and earlier notes with any of the guests, Kraken and Granola, a
 * conversation recorded by both shown once. Only what this person may see.
 */
export async function eventNotes(
  ctx: NotesContext,
  input: { eventId: string; recurringEventId?: string | null; emails?: readonly string[] },
  now: Date = ctx.now ?? new Date(),
): Promise<
  Result<{ meeting: MeetingView | null; series: MeetingListItem[]; pastNotes: MeetingListItem[] }>
> {
  return guard('read the notes for this event', async () => {
    const org = ctx.auth.organizationId;
    const loaded = await loadMeetings(ctx);
    const forEvent = loaded.meetings.filter((m) => m.provider_event_id === input.eventId);
    const mine = forEvent.find((m) => m.recorded_by === ctx.auth.userId) ?? forEvent[0] ?? null;
    const granola = (await ctx.store.list(
      'meeting_notes',
      org,
      { eq: { provider: 'granola' }, lt: { occurred_at: now.toISOString() } },
      { orderBy: [{ field: 'occurred_at', direction: 'desc' }], limit: SCAN },
    )) as MeetingNote[];
    const paired = new Set(
      loaded.meetings.map((m) => m.granola_external_id).filter((x): x is string => Boolean(x)),
    );
    const before = (m: Meeting) => occurredAt(m) < now.toISOString();

    const series = input.recurringEventId
      ? loaded.meetings
          .filter(
            (m) =>
              m.recurring_event_id === input.recurringEventId && m.id !== mine?.id && before(m),
          )
          .map((m) => copilotItem(m, loaded, granola))
          .sort(byNewest)
          .slice(0, PAST_NOTES)
      : [];

    // Guests only: the team is on every note, so its addresses match nothing.
    const team = await readTeamInfo(ctx.store, org);
    const own = ctx.auth.profile.email?.toLowerCase() ?? null;
    const emails = new Set(
      (input.emails ?? [])
        .map((e) => e.toLowerCase())
        .filter((e) => e !== own && !team.emails.has(e)),
    );
    const pastNotes: MeetingListItem[] = [];
    if (emails.size) {
      for (const m of loaded.meetings) {
        if (m.id === mine?.id || !before(m)) continue;
        const people = loaded.peopleOf.get(m.id) ?? [];
        if (people.some((p) => p.role !== 'self' && p.email && emails.has(p.email.toLowerCase()))) {
          pastNotes.push(copilotItem(m, loaded, granola));
        }
      }
      for (const n of granola) {
        if (paired.has(n.external_id)) continue;
        if (n.attendees.some((a) => emails.has(a.email.toLowerCase())))
          pastNotes.push(granolaItem(n));
      }
    }
    pastNotes.sort(byNewest);
    return ok({
      meeting: mine ? meetingView(ctx, mine) : null,
      series,
      pastNotes: pastNotes.slice(0, PAST_NOTES),
    });
  });
}
