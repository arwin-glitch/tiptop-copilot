import 'server-only';
import { renameInBlocks } from '@/lib/notes/bridge-protocol';
import {
  DRAFT_MODEL,
  DRAFT_PROMPT_VERSION,
  draftNotes,
  notesAsText,
  parseTypedNotes,
  type DraftSpeaker,
} from '@/lib/notes/draft';
import { toCopilotNoteView } from '@/lib/notes/views';
import { assemblySpeakers, renamedVoices, reownActionItems } from '@/lib/notes/voices';
import { recordAudit } from '@/lib/security/audit';
import { scanForInjection } from '@/lib/security/injection';
import { dueDateToInstant } from '@/lib/tasks/due';
import type { MeetingNote } from '@/lib/types/domain';
import {
  isBuiltinTemplateId,
  type CopilotNoteView,
  type Meeting,
  type MeetingParticipant,
  type MeetingSpeaker,
  type NotesRequest,
  type NotesRequestReason,
} from '@/lib/types/notes';
import { DEFAULT_TIMEZONE, localDateKey } from '@/lib/util/time';
import { err, ok, type Result } from '@/lib/util/result';
import { autoTemplateFor, meetingCrmContext, readTeamInfo } from './notes-context';
import { requestArwinNotes } from './notes-bridge';
import { toRequestView } from './notes-request-view';
import { fireMeetingFollowUp } from './notes-followup';
import { applyNamingLadder } from './notes-naming';
import { pairWithGranola } from './notes-pairing';
import { createTask } from './tasks';
import { allLinesOf, ensureNoteRow, guard, loadMeeting, noteOf, type NotesContext } from './notes';

/**
 * A meeting's notes and action items (D-076), at zero spend.
 *
 * Nothing here calls a model. Two kinds of notes:
 *   - Quick notes, written at once by rules (lib/notes/draft.ts): the typed
 *     notes word for word, the key lines by a simple score, and the promises
 *     as action items. Model 'none'. A meeting always has them the moment
 *     Stop is pressed.
 *   - Arwin's notes, written by Arwin's Claude routine through the Ask bridge
 *     (services/notes-bridge.ts): asked for after Stop, Regenerate or a
 *     template change, and stored when the result comes back through the
 *     Slack relay, usually a minute or three later. Until then the page says
 *     "Arwin is writing your notes" over the Quick notes (or over the notes
 *     it had, when they are being rewritten).
 */

export {
  DRAFT_MODEL,
  DRAFT_PROMPT_VERSION,
  draftNotes,
  dueFromText,
  notesAsText,
  parseTypedNotes,
} from '@/lib/notes/draft';
export { assemblySpeakers } from '@/lib/notes/voices';

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
  /** Refresh the Quick notes only; ask Arwin for nothing (after a rename of a Quick-notes meeting). */
  quickOnly?: boolean;
  /** Why Arwin's notes are asked for; worked out from the call when left out. */
  reason?: NotesRequestReason;
  fetchImpl?: typeof fetch;
}

/**
 * Write the Quick notes (unless Arwin's notes are already there, which stay
 * until their replacement arrives) and ask Arwin's routine for the notes,
 * optionally with another template. Tasks already made from action items are
 * kept. With no template chosen, the first time picks one from the meeting
 * type and the CRM.
 */
export async function generateNotes(
  ctx: NotesContext,
  meetingId: string,
  templateId?: string | null,
  options: GenerateOptions = {},
): Promise<Result<CopilotNoteView>> {
  return guard('write the notes', async () => {
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
    const templateChanged = templateId !== undefined && templateId !== meeting.template_id;
    if (templateChanged) {
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
    const now = (ctx.now ?? new Date()).toISOString();

    // Arwin's notes stay on the page until their replacement arrives; Quick
    // notes (or none yet) are written again from the meeting as it is now.
    let note: MeetingNote | null = existing;
    const keepArwin = Boolean(existing?.generated_at && existing.model !== DRAFT_MODEL);
    if (!keepArwin) {
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
        meetingDay: localDateKey(startedAt, timeZone),
        previous: existing?.action_items ?? [],
      });
      const content = notesAsText(draft.blocks, draft.actionItems);
      const flagged = meeting.injection_flagged || scanForInjection(content).flagged;
      note = await ensureNoteRow(ctx, meeting, {
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
        injection_flagged: flagged,
      });
      if (flagged && !meeting.injection_flagged) {
        await ctx.store.update('meetings', org, meeting.id, { injection_flagged: true });
      }
    } else if (existing) {
      // Arwin's notes stay, with the typed lines as they read now (edited
      // since, perhaps): word for word, put back by the app.
      const blocks = [
        ...parseTypedNotes(existing.user_notes ?? null),
        ...(existing.enhanced_blocks ?? []).filter((b) => b.source !== 'typed'),
      ];
      note = await ctx.store.update('meeting_notes', org, existing.id, {
        enhanced_blocks: blocks,
        content: notesAsText(blocks, existing.action_items ?? []) || '(No notes yet.)',
      } as Partial<MeetingNote>);
    }

    let request: NotesRequest | null = null;
    if (!options.quickOnly) {
      const reason = options.reason ?? (templateChanged ? 'template' : 'regenerate');
      request = await requestArwinNotes(ctx, meeting, reason, options.fetchImpl);
      if (request && note) {
        note = await ctx.store.update('meeting_notes', org, note.id, {
          notes_request_id: request.id,
        } as Partial<MeetingNote>);
      }
    }
    if (!note) note = await ensureNoteRow(ctx, meeting, { template_id: meeting.template_id });
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
        model: note.model ?? null,
        quick_notes_written: !keepArwin,
        arwin_requested: Boolean(request),
        request_id: request?.id ?? null,
        blocks: note.enhanced_blocks?.length ?? 0,
        action_items: note.action_items?.length ?? 0,
        template_id: meeting.template_id,
        template_auto: autoPicked !== null,
      },
    });
    return ok(toCopilotNoteView(note, meeting.id, null, request ? toRequestView(request) : null));
  });
}

/**
 * The job that runs after Stop: the naming pass (rules only), the Granola
 * twin, then the Quick notes and the request for Arwin's notes. The meeting
 * is 'ready' as soon as the Quick notes are written. The follow-up routine is
 * fired when Arwin's notes are stored; with nothing to ask Arwin for (no
 * line, no typed note) it is fired here.
 */
export async function finalizeMeeting(
  ctx: NotesContext,
  meetingId: string,
  fetchImpl?: typeof fetch,
): Promise<Result<{ queued: boolean }>> {
  const found = await guard('read the meeting', () => loadMeeting(ctx, meetingId));
  if (!found.ok) return found;
  const steps: [string, () => Promise<unknown>][] = [
    ['name the voices', () => applyNamingLadder(ctx, found.value)],
    ['pair with Granola', () => pairWithGranola(ctx, found.value)],
  ];
  for (const [what, step] of steps) {
    await guard(what, async () => {
      await step();
      return ok(true);
    });
  }
  const generated = await generateNotes(ctx, meetingId, undefined, { reason: 'stop', fetchImpl });
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
  if (!generated.value.request) {
    await guard('start the follow-up routine', async () => {
      const after = await loadMeeting(ctx, meetingId);
      if (after.ok) await fireMeetingFollowUp(ctx, after.value);
      return ok(true);
    });
  }
  return ok({ queued: true });
}

/* ================================================= after a rename == */

/**
 * After a voice is renamed, split or merged: action-item owners are read
 * again from the voices at once. Quick notes are written again; Arwin's notes
 * get the new names in place (every "Guest 2" now named, every owner renamed),
 * with no new request to the routine. Typed lines are never touched.
 */
export async function refreshAfterSpeakerChange(
  ctx: NotesContext,
  meetingId: string,
  moved: ReadonlyMap<string, string> = new Map(),
): Promise<Result<{ rewritten: boolean }>> {
  return guard<{ rewritten: boolean }>('refresh the notes', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const meeting = found.value;
    const note = await noteOf(ctx, meeting);
    if (!note?.generated_at) return ok({ rewritten: false });
    const { rows, speakers } = await speakersAndTeam(ctx, meeting);
    const before = note.action_items ?? [];
    const items = reownActionItems(before, speakers, moved);
    if (note.model === DRAFT_MODEL) {
      await ctx.store.update('meeting_notes', ctx.auth.organizationId, note.id, {
        action_items: items,
      } as Partial<MeetingNote>);
      const quick = await generateNotes(ctx, meetingId, undefined, { quickOnly: true });
      return quick.ok ? ok({ rewritten: true }) : quick;
    }
    const renamed = renameInBlocks(note.enhanced_blocks ?? [], renamedVoices(before, items, rows));
    // The checkbox lines name their owner too: written again from the items.
    const blocks = renamed.blocks.map((b) => {
      const item = items.find((a) => b.id === `ai-box-${a.id}`);
      return item ? { ...b, text: `${item.ownerName ?? 'Someone'}: ${item.text}` } : b;
    });
    await ctx.store.update('meeting_notes', ctx.auth.organizationId, note.id, {
      action_items: items,
      enhanced_blocks: blocks,
      content: notesAsText(blocks, items) || '(No notes yet.)',
      // Brought up to date with the names: not stale any more.
      generated_at: (ctx.now ?? new Date()).toISOString(),
    } as Partial<MeetingNote>);
    return ok({ rewritten: true });
  });
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
