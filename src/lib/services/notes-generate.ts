import 'server-only';
import { formatOffset } from '@/lib/notes/api';
import { toCopilotNoteView } from '@/lib/notes/views';
import { recordAudit } from '@/lib/security/audit';
import { scanForInjection } from '@/lib/security/injection';
import { speakerDisplayName } from '@/lib/speakers/ladder';
import { dueDateToInstant } from '@/lib/tasks/due';
import type { MeetingNote } from '@/lib/types/domain';
import {
  isBuiltinTemplateId,
  type ActionItem,
  type ChatCitation,
  type CopilotNoteView,
  type EnhancedBlock,
  type Meeting,
  type MeetingParticipant,
  type MeetingSpeaker,
  type NotesChatRequest,
  type TranscriptSegment,
} from '@/lib/types/notes';
import { addDaysToKey, DEFAULT_TIMEZONE, localDateKey } from '@/lib/util/time';
import { err, ok, type Result } from '@/lib/util/result';
import { createTask } from './tasks';
import {
  allLinesOf,
  canSeeMeeting,
  ensureNoteRow,
  guard,
  loadMeeting,
  noteOf,
  type NotesContext,
} from './notes';

/**
 * Notes, action items and chat for a meeting (D-076).
 *
 * The notes here are a draft built by rules, with no model: the typed notes
 * word for word, the lines that carry numbers or decisions, and the promises
 * ("I'll…", "we'll…", "let's…") as action items with their speaker as owner.
 * Every point links to the lines it came from, nothing is invented, and
 * `model` says 'none'. The AI pass (Claude through lib/ai's
 * generateStructured, a versioned meetingNotes prompt, transcripts fenced as
 * untrusted) replaces draftNotes behind the same shapes; the routes, the row
 * and the views stay as they are.
 */

export const DRAFT_PROMPT_VERSION = 'meeting-notes-draft@0.1.0';
export const DRAFT_MODEL = 'none';

/* ============================================================ typed == */

/** The notepad's markdown as blocks, kept word for word. */
export function parseTypedNotes(markdown: string | null | undefined): EnhancedBlock[] {
  if (!markdown) return [];
  const blocks: EnhancedBlock[] = [];
  markdown.split(/\r?\n/).forEach((raw, index) => {
    if (!raw.trim()) return;
    const indent = raw.match(/^\s*/)?.[0].replace(/\t/g, '  ').length ?? 0;
    const depth = Math.min(2, Math.floor(indent / 2)) as 0 | 1 | 2;
    const line = raw.trim();
    const id = `typed-${index}`;
    const heading = line.match(/^#{1,3}\s+(.*)$/);
    const box = line.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/);
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (heading?.[1]) {
      blocks.push({
        id,
        kind: 'heading',
        text: heading[1],
        depth: 0,
        source: 'typed',
        sources: [],
      });
    } else if (box?.[2]) {
      blocks.push({
        id,
        kind: 'checkbox',
        text: box[2],
        depth,
        source: 'typed',
        sources: [],
        checked: box[1] !== ' ',
      });
    } else if (bullet?.[1]) {
      blocks.push({ id, kind: 'bullet', text: bullet[1], depth, source: 'typed', sources: [] });
    } else {
      blocks.push({ id, kind: 'paragraph', text: line, depth, source: 'typed', sources: [] });
    }
  });
  return blocks;
}

/* ============================================================ draft == */

export interface DraftSpeaker {
  name: string;
  email: string | null;
  /** The recorder's own mic: their promises are flagged. */
  isRecorder: boolean;
}

const KEY_POINT_RE =
  /(\d|\bmillion\b|\bthousand\b|\bpercent\b|\braising\b|\bround\b|\bcap\b|\bclose\b|\bdecid|\bagreed?\b|\brevenue\b|\bretention\b)/i;
const PROMISE_RE = /\b(i'll|i will|we'll|we will|let's|let us)\b/i;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** A due date said in a line, as YYYY-MM-DD, relative to the meeting's day. */
export function dueFromText(text: string, meetingDay: string): string | null {
  const t = text.toLowerCase();
  if (/\btoday\b|\btonight\b|\bend of (the )?day\b/.test(t)) return meetingDay;
  if (/\btomorrow\b/.test(t)) return addDaysToKey(meetingDay, 1);
  if (/\bweek after next\b/.test(t)) return addDaysToKey(meetingDay, 14);
  if (/\bnext week\b/.test(t)) return addDaysToKey(meetingDay, 7);
  const day = WEEKDAYS.findIndex((d) => new RegExp(`\\b(by|on|this|next)?\\s*${d}\\b`).test(t));
  if (day >= 0) {
    const today = new Date(`${meetingDay}T12:00:00Z`).getUTCDay();
    const ahead = (day - today + 7) % 7 || 7;
    return addDaysToKey(meetingDay, ahead);
  }
  return null;
}

function clip(text: string, max = 220): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Draft notes from the typed notes and the transcript. Pure: the caller
 * passes the lines (final ones, in order), the voices' names and the
 * meeting's day.
 */
export function draftNotes(input: {
  userNotes: string | null;
  segments: readonly Pick<TranscriptSegment, 'seq' | 'cluster_key' | 'text' | 'edited_text'>[];
  speakers: ReadonlyMap<string, DraftSpeaker>;
  meetingDay: string;
  previous?: readonly ActionItem[];
}): { blocks: EnhancedBlock[]; actionItems: ActionItem[] } {
  const blocks: EnhancedBlock[] = [...parseTypedNotes(input.userNotes)];
  const who = (key: string): DraftSpeaker =>
    input.speakers.get(key) ?? { name: 'Guest', email: null, isRecorder: false };
  const lines = input.segments.map((s) => ({
    seq: s.seq,
    key: s.cluster_key,
    text: (s.edited_text ?? s.text).trim(),
  }));

  const keyPoints = lines.filter((l) => KEY_POINT_RE.test(l.text) && !PROMISE_RE.test(l.text));
  if (keyPoints.length) {
    blocks.push({
      id: 'ai-key-points',
      kind: 'heading',
      text: 'Key points',
      depth: 0,
      source: 'ai',
      sources: [],
    });
    for (const l of keyPoints.slice(0, 8)) {
      blocks.push({
        id: `ai-point-${l.seq}`,
        kind: 'bullet',
        text: `${who(l.key).name}: ${clip(l.text)}`,
        depth: 0,
        source: 'ai',
        sources: [{ fromSeq: l.seq, toSeq: l.seq }],
      });
    }
  }

  const previous = new Map((input.previous ?? []).map((a) => [a.id, a]));
  const actionItems: ActionItem[] = lines
    .filter((l) => PROMISE_RE.test(l.text))
    .slice(0, 20)
    .map((l) => {
      const owner = who(l.key);
      const id = `ai-action-${l.seq}`;
      return {
        id,
        text: clip(l.text, 300),
        ownerEmail: owner.email,
        ownerName: owner.name,
        ownerClusterKey: l.key,
        due: dueFromText(l.text, input.meetingDay),
        isPrincipalPromise: owner.isRecorder,
        taskId: previous.get(id)?.taskId ?? null,
        sources: [{ fromSeq: l.seq, toSeq: l.seq }],
      };
    });
  if (actionItems.length) {
    blocks.push({
      id: 'ai-actions',
      kind: 'heading',
      text: 'Action items',
      depth: 0,
      source: 'ai',
      sources: [],
    });
    for (const a of actionItems) {
      blocks.push({
        id: `ai-box-${a.id}`,
        kind: 'checkbox',
        text: `${a.ownerName ?? 'Someone'}: ${a.text}`,
        depth: 0,
        source: 'ai',
        sources: a.sources,
        checked: false,
      });
    }
  }
  return { blocks, actionItems };
}

/** The notes as plain text, for the readers that show `meeting_notes.content`. */
export function notesAsText(blocks: readonly EnhancedBlock[]): string {
  return blocks
    .map((b) => {
      const pad = '  '.repeat(b.depth);
      if (b.kind === 'heading') return `\n${b.text}`;
      if (b.kind === 'bullet') return `${pad}- ${b.text}`;
      if (b.kind === 'checkbox') return `${pad}[${b.checked ? 'x' : ' '}] ${b.text}`;
      return `${pad}${b.text}`;
    })
    .join('\n')
    .trim();
}

/* ========================================================= generate == */

async function draftSpeakers(ctx: NotesContext, meeting: Meeting) {
  const speakers = (await ctx.store.list('meeting_speakers', ctx.auth.organizationId, {
    eq: { meeting_id: meeting.id },
  })) as MeetingSpeaker[];
  return new Map<string, DraftSpeaker>(
    speakers.map((s) => [
      s.cluster_key,
      {
        name: speakerDisplayName(s),
        email: s.person_email,
        isRecorder:
          s.cluster_key === 'mic' && s.source === 'channel' && s.user_id === meeting.recorded_by,
      },
    ]),
  );
}

/** Generate (or regenerate) a meeting's notes, keeping tasks already made from its action items. */
export async function generateNotes(
  ctx: NotesContext,
  meetingId: string,
  templateId?: string | null,
): Promise<Result<CopilotNoteView>> {
  return guard('generate the notes', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    let meeting = found.value;
    if (meeting.status === 'recording' || meeting.status === 'paused') {
      return err(
        'conflict',
        'Stop the recording first; the notes are written from the whole meeting.',
      );
    }
    const org = ctx.auth.organizationId;
    if (templateId !== undefined && templateId !== meeting.template_id) {
      if (templateId && !isBuiltinTemplateId(templateId)) {
        const custom = await ctx.store.get('note_templates', org, templateId);
        if (!custom) return err('invalid_input', 'That template was not found.');
      }
      meeting = await ctx.store.update('meetings', org, meeting.id, { template_id: templateId });
    }
    const [segments, speakers, existing] = await Promise.all([
      allLinesOf(ctx, meeting.id, { finalOnly: true }),
      draftSpeakers(ctx, meeting),
      noteOf(ctx, meeting),
    ]);
    const timeZone = ctx.auth.profile.timezone || DEFAULT_TIMEZONE;
    const startedAt = new Date(meeting.started_at ?? meeting.scheduled_start ?? meeting.created_at);
    const draft = draftNotes({
      userNotes: existing?.user_notes ?? null,
      segments,
      speakers,
      meetingDay: localDateKey(startedAt, timeZone),
      previous: existing?.action_items ?? [],
    });
    const content = notesAsText(draft.blocks);
    const now = (ctx.now ?? new Date()).toISOString();
    const note = await ensureNoteRow(ctx, meeting, {
      title: meeting.title,
      occurred_at: startedAt.toISOString(),
      content: content || '(No notes yet.)',
      enhanced_blocks: draft.blocks,
      action_items: draft.actionItems,
      template_id: meeting.template_id,
      prompt_version: DRAFT_PROMPT_VERSION,
      model: DRAFT_MODEL,
      generated_at: now,
      visibility: meeting.visibility,
      owner_id: meeting.recorded_by,
      injection_flagged: meeting.injection_flagged || scanForInjection(content).flagged,
    });
    if (meeting.status === 'processing' || meeting.status === 'failed') {
      await ctx.store.update('meetings', org, meeting.id, { status: 'ready' });
    }
    await recordAudit(ctx.store, {
      organizationId: org,
      userId: ctx.auth.userId,
      action: 'notes.generated',
      entityType: 'meeting',
      entityId: meeting.id,
      metadata: {
        model: DRAFT_MODEL,
        prompt_version: DRAFT_PROMPT_VERSION,
        blocks: draft.blocks.length,
        action_items: draft.actionItems.length,
      },
    });
    return ok(toCopilotNoteView(note, meeting.id, null));
  });
}

/**
 * The job that runs after Stop: the notes, then (once its trigger is set up)
 * the meeting-follow-up routine. Notes failing leave the meeting 'failed',
 * so Regenerate can try again.
 */
export async function finalizeMeeting(
  ctx: NotesContext,
  meetingId: string,
): Promise<Result<{ queued: boolean }>> {
  const generated = await generateNotes(ctx, meetingId);
  if (!generated.ok) {
    if (generated.error.code !== 'not_configured') {
      await guard('mark the meeting failed', async () => {
        await ctx.store.update('meetings', ctx.auth.organizationId, meetingId, {
          status: 'failed',
        });
        return ok(true);
      });
    }
    return generated;
  }
  return ok({ queued: true });
}

/* ===================================================== action items == */

/** "Add to Tasks": a task through the tasks service (add-only; it goes to the principal). */
export async function addActionItemTask(
  ctx: NotesContext,
  meetingId: string,
  itemId: string,
): Promise<Result<{ taskId: string; created: boolean }>> {
  return guard<{ taskId: string; created: boolean }>('add the task', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const meeting = found.value;
    const note = await noteOf(ctx, meeting);
    const items = note?.action_items ?? [];
    const item = items.find((a) => a.id === itemId);
    if (!note || !item) return err('not_found', 'That action item was not found.');
    if (item.taskId) return ok({ taskId: item.taskId, created: false });
    const timeZone = ctx.auth.profile.timezone || DEFAULT_TIMEZONE;
    const owner = item.ownerName ? `${item.ownerName}: ` : '';
    const created = await createTask(ctx.auth, {
      title: `${owner}${item.text}`.slice(0, 300),
      detail: `From the meeting "${meeting.title}".`,
      dueAt: item.due ? (dueDateToInstant(item.due, timeZone) ?? null) : null,
      source: 'human',
    });
    if (!created.ok) return created;
    const next = items.map((a) => (a.id === itemId ? { ...a, taskId: created.value.id } : a));
    await ctx.store.update('meeting_notes', ctx.auth.organizationId, note.id, {
      action_items: next,
    } as Partial<MeetingNote>);
    await recordAudit(ctx.store, {
      organizationId: ctx.auth.organizationId,
      userId: ctx.auth.userId,
      action: 'notes.action_item_tasked',
      entityType: 'meeting',
      entityId: meeting.id,
      metadata: { item_id: itemId, task_id: created.value.id },
    });
    return ok({ taskId: created.value.id, created: true });
  });
}

/* ============================================================== chat == */

async function meetingsInScope(
  ctx: NotesContext,
  meeting: Meeting,
  request: NotesChatRequest,
): Promise<Meeting[]> {
  if (request.scope === 'meeting') return [meeting];
  const org = ctx.auth.organizationId;
  const all = (
    (await ctx.store.list(
      'meetings',
      org,
      { isNull: ['deleted_at'] },
      {
        orderBy: [{ field: 'created_at', direction: 'desc' }],
        limit: 500,
      },
    )) as Meeting[]
  ).filter((m) => canSeeMeeting(m, ctx.auth.userId));
  if (request.scope === 'all') return all;
  const participants = (await ctx.store.list('meeting_participants', org, {
    in: { meeting_id: all.map((m) => m.id) },
    notNull: ['email'],
  })) as MeetingParticipant[];
  const want = (p: MeetingParticipant) =>
    request.scope === 'person'
      ? p.email === request.personEmail
      : Boolean(p.email?.endsWith(`@${request.companyDomain}`));
  const ids = new Set(participants.filter(want).map((p) => p.meeting_id));
  return all.filter((m) => ids.has(m.id));
}

/**
 * Ask about this meeting, a person, a company or every meeting. Answers quote
 * the lines they rest on, each cited as "[12:31 Dana Reyes]". This version
 * finds the lines that match the question; the AI answer (speaking as Arwin,
 * from the shared persona) arrives behind the same shapes.
 */
export async function chatAboutMeetings(
  ctx: NotesContext,
  meetingId: string,
  request: NotesChatRequest,
): Promise<Result<{ answer: string; citations: ChatCitation[] }>> {
  return guard('answer that', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const meetings = await meetingsInScope(ctx, found.value, request);
    const org = ctx.auth.organizationId;
    await recordAudit(ctx.store, {
      organizationId: org,
      userId: ctx.auth.userId,
      action: 'notes.chat_asked',
      entityType: 'meeting',
      entityId: meetingId,
      metadata: { scope: request.scope, meetings: meetings.length },
    });
    const where = request.scope === 'meeting' ? 'this meeting' : `${meetings.length} meetings`;
    if (meetings.length === 0) {
      return ok({
        answer: `I couldn't find any meetings to look through for that.`,
        citations: [],
      });
    }
    const hits = await ctx.store.search(
      'transcript_segments',
      org,
      request.question,
      ['text', 'edited_text'],
      { in: { meeting_id: meetings.map((m) => m.id) } },
      3,
    );
    if (hits.length === 0) {
      return ok({ answer: `I couldn't find anything about that in ${where}.`, citations: [] });
    }
    const speakerRows = (await ctx.store.list('meeting_speakers', org, {
      in: { meeting_id: [...new Set(hits.map((h) => h.row.meeting_id))] },
    })) as MeetingSpeaker[];
    const name = (meetingKey: string, key: string) => {
      const row = speakerRows.find((s) => s.meeting_id === meetingKey && s.cluster_key === key);
      return row ? speakerDisplayName(row) : 'Guest';
    };
    const citations: ChatCitation[] = hits.map(({ row }) => {
      const speaker = name(row.meeting_id, row.cluster_key);
      return {
        meetingId: row.meeting_id,
        seq: row.seq,
        startMs: row.start_ms,
        speaker,
        label: `[${formatOffset(row.start_ms)} ${speaker}]`,
      };
    });
    const quotes = hits.map(
      ({ row }, i) => `${citations[i]?.label ?? ''} "${clip(row.edited_text ?? row.text, 300)}"`,
    );
    return ok({
      answer: `Here's what I found in ${where}:\n${quotes.join('\n')}`,
      citations,
    });
  });
}
