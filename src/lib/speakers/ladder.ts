import type { MeetingSpeaker, SpeakerCertainty, TranscriptTrack } from '@/lib/types/notes';

/**
 * The naming ladder (D-076): which name a voice carries, strongest evidence
 * first.
 *
 *   a) channel     the mic is the person recording, from the first word
 *   b) manual      a person picked the name ("This is…"); locked, automation
 *                  never overrides it
 *   c) voiceprint  a live match against a consented, enrolled voice
 *   d) roster      the meeting app's own speaker list lined up with talk time
 *   e) calendar    elimination against the invite's guests (one outside guest
 *                  and one voice: that guest, at 0.9)
 *   f) llm_cue     transcript cues ("thanks, Priya"): suggestion chips only
 *
 * A voice nobody has named shows as "Guest N". Spellings always come from the
 * calendar or the CRM, never from what the speech model heard.
 *
 * This module holds the parts every write path needs: the row a new voice
 * starts with (rung a, or a guest number), the rank of each rung, and how a
 * name reads in the UI. The cue and elimination passes run in the finalize
 * job and only ever write suggestions, or a name with weaker evidence than
 * the one a voice already has.
 */

export const SOURCE_RANK: Record<NonNullable<MeetingSpeaker['source']>, number> = {
  channel: 6,
  manual: 5,
  voiceprint: 4,
  roster: 3,
  calendar: 2,
  llm_cue: 1,
};

/** Whether evidence from `incoming` may replace the name a voice has now. */
export function mayOverride(current: MeetingSpeaker, incoming: MeetingSpeaker['source']): boolean {
  if (current.locked) return false;
  if (!incoming) return false;
  const have = current.source ? SOURCE_RANK[current.source] : 0;
  return SOURCE_RANK[incoming] >= have;
}

export interface Recorder {
  userId: string;
  email: string | null;
  name: string | null;
}

/**
 * The row a voice starts with the first time a line names its cluster. The
 * recorder's own mic is named at once (rung a); any other voice, a split of
 * the mic included, takes the next guest number.
 */
export function newSpeakerRow(params: {
  id: string;
  organizationId: string;
  meetingId: string;
  clusterKey: string;
  track: TranscriptTrack;
  recorder: Recorder | null;
  existing: readonly Pick<MeetingSpeaker, 'guest_number'>[];
  now: string;
}): MeetingSpeaker {
  // 'mic#2' (a split of the mic) is someone else at this computer, so a guest.
  const isRecorderMic = params.clusterKey === 'mic' && params.recorder !== null;
  const nextGuest = params.existing.reduce((max, s) => Math.max(max, s.guest_number ?? 0), 0) + 1;
  const recorder = params.recorder;
  return {
    id: params.id,
    organization_id: params.organizationId,
    meeting_id: params.meetingId,
    cluster_key: params.clusterKey,
    track: params.track,
    person_email: isRecorderMic ? (recorder?.email ?? null) : null,
    display_name: isRecorderMic ? (recorder?.name ?? recorder?.email ?? null) : null,
    crm_person_id: null,
    user_id: isRecorderMic ? (recorder?.userId ?? null) : null,
    guest_number: isRecorderMic ? null : Math.min(nextGuest, 99),
    source: isRecorderMic ? 'channel' : null,
    confidence: isRecorderMic ? 1 : null,
    locked: false,
    suggestions: [],
    merged_into: null,
    split_from: null,
    split_at_seq: null,
    confirmed_by: null,
    confirmed_at: null,
    created_at: params.now,
    updated_at: params.now,
  };
}

/** The name a voice shows: its person, else "Guest N". */
export function speakerDisplayName(
  speaker: Pick<MeetingSpeaker, 'display_name' | 'person_email' | 'guest_number'>,
): string {
  if (speaker.display_name) return speaker.display_name;
  if (speaker.person_email) return speaker.person_email;
  return `Guest ${speaker.guest_number ?? '?'}`;
}

export function isResolved(
  speaker: Pick<MeetingSpeaker, 'display_name' | 'person_email'>,
): boolean {
  return Boolean(speaker.display_name || speaker.person_email);
}

/** How sure a name is, in the People tab's words. */
export function certaintyOf(
  speaker: Pick<MeetingSpeaker, 'source' | 'display_name' | 'person_email'>,
): SpeakerCertainty {
  if (!isResolved(speaker)) return 'unknown';
  switch (speaker.source) {
    case 'channel':
      return 'channel';
    case 'manual':
      return 'confirmed';
    case 'voiceprint':
      return 'voice';
    case 'roster':
      return 'roster';
    case 'calendar':
      return 'calendar';
    case 'llm_cue':
      return 'suggested';
    default:
      return 'unknown';
  }
}
