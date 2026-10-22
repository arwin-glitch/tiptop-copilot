import type { MeetingNote } from '@/lib/types/domain';
import {
  BUILTIN_TEMPLATES,
  type CopilotNoteView,
  type Meeting,
  type MeetingParticipant,
  type MeetingSpeaker,
  type MeetingView,
  type NoteShareLink,
  type NoteTemplate,
  type ParticipantView,
  type SegmentView,
  type ShareLinkView,
  type SpeakerView,
  type TemplateView,
  type TranscriptSegment,
} from '@/lib/types/notes';
import { certaintyOf, isResolved, speakerDisplayName } from '@/lib/speakers/ladder';

/**
 * Rows to the shapes the API returns (D-076). Pure: no store, no clock but
 * the one passed in. What is left out is deliberate: a view never carries a
 * token hash, a voice identifier, or another person's consent evidence.
 */

export function toMeetingView(meeting: Meeting, viewerId: string): MeetingView {
  return {
    id: meeting.id,
    qualifiedId: `copilot:${meeting.id}`,
    title: meeting.title,
    kind: meeting.kind,
    platform: meeting.platform,
    captureSource: meeting.capture_source,
    status: meeting.status,
    providerEventId: meeting.provider_event_id,
    recurringEventId: meeting.recurring_event_id,
    calendarId: meeting.calendar_id,
    scheduledStart: meeting.scheduled_start,
    scheduledEnd: meeting.scheduled_end,
    startedAt: meeting.started_at,
    endedAt: meeting.ended_at,
    recordedMs: meeting.recorded_ms,
    visibility: meeting.visibility,
    folderId: meeting.folder_id,
    templateId: meeting.template_id,
    recordedBy: meeting.recorded_by,
    isRecorder: meeting.recorded_by === viewerId,
    consent: {
      state: meeting.consent_state,
      method: meeting.consent_method,
      at: meeting.consent_at,
      neverRecord: meeting.never_record_match,
    },
    lastSeq: meeting.last_seq,
    injectionFlagged: meeting.injection_flagged,
    deletedAt: meeting.deleted_at,
    createdAt: meeting.created_at,
    updatedAt: meeting.updated_at,
  };
}

export function toParticipantView(p: MeetingParticipant): ParticipantView {
  return {
    email: p.email,
    name: p.name,
    role: p.role,
    source: p.source,
    crmPersonId: p.crm_person_id,
    isExternal: p.is_external,
  };
}

export function toSpeakerView(
  speaker: MeetingSpeaker,
  options: {
    lineCount: number;
    recorderId: string | null;
    /** Lowercased addresses of people whose voice consent is on file. */
    voiceConsent: ReadonlySet<string>;
  },
): SpeakerView {
  const isOwner =
    speaker.cluster_key === 'mic' &&
    speaker.source === 'channel' &&
    speaker.user_id !== null &&
    speaker.user_id === options.recorderId;
  return {
    clusterKey: speaker.cluster_key,
    track: speaker.track,
    displayName: speakerDisplayName(speaker),
    personEmail: speaker.person_email,
    crmPersonId: speaker.crm_person_id,
    resolved: isResolved(speaker),
    isOwner,
    source: speaker.source,
    certainty: certaintyOf(speaker),
    confidence: speaker.confidence,
    locked: speaker.locked,
    suggestions: speaker.suggestions ?? [],
    mergedInto: speaker.merged_into,
    lineCount: options.lineCount,
    canRememberVoice: Boolean(
      speaker.person_email && options.voiceConsent.has(speaker.person_email.toLowerCase()),
    ),
  };
}

export function toSegmentView(segment: TranscriptSegment): SegmentView {
  return {
    seq: segment.seq,
    track: segment.track,
    clusterKey: segment.cluster_key,
    startMs: segment.start_ms,
    endMs: segment.end_ms,
    text: segment.edited_text ?? segment.text,
    edited: segment.edited_text !== null,
    originalText: segment.edited_text !== null ? segment.text : null,
    isFinal: segment.is_final,
    confidence: segment.confidence,
  };
}

export function isShareLinkActive(link: NoteShareLink, now: Date): boolean {
  return !link.revoked_at && Date.parse(link.expires_at) > now.getTime();
}

export function toShareLinkView(link: NoteShareLink, now: Date): ShareLinkView {
  return {
    id: link.id,
    includeTranscript: link.include_transcript,
    expiresAt: link.expires_at,
    revokedAt: link.revoked_at,
    createdAt: link.created_at,
    viewCount: link.view_count,
    lastViewedAt: link.last_viewed_at,
    active: isShareLinkActive(link, now),
  };
}

/**
 * The Copilot note on a meeting. `changedSince` is the newest rename, split
 * or merge of its voices: notes generated before it are stale.
 */
export function toCopilotNoteView(
  note: MeetingNote,
  meetingId: string,
  changedSince: string | null,
): CopilotNoteView {
  const generatedAt = note.generated_at ?? null;
  return {
    noteId: note.id,
    meetingId,
    userNotes: note.user_notes ?? null,
    blocks: note.enhanced_blocks ?? [],
    actionItems: note.action_items ?? [],
    templateId: note.template_id ?? null,
    promptVersion: note.prompt_version ?? null,
    model: note.model ?? null,
    generatedAt,
    editedAt: note.edited_at ?? null,
    stale: Boolean(
      generatedAt && changedSince && Date.parse(changedSince) > Date.parse(generatedAt),
    ),
  };
}

export function builtinTemplateViews(): TemplateView[] {
  return BUILTIN_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    meetingType: t.meetingType,
    purpose: t.purpose,
    length: t.length,
    sections: t.sections,
    isBuiltin: true,
  }));
}

export function toTemplateView(t: NoteTemplate): TemplateView {
  return {
    id: t.id,
    name: t.name,
    meetingType: t.meeting_type,
    purpose: t.purpose,
    length: t.length,
    sections: t.sections,
    isBuiltin: false,
  };
}
