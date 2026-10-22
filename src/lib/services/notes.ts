import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { matchNeverRecord } from '@/lib/notes/never-record';
import { readNotesPreferences } from '@/lib/notes/preferences';
import {
  builtinTemplateViews,
  toCopilotNoteView,
  toMeetingView,
  toParticipantView,
  toSegmentView,
  toShareLinkView,
  toSpeakerView,
  toTemplateView,
} from '@/lib/notes/views';
import { recordAudit } from '@/lib/security/audit';
import { scanForInjection } from '@/lib/security/injection';
import { log } from '@/lib/security/redact';
import { isEcho, type TimedText } from '@/lib/speakers/echo-dedupe';
import { isResolved, newSpeakerRow, type Recorder } from '@/lib/speakers/ladder';
import { planMerge, planSplit } from '@/lib/speakers/split-merge';
import { trackOfClusterKey } from '@/lib/transcribe/cluster';
import { getTranscriber, type KnownSpeaker } from '@/lib/transcribe';
import type { MeetingNote } from '@/lib/types/domain';
import {
  BUILTIN_TEMPLATES,
  CONSENT_NOTICE_TEXT,
  NEVER_RECORD_MESSAGE,
  NOTES_LIMITS,
  isBuiltinTemplateId,
  type CreateFolderRequest,
  type CreateMeetingRequest,
  type CreateRecipeRequest,
  type CreateTemplateRequest,
  type FolderView,
  type Meeting,
  type MeetingConsentLogEntry,
  type MeetingDetailResponse,
  type MeetingFolder,
  type MeetingParticipant,
  type MeetingSpeaker,
  type MeetingView,
  type NoteRecipe,
  type NoteShareLink,
  type NoteTemplate,
  type RecipeView,
  type RecordingRule,
  type RelabelSpeakerRequest,
  type RememberVoiceOutcome,
  type SegmentUpload,
  type SegmentView,
  type SpeakerPersonInput,
  type SpeakerView,
  type SplitSpeakerRequest,
  type StartRecordingRequest,
  type StopRecordingRequest,
  type SttSession,
  type TemplateView,
  type TranscriptSegment,
  type TranscriptTrack,
  type TranscriberProvider,
  type UpdateMeetingRequest,
  type VoiceProfile,
} from '@/lib/types/notes';
import { newId } from '@/lib/util/hash';
import { err, ok, type AppError, type Result } from '@/lib/util/result';
import { meetingCrmContext, readTeamInfo } from './notes-context';
import { applyNamingLadder, type NamingOptions } from './notes-naming';

/**
 * Copilot Notes, the core (D-076): meetings, the consent step and the
 * recording state, transcript lines, voices and their names, templates,
 * folders and recipes. Notes and chat are in notes-generate.ts, share links in
 * notes-share.ts, the list and search in notes-search.ts, voice consent in
 * voice-profiles.ts.
 *
 * Rules every function here keeps:
 * - A meeting is read only where its visibility allows: the team's, the
 *   recorder's own, or shared with the reader (canSeeMeeting). A meeting
 *   someone may not see is "not found", never "forbidden".
 * - Only the recorder starts, pauses and stops a recording, mints speech keys
 *   and uploads lines.
 * - Recording never starts before the consent step is confirmed, and never on
 *   a meeting that matches a never-record rule.
 * - Lines are stored by voice cluster; a name lives on meeting_speakers alone.
 * - Every new table may be missing (a migration not yet applied): reads and
 *   writes then answer `not_configured` rather than failing the page.
 * - Transcript text is untrusted: stored verbatim, scanned, rendered as text,
 *   and never logged or audited.
 */

export interface NotesContext {
  store: DataStore;
  auth: AuthContext;
  now?: Date;
}

const nowOf = (ctx: NotesContext) => ctx.now ?? new Date();

export const NOT_SET_UP: AppError = {
  code: 'not_configured',
  message:
    'Copilot Notes is not set up yet: its database migration (20261024000000_copilot_notes.sql) has not been applied.',
  stillUsable: 'Granola notes and the rest of Copilot work as before.',
};

/** Run a notes operation; a missing table or column becomes NOT_SET_UP, anything else a plain error. */
export async function guard<T>(what: string, fn: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await fn();
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) {
      return { ok: false, error: NOT_SET_UP };
    }
    log.error(`Copilot Notes: could not ${what}`, {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', `Could not ${what}. Try again.`, { retryable: true });
  }
}

/* ============================================================ access == */

/** Whether `userId` may read this meeting: the team's, theirs, or shared with them. */
export function canSeeMeeting(meeting: Meeting, userId: string): boolean {
  if (meeting.deleted_at) return meeting.recorded_by === userId;
  return (
    meeting.visibility === 'team' ||
    meeting.recorded_by === userId ||
    (meeting.shared_with ?? []).includes(userId)
  );
}

const NOT_FOUND = () => err('not_found', 'That meeting was not found.');
const RECORDER_ONLY = () => err('forbidden', 'Only the person recording this meeting can do that.');

/** The meeting, if this person may see it; `recorderOnly` also requires them to be its recorder. */
export async function loadMeeting(
  ctx: NotesContext,
  meetingId: string,
  options: { recorderOnly?: boolean } = {},
): Promise<Result<Meeting>> {
  const meeting = await ctx.store.get('meetings', ctx.auth.organizationId, meetingId);
  if (!meeting || !canSeeMeeting(meeting, ctx.auth.userId)) return NOT_FOUND();
  if (options.recorderOnly && meeting.recorded_by !== ctx.auth.userId) return RECORDER_ONLY();
  return ok(meeting);
}

function recorderOf(auth: AuthContext): Recorder {
  return {
    userId: auth.userId,
    email: auth.profile.email ? auth.profile.email.toLowerCase() : null,
    name: auth.profile.full_name ?? auth.profile.email ?? null,
  };
}

function domainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  return at < 0 ? null : email.slice(at + 1).toLowerCase();
}

async function logConsent(
  ctx: NotesContext,
  meeting: Meeting,
  event: MeetingConsentLogEntry['event'],
  extra: Partial<Pick<MeetingConsentLogEntry, 'method' | 'notice_text' | 'detail'>> = {},
): Promise<void> {
  await ctx.store.insert('meeting_consent_log', {
    id: newId(),
    organization_id: meeting.organization_id,
    meeting_id: meeting.id,
    event,
    method: extra.method ?? null,
    notice_text: extra.notice_text ?? null,
    actor_id: ctx.auth.userId,
    detail: extra.detail ?? {},
    created_at: nowOf(ctx).toISOString(),
  });
}

async function audit(
  ctx: NotesContext,
  action: Parameters<typeof recordAudit>[1]['action'],
  meetingId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await recordAudit(ctx.store, {
    organizationId: ctx.auth.organizationId,
    userId: ctx.auth.userId,
    action,
    entityType: 'meeting',
    entityId: meetingId,
    metadata,
  });
}

async function enabledRules(ctx: NotesContext): Promise<RecordingRule[]> {
  return (await ctx.store.list('recording_rules', ctx.auth.organizationId, {
    eq: { enabled: true },
  })) as RecordingRule[];
}

async function participantsOf(ctx: NotesContext, meetingId: string): Promise<MeetingParticipant[]> {
  return (await ctx.store.list(
    'meeting_participants',
    ctx.auth.organizationId,
    { eq: { meeting_id: meetingId } },
    { orderBy: [{ field: 'created_at', direction: 'asc' }] },
  )) as MeetingParticipant[];
}

async function speakersOf(ctx: NotesContext, meetingId: string): Promise<MeetingSpeaker[]> {
  return (await ctx.store.list(
    'meeting_speakers',
    ctx.auth.organizationId,
    { eq: { meeting_id: meetingId } },
    { orderBy: [{ field: 'created_at', direction: 'asc' }] },
  )) as MeetingSpeaker[];
}

async function segmentsOf(
  ctx: NotesContext,
  meetingId: string,
  options: { after?: number; limit?: number } = {},
): Promise<TranscriptSegment[]> {
  return (await ctx.store.list(
    'transcript_segments',
    ctx.auth.organizationId,
    {
      eq: { meeting_id: meetingId },
      ...(options.after !== undefined && options.after >= 0 ? { gt: { seq: options.after } } : {}),
    },
    {
      orderBy: [{ field: 'seq', direction: 'asc' }],
      limit: options.limit ?? NOTES_LIMITS.maxSegmentsPerPage,
    },
  )) as TranscriptSegment[];
}

/**
 * Every line of a meeting, in order. Paged, because PostgREST answers at most
 * 1,000 rows and a long meeting has more: a split or merge planned from the
 * first page alone would leave the rest of a voice's lines behind.
 */
export async function allLinesOf(
  ctx: NotesContext,
  meetingId: string,
  extra: { finalOnly?: boolean } = {},
): Promise<TranscriptSegment[]> {
  return (await listAllPages(
    ctx.store,
    'transcript_segments',
    ctx.auth.organizationId,
    { eq: { meeting_id: meetingId, ...(extra.finalOnly ? { is_final: true } : {}) } },
    [{ field: 'seq', direction: 'asc' }],
  )) as TranscriptSegment[];
}

/** The Copilot note row of a meeting (meeting_notes, provider 'copilot'), if any. */
export async function noteOf(ctx: NotesContext, meeting: Meeting): Promise<MeetingNote | null> {
  return ctx.store.findOne('meeting_notes', ctx.auth.organizationId, {
    eq: { provider: 'copilot', external_id: meeting.id },
  });
}

async function voiceConsentEmails(ctx: NotesContext): Promise<Set<string>> {
  const rows = (await ctx.store.list('voice_profiles', ctx.auth.organizationId, {
    eq: { consent_status: 'granted' },
  })) as VoiceProfile[];
  return new Set(rows.map((r) => r.person_email.toLowerCase()));
}

/** Every voice of a meeting as the API shows it, with line counts. */
export async function speakerViews(
  ctx: NotesContext,
  meeting: Meeting,
  speakers?: MeetingSpeaker[],
  segments?: Pick<TranscriptSegment, 'cluster_key'>[],
): Promise<SpeakerView[]> {
  const rows = speakers ?? (await speakersOf(ctx, meeting.id));
  const lines = segments ?? (await allLinesOf(ctx, meeting.id));
  const counts = new Map<string, number>();
  for (const s of lines) counts.set(s.cluster_key, (counts.get(s.cluster_key) ?? 0) + 1);
  const consent = await voiceConsentEmails(ctx);
  return rows.map((speaker) =>
    toSpeakerView(speaker, {
      lineCount: counts.get(speaker.cluster_key) ?? 0,
      recorderId: meeting.recorded_by,
      voiceConsent: consent,
    }),
  );
}

/**
 * Run the naming pass without letting it fail the write it follows: a voice
 * renamed or a batch of lines stored stays stored. True when a voice changed.
 */
export async function namingSafely(
  ctx: NotesContext,
  meeting: Meeting,
  options: NamingOptions = {},
): Promise<boolean> {
  try {
    const result = await applyNamingLadder(ctx, meeting, options);
    return result.changed > 0;
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) throw error;
    log.warn('Copilot Notes: the naming pass failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/* ========================================================== meetings == */

/**
 * Make a meeting: from a calendar event ("Take notes"), or ad hoc ("+ New
 * note"). "Take notes" twice on one event opens the same meeting. The person
 * making it is its recorder, and it starts private to them.
 */
export async function createMeeting(
  ctx: NotesContext,
  input: CreateMeetingRequest,
): Promise<Result<{ meeting: Meeting; created: boolean }>> {
  return guard<{ meeting: Meeting; created: boolean }>('make the meeting', async () => {
    const org = ctx.auth.organizationId;
    if (input.templateId && !isBuiltinTemplateId(input.templateId)) {
      const custom = await ctx.store.get('note_templates', org, input.templateId);
      if (!custom) return err('invalid_input', 'That template was not found.');
    }
    if (input.source === 'calendar' && input.providerEventId) {
      const existing = await ctx.store.findOne('meetings', org, {
        eq: { provider_event_id: input.providerEventId, recorded_by: ctx.auth.userId },
        isNull: ['deleted_at'],
      });
      if (existing) return ok({ meeting: existing, created: false });
    }

    const now = nowOf(ctx).toISOString();
    const recorder = recorderOf(ctx.auth);
    const ownDomain = domainOf(recorder.email);
    const attendees = new Map<string, { email: string | null; name: string | null }>();
    const named: { email: null; name: string }[] = [];
    for (const a of input.attendees ?? []) {
      if (a.email)
        attendees.set(a.email.toLowerCase(), { email: a.email.toLowerCase(), name: a.name });
      else if (a.name) named.push({ email: null, name: a.name });
    }

    const id = newId();
    // Private unless this person chose the team as their default (Settings).
    const preferences = await readNotesPreferences(ctx.store, org, ctx.auth.userId);
    const neverRecord = matchNeverRecord(
      {
        title: input.title,
        calendarId: input.calendarId ?? null,
        attendeeEmails: [...attendees.keys()],
      },
      await enabledRules(ctx),
    );
    const meeting: Meeting = {
      id,
      organization_id: org,
      provider_event_id: input.providerEventId ?? null,
      recurring_event_id: input.recurringEventId ?? null,
      calendar_id: input.calendarId ?? null,
      title: input.title,
      kind: input.kind ?? (input.source === 'adhoc' ? 'adhoc' : 'video'),
      platform: input.platform ?? null,
      capture_source: 'web',
      status: 'scheduled',
      recorded_by: ctx.auth.userId,
      scheduled_start: input.scheduledStart ?? null,
      scheduled_end: input.scheduledEnd ?? null,
      started_at: null,
      ended_at: null,
      recorded_ms: 0,
      visibility: preferences.defaultVisibility,
      shared_with: [],
      folder_id: null,
      template_id: input.templateId ?? null,
      language: 'en',
      consent_state: neverRecord ? 'blocked' : 'pending',
      consent_method: null,
      consent_at: null,
      consent_by: null,
      consent_notice_text: null,
      never_record_match: neverRecord,
      audio_retained: false,
      granola_external_id: null,
      last_seq: null,
      injection_flagged: false,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
    await ctx.store.insert('meetings', meeting);

    const participant = (
      p: { email: string | null; name: string | null },
      role: MeetingParticipant['role'],
      source: MeetingParticipant['source'],
    ): MeetingParticipant => ({
      id: newId(),
      organization_id: org,
      meeting_id: id,
      email: p.email,
      name: p.name,
      role,
      source,
      crm_person_id: null,
      user_id: role === 'self' ? ctx.auth.userId : null,
      is_external: role === 'self' ? false : !(ownDomain && domainOf(p.email) === ownDomain),
      created_at: now,
      updated_at: now,
    });
    const source: MeetingParticipant['source'] =
      input.source === 'calendar' ? 'calendar' : 'manual';
    const rows: MeetingParticipant[] = [
      participant({ email: recorder.email, name: recorder.name }, 'self', source),
      ...[...attendees.values()]
        .filter((a) => a.email !== recorder.email)
        .map((a) => participant(a, 'guest', source)),
      ...named.map((a) => participant(a, 'guest', source)),
    ];
    await ctx.store.insertMany('meeting_participants', rows);

    await audit(ctx, 'notes.meeting_created', id, {
      source: input.source,
      guests: rows.length - 1,
      never_record: neverRecord?.label ?? null,
    });
    return ok({ meeting, created: true });
  });
}

/** Everything the meeting page shows, in one read. */
export async function getMeetingDetail(
  ctx: NotesContext,
  meetingId: string,
): Promise<Result<Omit<MeetingDetailResponse, 'ok'>>> {
  return guard('read the meeting', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const meeting = found.value;
    const org = ctx.auth.organizationId;
    const [participants, speakers, segments, note, links] = await Promise.all([
      participantsOf(ctx, meeting.id),
      speakersOf(ctx, meeting.id),
      segmentsOf(ctx, meeting.id),
      noteOf(ctx, meeting),
      ctx.store.list(
        'note_share_links',
        org,
        { eq: { meeting_id: meeting.id } },
        { orderBy: [{ field: 'created_at', direction: 'desc' }] },
      ) as Promise<NoteShareLink[]>,
    ]);
    const changedSince = speakers.reduce<string | null>(
      (latest, s) => (!latest || s.updated_at > latest ? s.updated_at : latest),
      null,
    );
    return ok({
      meeting: toMeetingView(meeting, ctx.auth.userId),
      participants: participants.map(toParticipantView),
      // Line counts over every line, not just the first page sent here.
      speakers: await speakerViews(ctx, meeting, speakers),
      segments: segments.map(toSegmentView),
      note: note ? toCopilotNoteView(note, meeting.id, changedSince) : null,
      shareLinks: links.map((l) => toShareLinkView(l, nowOf(ctx))),
      template: await templateViewFor(ctx, meeting.template_id),
    });
  });
}

/**
 * The Copilot note row for a meeting, made on first need (typed notes are
 * saved before any notes are generated). `content` is the plain text the
 * older readers show.
 */
export async function ensureNoteRow(
  ctx: NotesContext,
  meeting: Meeting,
  patch: Partial<MeetingNote> = {},
): Promise<MeetingNote> {
  const existing = await noteOf(ctx, meeting);
  const now = nowOf(ctx).toISOString();
  if (existing) {
    return ctx.store.update('meeting_notes', ctx.auth.organizationId, existing.id, {
      ...patch,
      updated_at: now,
    });
  }
  const participants = await participantsOf(ctx, meeting.id);
  const row: MeetingNote = {
    id: newId(),
    organization_id: ctx.auth.organizationId,
    provider: 'copilot',
    external_id: meeting.id,
    title: meeting.title,
    occurred_at: meeting.started_at ?? meeting.scheduled_start ?? meeting.created_at,
    attendees: participants
      .filter((p): p is MeetingParticipant & { email: string } => Boolean(p.email))
      .map((p) => ({ name: p.name, email: p.email })),
    content: '',
    source_url: null,
    injection_flagged: false,
    meeting_id: meeting.id,
    user_notes: null,
    enhanced_blocks: null,
    action_items: [],
    template_id: meeting.template_id,
    prompt_version: null,
    model: null,
    generated_at: null,
    edited_at: null,
    visibility: meeting.visibility,
    owner_id: meeting.recorded_by,
    created_at: now,
    updated_at: now,
    ...patch,
  };
  return ctx.store.insert('meeting_notes', row);
}

/** Rename, file, re-template, share with teammates, or save the notepad. */
export async function updateMeeting(
  ctx: NotesContext,
  meetingId: string,
  patch: UpdateMeetingRequest,
): Promise<Result<Meeting>> {
  return guard('save the meeting', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const meeting = found.value;
    const isRecorder = meeting.recorded_by === ctx.auth.userId;
    if ((patch.visibility !== undefined || patch.sharedWith !== undefined) && !isRecorder) {
      return err('forbidden', 'Only the person who recorded this meeting can change who sees it.');
    }
    const org = ctx.auth.organizationId;
    const next: Partial<Meeting> = {};
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.kind !== undefined) next.kind = patch.kind;
    if (patch.platform !== undefined) next.platform = patch.platform;
    if (patch.templateId !== undefined) {
      if (patch.templateId && !isBuiltinTemplateId(patch.templateId)) {
        const custom = await ctx.store.get('note_templates', org, patch.templateId);
        if (!custom) return err('invalid_input', 'That template was not found.');
      }
      next.template_id = patch.templateId;
    }
    if (patch.sharedWith !== undefined) next.shared_with = [...new Set(patch.sharedWith)];
    if (patch.visibility !== undefined) next.visibility = patch.visibility;
    if (patch.folderId !== undefined) {
      if (patch.folderId) {
        const folder = await ctx.store.get('meeting_folders', org, patch.folderId);
        if (!folder) return err('invalid_input', 'That folder was not found.');
        // A private folder keeps its meetings private.
        if (folder.is_private) next.visibility = 'private';
      }
      next.folder_id = patch.folderId;
    }
    const folderAfter = patch.folderId !== undefined ? patch.folderId : meeting.folder_id;
    if (patch.visibility === 'team' && folderAfter) {
      const folder = await ctx.store.get('meeting_folders', org, folderAfter);
      if (folder?.is_private) {
        return err('invalid_input', 'Meetings in a private folder stay private.');
      }
    }

    const updated = Object.keys(next).length
      ? await ctx.store.update('meetings', org, meeting.id, next)
      : meeting;

    const notePatch: Partial<MeetingNote> = {};
    if (patch.userNotes !== undefined) {
      notePatch.user_notes = patch.userNotes;
      notePatch.edited_at = nowOf(ctx).toISOString();
    }
    if (next.title !== undefined) notePatch.title = next.title;
    if (next.visibility !== undefined) notePatch.visibility = next.visibility;
    if (next.template_id !== undefined) notePatch.template_id = next.template_id;
    if (Object.keys(notePatch).length) {
      const note = await noteOf(ctx, updated);
      if (note || patch.userNotes !== undefined) {
        if (patch.userNotes !== undefined && !note?.generated_at) {
          // Until notes are generated, the older readers show the typed notes.
          notePatch.content = patch.userNotes;
        }
        await ensureNoteRow(ctx, updated, notePatch);
      }
    }
    await audit(ctx, 'notes.meeting_updated', meeting.id, {
      fields: Object.keys(patch).join(','),
    });
    return ok(updated);
  });
}

/** Move a meeting to the trash (purged with everything under it after 7 days). Recorder only. */
export async function deleteMeeting(ctx: NotesContext, meetingId: string): Promise<Result<true>> {
  return guard('delete the meeting', async () => {
    const found = await loadMeeting(ctx, meetingId, { recorderOnly: true });
    if (!found.ok) return found;
    if (found.value.status === 'recording' || found.value.status === 'paused') {
      return err('conflict', 'Stop the recording before deleting the meeting.');
    }
    await ctx.store.update('meetings', ctx.auth.organizationId, meetingId, {
      deleted_at: nowOf(ctx).toISOString(),
    });
    await audit(ctx, 'notes.meeting_deleted', meetingId);
    return ok(true);
  });
}

/* ================================================== consent and state == */

/**
 * Start recording. Refused unless the consent step is confirmed (the schema
 * insists on `confirmed: true`), and refused on a meeting that matches a
 * never-record rule, checked again here with the rules as they are now.
 */
export async function startRecording(
  ctx: NotesContext,
  meetingId: string,
  input: StartRecordingRequest,
): Promise<Result<Meeting>> {
  return guard('start recording', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const meeting = found.value;
    if (meeting.recorded_by && meeting.recorded_by !== ctx.auth.userId) return RECORDER_ONLY();
    if (meeting.deleted_at) return NOT_FOUND();
    if (meeting.status === 'recording') return ok(meeting);
    if (meeting.status !== 'scheduled') {
      return err(
        'conflict',
        'This meeting was already recorded. Start a new note to record again.',
      );
    }
    const participants = await participantsOf(ctx, meeting.id);
    const neverRecord = matchNeverRecord(
      {
        title: meeting.title,
        calendarId: meeting.calendar_id,
        attendeeEmails: participants.map((p) => p.email),
      },
      await enabledRules(ctx),
    );
    const org = ctx.auth.organizationId;
    if (neverRecord) {
      await ctx.store.update('meetings', org, meeting.id, {
        consent_state: 'blocked',
        never_record_match: neverRecord,
      });
      await logConsent(ctx, meeting, 'blocked', { detail: { label: neverRecord.label } });
      await audit(ctx, 'notes.start_blocked', meeting.id, { label: neverRecord.label });
      return err('forbidden', NEVER_RECORD_MESSAGE, {
        details: { never_record: neverRecord.label },
      });
    }
    const now = nowOf(ctx).toISOString();
    const noticeText =
      input.consent.noticeText?.trim() ||
      (input.consent.method === 'chat_notice' ? CONSENT_NOTICE_TEXT : null);
    const updated = await ctx.store.update('meetings', org, meeting.id, {
      recorded_by: ctx.auth.userId,
      status: 'recording',
      capture_source: input.captureSource,
      kind: input.kind ?? meeting.kind,
      started_at: meeting.started_at ?? now,
      consent_state: 'confirmed',
      consent_method: input.consent.method,
      consent_at: now,
      consent_by: ctx.auth.userId,
      consent_notice_text: noticeText,
      never_record_match: null,
    });
    await logConsent(ctx, meeting, 'confirmed', {
      method: input.consent.method,
      notice_text: noticeText,
    });
    await logConsent(ctx, meeting, 'recording_started', {
      detail: { capture_source: input.captureSource },
    });
    await audit(ctx, 'notes.consent_confirmed', meeting.id, { method: input.consent.method });
    await audit(ctx, 'notes.start', meeting.id, { capture_source: input.captureSource });
    return ok(updated);
  });
}

/** Pause (sockets close; nothing is heard) or resume. Recorder only. */
export async function pauseRecording(
  ctx: NotesContext,
  meetingId: string,
  paused: boolean,
): Promise<Result<Meeting>> {
  return guard(paused ? 'pause' : 'resume', async () => {
    const found = await loadMeeting(ctx, meetingId, { recorderOnly: true });
    if (!found.ok) return found;
    const meeting = found.value;
    const want = paused ? 'paused' : 'recording';
    if (meeting.status === want) return ok(meeting);
    if (meeting.status !== 'recording' && meeting.status !== 'paused') {
      return err('conflict', 'This meeting is not being recorded.');
    }
    const updated = await ctx.store.update('meetings', ctx.auth.organizationId, meeting.id, {
      status: want,
    });
    await logConsent(ctx, meeting, paused ? 'paused' : 'resumed');
    await audit(ctx, paused ? 'notes.paused' : 'notes.resumed', meeting.id);
    return ok(updated);
  });
}

/**
 * Stop: the recording is over and the notes job runs. The recorder posts its
 * last lines before calling this; lines still arriving while the job runs
 * are accepted.
 */
export async function stopRecording(
  ctx: NotesContext,
  meetingId: string,
  input: StopRecordingRequest,
): Promise<Result<Meeting>> {
  return guard('stop recording', async () => {
    const found = await loadMeeting(ctx, meetingId, { recorderOnly: true });
    if (!found.ok) return found;
    const meeting = found.value;
    if (meeting.status === 'processing' || meeting.status === 'ready') return ok(meeting);
    if (meeting.status !== 'recording' && meeting.status !== 'paused') {
      return err('conflict', 'This meeting is not being recorded.');
    }
    const now = nowOf(ctx);
    const elapsed = meeting.started_at
      ? Math.max(0, now.getTime() - Date.parse(meeting.started_at))
      : 0;
    // The recorder's own count (pauses excluded), never more than the wall clock.
    const recordedMs =
      input.recordedMs !== undefined && meeting.started_at
        ? Math.min(input.recordedMs, elapsed)
        : (input.recordedMs ?? elapsed);
    const updated = await ctx.store.update('meetings', ctx.auth.organizationId, meeting.id, {
      status: 'processing',
      ended_at: now.toISOString(),
      recorded_ms: Math.round(recordedMs),
    });
    await logConsent(ctx, meeting, 'stopped', { detail: { reason: input.reason ?? 'user' } });
    await audit(ctx, 'notes.stop', meeting.id, { reason: input.reason ?? 'user' });
    return ok(updated);
  });
}

/** Log a consent-step event that changes nothing else (the notice was copied). */
export async function logConsentEvent(
  ctx: NotesContext,
  meetingId: string,
  event: 'notice_copied',
): Promise<Result<true>> {
  return guard('note the consent step', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    await logConsent(ctx, found.value, event, { notice_text: CONSENT_NOTICE_TEXT });
    return ok(true);
  });
}

/* ================================================== speech-to-text keys == */

/**
 * Mint one speech session per track asked for. Recorder only, and only while
 * recording: a paused meeting resumes first. The long-lived vendor key never
 * leaves the server; each session's key lives 60 seconds.
 */
/**
 * Words the speech vendor should spell right: the invite's names and the
 * guests' companies as the CRM knows them. Spellings, never facts: nothing
 * here reaches the notes.
 */
async function sessionVocabulary(
  ctx: NotesContext,
  meeting: Meeting,
  participants: readonly MeetingParticipant[],
): Promise<string[]> {
  const words = new Set<string>();
  for (const p of participants) if (p.name?.trim()) words.add(p.name.trim());
  try {
    const team = await readTeamInfo(ctx.store, ctx.auth.organizationId);
    const crm = await meetingCrmContext(ctx, meeting, participants, team);
    for (const d of crm.deals) words.add(d.company);
    for (const c of crm.portfolio) words.add(c.name);
    for (const c of crm.contacts) if (c.company) words.add(c.company);
  } catch (error) {
    log.warn('Copilot Notes: CRM words for the speech session could not be read', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return [...words].slice(0, 100);
}

export interface MintOptions {
  /**
   * The consented, enrolled voices to recognise, given the invite's emails
   * (services/voice-profiles.ts knownSpeakersFor; the route passes it in).
   */
  knownSpeakers?: (inviteEmails: (string | null)[]) => Promise<KnownSpeaker[]>;
}

export async function mintSttSessions(
  ctx: NotesContext,
  meetingId: string,
  tracks: TranscriptTrack[],
  options: MintOptions = {},
): Promise<Result<{ provider: TranscriberProvider; sessions: SttSession[] }>> {
  return guard('start the transcript', async () => {
    const found = await loadMeeting(ctx, meetingId, { recorderOnly: true });
    if (!found.ok) return found;
    const meeting = found.value;
    if (meeting.status !== 'recording') {
      return err('conflict', 'Start (or resume) the recording first.');
    }
    const participants = await participantsOf(ctx, meeting.id);
    const vocabulary = await sessionVocabulary(ctx, meeting, participants);
    const transcriber = getTranscriber();
    // Only Speechmatics recognises enrolled voices, and only on a diarized
    // track (every mic word is the recorder's). Consent is checked by the
    // resolver: nobody without it is ever in this list.
    let knownSpeakers: KnownSpeaker[] = [];
    if (
      options.knownSpeakers &&
      transcriber.provider === 'speechmatics' &&
      tracks.some((t) => t !== 'mic')
    ) {
      try {
        knownSpeakers = await options.knownSpeakers(participants.map((p) => p.email));
      } catch (error) {
        log.warn('Copilot Notes: enrolled voices could not be read', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const sessions: SttSession[] = [];
    for (const track of tracks) {
      const minted = await transcriber.mintSession({
        meetingId: meeting.id,
        track,
        language: meeting.language,
        knownSpeakers,
        vocabulary,
        now: nowOf(ctx),
      });
      if (!minted.ok) return minted;
      sessions.push(minted.value);
    }
    await audit(ctx, 'notes.stt_token_minted', meeting.id, {
      provider: transcriber.provider,
      tracks: tracks.join(','),
      known_voices: knownSpeakers.length,
    });
    return ok({ provider: transcriber.provider, sessions });
  });
}

/* ========================================================= transcript == */

const UPLOADABLE: readonly Meeting['status'][] = ['recording', 'paused', 'processing'];

/**
 * Store finished lines. Recorder only. Upserts on (meeting, seq): a line
 * already stored under its seq is counted as a duplicate and left as it is,
 * so a retried batch changes nothing. A mic line that repeats the meeting
 * audio is dropped as echo. A voice seen for the first time gets its row
 * (the recorder's mic named at once, anyone else "Guest N").
 */
export async function uploadSegments(
  ctx: NotesContext,
  meetingId: string,
  uploads: SegmentUpload[],
): Promise<
  Result<{
    accepted: number;
    duplicates: number;
    dropped: number;
    lastSeq: number | null;
    speakers: SpeakerView[];
  }>
> {
  return guard('save the transcript', async () => {
    const found = await loadMeeting(ctx, meetingId, { recorderOnly: true });
    if (!found.ok) return found;
    const meeting = found.value;
    if (!UPLOADABLE.includes(meeting.status)) {
      return err('conflict', 'This meeting is not being recorded.');
    }
    for (const u of uploads) {
      if (trackOfClusterKey(u.clusterKey) !== u.track) {
        return err('invalid_input', `Line ${u.seq}: its voice is not on the ${u.track} track.`);
      }
    }
    const org = ctx.auth.organizationId;

    // First copy of each seq in the batch wins.
    const bySeq = new Map<number, SegmentUpload>();
    for (const u of uploads) if (!bySeq.has(u.seq)) bySeq.set(u.seq, u);
    const seqs = [...bySeq.keys()];
    const stored = new Set<number>();
    for (const part of chunk(seqs, 200)) {
      const rows = (await ctx.store.list('transcript_segments', org, {
        eq: { meeting_id: meeting.id },
        in: { seq: part },
      })) as TranscriptSegment[];
      for (const r of rows) stored.add(r.seq);
    }
    const fresh = [...bySeq.values()].filter((u) => !stored.has(u.seq));

    // Echo: mic lines against meeting-audio lines on hand (this batch and stored).
    let dropped = 0;
    let kept = fresh;
    const micLines = fresh.filter((u) => u.track === 'mic');
    if (micLines.length > 0) {
      const window = NOTES_LIMITS.echoDedupeWindowMs;
      const from = Math.min(...micLines.map((u) => u.startMs)) - window;
      const to = Math.max(...micLines.map((u) => u.endMs)) + window;
      const storedSystem = (await ctx.store.list('transcript_segments', org, {
        eq: { meeting_id: meeting.id, track: 'system' },
        gte: { start_ms: Math.max(0, from - 60_000) },
        lte: { start_ms: to },
      })) as TranscriptSegment[];
      const others: TimedText[] = [
        ...storedSystem.map((s) => ({ startMs: s.start_ms, endMs: s.end_ms, text: s.text })),
        ...fresh
          .filter((u) => u.track === 'system')
          .map((u) => ({ startMs: u.startMs, endMs: u.endMs, text: u.text })),
      ];
      kept = fresh.filter((u) => {
        if (u.track !== 'mic') return true;
        const echo = isEcho({ startMs: u.startMs, endMs: u.endMs, text: u.text }, others, window);
        if (echo) dropped += 1;
        return !echo;
      });
    }

    // Voices seen for the first time.
    const now = nowOf(ctx).toISOString();
    const speakers = await speakersOf(ctx, meeting.id);
    const known = new Set(speakers.map((s) => s.cluster_key));
    const recorder = meeting.recorded_by === ctx.auth.userId ? recorderOf(ctx.auth) : null;
    const newSpeakers: MeetingSpeaker[] = [];
    for (const u of kept) {
      if (known.has(u.clusterKey)) continue;
      known.add(u.clusterKey);
      newSpeakers.push(
        newSpeakerRow({
          id: newId(),
          organizationId: org,
          meetingId: meeting.id,
          clusterKey: u.clusterKey,
          track: u.track,
          recorder,
          existing: [...speakers, ...newSpeakers],
          now,
        }),
      );
    }
    if (newSpeakers.length) {
      try {
        await ctx.store.insertMany('meeting_speakers', newSpeakers);
      } catch (error) {
        if (isMissingTableError(error) || isMissingColumnError(error)) throw error;
        // Another batch added one of these voices first. Add only the ones
        // still missing, one at a time; never overwrite a voice's name.
        for (const row of newSpeakers) {
          const exists = await ctx.store.findOne('meeting_speakers', org, {
            eq: { meeting_id: meeting.id, cluster_key: row.cluster_key },
          });
          if (!exists) await ctx.store.insert('meeting_speakers', row);
        }
      }
    }

    let flagged = false;
    const rows: TranscriptSegment[] = kept.map((u) => {
      if (!flagged && scanForInjection(u.text).flagged) flagged = true;
      return {
        id: newId(),
        organization_id: org,
        meeting_id: meeting.id,
        seq: u.seq,
        track: u.track,
        cluster_key: u.clusterKey,
        vendor_label: u.vendorLabel ?? null,
        start_ms: u.startMs,
        end_ms: u.endMs,
        text: u.text,
        edited_text: null,
        edited_by: null,
        edited_at: null,
        confidence: u.confidence ?? null,
        is_final: u.isFinal ?? true,
        created_at: now,
        updated_at: now,
      };
    });
    if (rows.length) {
      try {
        await ctx.store.insertMany('transcript_segments', rows);
      } catch (error) {
        if (isMissingTableError(error) || isMissingColumnError(error)) throw error;
        // A concurrent retry stored some of these first: fall back to one
        // upsert per line, which treats the stored copy as the same line.
        for (const row of rows) {
          await ctx.store.upsert('transcript_segments', row, ['meeting_id', 'seq']);
        }
      }
    }

    const maxSeq = seqs.length ? Math.max(...seqs) : null;
    const lastSeq = maxSeq === null ? meeting.last_seq : Math.max(maxSeq, meeting.last_seq ?? -1);
    const meetingPatch: Partial<Meeting> = {};
    if (lastSeq !== meeting.last_seq) meetingPatch.last_seq = lastSeq;
    if (flagged && !meeting.injection_flagged) meetingPatch.injection_flagged = true;
    if (Object.keys(meetingPatch).length) {
      await ctx.store.update('meetings', org, meeting.id, meetingPatch);
    }
    if (flagged && !meeting.injection_flagged) {
      await audit(ctx, 'security.injection_flagged', meeting.id, { where: 'transcript' });
    }

    // Live naming: a new voice, or more lines from one nobody has named yet,
    // may now be named by the invite or a consented voice (rules only here;
    // the AI cue pass runs once, after Stop).
    let current = [...speakers, ...newSpeakers];
    const lines = await allLinesOf(ctx, meeting.id);
    const open = new Set(
      current
        .filter((s) => !s.locked && !s.merged_into && !isResolved(s))
        .map((s) => s.cluster_key),
    );
    if (newSpeakers.length > 0 || rows.some((r) => open.has(r.cluster_key))) {
      const changed = await namingSafely(ctx, meeting, {
        speakers: current,
        lines: lines.filter((l) => l.is_final),
      });
      if (changed) current = await speakersOf(ctx, meeting.id);
    }

    return ok({
      accepted: rows.length,
      duplicates: uploads.length - fresh.length,
      dropped,
      lastSeq,
      speakers: await speakerViews(ctx, meeting, current, lines),
    });
  });
}

/** Lines after `after`, for a viewer polling a live meeting. */
export async function listSegments(
  ctx: NotesContext,
  meetingId: string,
  options: { after?: number; limit?: number },
): Promise<
  Result<{
    segments: SegmentView[];
    speakers: SpeakerView[];
    lastSeq: number | null;
    status: Meeting['status'];
  }>
> {
  return guard('read the transcript', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const meeting = found.value;
    const segments = await segmentsOf(ctx, meeting.id, options);
    return ok({
      segments: segments.map(toSegmentView),
      speakers: await speakerViews(ctx, meeting),
      lastSeq: meeting.last_seq,
      status: meeting.status,
    });
  });
}

/** Fix a line in place (a number, a name). The vendor's text is kept for audit. */
export async function editSegment(
  ctx: NotesContext,
  meetingId: string,
  seq: number,
  text: string,
): Promise<Result<SegmentView>> {
  return guard('save the line', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const org = ctx.auth.organizationId;
    const line = await ctx.store.findOne('transcript_segments', org, {
      eq: { meeting_id: meetingId, seq },
    });
    if (!line) return err('not_found', 'That line was not found.');
    const updated = await ctx.store.update('transcript_segments', org, line.id, {
      edited_text: text === line.text ? null : text,
      edited_by: text === line.text ? null : ctx.auth.userId,
      edited_at: text === line.text ? null : nowOf(ctx).toISOString(),
    });
    await audit(ctx, 'notes.segment_edited', meetingId, { seq });
    return ok(toSegmentView(updated));
  });
}

/* ============================================================ voices == */

async function personPatch(
  ctx: NotesContext,
  meetingId: string,
  person: SpeakerPersonInput,
): Promise<Partial<MeetingSpeaker>> {
  const email = person.email ? person.email.toLowerCase() : null;
  let crmPersonId = person.crmPersonId ?? null;
  let name = person.name;
  if (email) {
    // Spelling and CRM link from the invite when the person is on it.
    const guest = await ctx.store.findOne('meeting_participants', ctx.auth.organizationId, {
      eq: { meeting_id: meetingId, email },
    });
    if (guest?.name) name = guest.name;
    crmPersonId = crmPersonId ?? guest?.crm_person_id ?? null;
  }
  return {
    display_name: name,
    person_email: email,
    crm_person_id: crmPersonId,
    source: 'manual',
    confidence: 1,
    confirmed_by: ctx.auth.userId,
    confirmed_at: nowOf(ctx).toISOString(),
  };
}

/** Whether a generated note exists, so the UI says "notes refreshing". */
async function hasGeneratedNote(ctx: NotesContext, meeting: Meeting): Promise<boolean> {
  const note = await noteOf(ctx, meeting);
  return Boolean(note?.generated_at);
}

/**
 * "This is…": name a voice (one update, and every line of that voice reads
 * the new name), clear it back to "Guest N", or lock it. A name picked by a
 * person is locked unless they say otherwise.
 */
export async function relabelSpeaker(
  ctx: NotesContext,
  meetingId: string,
  clusterKey: string,
  input: RelabelSpeakerRequest,
): Promise<
  Result<{
    speaker: SpeakerView;
    speakers: SpeakerView[];
    updatedLines: number;
    notesRefreshing: boolean;
    rememberVoice?: RememberVoiceOutcome;
  }>
> {
  return guard('rename the voice', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const meeting = found.value;
    const org = ctx.auth.organizationId;
    const speaker = await ctx.store.findOne('meeting_speakers', org, {
      eq: { meeting_id: meeting.id, cluster_key: clusterKey },
    });
    if (!speaker) return err('not_found', 'That voice is not in this meeting.');
    if (speaker.merged_into) {
      return err('conflict', 'That voice was merged into another; rename that one instead.');
    }

    let patch: Partial<MeetingSpeaker> = {};
    if (input.person === null) {
      const others = await speakersOf(ctx, meeting.id);
      patch = {
        display_name: null,
        person_email: null,
        crm_person_id: null,
        user_id: null,
        source: null,
        confidence: null,
        locked: false,
        confirmed_by: null,
        confirmed_at: null,
        guest_number:
          speaker.guest_number ??
          others.reduce((max, s) => Math.max(max, s.guest_number ?? 0), 0) + 1,
      };
    } else if (input.person) {
      patch = { ...(await personPatch(ctx, meeting.id, input.person)), locked: true };
    }
    if (input.locked !== undefined) patch.locked = input.locked;
    const updated = Object.keys(patch).length
      ? await ctx.store.update('meeting_speakers', org, speaker.id, patch)
      : speaker;

    const lines = await allLinesOf(ctx, meeting.id);
    await audit(ctx, 'notes.speaker_relabelled', meeting.id, {
      cluster_key: clusterKey,
      cleared: input.person === null,
      remember_voice_asked: Boolean(input.rememberVoice),
    });
    // A name picked here can leave one guest and one voice: elimination
    // names the last one (and a person's tap is never undone by it).
    if (input.person !== undefined) {
      await namingSafely(ctx, meeting, { lines: lines.filter((l) => l.is_final) });
    }
    const speakers = await speakerViews(ctx, meeting, undefined, lines);
    const view = speakers.find((s) => s.clusterKey === updated.cluster_key);
    if (!view) return err('internal', 'The voice could not be read back.');
    return ok({
      speaker: view,
      speakers,
      updatedLines: lines.filter((l) => l.cluster_key === clusterKey).length,
      notesRefreshing: await hasGeneratedNote(ctx, meeting),
      ...(input.rememberVoice
        ? { rememberVoice: await rememberVoiceOutcome(ctx, meeting, updated) }
        : {}),
    });
  });
}

/**
 * What "Remember this voice" can do now. Identifiers exist only while the
 * vendor session is open, so the recorder fetches them for this voice's
 * vendor label and posts them to /voice-profiles/enroll, where consent is
 * checked again. Nothing is stored here.
 */
async function rememberVoiceOutcome(
  ctx: NotesContext,
  meeting: Meeting,
  speaker: MeetingSpeaker,
): Promise<RememberVoiceOutcome> {
  const email = speaker.person_email;
  const base = { vendorLabel: null, email };
  if (!email) return { status: 'no_consent', ...base };
  const consent = await ctx.store.findOne('voice_profiles', ctx.auth.organizationId, {
    eq: { person_email: email.toLowerCase(), consent_status: 'granted' },
  });
  if (!consent) return { status: 'no_consent', ...base };
  const provider = getTranscriber().provider;
  // The mic is not diarized, and a split voice has no vendor label of its own.
  if (
    (provider !== 'speechmatics' && provider !== 'mock') ||
    speaker.track === 'mic' ||
    speaker.cluster_key.includes('#')
  ) {
    return { status: 'not_supported', ...base };
  }
  if (meeting.status !== 'recording' && meeting.status !== 'paused') {
    return { status: 'not_live', ...base };
  }
  const label = speaker.cluster_key.slice(speaker.cluster_key.indexOf(':') + 1);
  return { status: 'requested', vendorLabel: label, email };
}

/** "From here it's someone else" (or just this line): the lines move to a new voice. */
export async function splitSpeaker(
  ctx: NotesContext,
  meetingId: string,
  input: SplitSpeakerRequest,
): Promise<
  Result<{
    newClusterKey: string;
    movedLines: number;
    speakers: SpeakerView[];
    notesRefreshing: boolean;
  }>
> {
  return guard('split the voice', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const meeting = found.value;
    const org = ctx.auth.organizationId;
    const speakers = await speakersOf(ctx, meeting.id);
    const lines = await allLinesOf(ctx, meeting.id);
    const plan = planSplit(speakers, lines, input);
    if (!plan.ok) return plan;
    const source = speakers.find((s) => s.cluster_key === input.clusterKey) as MeetingSpeaker;
    const now = nowOf(ctx).toISOString();
    const row: MeetingSpeaker = {
      ...newSpeakerRow({
        id: newId(),
        organizationId: org,
        meetingId: meeting.id,
        clusterKey: plan.value.newClusterKey,
        track: source.track,
        recorder: null,
        existing: speakers,
        now,
      }),
      split_from: source.cluster_key,
      split_at_seq: input.fromSeq,
    };
    if (input.person) {
      Object.assign(row, await personPatch(ctx, meeting.id, input.person), { locked: true });
    }
    await ctx.store.insert('meeting_speakers', row);
    for (const part of chunk(plan.value.moveSeqs, 200)) {
      await ctx.store.updateWhere(
        'transcript_segments',
        org,
        { eq: { meeting_id: meeting.id, cluster_key: source.cluster_key }, in: { seq: part } },
        { cluster_key: plan.value.newClusterKey },
      );
    }
    // Touch the source voice so notes generated before the split read as stale.
    await ctx.store.update('meeting_speakers', org, source.id, { updated_at: now });
    await namingSafely(ctx, meeting);
    await audit(ctx, 'notes.speaker_split', meeting.id, {
      from: source.cluster_key,
      to: plan.value.newClusterKey,
      lines: plan.value.moveSeqs.length,
      mode: input.mode,
    });
    return ok({
      newClusterKey: plan.value.newClusterKey,
      movedLines: plan.value.moveSeqs.length,
      speakers: await speakerViews(ctx, meeting),
      notesRefreshing: await hasGeneratedNote(ctx, meeting),
    });
  });
}

/** Two voices are one person: every line of `from` moves to `into`. */
export async function mergeSpeakers(
  ctx: NotesContext,
  meetingId: string,
  from: string,
  into: string,
): Promise<Result<{ movedLines: number; speakers: SpeakerView[]; notesRefreshing: boolean }>> {
  return guard('merge the voices', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const meeting = found.value;
    const org = ctx.auth.organizationId;
    const speakers = await speakersOf(ctx, meeting.id);
    const lines = await allLinesOf(ctx, meeting.id);
    const plan = planMerge(speakers, lines, from, into);
    if (!plan.ok) return plan;
    await ctx.store.updateWhere(
      'transcript_segments',
      org,
      { eq: { meeting_id: meeting.id, cluster_key: from } },
      { cluster_key: into },
    );
    const source = speakers.find((s) => s.cluster_key === from) as MeetingSpeaker;
    const target = speakers.find((s) => s.cluster_key === into) as MeetingSpeaker;
    await ctx.store.update('meeting_speakers', org, source.id, { merged_into: into });
    for (const key of plan.value.repoint) {
      const row = speakers.find((s) => s.cluster_key === key);
      if (row) await ctx.store.update('meeting_speakers', org, row.id, { merged_into: into });
    }
    await ctx.store.update('meeting_speakers', org, target.id, {
      updated_at: nowOf(ctx).toISOString(),
    });
    await namingSafely(ctx, meeting);
    await audit(ctx, 'notes.speakers_merged', meeting.id, {
      from,
      into,
      lines: plan.value.moveSeqs.length,
    });
    return ok({
      movedLines: plan.value.moveSeqs.length,
      speakers: await speakerViews(ctx, meeting),
      notesRefreshing: await hasGeneratedNote(ctx, meeting),
    });
  });
}

/* ================================================ templates and more == */

export async function templateViewFor(
  ctx: NotesContext,
  templateId: string | null,
): Promise<TemplateView | null> {
  if (!templateId) return null;
  if (isBuiltinTemplateId(templateId)) {
    return builtinTemplateViews().find((t) => t.id === templateId) ?? null;
  }
  const row = await ctx.store.get('note_templates', ctx.auth.organizationId, templateId);
  return row && !row.archived ? toTemplateView(row) : null;
}

export async function listTemplates(ctx: NotesContext): Promise<Result<TemplateView[]>> {
  return guard('read the templates', async () => {
    const custom = (await ctx.store.list(
      'note_templates',
      ctx.auth.organizationId,
      { eq: { archived: false } },
      { orderBy: [{ field: 'name', direction: 'asc' }] },
    )) as NoteTemplate[];
    return ok([...builtinTemplateViews(), ...custom.map(toTemplateView)]);
  });
}

export async function createTemplate(
  ctx: NotesContext,
  input: CreateTemplateRequest,
): Promise<Result<TemplateView>> {
  return guard('save the template', async () => {
    if (BUILTIN_TEMPLATES.some((t) => t.name.toLowerCase() === input.name.toLowerCase())) {
      return err('conflict', 'A built-in template already has that name.');
    }
    const now = nowOf(ctx).toISOString();
    const row: NoteTemplate = {
      id: newId(),
      organization_id: ctx.auth.organizationId,
      name: input.name,
      meeting_type: input.meetingType ?? 'other',
      purpose: input.purpose ?? '',
      length: input.length ?? 'standard',
      sections: input.sections,
      prompt: input.prompt ?? '',
      auto_rule: input.autoRule ?? null,
      archived: false,
      created_by: ctx.auth.userId,
      created_at: now,
      updated_at: now,
    };
    await ctx.store.insert('note_templates', row);
    await audit(ctx, 'notes.template_created', null, { template_id: row.id });
    return ok(toTemplateView(row));
  });
}

export async function listFolders(ctx: NotesContext): Promise<Result<FolderView[]>> {
  return guard('read the folders', async () => {
    const org = ctx.auth.organizationId;
    const [folders, meetings] = await Promise.all([
      ctx.store.list(
        'meeting_folders',
        org,
        {},
        {
          orderBy: [
            { field: 'position', direction: 'asc' },
            { field: 'name', direction: 'asc' },
          ],
        },
      ) as Promise<MeetingFolder[]>,
      ctx.store.list('meetings', org, {
        notNull: ['folder_id'],
        isNull: ['deleted_at'],
      }) as Promise<Meeting[]>,
    ]);
    const counts = new Map<string, number>();
    for (const m of meetings) {
      if (m.folder_id && canSeeMeeting(m, ctx.auth.userId)) {
        counts.set(m.folder_id, (counts.get(m.folder_id) ?? 0) + 1);
      }
    }
    return ok(
      folders.map((f) => ({
        id: f.id,
        name: f.name,
        isPrivate: f.is_private,
        meetingCount: counts.get(f.id) ?? 0,
      })),
    );
  });
}

export async function createFolder(
  ctx: NotesContext,
  input: CreateFolderRequest,
): Promise<Result<FolderView>> {
  return guard('make the folder', async () => {
    const org = ctx.auth.organizationId;
    const folders = (await ctx.store.list('meeting_folders', org, {})) as MeetingFolder[];
    if (folders.some((f) => f.name.toLowerCase() === input.name.toLowerCase())) {
      return err('conflict', 'There is already a folder with that name.');
    }
    const now = nowOf(ctx).toISOString();
    const row: MeetingFolder = {
      id: newId(),
      organization_id: org,
      name: input.name,
      is_private: input.isPrivate ?? false,
      slack_channel_id: null,
      position: 0,
      created_by: ctx.auth.userId,
      created_at: now,
      updated_at: now,
    };
    await ctx.store.insert('meeting_folders', row);
    await audit(ctx, 'notes.folder_created', null, { folder_id: row.id, private: row.is_private });
    return ok({ id: row.id, name: row.name, isPrivate: row.is_private, meetingCount: 0 });
  });
}

export async function listRecipes(ctx: NotesContext): Promise<Result<RecipeView[]>> {
  return guard('read the recipes', async () => {
    const rows = (await ctx.store.list(
      'note_recipes',
      ctx.auth.organizationId,
      {},
      { orderBy: [{ field: 'name', direction: 'asc' }] },
    )) as NoteRecipe[];
    return ok(rows.map((r) => ({ id: r.id, name: r.name, prompt: r.prompt, scope: r.scope })));
  });
}

export async function createRecipe(
  ctx: NotesContext,
  input: CreateRecipeRequest,
): Promise<Result<RecipeView>> {
  return guard('save the recipe', async () => {
    const now = nowOf(ctx).toISOString();
    const row: NoteRecipe = {
      id: newId(),
      organization_id: ctx.auth.organizationId,
      name: input.name,
      prompt: input.prompt,
      scope: input.scope ?? 'meeting',
      created_by: ctx.auth.userId,
      created_at: now,
      updated_at: now,
    };
    await ctx.store.insert('note_recipes', row);
    await audit(ctx, 'notes.recipe_created', null, { recipe_id: row.id });
    return ok({ id: row.id, name: row.name, prompt: row.prompt, scope: row.scope });
  });
}

/** The API view of a meeting row for this person. */
export function meetingView(ctx: NotesContext, meeting: Meeting): MeetingView {
  return toMeetingView(meeting, ctx.auth.userId);
}
