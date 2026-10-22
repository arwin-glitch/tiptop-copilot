import {
  mockTranscriptEvents,
  MOCK_CALL_DURATION_MS,
  MOCK_CALL_TITLE,
} from '@/lib/transcribe/mock-script';
import { clusterKeyFor } from '@/lib/transcribe/cluster';
import type { MeetingNote } from '@/lib/types/domain';
import {
  CONSENT_NOTICE_TEXT,
  type ActionItem,
  type EnhancedBlock,
  type Meeting,
  type MeetingConsentLogEntry,
  type MeetingFolder,
  type MeetingParticipant,
  type MeetingSpeaker,
  type NoteRecipe,
  type NoteShareLink,
  type NoteTemplate,
  type RecordingRule,
  type TranscriptSegment,
  type VoiceIdentifier,
  type VoiceProfile,
} from '@/lib/types/notes';
import { DEMO_IDS } from './ids';

/**
 * Copilot Notes demo data (D-076). Fictional throughout: Acme Robotics, Dana
 * Reyes and Priya Shah exist nowhere, and every address is on .example.
 *
 * Two meetings with the demo user as recorder:
 * - a finished one, nine days ago (older than the Granola demo notes, so the
 *   Granola feed's freshness reads as before): the scripted call from
 *   lib/transcribe/mock-script.ts, with Dana confirmed by a tap, Priya named
 *   by calendar elimination, the late joiner still "Guest 1", draft notes and
 *   action items, and its consent log;
 * - one scheduled two hours from now, not yet recorded, to start a recording
 *   on in demo mode.
 * Plus a private "Coaching" folder and the demo user's own voice consent (no
 * identifier: nobody is enrolled in the demo).
 */

const NS = '00000000-0000-4000-8000-';
const nid = (n: number) => `${NS}${(0xd0000 + n).toString(16).padStart(12, '0')}`;

export const DEMO_NOTES_IDS = {
  folderCoaching: nid(1),
  meetingAcmeIntro: nid(10),
  meetingAcmeFollowUp: nid(11),
  noteAcmeIntro: nid(20),
  voiceProfileOwner: nid(30),
} as const;

/** The finished demo meeting's Google event id (not on the demo calendar). */
export const DEMO_NOTES_EVENT_ID = 'demo-notes-acme-intro';

const ORG = DEMO_IDS.org;
const USER = DEMO_IDS.user;
const OWNER = { name: 'Nick Tippmann', email: 'nick@tiptop.demo' };
const DANA = { name: 'Dana Reyes', email: 'dana@acmerobotics.example' };
const PRIYA = { name: 'Priya Shah', email: 'priya@acmerobotics.example' };

export interface DemoNotes {
  /** Rows for meeting_notes, appended to the Granola demo notes. */
  meeting_notes: MeetingNote[];
  meetings: Meeting[];
  meeting_participants: MeetingParticipant[];
  meeting_speakers: MeetingSpeaker[];
  transcript_segments: TranscriptSegment[];
  meeting_folders: MeetingFolder[];
  note_templates: NoteTemplate[];
  note_recipes: NoteRecipe[];
  note_share_links: NoteShareLink[];
  meeting_consent_log: MeetingConsentLogEntry[];
  voice_profiles: VoiceProfile[];
  voice_identifiers: VoiceIdentifier[];
  recording_rules: RecordingRule[];
}

function meetingRow(
  partial: Partial<Meeting> & Pick<Meeting, 'id' | 'title'>,
  at: string,
): Meeting {
  return {
    organization_id: ORG,
    provider_event_id: null,
    recurring_event_id: null,
    calendar_id: null,
    kind: 'video',
    platform: 'meet',
    capture_source: 'web',
    status: 'scheduled',
    recorded_by: USER,
    scheduled_start: null,
    scheduled_end: null,
    started_at: null,
    ended_at: null,
    recorded_ms: 0,
    visibility: 'private',
    shared_with: [],
    folder_id: null,
    template_id: null,
    language: 'en',
    consent_state: 'pending',
    consent_method: null,
    consent_at: null,
    consent_by: null,
    consent_notice_text: null,
    never_record_match: null,
    audio_retained: false,
    granola_external_id: null,
    last_seq: null,
    injection_flagged: false,
    deleted_at: null,
    created_at: at,
    updated_at: at,
    ...partial,
  };
}

export function demoNotes(now: Date): DemoNotes {
  const at = (ms: number) => new Date(ms).toISOString();
  // Nine days ago, 10:00 Central (15:00 UTC).
  const day = new Date(now.getTime() - 9 * 86_400_000);
  const started = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 15, 0, 0);
  const ended = started + MOCK_CALL_DURATION_MS + 6_000;
  const followUpStart = Math.floor((now.getTime() + 2 * 3_600_000) / 900_000) * 900_000;

  const intro = meetingRow(
    {
      id: DEMO_NOTES_IDS.meetingAcmeIntro,
      title: MOCK_CALL_TITLE,
      provider_event_id: DEMO_NOTES_EVENT_ID,
      status: 'ready',
      scheduled_start: at(started),
      scheduled_end: at(started + 30 * 60_000),
      started_at: at(started),
      ended_at: at(ended),
      recorded_ms: MOCK_CALL_DURATION_MS,
      visibility: 'team',
      template_id: 'builtin:founder_pitch',
      consent_state: 'confirmed',
      consent_method: 'chat_notice',
      consent_at: at(started - 20_000),
      consent_by: USER,
      consent_notice_text: CONSENT_NOTICE_TEXT,
      last_seq: 0,
    },
    at(started - 60_000),
  );
  const followUp = meetingRow(
    {
      id: DEMO_NOTES_IDS.meetingAcmeFollowUp,
      title: 'Acme Robotics follow-up: full team',
      provider_event_id: 'demo-notes-acme-follow-up',
      scheduled_start: at(followUpStart),
      scheduled_end: at(followUpStart + 45 * 60_000),
    },
    at(now.getTime() - 3_600_000),
  );

  let participantN = 100;
  const participant = (
    meetingId: string,
    who: { name: string; email: string },
    role: MeetingParticipant['role'],
    createdAt: string,
  ): MeetingParticipant => ({
    id: nid(participantN++),
    organization_id: ORG,
    meeting_id: meetingId,
    email: who.email,
    name: who.name,
    role,
    source: 'calendar',
    crm_person_id: null,
    user_id: role === 'self' ? USER : null,
    is_external: role !== 'self',
    created_at: createdAt,
    updated_at: createdAt,
  });
  const meeting_participants: MeetingParticipant[] = [intro, followUp].flatMap((m) => [
    participant(m.id, OWNER, 'self', m.created_at),
    participant(m.id, DANA, 'guest', m.created_at),
    participant(m.id, PRIYA, 'guest', m.created_at),
  ]);

  const speakerBase = (key: string, n: number): MeetingSpeaker => ({
    id: nid(200 + n),
    organization_id: ORG,
    meeting_id: intro.id,
    cluster_key: key,
    track: key === 'mic' ? 'mic' : 'system',
    person_email: null,
    display_name: null,
    crm_person_id: null,
    user_id: null,
    guest_number: null,
    source: null,
    confidence: null,
    locked: false,
    suggestions: [],
    merged_into: null,
    split_from: null,
    split_at_seq: null,
    confirmed_by: null,
    confirmed_at: null,
    created_at: at(started),
    updated_at: at(started),
  });
  const meeting_speakers: MeetingSpeaker[] = [
    {
      ...speakerBase('mic', 0),
      person_email: OWNER.email,
      display_name: OWNER.name,
      user_id: USER,
      source: 'channel',
      confidence: 1,
    },
    {
      ...speakerBase(clusterKeyFor('system', 'S1'), 1),
      person_email: DANA.email,
      display_name: DANA.name,
      source: 'manual',
      confidence: 1,
      locked: true,
      confirmed_by: USER,
      confirmed_at: at(ended - 2_000),
    },
    {
      ...speakerBase(clusterKeyFor('system', 'S2'), 2),
      person_email: PRIYA.email,
      display_name: PRIYA.name,
      source: 'calendar',
      confidence: 0.9,
    },
    {
      ...speakerBase(clusterKeyFor('system', 'S3'), 3),
      guest_number: 1,
    },
  ];

  const events = mockTranscriptEvents(['mic', 'system']);
  const transcript_segments: TranscriptSegment[] = events.map((e, seq) => ({
    id: nid(1000 + seq),
    organization_id: ORG,
    meeting_id: intro.id,
    seq,
    track: e.track,
    cluster_key: clusterKeyFor(e.track, e.speakerLabel),
    vendor_label: e.speakerLabel,
    start_ms: e.startMs,
    end_ms: e.endMs,
    text: e.text,
    edited_text: null,
    edited_by: null,
    edited_at: null,
    confidence: e.confidence,
    is_final: true,
    created_at: at(started + e.endMs),
    updated_at: at(started + e.endMs),
  }));
  intro.last_seq = transcript_segments.length - 1;

  const seqOf = (needle: string) => {
    const found = transcript_segments.find((s) => s.text.includes(needle));
    if (!found) throw new Error(`Demo transcript has no line with "${needle}"`);
    return found.seq;
  };
  const range = (needle: string) => [{ fromSeq: seqOf(needle), toSeq: seqOf(needle) }];
  const dueOn = (offsetDays: number) =>
    new Date(started + offsetDays * 86_400_000).toISOString().slice(0, 10);

  const userNotes = [
    '## Acme Robotics',
    '- Retrofit arm, live in ~2 weeks',
    '- Ask about gross margin on hardware',
  ].join('\n');
  const blocks: EnhancedBlock[] = [
    {
      id: 'typed-0',
      kind: 'heading',
      text: 'Acme Robotics',
      depth: 0,
      source: 'typed',
      sources: [],
    },
    {
      id: 'typed-1',
      kind: 'bullet',
      text: 'Retrofit arm, live in ~2 weeks',
      depth: 0,
      source: 'typed',
      sources: [],
    },
    {
      id: 'typed-2',
      kind: 'bullet',
      text: 'Ask about gross margin on hardware',
      depth: 0,
      source: 'typed',
      sources: [],
    },
    {
      id: 'ai-key-points',
      kind: 'heading',
      text: 'Key points',
      depth: 0,
      source: 'ai',
      sources: [],
    },
    {
      id: 'ai-point-arr',
      kind: 'bullet',
      text: 'Dana Reyes: $1.2M ARR, up from $400K a year ago, across 19 customers.',
      depth: 0,
      source: 'ai',
      sources: range('1.2 million'),
    },
    {
      id: 'ai-point-nrr',
      kind: 'bullet',
      text: 'Dana Reyes: net revenue retention 130%; one customer lost (a site closure).',
      depth: 0,
      source: 'ai',
      sources: range('130 percent'),
    },
    {
      id: 'ai-point-round',
      kind: 'bullet',
      text: 'Dana Reyes: raising $4M on a SAFE at a $22M cap, about $2.5M committed, no lead yet; aiming to close mid-November.',
      depth: 0,
      source: 'ai',
      sources: [{ fromSeq: seqOf('Four million'), toSeq: seqOf('No lead yet') }],
    },
    {
      id: 'ai-point-deploy',
      kind: 'bullet',
      text: 'Priya Shah: average deployment is down to eleven days.',
      depth: 0,
      source: 'ai',
      sources: range('eleven days'),
    },
  ];
  const action_items: ActionItem[] = [
    {
      id: `ai-action-${seqOf('data room')}`,
      text: 'Send the data room link with the unit economics.',
      ownerEmail: DANA.email,
      ownerName: DANA.name,
      ownerClusterKey: 'sys:S1',
      due: dueOn(0),
      isPrincipalPromise: false,
      taskId: null,
      sources: range('data room'),
    },
    {
      id: `ai-action-${seqOf('portfolio operations lead')}`,
      text: 'Intro Dana to the portfolio operations lead.',
      ownerEmail: OWNER.email,
      ownerName: OWNER.name,
      ownerClusterKey: 'mic',
      due: dueOn((5 - new Date(started).getUTCDay() + 7) % 7 || 7),
      isPrincipalPromise: true,
      taskId: null,
      sources: range('portfolio operations lead'),
    },
    {
      id: `ai-action-${seqOf('case study')}`,
      text: 'Put together a short deployment case study.',
      ownerEmail: null,
      ownerName: 'Guest 1',
      ownerClusterKey: 'sys:S3',
      due: null,
      isPrincipalPromise: false,
      taskId: null,
      sources: range('case study'),
    },
  ];
  blocks.push(
    {
      id: 'ai-actions',
      kind: 'heading',
      text: 'Action items',
      depth: 0,
      source: 'ai',
      sources: [],
    },
    ...action_items.map((a): EnhancedBlock => ({
      id: `ai-box-${a.id}`,
      kind: 'checkbox',
      text: `${a.ownerName}: ${a.text}`,
      depth: 0,
      source: 'ai',
      sources: a.sources,
      checked: false,
    })),
  );

  const note: MeetingNote = {
    id: DEMO_NOTES_IDS.noteAcmeIntro,
    organization_id: ORG,
    provider: 'copilot',
    external_id: intro.id,
    title: intro.title,
    occurred_at: at(started),
    attendees: [OWNER, DANA, PRIYA],
    content: blocks
      .map((b) => (b.kind === 'heading' ? `\n${b.text}` : `- ${b.text}`))
      .join('\n')
      .trim(),
    source_url: null,
    injection_flagged: false,
    meeting_id: intro.id,
    user_notes: userNotes,
    enhanced_blocks: blocks,
    action_items,
    template_id: 'builtin:founder_pitch',
    prompt_version: 'meeting-notes-draft@0.1.0',
    model: 'none',
    generated_at: at(ended + 30_000),
    edited_at: null,
    visibility: 'team',
    owner_id: USER,
    created_at: at(started),
    updated_at: at(ended + 30_000),
  };

  const log = (
    n: number,
    event: MeetingConsentLogEntry['event'],
    ms: number,
    extra: Partial<MeetingConsentLogEntry> = {},
  ): MeetingConsentLogEntry => ({
    id: nid(300 + n),
    organization_id: ORG,
    meeting_id: intro.id,
    event,
    method: null,
    notice_text: null,
    actor_id: USER,
    detail: {},
    created_at: at(ms),
    ...extra,
  });

  return {
    meeting_notes: [note],
    meetings: [intro, followUp],
    meeting_participants,
    meeting_speakers,
    transcript_segments,
    meeting_folders: [
      {
        id: DEMO_NOTES_IDS.folderCoaching,
        organization_id: ORG,
        name: 'Coaching',
        is_private: true,
        slack_channel_id: null,
        position: 0,
        created_by: USER,
        created_at: at(started - 86_400_000),
        updated_at: at(started - 86_400_000),
      },
    ],
    note_templates: [],
    note_recipes: [],
    note_share_links: [],
    meeting_consent_log: [
      log(0, 'notice_copied', started - 40_000, { notice_text: CONSENT_NOTICE_TEXT }),
      log(1, 'confirmed', started - 20_000, {
        method: 'chat_notice',
        notice_text: CONSENT_NOTICE_TEXT,
      }),
      log(2, 'recording_started', started, { detail: { capture_source: 'web' } }),
      log(3, 'stopped', ended, { detail: { reason: 'user' } }),
    ],
    voice_profiles: [
      {
        id: DEMO_NOTES_IDS.voiceProfileOwner,
        organization_id: ORG,
        person_email: OWNER.email,
        display_name: OWNER.name,
        crm_person_id: null,
        user_id: USER,
        provider: 'speechmatics',
        consent_status: 'granted',
        consent_at: at(started - 2 * 86_400_000),
        consent_evidence: 'self_checkbox',
        consent_text_version: 'voice-consent@1',
        consent_recorded_by: USER,
        enrolled_at: null,
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
        created_at: at(started - 2 * 86_400_000),
        updated_at: at(started - 2 * 86_400_000),
      },
    ],
    voice_identifiers: [],
    recording_rules: [],
  };
}
