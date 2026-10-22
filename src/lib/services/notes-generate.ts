import 'server-only';
import {
  MEETING_AI_OPERATIONS,
  MEETING_CHAT_PROMPT,
  MEETING_CHAT_PROMPT_VERSION,
  MEETING_NOTES_PROMPT,
  MEETING_NOTES_PROMPT_VERSION,
  meetingChatOutputSchema,
  meetingNotesOutputSchema,
} from '@/lib/ai/prompts/meeting-notes';
import { formatOffset } from '@/lib/notes/api';
import {
  clip,
  DRAFT_MODEL,
  DRAFT_PROMPT_VERSION,
  draftNotes,
  notesAsText,
  parseTypedNotes,
  type DraftSpeaker,
} from '@/lib/notes/draft';
import {
  assembleNotes,
  reownActionItems,
  resolveChatCitations,
  type AssemblySpeaker,
  type ChatMeetingRef,
} from '@/lib/notes/notes-assembly';
import { transcriptBlock, typedNotesBlock } from '@/lib/notes/prompt-input';
import { domainOf } from '@/lib/notes/template-pick';
import { toCopilotNoteView } from '@/lib/notes/views';
import { isTeamVisibleNote } from '@/lib/notes/visibility';
import { getAI } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { fenceUntrusted, scanForInjection, type UntrustedBlock } from '@/lib/security/injection';
import { checkAiBudget, recordAiUsage } from '@/lib/security/limits';
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
import { DEFAULT_TIMEZONE, localDateKey } from '@/lib/util/time';
import { err, ok, type Result } from '@/lib/util/result';
import { autoTemplateFor, meetingCrmContext, readTeamInfo, type TeamInfo } from './notes-context';
import { fireMeetingFollowUp } from './notes-followup';
import { applyNamingLadder } from './notes-naming';
import { pairWithGranola } from './notes-pairing';
import { createTask } from './tasks';
import {
  allLinesOf,
  canSeeMeeting,
  ensureNoteRow,
  guard,
  loadMeeting,
  noteOf,
  templateViewFor,
  type NotesContext,
} from './notes';

/**
 * Notes, action items and chat for a meeting (D-076).
 *
 * The notes are written by Claude (the deep tier, Opus 5.5 by default)
 * through lib/ai's generateStructured, with the versioned meeting-notes
 * prompt: the typed notes, the transcript, the invite, the voices' names and
 * what the CRM knows about the guests, the transcript and typed notes fenced
 * as untrusted. lib/notes/notes-assembly.ts checks the answer before it is
 * stored: typed lines word for word, every point linked to lines that exist,
 * owners from the voices.
 *
 * Without a model (production with no ANTHROPIC_API_KEY, a refusal, an
 * outage, the daily AI budget spent) the notes are the rules draft
 * (lib/notes/draft.ts) with model 'none', so a meeting is never left without
 * notes, and Regenerate tries the model again.
 */

export {
  DRAFT_MODEL,
  DRAFT_PROMPT_VERSION,
  draftNotes,
  dueFromText,
  notesAsText,
  parseTypedNotes,
} from '@/lib/notes/draft';

/* ========================================================== voices == */

/** Each voice as the notes name it, the principal's (Nick's) own flagged. */
export function assemblySpeakers(
  speakers: readonly MeetingSpeaker[],
  meeting: Pick<Meeting, 'recorded_by'>,
  team: Pick<TeamInfo, 'principalId' | 'principalEmail'>,
): Map<string, AssemblySpeaker> {
  const byKey = new Map(speakers.map((s) => [s.cluster_key, s]));
  const isPrincipal = (s: MeetingSpeaker): boolean => {
    if (team.principalId && s.user_id === team.principalId) return true;
    if (team.principalEmail && s.person_email?.toLowerCase() === team.principalEmail) return true;
    // No principal known: the recorder's own mic stands in, as before.
    return (
      !team.principalId &&
      s.cluster_key === 'mic' &&
      s.source === 'channel' &&
      s.user_id === meeting.recorded_by
    );
  };
  const out = new Map<string, AssemblySpeaker>();
  for (const s of speakers) {
    const target = s.merged_into ? (byKey.get(s.merged_into) ?? s) : s;
    out.set(s.cluster_key, {
      name: speakerDisplayName(target),
      email: target.person_email,
      isPrincipal: isPrincipal(target),
    });
  }
  return out;
}

async function speakersAndTeam(ctx: NotesContext, meeting: Meeting) {
  const [rows, team] = await Promise.all([
    ctx.store.list('meeting_speakers', ctx.auth.organizationId, {
      eq: { meeting_id: meeting.id },
    }) as Promise<MeetingSpeaker[]>,
    readTeamInfo(ctx.store, ctx.auth.organizationId),
  ]);
  return { rows, team, speakers: assemblySpeakers(rows, meeting, team) };
}

/* ======================================================== generate == */

export interface GenerateOptions {
  /** false: the rules draft only, no model call (a cheap refresh of a draft). */
  ai?: boolean;
}

interface Written {
  blocks: EnhancedBlock[];
  actionItems: ActionItem[];
  model: string;
  promptVersion: string;
  injectionObserved: boolean;
  aiError: string | null;
}

/** The model's notes, or why there are none. */
async function aiNotes(
  ctx: NotesContext,
  meeting: Meeting,
  input: {
    segments: TranscriptSegment[];
    speakerRows: MeetingSpeaker[];
    speakers: Map<string, AssemblySpeaker>;
    participants: MeetingParticipant[];
    team: TeamInfo;
    typed: EnhancedBlock[];
    previous: ActionItem[];
    meetingDay: string;
  },
): Promise<Written | { aiError: string }> {
  const ai = getAI();
  if (ai.kind === 'none' || !ai.available()) return { aiError: 'not_configured' };
  if (input.segments.length === 0) return { aiError: 'no_transcript' };
  const org = ctx.auth.organizationId;
  const budget = await checkAiBudget(ctx.store, org, ctx.auth.userId, ctx.now);
  if (!budget.ok) return { aiError: budget.error.code };

  const [crm, template] = await Promise.all([
    meetingCrmContext(ctx, meeting, input.participants, input.team),
    templateViewFor(ctx, meeting.template_id),
  ]);
  const names = new Map([...input.speakers].map(([key, s]) => [key, s.name]));
  const recorder = input.speakerRows.find((s) => s.cluster_key === 'mic' && s.source === 'channel');
  const context = {
    meeting: {
      title: meeting.title,
      date: input.meetingDay,
      kind: meeting.kind,
      platform: meeting.platform,
      recorded_by: recorder ? speakerDisplayName(recorder) : null,
      minutes: Math.round(meeting.recorded_ms / 60_000),
    },
    template: template
      ? {
          name: template.name,
          purpose: template.purpose,
          length: template.length,
          sections: template.sections,
        }
      : null,
    invite: input.participants.map((p) => {
      const email = p.email?.toLowerCase() ?? null;
      return {
        name: p.name,
        company_domain: email ? domainOf(email) : null,
        role: p.role,
        on_team: Boolean(
          email && (input.team.emails.has(email) || input.team.domains.has(domainOf(email) ?? '')),
        ),
      };
    }),
    voices: input.speakerRows
      .filter((s) => !s.merged_into)
      .map((s) => ({
        cluster_key: s.cluster_key,
        name: speakerDisplayName(s),
        is_recorder: s.source === 'channel',
        is_principal: Boolean(input.speakers.get(s.cluster_key)?.isPrincipal),
      })),
    crm: {
      deals: crm.deals.map((d) => ({ company: d.company, stage: d.stage })),
      portfolio: crm.portfolio.map((c) => ({ company: c.name, stage: c.stage })),
      on_lp_list: crm.lpKeys.size > 0,
      people: crm.contacts.map((c) => ({
        name: c.name,
        title: c.title,
        company: c.company,
        relationship: c.relationship,
      })),
    },
    earlier_meetings: crm.earlier.map((e) => ({ title: e.title, date: e.date, source: e.source })),
    typed_line_count: input.typed.length,
  };
  const blocks: UntrustedBlock[] = [];
  const typedBlock = typedNotesBlock(input.typed);
  if (typedBlock) blocks.push(typedBlock);
  blocks.push(transcriptBlock(input.segments, names));
  crm.earlier.forEach((e, i) => {
    blocks.push({
      sourceId: `earlier_${i}`,
      sourceKind: 'earlier_notes',
      label: `Earlier meeting: ${e.title}`,
      occurredAt: e.date,
      text: e.excerpt,
    });
  });

  const response = await ai.generateStructured({
    tier: 'deep',
    operation: MEETING_AI_OPERATIONS.notes,
    promptVersion: MEETING_NOTES_PROMPT_VERSION,
    system: MEETING_NOTES_PROMPT,
    messages: [
      {
        role: 'user',
        content: `<context>${JSON.stringify(context)}</context>\n\n${fenceUntrusted(blocks)}\n\nWrite this meeting's notes and action items.`,
      },
    ],
    schema: meetingNotesOutputSchema,
    maxTokens: 12_000,
  });
  await recordAiUsage(ctx.store, {
    organizationId: org,
    userId: ctx.auth.userId,
    operation: MEETING_AI_OPERATIONS.notes,
    promptVersion: MEETING_NOTES_PROMPT_VERSION,
    usage: response.ok ? response.value.usage : null,
    ok: response.ok,
    errorCode: response.ok ? null : response.error.code,
  });
  if (!response.ok) return { aiError: response.error.code };
  const assembled = assembleNotes({
    output: response.value.value,
    typed: input.typed,
    seqs: input.segments.map((s) => s.seq),
    speakers: input.speakers,
    previous: input.previous,
  });
  if (!assembled.blocks.some((b) => b.source === 'ai')) return { aiError: 'invalid_model_output' };
  return {
    ...assembled,
    model: response.value.usage.model,
    promptVersion: MEETING_NOTES_PROMPT_VERSION,
    injectionObserved: response.value.value.injection_observed,
    aiError: null,
  };
}

/**
 * Generate (or regenerate) a meeting's notes, keeping tasks already made from
 * its action items. With no template chosen, the first generation picks one
 * from the meeting type and the CRM.
 */
export async function generateNotes(
  ctx: NotesContext,
  meetingId: string,
  templateId?: string | null,
  options: GenerateOptions = {},
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
    const [segments, existing, participants, voices] = await Promise.all([
      allLinesOf(ctx, meeting.id, { finalOnly: true }),
      noteOf(ctx, meeting),
      ctx.store.list(
        'meeting_participants',
        org,
        { eq: { meeting_id: meeting.id } },
        { orderBy: [{ field: 'created_at', direction: 'asc' }] },
      ) as Promise<MeetingParticipant[]>,
      speakersAndTeam(ctx, meeting),
    ]);

    // Nobody picked a template (and nobody chose "none" on an earlier run):
    // pick one from the meeting type and what the CRM knows about the guests.
    let autoPicked: string | null = null;
    if (templateId === undefined && !meeting.template_id && !existing?.generated_at) {
      const crm = await meetingCrmContext(ctx, meeting, participants, voices.team);
      const pick = await autoTemplateFor(ctx, meeting, participants, voices.team, crm);
      if (pick.templateId) {
        meeting = await ctx.store.update('meetings', org, meeting.id, {
          template_id: pick.templateId,
        });
        autoPicked = pick.templateId;
      }
    }

    const timeZone = ctx.auth.profile.timezone || DEFAULT_TIMEZONE;
    const startedAt = new Date(meeting.started_at ?? meeting.scheduled_start ?? meeting.created_at);
    const meetingDay = localDateKey(startedAt, timeZone);
    const typed = parseTypedNotes(existing?.user_notes ?? null);
    const previous = existing?.action_items ?? [];

    let written: Written | null = null;
    let aiError: string | null = options.ai === false ? 'skipped' : null;
    if (options.ai !== false) {
      const result = await aiNotes(ctx, meeting, {
        segments,
        speakerRows: voices.rows,
        speakers: voices.speakers,
        participants,
        team: voices.team,
        typed,
        previous,
        meetingDay,
      });
      if ('blocks' in result) written = result;
      else aiError = result.aiError;
    }
    if (!written) {
      const draftSpeakers = new Map<string, DraftSpeaker>(
        [...voices.speakers].map(([key, s]) => [
          key,
          { name: s.name, email: s.email, isPrincipal: s.isPrincipal },
        ]),
      );
      const draft = draftNotes({
        userNotes: existing?.user_notes ?? null,
        segments,
        speakers: draftSpeakers,
        meetingDay,
        previous,
      });
      written = {
        ...draft,
        model: DRAFT_MODEL,
        promptVersion: DRAFT_PROMPT_VERSION,
        injectionObserved: false,
        aiError,
      };
    }

    const content = notesAsText(written.blocks, written.actionItems);
    const now = (ctx.now ?? new Date()).toISOString();
    const flagged =
      meeting.injection_flagged || written.injectionObserved || scanForInjection(content).flagged;
    const note = await ensureNoteRow(ctx, meeting, {
      title: meeting.title,
      occurred_at: startedAt.toISOString(),
      content: content || '(No notes yet.)',
      enhanced_blocks: written.blocks,
      action_items: written.actionItems,
      template_id: meeting.template_id,
      prompt_version: written.promptVersion,
      model: written.model,
      generated_at: now,
      visibility: meeting.visibility,
      owner_id: meeting.recorded_by,
      injection_flagged: flagged,
    });
    if (meeting.status === 'processing' || meeting.status === 'failed') {
      await ctx.store.update('meetings', org, meeting.id, { status: 'ready' });
    }
    if (flagged && !meeting.injection_flagged) {
      await ctx.store.update('meetings', org, meeting.id, { injection_flagged: true });
    }
    await recordAudit(ctx.store, {
      organizationId: org,
      userId: ctx.auth.userId,
      action: 'notes.generated',
      entityType: 'meeting',
      entityId: meeting.id,
      metadata: {
        model: written.model,
        prompt_version: written.promptVersion,
        blocks: written.blocks.length,
        action_items: written.actionItems.length,
        template_id: meeting.template_id,
        template_auto: autoPicked !== null,
        ai_error: written.aiError,
      },
    });
    return ok(toCopilotNoteView(note, meeting.id, null));
  });
}

/**
 * The job that runs after Stop: the naming pass (with the AI cue pass), the
 * Granola twin, the notes, then the meeting-follow-up routine. Notes failing
 * leave the meeting 'failed', so Regenerate can try again; the other steps
 * failing never stops the notes.
 */
export async function finalizeMeeting(
  ctx: NotesContext,
  meetingId: string,
): Promise<Result<{ queued: boolean }>> {
  const found = await guard('read the meeting', () => loadMeeting(ctx, meetingId));
  if (!found.ok) return found;
  const steps: [string, () => Promise<unknown>][] = [
    ['name the voices', () => applyNamingLadder(ctx, found.value, { ai: true })],
    ['pair with Granola', () => pairWithGranola(ctx, found.value)],
  ];
  for (const [what, step] of steps) {
    await guard(what, async () => {
      await step();
      return ok(true);
    });
  }
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
  await guard('start the follow-up routine', async () => {
    const after = await loadMeeting(ctx, meetingId);
    if (after.ok) await fireMeetingFollowUp(ctx, after.value);
    return ok(true);
  });
  return ok({ queued: true });
}

/* ================================================= after a rename == */

/**
 * After a voice is renamed, split or merged: action-item owners are read
 * again from the voices at once (no model call), and the notes themselves
 * are regenerated. A rules draft regenerates here; model notes are left to
 * `regenerateNotes`, which the route runs after answering (it takes a model
 * call). Returns whether a regeneration is still to run.
 */
export async function refreshAfterSpeakerChange(
  ctx: NotesContext,
  meetingId: string,
  moved: ReadonlyMap<string, string> = new Map(),
): Promise<Result<{ regenerate: boolean }>> {
  return guard<{ regenerate: boolean }>('refresh the notes', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const meeting = found.value;
    const note = await noteOf(ctx, meeting);
    if (!note?.generated_at) return ok({ regenerate: false });
    const { speakers } = await speakersAndTeam(ctx, meeting);
    const items = reownActionItems(note.action_items ?? [], speakers, moved);
    await ctx.store.update('meeting_notes', ctx.auth.organizationId, note.id, {
      action_items: items,
    } as Partial<MeetingNote>);
    if (note.model === DRAFT_MODEL) {
      const draft = await generateNotes(ctx, meetingId, undefined, { ai: false });
      if (!draft.ok) return draft;
      return ok({ regenerate: false });
    }
    return ok({ regenerate: true });
  });
}

/**
 * Regenerate model notes when they are older than the latest change to the
 * voices (a run of taps regenerates once: the first run brings the notes up
 * to date and the later ones find nothing stale).
 */
export async function regenerateIfStale(
  ctx: NotesContext,
  meetingId: string,
): Promise<Result<{ regenerated: boolean }>> {
  const found = await guard('read the meeting', () => loadMeeting(ctx, meetingId));
  if (!found.ok) return found;
  const stale = await guard<boolean>('check the notes', async () => {
    const note = await noteOf(ctx, found.value);
    if (!note?.generated_at) return ok(false);
    const speakers = (await ctx.store.list('meeting_speakers', ctx.auth.organizationId, {
      eq: { meeting_id: meetingId },
    })) as MeetingSpeaker[];
    return ok(speakers.some((s) => s.updated_at > (note.generated_at as string)));
  });
  if (!stale.ok) return stale;
  if (!stale.value) return ok({ regenerated: false });
  const generated = await generateNotes(ctx, meetingId);
  return generated.ok ? ok({ regenerated: true }) : generated;
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
      detail: `From the meeting "${meeting.title}".${item.isPrincipalPromise ? " You said you'd do this." : ''}`,
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

const CHAT_MAX_MEETINGS = 12;
const CHAT_NOTE_CHARS = 1_500;
const CHAT_HITS = 40;

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
  const ids = new Set(
    participants.filter((p) => inScope(request, p.email)).map((p) => p.meeting_id),
  );
  return all.filter((m) => ids.has(m.id));
}

function inScope(request: NotesChatRequest, email: string | null): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  if (request.scope === 'person') return e === request.personEmail?.toLowerCase();
  if (request.scope === 'company') return e.endsWith(`@${request.companyDomain?.toLowerCase()}`);
  return true;
}

/** Granola notes in a person, company or all-meetings scope (they carry summaries, not transcripts). */
async function granolaInScope(
  ctx: NotesContext,
  request: NotesChatRequest,
): Promise<MeetingNote[]> {
  if (request.scope === 'meeting') return [];
  const rows = (await ctx.store.list(
    'meeting_notes',
    ctx.auth.organizationId,
    { eq: { provider: 'granola' } },
    { orderBy: [{ field: 'occurred_at', direction: 'desc' }], limit: 300 },
  )) as MeetingNote[];
  return rows.filter(
    (n) =>
      isTeamVisibleNote(n, ctx.auth.userId) &&
      (request.scope === 'all' || n.attendees.some((a) => inScope(request, a.email))),
  );
}

interface ChatMaterial {
  refs: ChatMeetingRef[];
  blocks: UntrustedBlock[];
  meetingsListed: { index: number; title: string; date: string; source: 'copilot' | 'granola' }[];
}

/**
 * What the chat reads: for one meeting its whole transcript and notes; for a
 * person, company or every meeting, the lines that match the question (with
 * a line either side) and each meeting's notes, newest meetings first.
 */
async function chatMaterial(
  ctx: NotesContext,
  meetings: Meeting[],
  granola: MeetingNote[],
  request: NotesChatRequest,
): Promise<ChatMaterial> {
  const org = ctx.auth.organizationId;
  const shown = meetings.slice(0, CHAT_MAX_MEETINGS);
  const ids = shown.map((m) => m.id);
  const [speakerRows, notes] = await Promise.all([
    ctx.store.list('meeting_speakers', org, { in: { meeting_id: ids } }) as Promise<
      MeetingSpeaker[]
    >,
    ctx.store.list('meeting_notes', org, {
      eq: { provider: 'copilot' },
      in: { external_id: ids },
    }) as Promise<MeetingNote[]>,
  ]);
  let lines: TranscriptSegment[];
  if (request.scope === 'meeting' && shown[0]) {
    lines = await allLinesOf(ctx, shown[0].id, { finalOnly: true });
  } else {
    const hits = ids.length
      ? await ctx.store.search(
          'transcript_segments',
          org,
          request.question,
          ['text', 'edited_text'],
          { in: { meeting_id: ids } },
          CHAT_HITS,
        )
      : [];
    const wanted = new Map<string, Set<number>>();
    for (const { row } of hits) {
      const set = wanted.get(row.meeting_id) ?? new Set<number>();
      for (const seq of [row.seq - 1, row.seq, row.seq + 1]) if (seq >= 0) set.add(seq);
      wanted.set(row.meeting_id, set);
    }
    lines = [];
    for (const [meetingId, seqs] of wanted) {
      lines.push(
        ...((await ctx.store.list('transcript_segments', org, {
          eq: { meeting_id: meetingId },
          in: { seq: [...seqs] },
        })) as TranscriptSegment[]),
      );
    }
  }

  const refs: ChatMeetingRef[] = [];
  const blocks: UntrustedBlock[] = [];
  const meetingsListed: ChatMaterial['meetingsListed'] = [];
  shown.forEach((m, index) => {
    const mine = speakerRows.filter((s) => s.meeting_id === m.id);
    const names = new Map(
      [...assemblySpeakers(mine, m, { principalId: null, principalEmail: null })].map(([k, s]) => [
        k,
        s.name,
      ]),
    );
    const own = lines.filter((l) => l.meeting_id === m.id).sort((a, b) => a.seq - b.seq);
    refs.push({
      meetingId: m.id,
      title: m.title,
      lines: new Map(
        own.map((l) => [
          l.seq,
          { startMs: l.start_ms, speaker: names.get(l.cluster_key) ?? 'Guest' },
        ]),
      ),
    });
    const date = (m.started_at ?? m.scheduled_start ?? m.created_at).slice(0, 10);
    meetingsListed.push({ index, title: m.title, date, source: 'copilot' });
    if (own.length) {
      blocks.push({
        ...transcriptBlock(own, names, {
          prefix: `M${index}.`,
          sourceId: `M${index}`,
          label: m.title,
        }),
      });
    }
    const note = notes.find((n) => n.external_id === m.id);
    if (note?.content) {
      blocks.push({
        sourceId: `M${index}.N`,
        sourceKind: 'meeting_notes',
        label: `M${index}.N ${m.title}`,
        occurredAt: date,
        text: clip(note.content, CHAT_NOTE_CHARS),
      });
    }
  });
  granola.slice(0, Math.max(0, CHAT_MAX_MEETINGS - shown.length)).forEach((n, i) => {
    const index = shown.length + i;
    refs.push({ meetingId: n.id, title: n.title, lines: new Map() });
    meetingsListed.push({
      index,
      title: n.title,
      date: n.occurred_at.slice(0, 10),
      source: 'granola',
    });
    blocks.push({
      sourceId: `M${index}.N`,
      sourceKind: 'meeting_notes',
      label: `M${index}.N ${n.title}`,
      occurredAt: n.occurred_at.slice(0, 10),
      text: clip(n.content, CHAT_NOTE_CHARS),
    });
  });
  return { refs, blocks, meetingsListed };
}

/** The answer without a model: the lines that match the question, quoted and cited. */
async function retrievalAnswer(
  ctx: NotesContext,
  meetings: Meeting[],
  request: NotesChatRequest,
): Promise<{ answer: string; citations: ChatCitation[] }> {
  const org = ctx.auth.organizationId;
  const where = request.scope === 'meeting' ? 'this meeting' : `${meetings.length} meetings`;
  const hits = await ctx.store.search(
    'transcript_segments',
    org,
    request.question,
    ['text', 'edited_text'],
    { in: { meeting_id: meetings.map((m) => m.id) } },
    3,
  );
  if (hits.length === 0) {
    return { answer: `I couldn't find anything about that in ${where}.`, citations: [] };
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
  return { answer: `Here's what I found in ${where}:\n${quotes.join('\n')}`, citations };
}

/**
 * Ask about this meeting, a person, a company or every meeting, as Arwin.
 * Answers cite the lines they rest on, each as "[12:31 Dana Reyes]". Without
 * a model, the matching lines are quoted instead.
 */
export async function chatAboutMeetings(
  ctx: NotesContext,
  meetingId: string,
  request: NotesChatRequest,
): Promise<Result<{ answer: string; citations: ChatCitation[] }>> {
  return guard('answer that', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const [meetings, granola] = await Promise.all([
      meetingsInScope(ctx, found.value, request),
      granolaInScope(ctx, request),
    ]);
    const org = ctx.auth.organizationId;
    await recordAudit(ctx.store, {
      organizationId: org,
      userId: ctx.auth.userId,
      action: 'notes.chat_asked',
      entityType: 'meeting',
      entityId: meetingId,
      metadata: { scope: request.scope, meetings: meetings.length, granola: granola.length },
    });
    if (meetings.length === 0 && granola.length === 0) {
      return ok({
        answer: `I couldn't find any meetings to look through for that.`,
        citations: [],
      });
    }

    const ai = getAI();
    const budget =
      ai.kind !== 'none' && ai.available()
        ? await checkAiBudget(ctx.store, org, ctx.auth.userId, ctx.now)
        : null;
    if (!budget?.ok) return ok(await retrievalAnswer(ctx, meetings, request));

    const material = await chatMaterial(ctx, meetings, granola, request);
    const context = {
      scope: request.scope,
      person: request.scope === 'person' ? request.personEmail : null,
      company: request.scope === 'company' ? request.companyDomain : null,
      meetings: material.meetingsListed,
      asked_by: ctx.auth.profile.full_name ?? null,
      question: request.question,
    };
    const response = await ai.generateStructured({
      tier: 'deep',
      operation: MEETING_AI_OPERATIONS.chat,
      promptVersion: MEETING_CHAT_PROMPT_VERSION,
      system: MEETING_CHAT_PROMPT,
      messages: [
        {
          role: 'user',
          content: `<context>${JSON.stringify(context)}</context>\n\n${fenceUntrusted(material.blocks)}\n\nThe question: ${request.question}`,
        },
      ],
      schema: meetingChatOutputSchema,
      maxTokens: 4_000,
    });
    await recordAiUsage(ctx.store, {
      organizationId: org,
      userId: ctx.auth.userId,
      operation: MEETING_AI_OPERATIONS.chat,
      promptVersion: MEETING_CHAT_PROMPT_VERSION,
      usage: response.ok ? response.value.usage : null,
      ok: response.ok,
      errorCode: response.ok ? null : response.error.code,
    });
    if (!response.ok) return ok(await retrievalAnswer(ctx, meetings, request));
    const resolved = resolveChatCitations(response.value.value.answer, material.refs);
    return ok({
      answer: resolved.answer || "I couldn't find anything about that in these meetings.",
      citations: resolved.citations,
    });
  });
}
