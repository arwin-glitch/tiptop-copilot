import 'server-only';
import { chunk } from '@/lib/db/paging';
import type { MeetingNote } from '@/lib/types/domain';
import type {
  ListMeetingsQuery,
  Meeting,
  MeetingListItem,
  MeetingParticipant,
  NotesSearchHit,
  TranscriptSegment,
} from '@/lib/types/notes';
import { ok, type Result } from '@/lib/util/result';
import { canSeeMeeting, guard, type NotesContext } from './notes';

/**
 * The Notes tab's list and search (D-076): Copilot meetings and Granola notes
 * in one list, newest first, each with its source. A Copilot meeting paired
 * with a Granola note of the same conversation (meetings.granola_external_id)
 * shows once, as the Copilot row, with the Granola row named in `pairedWith`.
 *
 * Search matches titles, notes and transcript lines. On Supabase the
 * transcript and notes go through the tsvector columns; in demo mode, a
 * ranked substring match. Transcript hits carry the line's time, so a result
 * opens the transcript at that moment.
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
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + query.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

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

    const meetings =
      source === 'granola'
        ? []
        : (
            (await ctx.store.list(
              'meetings',
              org,
              {
                isNull: ['deleted_at'],
                ...(query.folder || query.eventId
                  ? {
                      eq: {
                        ...(query.folder ? { folder_id: query.folder } : {}),
                        ...(query.eventId ? { provider_event_id: query.eventId } : {}),
                      },
                    }
                  : {}),
              },
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
    const granola =
      source === 'copilot' || query.folder || query.eventId
        ? []
        : ((await ctx.store.list(
            'meeting_notes',
            org,
            { eq: { provider: 'granola' } },
            { orderBy: [{ field: 'occurred_at', direction: 'desc' }], limit: SCAN },
          )) as MeetingNote[]);

    const peopleOf = new Map<string, MeetingParticipant[]>();
    for (const p of participants) {
      const list = peopleOf.get(p.meeting_id) ?? [];
      list.push(p);
      peopleOf.set(p.meeting_id, list);
    }
    const noteOf = new Map(copilotNotes.map((n) => [n.external_id, n]));
    const paired = new Map(
      meetings
        .filter((m) => m.granola_external_id)
        .map((m) => [m.granola_external_id as string, m]),
    );

    const hits: NotesSearchHit[] = [];
    const matchedMeetings = new Set<string>();
    if (q) {
      const lower = q.toLowerCase();
      for (const m of meetings) {
        if (m.title.toLowerCase().includes(lower)) {
          matchedMeetings.add(m.id);
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
      }
      if (ids.length) {
        const lines = await ctx.store.search(
          'transcript_segments',
          org,
          q,
          ['text', 'edited_text'],
          { in: { meeting_id: ids.slice(0, 200) } },
          30,
        );
        const byId = new Map(meetings.map((m) => [m.id, m]));
        for (const { row } of lines as { row: TranscriptSegment }[]) {
          const m = byId.get(row.meeting_id);
          if (!m) continue;
          matchedMeetings.add(m.id);
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
      for (const n of [...copilotNotes, ...granola]) {
        const text = `${n.user_notes ?? ''}\n${n.content}`;
        if (!text.toLowerCase().includes(lower) && !n.title.toLowerCase().includes(lower)) continue;
        const isCopilot = n.provider === 'copilot';
        if (isCopilot) matchedMeetings.add(n.external_id);
        else matchedMeetings.add(`granola:${n.id}`);
        hits.push({
          qualifiedId: isCopilot ? `copilot:${n.external_id}` : `granola:${n.id}`,
          meetingId: isCopilot ? n.external_id : null,
          source: isCopilot ? 'copilot' : 'granola',
          title: n.title,
          occurredAt: n.occurred_at,
          field: n.title.toLowerCase().includes(lower) ? 'title' : 'notes',
          snippet: snippetAround(text.trim(), q),
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
      if (q && !matchedMeetings.has(m.id)) continue;
      const people = peopleOf.get(m.id) ?? [];
      if (!personMatch(people.map((p) => p.email))) continue;
      const note = noteOf.get(m.id);
      const hasActionItems = (note?.action_items ?? []).length > 0;
      if (query.hasActionItems !== undefined && hasActionItems !== query.hasActionItems) continue;
      items.push({
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
        hasActionItems,
        folderId: m.folder_id,
        visibility: m.visibility,
        recordedMs: m.recorded_ms,
        pairedWith: m.granola_external_id
          ? (() => {
              const g = granola.find((n) => n.external_id === m.granola_external_id);
              return g ? `granola:${g.id}` : null;
            })()
          : null,
      });
    }
    for (const n of granola) {
      if (paired.has(n.external_id)) continue;
      if (q && !matchedMeetings.has(`granola:${n.id}`)) continue;
      if (!personMatch(n.attendees.map((a) => a.email))) continue;
      if (query.hasActionItems === true) continue;
      items.push({
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
      });
    }
    items.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
    const offset = Math.max(0, Number.parseInt(query.cursor ?? '0', 10) || 0);
    const page = items.slice(offset, offset + PAGE);
    return ok({
      meetings: page,
      hits: hits.slice(0, 50),
      nextCursor: offset + PAGE < items.length ? String(offset + PAGE) : null,
    });
  });
}
