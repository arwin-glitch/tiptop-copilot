import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import { isSameConversation, PAIR_WINDOW_MS, uniqueMatch } from '@/lib/notes/pairing';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type { MeetingNote } from '@/lib/types/domain';
import type { Meeting, MeetingParticipant } from '@/lib/types/notes';
import { externalEmailsOf, readTeamInfo } from './notes-context';
import type { NotesContext } from './notes';

/**
 * Pairing a Kraken meeting with its Granola twin (D-076), from either side:
 * when a meeting's notes are finalized (the Granola note may already be in),
 * and when a Granola note arrives (the meeting may already be recorded). The
 * rule is lib/notes/pairing.ts; the pair is meetings.granola_external_id,
 * which the lists, the MCP tools and the deal and company pages read to show
 * the conversation once.
 */

const meetingAt = (m: Pick<Meeting, 'started_at' | 'scheduled_start' | 'created_at'>) =>
  m.started_at ?? m.scheduled_start ?? m.created_at;

function window(at: string): { gte: string; lte: string } {
  const t = Date.parse(at);
  return {
    gte: new Date(t - PAIR_WINDOW_MS).toISOString(),
    lte: new Date(t + PAIR_WINDOW_MS).toISOString(),
  };
}

/** Pair a meeting with its Granola note, when exactly one matches. Returns the note's external id. */
export async function pairWithGranola(ctx: NotesContext, meeting: Meeting): Promise<string | null> {
  if (meeting.granola_external_id) return meeting.granola_external_id;
  const org = ctx.auth.organizationId;
  const at = meetingAt(meeting);
  const range = window(at);
  const [notes, participants, team, taken] = await Promise.all([
    ctx.store.list('meeting_notes', org, {
      eq: { provider: 'granola' },
      gte: { occurred_at: range.gte },
      lte: { occurred_at: range.lte },
    }) as Promise<MeetingNote[]>,
    ctx.store.list('meeting_participants', org, { eq: { meeting_id: meeting.id } }) as Promise<
      MeetingParticipant[]
    >,
    readTeamInfo(ctx.store, org),
    ctx.store.list('meetings', org, { notNull: ['granola_external_id'] }) as Promise<Meeting[]>,
  ]);
  const used = new Set(taken.map((m) => m.granola_external_id));
  const external = externalEmailsOf(participants, team);
  const match = uniqueMatch(
    notes.filter((n) => !used.has(n.external_id)),
    (n) =>
      isSameConversation(
        { title: meeting.title, at, externalEmails: external },
        {
          title: n.title,
          occurredAt: n.occurred_at,
          attendeeEmails: n.attendees.map((a) => a.email),
        },
      ),
  );
  if (!match) return null;
  await ctx.store.update('meetings', org, meeting.id, { granola_external_id: match.external_id });
  await recordAudit(ctx.store, {
    organizationId: org,
    userId: ctx.auth.userId,
    action: 'notes.paired_with_granola',
    entityType: 'meeting',
    entityId: meeting.id,
    metadata: { granola_note_id: match.id },
  });
  return match.external_id;
}

/**
 * A Granola note just arrived: pair it with the Kraken meeting of the same
 * conversation, when exactly one unpaired meeting matches. Never fails the
 * delivery: before the Kraken Notes migration there is nothing to pair.
 */
export async function pairGranolaNote(
  store: DataStore,
  organizationId: string,
  note: Pick<MeetingNote, 'id' | 'external_id' | 'title' | 'occurred_at' | 'attendees'>,
): Promise<string | null> {
  try {
    const already = await store.findOne('meetings', organizationId, {
      eq: { granola_external_id: note.external_id },
    });
    if (already) return already.id;
    const meetings = (
      (await store.list(
        'meetings',
        organizationId,
        { isNull: ['granola_external_id', 'deleted_at'] },
        { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 200 },
      )) as Meeting[]
    ).filter(
      (m) => Math.abs(Date.parse(meetingAt(m)) - Date.parse(note.occurred_at)) <= PAIR_WINDOW_MS,
    );
    if (meetings.length === 0) return null;
    const team = await readTeamInfo(store, organizationId);
    const participants = (await store.list('meeting_participants', organizationId, {
      in: { meeting_id: meetings.map((m) => m.id) },
    })) as MeetingParticipant[];
    const match = uniqueMatch(meetings, (m) =>
      isSameConversation(
        {
          title: m.title,
          at: meetingAt(m),
          externalEmails: externalEmailsOf(
            participants.filter((p) => p.meeting_id === m.id),
            team,
          ),
        },
        {
          title: note.title,
          occurredAt: note.occurred_at,
          attendeeEmails: note.attendees.map((a) => a.email),
        },
      ),
    );
    if (!match) return null;
    await store.update('meetings', organizationId, match.id, {
      granola_external_id: note.external_id,
    });
    await recordAudit(store, {
      organizationId,
      userId: null,
      action: 'notes.paired_with_granola',
      entityType: 'meeting',
      entityId: match.id,
      metadata: { granola_note_id: note.id },
    });
    return match.id;
  } catch (error) {
    if (!isMissingTableError(error) && !isMissingColumnError(error)) {
      log.warn('Kraken Notes: a Granola note could not be paired', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}
