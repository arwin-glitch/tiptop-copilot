/**
 * Kraken Notes: the shared contract (D-076).
 *
 * Row shapes for the tables in supabase/migrations/20261024000000_copilot_notes.sql,
 * the extra fields a Kraken row carries in `meeting_notes`, the speech-to-text
 * session and event shapes, and the request and response bodies of every
 * /api/notes route. The UI (components/notes, app/(app)/meetings), the web
 * recorder (lib/capture) and the server (lib/services/notes*.ts,
 * app/api/notes) all build against this file, so it holds types and
 * client-safe constants only: no server import, no secret, no I/O.
 *
 * Conventions, as in domain.ts: unknown is `null`, never a placeholder; ids
 * are uuids; times are ISO strings; durations and offsets are milliseconds
 * from the start of the recording.
 *
 * Privacy, as code: no shape here carries audio. Speech is transcribed in the
 * recorder's own browser (D-076); only finished lines of text reach the server.
 * Voiceprints leave the server only inside a recorder's speech setup, for the
 * consented people on that meeting's invite and the team, and only into that
 * browser's speech worker (VoiceIdentifier is a row type for the service
 * alone; no other response includes one). Share-link responses carry the
 * token once, at creation; rows carry only its hash. Public shared views carry
 * no email address.
 */

import type { IsoDateTime, MeetingNote, Uuid } from './domain';

/* ================================================================ enums == */

export const MEETING_KINDS = ['video', 'in_person', 'phone', 'adhoc'] as const;
export type MeetingKind = (typeof MEETING_KINDS)[number];

export const MEETING_PLATFORMS = ['meet', 'zoom', 'teams', 'other'] as const;
export type MeetingPlatform = (typeof MEETING_PLATFORMS)[number];

/** Where the audio was captured. Only 'web' ships in v1; 'desktop' is deferred. */
export const CAPTURE_SOURCES = ['web', 'desktop', 'iphone', 'upload'] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

export const MEETING_STATUSES = [
  'scheduled',
  'recording',
  'paused',
  'processing',
  'ready',
  'failed',
  'discarded',
] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/** 'private': the recorder plus `shared_with`. 'team': every member of the organization. */
export const MEETING_VISIBILITIES = ['private', 'team'] as const;
export type MeetingVisibility = (typeof MEETING_VISIBILITIES)[number];

/** Recording cannot start until 'confirmed'; 'blocked' means a never-record rule matched. */
export const CONSENT_STATES = ['pending', 'confirmed', 'blocked'] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

export const CONSENT_METHODS = [
  'verbal',
  'chat_notice',
  'invite_notice',
  'in_person_notice',
  'other',
] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

export const CONSENT_LOG_EVENTS = [
  'notice_copied',
  'confirmed',
  'blocked',
  'recording_started',
  'paused',
  'resumed',
  'stopped',
] as const;
export type ConsentLogEvent = (typeof CONSENT_LOG_EVENTS)[number];

/**
 * 'mic': the person at this computer (every word is theirs). 'system': the
 * meeting audio, everyone else, diarized. 'mixed': one track with everyone
 * (in person, phone), diarized.
 */
export const TRANSCRIPT_TRACKS = ['mic', 'system', 'mixed'] as const;
export type TranscriptTrack = (typeof TRANSCRIPT_TRACKS)[number];

/** The naming ladder's rungs, strongest evidence first. */
export const SPEAKER_SOURCES = [
  'channel',
  'manual',
  'voiceprint',
  'roster',
  'calendar',
  'llm_cue',
] as const;
export type SpeakerSource = (typeof SPEAKER_SOURCES)[number];

export const PARTICIPANT_ROLES = ['organizer', 'guest', 'self'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export const PARTICIPANT_SOURCES = ['calendar', 'roster', 'manual'] as const;
export type ParticipantSource = (typeof PARTICIPANT_SOURCES)[number];

/**
 * Who turns speech into text (D-076). 'browser-whisper': Whisper running in the
 * recorder's own browser (a Web Worker, WebGPU or WebAssembly), free, with the
 * audio never leaving the device. 'mock': demo mode's scripted call, no model.
 */
export const TRANSCRIBER_PROVIDERS = ['browser-whisper', 'mock'] as const;
export type TranscriberProvider = (typeof TRANSCRIBER_PROVIDERS)[number];

export const CHAT_SCOPES = ['meeting', 'person', 'company', 'all'] as const;
export type ChatScope = (typeof CHAT_SCOPES)[number];

/**
 * A job handed to Arwin's Claude routine (the Ask bridge, D-076): 'notes' is
 * "write this meeting's notes", 'chat' a question about meetings asked
 * through Ask. Nothing here calls a paid API: the routine runs on Arwin's
 * Claude plan and answers through the Slack relay.
 */
export const NOTES_REQUEST_KINDS = ['notes', 'chat'] as const;
export type NotesRequestKind = (typeof NOTES_REQUEST_KINDS)[number];

/** pending → ready (the result arrived), failed (it could not be used) or expired (none came). */
export const NOTES_REQUEST_STATUSES = ['pending', 'ready', 'failed', 'expired'] as const;
export type NotesRequestStatus = (typeof NOTES_REQUEST_STATUSES)[number];

/** Why the notes were asked for: after Stop, Regenerate, or another template. */
export const NOTES_REQUEST_REASONS = ['stop', 'regenerate', 'template'] as const;
export type NotesRequestReason = (typeof NOTES_REQUEST_REASONS)[number];

export const SHARE_EXPIRY_DAYS = [7, 30, 90] as const;
export type ShareExpiryDays = (typeof SHARE_EXPIRY_DAYS)[number];

export const RECORDING_RULE_KINDS = [
  'title',
  'attendee_domain',
  'attendee_email',
  'calendar_id',
] as const;
export type RecordingRuleKind = (typeof RECORDING_RULE_KINDS)[number];

export const VOICE_CONSENT_STATUSES = ['not_asked', 'granted', 'revoked'] as const;
export type VoiceConsentStatus = (typeof VOICE_CONSENT_STATUSES)[number];

export const VOICE_CONSENT_EVIDENCE = ['self_checkbox', 'written', 'verbal_recorded'] as const;
export type VoiceConsentEvidence = (typeof VOICE_CONSENT_EVIDENCE)[number];

export const TEMPLATE_MEETING_TYPES = [
  'pitch',
  'lp',
  'portfolio',
  'intro',
  'internal',
  'other',
] as const;
export type TemplateMeetingType = (typeof TEMPLATE_MEETING_TYPES)[number];

export const TEMPLATE_LENGTHS = ['brief', 'standard', 'detailed'] as const;
export type TemplateLength = (typeof TEMPLATE_LENGTHS)[number];

/** Why a recording stopped. */
export const STOP_REASONS = ['user', 'silence', 'call_ended', 'error'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/* =============================================================== limits == */

/** The numbers both ends agree on. The server enforces every one of them. */
export const NOTES_LIMITS = {
  /** Lines in one POST /segments. */
  maxSegmentsPerRequest: 200,
  /** Characters in one line (the speech engine's finished line, or a person's edit). */
  maxSegmentChars: 4000,
  /** Speech setups per user per hour (POST /speech-setup and /voice-profiles/enroll-session). */
  speechSetupsPerHour: 60,
  /** Audio the recorder keeps in memory to replay if its speech engine restarts. Never written to disk. */
  reconnectBufferSeconds: 30,
  /** How often the recorder posts finished lines. */
  uploadIntervalMs: 2500,
  /** The recorder stops itself after this much silence on every track. */
  silenceAutoStopMinutes: 15,
  /** "No meeting audio detected" after this much silence on the meeting-audio track. */
  noMeetingAudioWarningSeconds: 20,
  /** Mic words that repeat meeting-audio words within this window are echo, and dropped. */
  echoDedupeWindowMs: 1500,
  /** Unknown voices the on-device speaker clustering tells apart on one track. */
  maxSpeakersPerSession: 8,
  /** Enrolled voices one speech setup may carry (people on the invite plus the team). */
  maxVoiceIdentifiersPerSession: 50,
  shareDefaultDays: 30 as ShareExpiryDays,
  shareMaxDays: 90,
  /** A voice identifier is deleted at most this long after it was last used. */
  voiceprintMaxDays: 365,
  /** A deleted meeting stays in the trash this long, then is purged. */
  trashDays: 7,
  /** Lines returned by one GET /segments. */
  maxSegmentsPerPage: 1000,
  /** Characters in one chat question. */
  maxChatQuestionChars: 2000,
  /** Characters of typed notes. */
  maxUserNotesChars: 200_000,
} as const;

/* ============================================================== consent == */

/** The pre-start banner's headline. */
export const CONSENT_BANNER_TEXT = "Everyone on this call should know it's being transcribed.";

/** What [Copy notice] copies, to paste into the meeting chat. */
export const CONSENT_NOTICE_TEXT =
  "Hi all, I'm using TipTop Kraken to transcribe and take notes on this call. Let me know if you'd rather I didn't.";

/** The required checkbox before Start is enabled. */
export const CONSENT_CHECKBOX_LABEL = "I've told everyone / posted the notice";

/** Shown in place of Start when a never-record rule matches. */
export const NEVER_RECORD_MESSAGE = 'This meeting is on your never-record list.';

/** The line a meeting booked through Kraken's booking link carries in its invite. */
export const INVITE_NOTICE_LINE =
  'TipTop Kraken may transcribe this meeting to take notes. Reply if you would rather it did not.';

/** Version of the voice-enrolment consent wording, stored with each consent. */
export const VOICE_CONSENT_TEXT_VERSION = 'voice-consent@1';

/** The voice-enrolment consent wording (counsel confirms it before external use). */
export const VOICE_CONSENT_TEXT =
  'I agree that TipTop Kraken may create a voice identifier from a short recording of my voice, ' +
  'so my name appears on my lines in meeting transcripts. It is encrypted, used only for this, never ' +
  'shared or exported, deleted within a year of its last use, and deleted at once if I withdraw consent.';

/* ================================================================= rows == */

export interface Meeting {
  id: Uuid;
  organization_id: Uuid;
  provider_event_id: string | null;
  recurring_event_id: string | null;
  calendar_id: string | null;
  title: string;
  kind: MeetingKind;
  platform: MeetingPlatform | null;
  capture_source: CaptureSource;
  status: MeetingStatus;
  /** The only person who may upload lines or mint speech keys for this meeting. */
  recorded_by: Uuid | null;
  scheduled_start: IsoDateTime | null;
  scheduled_end: IsoDateTime | null;
  started_at: IsoDateTime | null;
  ended_at: IsoDateTime | null;
  /** Recorded time, pauses excluded. */
  recorded_ms: number;
  visibility: MeetingVisibility;
  /** Team members who may read a private meeting. */
  shared_with: Uuid[];
  folder_id: Uuid | null;
  /** 'builtin:<key>' or a note_templates id. */
  template_id: string | null;
  language: string;
  consent_state: ConsentState;
  consent_method: ConsentMethod | null;
  consent_at: IsoDateTime | null;
  consent_by: Uuid | null;
  consent_notice_text: string | null;
  never_record_match: NeverRecordMatch | null;
  /** Always false in v1; the schema refuses true. */
  audio_retained: false;
  /** The Granola note of the same conversation, while both tools run. */
  granola_external_id: string | null;
  /** The highest line number stored, or null before the first line. */
  last_seq: number | null;
  injection_flagged: boolean;
  /** In the trash since; purged after NOTES_LIMITS.trashDays. */
  deleted_at: IsoDateTime | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface MeetingParticipant {
  id: Uuid;
  organization_id: Uuid;
  meeting_id: Uuid;
  /** Lowercased; null for someone added by name only. */
  email: string | null;
  name: string | null;
  role: ParticipantRole;
  source: ParticipantSource;
  crm_person_id: Uuid | null;
  /** A team member, when the participant is one. */
  user_id: Uuid | null;
  is_external: boolean;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/** A ranked guess for an unresolved voice, shown as a chip; never applied on its own. */
export interface SpeakerSuggestion {
  email: string | null;
  name: string;
  crmPersonId: Uuid | null;
  source: Exclude<SpeakerSource, 'channel' | 'manual'>;
  confidence: number;
  /** Plain words: "the only outside guest", "Nick said 'thanks, Priya' at 4:12". */
  reason: string;
}

export interface MeetingSpeaker {
  id: Uuid;
  organization_id: Uuid;
  meeting_id: Uuid;
  /** See clusterKeyFor in lib/transcribe/cluster.ts. */
  cluster_key: string;
  track: TranscriptTrack;
  person_email: string | null;
  display_name: string | null;
  crm_person_id: Uuid | null;
  user_id: Uuid | null;
  /** "Guest 1": the number an unresolved voice shows. */
  guest_number: number | null;
  source: SpeakerSource | null;
  confidence: number | null;
  /** A person picked this name; automation never overrides it. */
  locked: boolean;
  suggestions: SpeakerSuggestion[];
  /** Set when this voice was merged into another: that voice's cluster key. */
  merged_into: string | null;
  split_from: string | null;
  split_at_seq: number | null;
  confirmed_by: Uuid | null;
  confirmed_at: IsoDateTime | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface TranscriptSegment {
  id: Uuid;
  organization_id: Uuid;
  meeting_id: Uuid;
  seq: number;
  track: TranscriptTrack;
  cluster_key: string;
  vendor_label: string | null;
  start_ms: number;
  end_ms: number;
  /** What the speech model heard. Untrusted; rendered as text only. */
  text: string;
  /** A person's correction; `text` keeps the original. */
  edited_text: string | null;
  edited_by: Uuid | null;
  edited_at: IsoDateTime | null;
  confidence: number | null;
  is_final: boolean;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface MeetingFolder {
  id: Uuid;
  organization_id: Uuid;
  name: string;
  /** Meetings in it stay private, and routines and MCP leave it out. */
  is_private: boolean;
  slack_channel_id: string | null;
  position: number;
  created_by: Uuid | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface TemplateSection {
  heading: string;
  /** What to put under the heading, in plain words. */
  prompt: string;
}

export interface TemplateAutoRule {
  meetingTypes?: TemplateMeetingType[];
  /** Bare domains of guests that pick this template. */
  domains?: string[];
  /** Words in the title that pick this template. */
  titleIncludes?: string[];
}

/** A custom template. Built-in templates are constants (BUILTIN_TEMPLATES). */
export interface NoteTemplate {
  id: Uuid;
  organization_id: Uuid;
  name: string;
  meeting_type: TemplateMeetingType;
  purpose: string;
  length: TemplateLength;
  sections: TemplateSection[];
  prompt: string;
  auto_rule: TemplateAutoRule | null;
  archived: boolean;
  created_by: Uuid | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface NoteRecipe {
  id: Uuid;
  organization_id: Uuid;
  name: string;
  prompt: string;
  scope: 'meeting' | 'many';
  created_by: Uuid | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface NoteShareLink {
  id: Uuid;
  organization_id: Uuid;
  meeting_id: Uuid;
  /** Hex SHA-256 of the token and NOTES_SHARE_PEPPER. The token is never stored. */
  token_hash: string;
  include_transcript: boolean;
  expires_at: IsoDateTime;
  revoked_at: IsoDateTime | null;
  revoked_by: Uuid | null;
  created_by: Uuid | null;
  view_count: number;
  last_viewed_at: IsoDateTime | null;
  created_at: IsoDateTime;
}

export interface MeetingConsentLogEntry {
  id: Uuid;
  organization_id: Uuid;
  meeting_id: Uuid;
  event: ConsentLogEvent;
  method: ConsentMethod | null;
  notice_text: string | null;
  actor_id: Uuid | null;
  /** Non-sensitive context: a rule's label, a stop reason. */
  detail: Record<string, string | number | boolean | null>;
  created_at: IsoDateTime;
}

export interface VoiceProfile {
  id: Uuid;
  organization_id: Uuid;
  person_email: string;
  display_name: string | null;
  crm_person_id: Uuid | null;
  user_id: Uuid | null;
  /** Voiceprints are made on the recorder's own device (VOICEPRINT_PROVIDER). */
  provider: 'on_device';
  consent_status: VoiceConsentStatus;
  consent_at: IsoDateTime | null;
  consent_evidence: VoiceConsentEvidence | null;
  consent_text_version: string | null;
  consent_recorded_by: Uuid | null;
  enrolled_at: IsoDateTime | null;
  last_used_at: IsoDateTime | null;
  expires_at: IsoDateTime | null;
  revoked_at: IsoDateTime | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/**
 * The encrypted voice identifier. Server only: read by lib/services/voice-profiles.ts
 * alone, never returned by a route, never sent to MCP, Slack or a share link.
 */
export interface VoiceIdentifier {
  id: Uuid;
  organization_id: Uuid;
  voice_profile_id: Uuid;
  /** AES-256-GCM sealed with VOICEPRINT_ENC_KEY, bound to the profile id. */
  identifier_enc: { ciphertext: string; iv: string; authTag: string; keyVersion: number };
  /** The speaker-embedding model that made it; a voiceprint only matches its own model's. */
  model_version: string;
  created_at: IsoDateTime;
  expires_at: IsoDateTime;
}

/**
 * Where a line id the routine cites points. For notes the id is a seq and the
 * entry is the run of lines it stands for (consecutive lines of one speaker
 * are merged before they are sent); for chat the id is "L<n>" and the entry
 * also names the meeting, the moment and the speaker, for "[12:31 Dana]".
 */
export interface NotesLineRef {
  fromSeq: number;
  toSeq: number;
  meetingId?: Uuid;
  startMs?: number;
  speaker?: string;
}

/** One job for Arwin's routine: write a meeting's notes, or answer a question about meetings. */
export interface NotesRequest {
  id: Uuid;
  organization_id: Uuid;
  meeting_id: Uuid;
  kind: NotesRequestKind;
  status: NotesRequestStatus;
  reason: NotesRequestReason | null;
  /** Chat only: the pending Ask message the answer lands on, and its conversation. */
  message_id: Uuid | null;
  thread_id: Uuid | null;
  template_id: string | null;
  /** The meeting's day (YYYY-MM-DD) in the recorder's time zone, for due dates. */
  meeting_day: string | null;
  requested_by: Uuid | null;
  /** When the routine's trigger accepted it; null while Kraken keeps trying. */
  fired_at: IsoDateTime | null;
  fire_attempts: number;
  last_fire_at: IsoDateTime | null;
  /** Line id → the lines it stands for. Ids only: never the words. */
  line_map: Record<string, NotesLineRef>;
  /** NOTES_RESULT_V1 parts received so far, by part number, until all have arrived. */
  parts: Record<string, unknown>;
  payload_chars: number | null;
  /** Lines left out to fit NOTES_FIRE_MAX_CHARS. */
  omitted_lines: number;
  /** Why it failed or expired, in plain words. Never transcript text. */
  error: string | null;
  completed_at: IsoDateTime | null;
  expires_at: IsoDateTime;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface RecordingRule {
  id: Uuid;
  organization_id: Uuid;
  kind: RecordingRuleKind;
  pattern: string;
  /** What the rule protects, e.g. 'legal', 'family'. */
  label: string;
  enabled: boolean;
  created_by: Uuid | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/** The never-record rule a meeting matched. `ruleId` is a row id, or 'default:<key>'. */
export interface NeverRecordMatch {
  ruleId: string;
  label: string;
  /** Plain words: 'the title has "counsel"'. */
  reason: string;
}

/* ====================================== Kraken rows in meeting_notes == */

/** Lines a note point came from: a closed range of transcript seq numbers. */
export interface SegmentRange {
  fromSeq: number;
  toSeq: number;
}

export const ENHANCED_BLOCK_KINDS = ['heading', 'bullet', 'paragraph', 'checkbox'] as const;
export type EnhancedBlockKind = (typeof ENHANCED_BLOCK_KINDS)[number];

/**
 * One block of the enhanced notes. 'typed' blocks are the person's own words,
 * kept verbatim and shown in full ink; 'ai' blocks are written by the model
 * (a lighter tone) and carry the transcript ranges behind them.
 */
export interface EnhancedBlock {
  id: string;
  kind: EnhancedBlockKind;
  text: string;
  /** Nesting under the nearest heading or bullet: 0, 1 or 2. */
  depth: 0 | 1 | 2;
  source: 'typed' | 'ai';
  sources: SegmentRange[];
  /** Checkbox state, for 'checkbox' blocks. */
  checked?: boolean;
}

export interface ActionItem {
  id: string;
  text: string;
  /** From the resolved speaker names, never guessed from the transcript's spelling. */
  ownerEmail: string | null;
  ownerName: string | null;
  ownerClusterKey: string | null;
  /** YYYY-MM-DD, when one was said. */
  due: string | null;
  /** Something the principal (Nick) promised; flagged in the UI. */
  isPrincipalPromise: boolean;
  /** Set once "Add to Tasks" made a task. */
  taskId: Uuid | null;
  sources: SegmentRange[];
}

/**
 * The fields a Kraken row adds to `meeting_notes` (provider 'copilot',
 * external_id = the meeting's id). Optional on MeetingNote so Granola rows,
 * which never carry them, stay valid as they are.
 */
export interface CopilotNoteFields {
  meeting_id?: Uuid | null;
  /** Typed during the meeting, markdown, word for word. */
  user_notes?: string | null;
  enhanced_blocks?: EnhancedBlock[] | null;
  action_items?: ActionItem[];
  template_id?: string | null;
  prompt_version?: string | null;
  model?: string | null;
  generated_at?: IsoDateTime | null;
  edited_at?: IsoDateTime | null;
  /** 'team' for every Granola row; a Kraken row copies its meeting's. */
  visibility?: MeetingVisibility;
  owner_id?: Uuid | null;
  /** The latest request for Arwin's notes (notes_requests), when there is one. */
  notes_request_id?: Uuid | null;
}

/** A meeting_notes row written by Kraken. */
export type CopilotMeetingNote = MeetingNote & {
  provider: 'copilot';
  meeting_id: Uuid;
  enhanced_blocks: EnhancedBlock[] | null;
  action_items: ActionItem[];
};

/* ========================================================== templates == */

export interface BuiltinTemplate {
  /** 'builtin:<key>'. */
  id: string;
  key: string;
  name: string;
  meetingType: TemplateMeetingType;
  purpose: string;
  length: TemplateLength;
  sections: TemplateSection[];
}

/** The built-in VC templates. Custom ones are note_templates rows. */
export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  {
    id: 'builtin:founder_pitch',
    key: 'founder_pitch',
    name: 'Founder pitch',
    meetingType: 'pitch',
    purpose: 'First or second meeting with a founder raising a round.',
    length: 'standard',
    sections: [
      { heading: 'Company', prompt: 'What they build, for whom, and why now.' },
      { heading: 'Traction', prompt: 'Revenue, customers, growth and retention, as stated.' },
      { heading: 'Team', prompt: 'Founders, key hires, and gaps they named.' },
      { heading: 'Round', prompt: 'Amount, instrument, valuation or cap, lead, timing.' },
      { heading: 'Concerns', prompt: 'Risks and open questions raised in the meeting.' },
      { heading: 'Next steps', prompt: 'What each side said they would do, with dates.' },
    ],
  },
  {
    id: 'builtin:lp_call',
    key: 'lp_call',
    name: 'LP call',
    meetingType: 'lp',
    purpose: 'A call with a current or prospective limited partner.',
    length: 'standard',
    sections: [
      { heading: 'Who', prompt: 'The LP, their firm, and their role.' },
      { heading: 'Interest', prompt: 'What they want to know and how interested they sounded.' },
      { heading: 'Questions asked', prompt: 'Their questions and our answers.' },
      { heading: 'Commitments', prompt: 'Any amount, timing or condition they mentioned.' },
      { heading: 'Next steps', prompt: 'What each side said they would do, with dates.' },
    ],
  },
  {
    id: 'builtin:portfolio_checkin',
    key: 'portfolio_checkin',
    name: 'Portfolio check-in / board',
    meetingType: 'portfolio',
    purpose: 'A check-in or board meeting with a portfolio company.',
    length: 'standard',
    sections: [
      { heading: 'Headline', prompt: 'The one thing to remember from this meeting.' },
      { heading: 'Metrics', prompt: 'Numbers shared: revenue, burn, runway, hiring.' },
      { heading: 'Wins', prompt: 'What went well since the last check-in.' },
      { heading: 'Asks', prompt: 'Where the company asked for help.' },
      { heading: 'Risks', prompt: 'Concerns raised by either side.' },
      { heading: 'Next steps', prompt: 'What each side said they would do, with dates.' },
    ],
  },
  {
    id: 'builtin:intro_call',
    key: 'intro_call',
    name: 'Intro call',
    meetingType: 'intro',
    purpose: 'A first conversation someone introduced.',
    length: 'brief',
    sections: [
      { heading: 'Who they are', prompt: 'Name, company, role and background.' },
      { heading: 'Why we met', prompt: 'The reason for the intro and what they want.' },
      { heading: 'Takeaways', prompt: 'What was learned.' },
      { heading: 'Next steps', prompt: 'What each side said they would do, with dates.' },
    ],
  },
  {
    id: 'builtin:internal_1on1',
    key: 'internal_1on1',
    name: 'Internal 1:1',
    meetingType: 'internal',
    purpose: 'A one-to-one inside the team.',
    length: 'brief',
    sections: [
      { heading: 'Updates', prompt: 'What each person reported.' },
      { heading: 'Decisions', prompt: 'What was decided.' },
      { heading: 'Action items', prompt: 'Who does what, by when.' },
    ],
  },
];

/** Every template id the server accepts: a built-in id, or a uuid (a custom row). */
export function isBuiltinTemplateId(id: string): boolean {
  return BUILTIN_TEMPLATES.some((t) => t.id === id);
}

/* ======================================================= speech-to-text == */

/** Where a voiceprint is made: on the recorder's own device, by the speech worker. */
export const VOICEPRINT_PROVIDER = 'on_device' as const;

/**
 * A consented, enrolled voice the speech worker should recognise (D-076).
 * Lines matched to it carry the cluster key 'sys:<label>' (or 'mix:<label>'),
 * which the naming ladder reads as a voiceprint match. Never a name.
 */
export interface KnownVoice {
  /** The voice profile's id. */
  label: Uuid;
  /** Base64 of the Float32 speaker embedding (lib/transcribe/voiceprint.ts). */
  voiceprint: string;
  /** The embedding model that made it; the worker skips one from another model. */
  modelVersion: string;
}

/**
 * What POST /speech-setup returns per track: the settings the recorder's
 * speech engine runs with (D-076). Nothing here is a credential and nothing
 * is paid for: the browser transcribes with Whisper in a Web Worker and only
 * finished lines of text come back to Kraken. Provider 'mock' (demo mode)
 * runs no model at all: the recorder plays lib/transcribe/mock-script.ts.
 */
export interface SpeechSession {
  track: TranscriptTrack;
  provider: TranscriberProvider;
  /** BCP 47, 'en' by default. English picks the English-only Whisper models. */
  language: string;
  /** Names and terms worth spelling right (the invite, the CRM); applied to finished text. */
  vocabulary: string[];
  /** Consented, enrolled voices to recognise. Always empty on the mic: every mic word is the recorder's. */
  knownVoices: KnownVoice[];
  /** Mock only: which scripted call to play (`{ script, track }`). Empty otherwise. */
  sessionConfig: Record<string, unknown>;
  /** Audio the engine takes: always 16 kHz mono PCM16, little-endian. */
  audio: { sampleRate: 16000; encoding: 'pcm_s16le'; channels: 1 };
}

/**
 * One line from the speech engine, normalised. The recorder turns each
 * finished event into a SegmentUpload; partial events only update the live view.
 */
export interface TranscriptEvent {
  type: 'partial' | 'final';
  track: TranscriptTrack;
  /**
   * Who spoke: the on-device clustering's label ('A', 'B'…), an enrolled
   * profile's id when the voice matched a voiceprint, or null on the mic.
   */
  speakerLabel: string | null;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
}

/* ========================================================== API: views == */

/** A meeting as the API returns it. */
export interface MeetingView {
  id: Uuid;
  /** 'copilot:<uuid>': the id routines and MCP use. */
  qualifiedId: string;
  title: string;
  kind: MeetingKind;
  platform: MeetingPlatform | null;
  captureSource: CaptureSource;
  status: MeetingStatus;
  providerEventId: string | null;
  recurringEventId: string | null;
  calendarId: string | null;
  scheduledStart: IsoDateTime | null;
  scheduledEnd: IsoDateTime | null;
  startedAt: IsoDateTime | null;
  endedAt: IsoDateTime | null;
  recordedMs: number;
  visibility: MeetingVisibility;
  folderId: Uuid | null;
  templateId: string | null;
  recordedBy: Uuid | null;
  /** The signed-in person recorded it (and so may record, upload and read its speech setup). */
  isRecorder: boolean;
  consent: ConsentView;
  lastSeq: number | null;
  injectionFlagged: boolean;
  deletedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ConsentView {
  state: ConsentState;
  method: ConsentMethod | null;
  at: IsoDateTime | null;
  /** Set when a never-record rule matches; Start is replaced by NEVER_RECORD_MESSAGE. */
  neverRecord: NeverRecordMatch | null;
}

export interface ParticipantView {
  email: string | null;
  name: string | null;
  role: ParticipantRole;
  source: ParticipantSource;
  crmPersonId: Uuid | null;
  isExternal: boolean;
}

/** How sure a name is, in the People tab's words. */
export type SpeakerCertainty =
  'channel' | 'confirmed' | 'voice' | 'roster' | 'calendar' | 'suggested' | 'unknown';

export interface SpeakerView {
  clusterKey: string;
  track: TranscriptTrack;
  /** The resolved name, or "Guest N" while unresolved. Never an engine label. */
  displayName: string;
  personEmail: string | null;
  crmPersonId: Uuid | null;
  /** True once a name is attached (by any rung); false shows the dashed "Who is this?" chip. */
  resolved: boolean;
  /** The mic voice of the recorder: gold, on the right. */
  isOwner: boolean;
  source: SpeakerSource | null;
  certainty: SpeakerCertainty;
  confidence: number | null;
  locked: boolean;
  suggestions: SpeakerSuggestion[];
  /** Merged voices still appear here, pointing at the voice they joined. */
  mergedInto: string | null;
  lineCount: number;
  /** "Remember this voice" shows only when this person's consent is on file. */
  canRememberVoice: boolean;
}

/** A transcript line. The speaker's name comes from SpeakerView by clusterKey. */
export interface SegmentView {
  seq: number;
  track: TranscriptTrack;
  clusterKey: string;
  startMs: number;
  endMs: number;
  /** The edited text when there is one, else what the speech model heard. */
  text: string;
  edited: boolean;
  /** The speech model's text, when the line was edited. */
  originalText: string | null;
  isFinal: boolean;
  confidence: number | null;
}

export interface CopilotNoteView {
  noteId: Uuid;
  meetingId: Uuid;
  userNotes: string | null;
  blocks: EnhancedBlock[];
  actionItems: ActionItem[];
  templateId: string | null;
  promptVersion: string | null;
  model: string | null;
  generatedAt: IsoDateTime | null;
  editedAt: IsoDateTime | null;
  /** The notes are older than a rename or a split/merge: regenerating would change them. */
  stale: boolean;
  /**
   * Arwin's notes, as asked for after Stop, Regenerate or a template change.
   * While it is 'pending' the notes shown are the Quick notes (model 'none')
   * or the previous ones; they are replaced when the result arrives.
   */
  request: NotesRequestView | null;
}

export interface NotesRequestView {
  id: Uuid;
  status: NotesRequestStatus;
  reason: NotesRequestReason | null;
  templateId: string | null;
  requestedAt: IsoDateTime;
  /** The routine was started. False while Kraken keeps trying, or when it is not connected. */
  fired: boolean;
  /** The routine's trigger and the relay are both set up, so the notes can arrive. */
  connected: boolean;
  completedAt: IsoDateTime | null;
  /** Why it failed or expired, in plain words. */
  error: string | null;
  /** Lines left out of a very long meeting to fit what the routine is sent. */
  omittedLines: number;
}

export interface ShareLinkView {
  id: Uuid;
  includeTranscript: boolean;
  expiresAt: IsoDateTime;
  revokedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  viewCount: number;
  lastViewedAt: IsoDateTime | null;
  /** Not revoked and not expired. */
  active: boolean;
}

export interface TemplateView {
  /** 'builtin:<key>' or a uuid. */
  id: string;
  name: string;
  meetingType: TemplateMeetingType;
  purpose: string;
  length: TemplateLength;
  sections: TemplateSection[];
  isBuiltin: boolean;
}

export interface FolderView {
  id: Uuid;
  name: string;
  isPrivate: boolean;
  meetingCount: number;
}

export interface RecipeView {
  id: Uuid;
  name: string;
  prompt: string;
  scope: 'meeting' | 'many';
}

export interface VoiceProfileView {
  email: string;
  name: string | null;
  consentStatus: VoiceConsentStatus;
  consentAt: IsoDateTime | null;
  /** An identifier is on file. The identifier itself is never returned. */
  enrolled: boolean;
  expiresAt: IsoDateTime | null;
}

/** One row of the Notes tab: a Kraken meeting or a Granola note. */
export interface MeetingListItem {
  source: 'copilot' | 'granola';
  /** 'copilot:<meeting uuid>' or 'granola:<meeting_notes id>'. */
  qualifiedId: string;
  /** The meeting id for Kraken rows; null for Granola rows. */
  meetingId: Uuid | null;
  /** The meeting_notes row, when there is one. */
  noteId: Uuid | null;
  title: string;
  occurredAt: IsoDateTime;
  status: MeetingStatus | null;
  attendees: { name: string | null; email: string }[];
  hasActionItems: boolean;
  folderId: Uuid | null;
  visibility: MeetingVisibility;
  recordedMs: number | null;
  /** The other tool's row for the same conversation, collapsed under this one. */
  pairedWith: string | null;
}

/** A search hit with the place it was found. Transcript hits deep-link to `startMs`. */
export interface NotesSearchHit {
  qualifiedId: string;
  meetingId: Uuid | null;
  source: 'copilot' | 'granola';
  title: string;
  occurredAt: IsoDateTime;
  field: 'title' | 'notes' | 'transcript';
  /** Plain text around the match. */
  snippet: string;
  seq: number | null;
  startMs: number | null;
}

/** A line an answer cites: "[12:31 Dana Reyes]" links to the meeting at that moment. */
export interface ChatCitation {
  meetingId: Uuid;
  seq: number;
  startMs: number;
  speaker: string;
  label: string;
}

/**
 * What /n/[token] renders: the summary, and the transcript only when the link
 * includes it. No email address, no voice data, no internal ids beyond the
 * meeting's title and date.
 */
export interface SharedNoteView {
  title: string;
  occurredAt: IsoDateTime;
  blocks: { kind: EnhancedBlockKind; text: string; depth: 0 | 1 | 2; source: 'typed' | 'ai' }[];
  actionItems: { text: string; ownerName: string | null; due: string | null }[];
  transcript: { startMs: number; speaker: string; text: string }[] | null;
  expiresAt: IsoDateTime;
}

/* ===================================================== API: requests == */
//
// Every route answers { ok: true, ...body } or { ok: false, error: AppError }
// (lib/util/result.ts). Request bodies are validated by the zod schemas in
// lib/notes/schemas.ts, which are typed against these interfaces.

export interface NotesApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    stillUsable?: string;
    details?: Record<string, string | number | boolean | null>;
    retryable?: boolean;
  };
}

/** GET /api/notes/beta */
export interface NotesAccessResponse {
  ok: true;
  /** NOTES_ENABLED: 'off' hides the feature, 'beta' follows each person's switch, 'on' shows it to everyone. */
  mode: 'off' | 'beta' | 'on';
  /** This person's "Kraken Notes (beta)" switch. */
  beta: boolean;
  /** What the app does for this person: the feature shows and its routes answer. */
  enabled: boolean;
}

/** POST /api/notes/beta */
export interface SetNotesBetaRequest {
  enabled: boolean;
}

export interface AttendeeInput {
  email: string | null;
  name: string | null;
}

/** POST /api/notes/meetings: from a calendar event, or ad hoc ("+ New note"). */
export interface CreateMeetingRequest {
  source: 'calendar' | 'adhoc';
  providerEventId?: string | null;
  recurringEventId?: string | null;
  calendarId?: string | null;
  title: string;
  kind?: MeetingKind;
  platform?: MeetingPlatform | null;
  scheduledStart?: IsoDateTime | null;
  scheduledEnd?: IsoDateTime | null;
  attendees?: AttendeeInput[];
  templateId?: string | null;
}

export interface CreateMeetingResponse {
  ok: true;
  meeting: MeetingView;
  /** False when "Take notes" found the meeting already made for this event. */
  created: boolean;
}

/** GET /api/notes/meetings?q=&person=&company=&folder=&source=&eventId=&cursor= */
export interface ListMeetingsQuery {
  q?: string;
  /** An email address. */
  person?: string;
  /** A bare domain. */
  company?: string;
  folder?: Uuid;
  source?: 'copilot' | 'granola' | 'all';
  hasActionItems?: boolean;
  /** A Google event id: the Kraken meeting made for that event ("Notes ready" on its card). */
  eventId?: string;
  cursor?: string;
}

export interface ListMeetingsResponse {
  ok: true;
  meetings: MeetingListItem[];
  /** Where `q` matched, when it was given. */
  hits: NotesSearchHit[];
  nextCursor: string | null;
}

/** GET /api/notes/meetings/[id] */
export interface MeetingDetailResponse {
  ok: true;
  meeting: MeetingView;
  participants: ParticipantView[];
  speakers: SpeakerView[];
  /** The first page of lines; GET /segments?after= for the rest. */
  segments: SegmentView[];
  note: CopilotNoteView | null;
  shareLinks: ShareLinkView[];
  template: TemplateView | null;
}

/** PATCH /api/notes/meetings/[id] */
export interface UpdateMeetingRequest {
  title?: string;
  visibility?: MeetingVisibility;
  folderId?: Uuid | null;
  templateId?: string | null;
  /** The notepad, saved as typed. */
  userNotes?: string;
  kind?: MeetingKind;
  platform?: MeetingPlatform | null;
  sharedWith?: Uuid[];
}

export interface MeetingResponse {
  ok: true;
  meeting: MeetingView;
}

/**
 * POST /api/notes/meetings/[id]/start. Refused with code 'forbidden' and
 * details.never_record = rule label when a never-record rule matches, and
 * with 'invalid_input' unless consent.confirmed is true.
 */
export interface StartRecordingRequest {
  consent: { confirmed: true; method: ConsentMethod; noticeText?: string | null };
  captureSource: CaptureSource;
  kind?: MeetingKind;
}

/** POST /api/notes/meetings/[id]/pause */
export interface PauseRecordingRequest {
  paused: boolean;
}

/** POST /api/notes/meetings/[id]/stop */
export interface StopRecordingRequest {
  reason?: StopReason;
  /** Recorded time as the recorder counted it, pauses excluded. */
  recordedMs?: number;
}

export interface StopRecordingResponse {
  ok: true;
  meeting: MeetingView;
  /** The notes job: naming pass, then notes, then action items. */
  finalize: { queued: boolean };
}

/** POST /api/notes/meetings/[id]/speech-setup: one session per track asked for. */
export interface SpeechSetupRequest {
  tracks: TranscriptTrack[];
}

export interface SpeechSetupResponse {
  ok: true;
  provider: TranscriberProvider;
  sessions: SpeechSession[];
}

/** One finished line, as the recorder posts it. */
export interface SegmentUpload {
  seq: number;
  track: TranscriptTrack;
  /** clusterKeyFor(track, speakerLabel) from lib/transcribe/cluster.ts. */
  clusterKey: string;
  vendorLabel?: string | null;
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number | null;
  isFinal?: boolean;
}

/** POST /api/notes/meetings/[id]/segments: upsert on (meeting, seq); at most 200 lines. */
export interface UploadSegmentsRequest {
  segments: SegmentUpload[];
}

export interface UploadSegmentsResponse {
  ok: true;
  /** Lines stored now. */
  accepted: number;
  /** Lines already stored under the same seq (a retried batch). */
  duplicates: number;
  /** Mic lines dropped as echo of the meeting audio. */
  dropped: number;
  lastSeq: number | null;
  /** Every voice, so the recorder can label a new one at once. */
  speakers: SpeakerView[];
}

/** GET /api/notes/meetings/[id]/segments?after=<seq>&limit= : for polling viewers. */
export interface ListSegmentsResponse {
  ok: true;
  segments: SegmentView[];
  speakers: SpeakerView[];
  lastSeq: number | null;
  status: MeetingStatus;
}

/** PATCH /api/notes/meetings/[id]/segments/[seq]: fix a number or a name in place. */
export interface EditSegmentRequest {
  text: string;
}

export interface EditSegmentResponse {
  ok: true;
  segment: SegmentView;
}

/** A person picked in "This is…": calendar guest, CRM person, or typed. */
export interface SpeakerPersonInput {
  email?: string | null;
  name: string;
  crmPersonId?: Uuid | null;
}

/**
 * PATCH /api/notes/meetings/[id]/speakers/[clusterKey] (encodeURIComponent the key).
 * `person: null` clears the name back to "Guest N".
 */
export interface RelabelSpeakerRequest {
  person?: SpeakerPersonInput | null;
  locked?: boolean;
  /** Only honoured when that person's voice consent is on file. */
  rememberVoice?: boolean;
}

export interface RelabelSpeakerResponse {
  ok: true;
  speaker: SpeakerView;
  speakers: SpeakerView[];
  /** "Updated 37 lines". */
  updatedLines: number;
  /** The notes will regenerate with the new name. */
  notesRefreshing: boolean;
  /** Present when `rememberVoice` was asked: what happens next (RememberVoiceOutcome). */
  rememberVoice?: RememberVoiceOutcome;
}

/**
 * "Remember this voice" (D-076). 'requested': the meeting is live and the
 * person's consent is on file, so the recorder asks its speech worker for the
 * voiceprint of `vendorLabel` (the voice's cluster label) and posts it to
 * /voice-profiles/enroll. Everyone else's voice stays in the worker.
 * 'no_consent': nobody may be remembered without consent on file.
 * 'not_live': the worker holds a voice only while the recording runs.
 * 'not_supported': the mic (always the recorder) or a split voice.
 */
export interface RememberVoiceOutcome {
  status: 'requested' | 'no_consent' | 'not_live' | 'not_supported';
  vendorLabel: string | null;
  email: string | null;
}

/** POST /api/notes/meetings/[id]/speakers/split */
export interface SplitSpeakerRequest {
  clusterKey: string;
  fromSeq: number;
  /** 'line': only that line is someone else. 'from_here': that line and every later one of this voice. */
  mode: 'line' | 'from_here';
  person?: SpeakerPersonInput | null;
}

export interface SplitSpeakerResponse {
  ok: true;
  newClusterKey: string;
  movedLines: number;
  speakers: SpeakerView[];
  notesRefreshing: boolean;
}

/** POST /api/notes/meetings/[id]/speakers/merge: `from` is the same person as `into`. */
export interface MergeSpeakersRequest {
  from: string;
  into: string;
}

export interface MergeSpeakersResponse {
  ok: true;
  movedLines: number;
  speakers: SpeakerView[];
  notesRefreshing: boolean;
}

/** POST /api/notes/meetings/[id]/generate */
export interface GenerateNotesRequest {
  templateId?: string | null;
}

export interface GenerateNotesResponse {
  ok: true;
  note: CopilotNoteView;
}

/** POST /api/notes/meetings/[id]/chat */
export interface NotesChatRequest {
  scope: ChatScope;
  question: string;
  /** For scope 'person'. */
  personEmail?: string | null;
  /** For scope 'company': a bare domain. */
  companyDomain?: string | null;
  /** Continue this Ask conversation (a follow-up question). */
  threadId?: Uuid | null;
}

/**
 * POST /api/notes/meetings/[id]/chat, and GET ?messageId= while it is
 * pending. With the Ask bridge set up the question goes to Arwin's routine
 * as an Ask question ('pending': poll with the messageId); without it, the
 * matching lines are quoted at once ('answered').
 */
export interface NotesChatResponse {
  ok: true;
  status: 'answered' | 'pending';
  /** Empty while pending. Citations read "[12:31 Dana Reyes]". */
  answer: string;
  citations: ChatCitation[];
  /** The Ask conversation it went into (the bridge path): follow-ups continue it, and Ask lists it. */
  threadId: Uuid | null;
  messageId: Uuid | null;
}

/** POST /api/notes/meetings/[id]/share */
export interface CreateShareLinkRequest {
  includeTranscript?: boolean;
  expiresInDays?: ShareExpiryDays;
}

export interface CreateShareLinkResponse {
  ok: true;
  link: ShareLinkView;
  /** The full /n/<token> address. Shown once: only the token's hash is kept. */
  url: string;
}

/** GET /api/notes/meetings/[id]/share */
export interface ListShareLinksResponse {
  ok: true;
  links: ShareLinkView[];
}

/** POST /api/notes/meetings/[id]/action-items: "Add to Tasks" (add-only, via the tasks service). */
export interface AddActionItemTaskRequest {
  itemId: string;
}

export interface AddActionItemTaskResponse {
  ok: true;
  taskId: Uuid;
  /** False when the item already had a task. */
  created: boolean;
}

/** POST /api/notes/meetings/[id]/consent: log that the notice was copied. */
export interface LogConsentRequest {
  event: 'notice_copied';
}

/** GET /api/notes/templates */
export interface ListTemplatesResponse {
  ok: true;
  templates: TemplateView[];
}

/** POST /api/notes/templates */
export interface CreateTemplateRequest {
  name: string;
  meetingType?: TemplateMeetingType;
  purpose?: string;
  length?: TemplateLength;
  sections: TemplateSection[];
  prompt?: string;
  autoRule?: TemplateAutoRule | null;
}

export interface TemplateResponse {
  ok: true;
  template: TemplateView;
}

/** GET /api/notes/folders */
export interface ListFoldersResponse {
  ok: true;
  folders: FolderView[];
}

/** POST /api/notes/folders */
export interface CreateFolderRequest {
  name: string;
  isPrivate?: boolean;
}

/** GET /api/notes/recipes */
export interface ListRecipesResponse {
  ok: true;
  recipes: RecipeView[];
}

/** POST /api/notes/recipes */
export interface CreateRecipeRequest {
  name: string;
  prompt: string;
  scope?: 'meeting' | 'many';
}

/** GET /api/notes/voice-profiles */
export interface ListVoiceProfilesResponse {
  ok: true;
  profiles: VoiceProfileView[];
  /** The wording consent is given to, and its version. */
  consentText: string;
  consentTextVersion: string;
}

/**
 * POST /api/notes/voice-profiles. 'grant' records consent (enrolment then
 * needs a solo clip); 'revoke' withdraws it and deletes the identifier at once.
 */
export interface VoiceConsentRequest {
  action: 'grant' | 'revoke';
  email: string;
  name?: string | null;
  evidence?: VoiceConsentEvidence;
}

export interface VoiceConsentResponse {
  ok: true;
  profile: VoiceProfileView;
}

/* ============================================ API: part 2 additions == */
//
// Added after the day-0 contract (D-076), all additive: new routes, and
// optional fields on existing answers.

/** POST /api/notes/voice-profiles/enroll-session: a speech session for one consented person's solo clip. */
export interface VoiceEnrollSessionRequest {
  email: string;
}

export interface VoiceEnrollSessionResponse {
  ok: true;
  provider: TranscriberProvider;
  /** Run the clip through the speech worker like a mic-only track, then ask it for the voiceprint. */
  session: SpeechSession;
}

/**
 * POST /api/notes/voice-profiles/enroll: one consented person's voiceprint,
 * from an enrolment clip or "Remember this voice". Refused without consent
 * on file; sealed before storing; replaces what was on file.
 */
export interface VoiceEnrollRequest {
  email: string;
  /**
   * Voiceprints of that one voice: base64 Float32 speaker embeddings made in
   * the recorder's browser (lib/transcribe/voiceprint.ts). Never anyone else's.
   */
  identifiers: string[];
  /** The embedding model that made them; they stop matching when it changes. */
  modelVersion: string;
}

/** GET / POST /api/notes/preferences: this person's Kraken Notes settings. */
export interface NotesPreferences {
  /** Who sees a meeting this person records, unless they change it: 'private' or the whole 'team'. */
  defaultVisibility: MeetingVisibility;
}

export interface NotesPreferencesResponse {
  ok: true;
  preferences: NotesPreferences;
}

export type SetNotesPreferencesRequest = Partial<NotesPreferences>;

/** A never-record rule as Settings lists it: the firm's own rows, then the built-in defaults. */
export interface RecordingRuleView {
  /** A row id, or 'default:<key>' for a built-in rule. */
  id: string;
  kind: RecordingRuleKind;
  pattern: string;
  label: string;
  enabled: boolean;
  /** Built in (legal and family words): shown, never edited or removed. */
  isDefault: boolean;
}

/** GET /api/notes/recording-rules */
export interface ListRecordingRulesResponse {
  ok: true;
  rules: RecordingRuleView[];
}

/** POST /api/notes/recording-rules */
export interface CreateRecordingRuleRequest {
  kind: RecordingRuleKind;
  pattern: string;
  label: string;
  enabled?: boolean;
}

/** PATCH /api/notes/recording-rules/[id]; DELETE removes the row (admins). */
export interface UpdateRecordingRuleRequest {
  pattern?: string;
  label?: string;
  enabled?: boolean;
}

export interface RecordingRuleResponse {
  ok: true;
  rule: RecordingRuleView;
}

/** PATCH /api/notes/templates/[id] (custom templates only); DELETE archives it. */
export type UpdateTemplateRequest = Partial<CreateTemplateRequest>;

/**
 * GET /api/notes/by-event?eventId=&recurringEventId=&emails=a,b : what the
 * calendar's event card shows. `meeting` is this person's meeting for the
 * event (null before "Take notes"); `series` the earlier meetings of a
 * recurring event; `pastNotes` earlier notes with these guests, Kraken and
 * Granola, newest first, only what this person may see.
 */
export interface EventNotesResponse {
  ok: true;
  meeting: MeetingView | null;
  series: MeetingListItem[];
  pastNotes: MeetingListItem[];
}

/** One speaking turn from the meeting app's own roster (the Meet extension). */
export interface RosterTurnInput {
  name: string;
  email?: string | null;
  startMs: number;
  endMs: number;
}

/** POST /api/notes/meetings/[id]/roster: lines voices up with who the meeting app showed speaking. */
export interface ApplyRosterRequest {
  turns: RosterTurnInput[];
}

export interface ApplyRosterResponse {
  ok: true;
  speakers: SpeakerView[];
  /** Voices that got a name from the roster. */
  named: number;
}
