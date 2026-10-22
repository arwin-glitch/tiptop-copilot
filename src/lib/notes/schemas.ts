import { z } from 'zod';
import {
  CAPTURE_SOURCES,
  CHAT_SCOPES,
  CONSENT_METHODS,
  MEETING_KINDS,
  MEETING_PLATFORMS,
  MEETING_VISIBILITIES,
  NOTES_LIMITS,
  RECORDING_RULE_KINDS,
  SHARE_EXPIRY_DAYS,
  STOP_REASONS,
  TEMPLATE_LENGTHS,
  TEMPLATE_MEETING_TYPES,
  TRANSCRIPT_TRACKS,
  VOICE_CONSENT_EVIDENCE,
  type AddActionItemTaskRequest,
  type CreateFolderRequest,
  type CreateMeetingRequest,
  type CreateRecordingRuleRequest,
  type CreateRecipeRequest,
  type CreateShareLinkRequest,
  type CreateTemplateRequest,
  type EditSegmentRequest,
  type GenerateNotesRequest,
  type LogConsentRequest,
  type MergeSpeakersRequest,
  type NotesChatRequest,
  type PauseRecordingRequest,
  type RelabelSpeakerRequest,
  type SetNotesBetaRequest,
  type SplitSpeakerRequest,
  type StartRecordingRequest,
  type StopRecordingRequest,
  type SttTokenRequest,
  type UpdateMeetingRequest,
  type UpdateRecordingRuleRequest,
  type UploadSegmentsRequest,
  type VoiceConsentRequest,
} from '@/lib/types/notes';
import { CLUSTER_KEY_RE } from '@/lib/transcribe/cluster';

/**
 * Request bodies of the /api/notes routes (D-076), validated on the server
 * and usable on the client. Each schema is checked against its interface in
 * lib/types/notes.ts (`satisfies`), so the two cannot drift apart.
 *
 * Every string has a ceiling; nothing unbounded reaches the store.
 */

const enumOf = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values);

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime({ offset: true });
const email = z.string().trim().toLowerCase().max(320).pipe(z.string().email());
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^([a-z0-9-]+\.)+[a-z]{2,}$/);
/** 'builtin:<key>' or a custom template's uuid. */
const templateId = z
  .string()
  .max(64)
  .regex(/^(builtin:[a-z0-9_]{1,40}|[0-9a-f-]{36})$/i);
const clusterKey = z.string().max(80).regex(CLUSTER_KEY_RE);
const seq = z.number().int().min(0).max(10_000_000);
const ms = z
  .number()
  .int()
  .min(0)
  .max(24 * 60 * 60 * 1000);
const name = z.string().trim().min(1).max(300);

export const SET_NOTES_BETA = z
  .object({ enabled: z.boolean() })
  .strict() satisfies z.ZodType<SetNotesBetaRequest>;

const ATTENDEE = z.object({
  email: email.nullable(),
  name: z.string().trim().max(300).nullable(),
});

export const CREATE_MEETING = z
  .object({
    source: z.enum(['calendar', 'adhoc']),
    providerEventId: z.string().min(1).max(1024).nullable().optional(),
    recurringEventId: z.string().min(1).max(1024).nullable().optional(),
    calendarId: z.string().min(1).max(320).nullable().optional(),
    title: z.string().trim().min(1).max(500),
    kind: enumOf(MEETING_KINDS).optional(),
    platform: enumOf(MEETING_PLATFORMS).nullable().optional(),
    scheduledStart: isoDateTime.nullable().optional(),
    scheduledEnd: isoDateTime.nullable().optional(),
    attendees: z.array(ATTENDEE).max(200).optional(),
    templateId: templateId.nullable().optional(),
  })
  .strict()
  .refine((v) => v.source !== 'calendar' || Boolean(v.providerEventId), {
    message: 'A meeting from the calendar needs its event id.',
    path: ['providerEventId'],
  }) satisfies z.ZodType<CreateMeetingRequest>;

export const UPDATE_MEETING = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    visibility: enumOf(MEETING_VISIBILITIES).optional(),
    folderId: uuid.nullable().optional(),
    templateId: templateId.nullable().optional(),
    userNotes: z.string().max(NOTES_LIMITS.maxUserNotesChars).optional(),
    kind: enumOf(MEETING_KINDS).optional(),
    platform: enumOf(MEETING_PLATFORMS).nullable().optional(),
    sharedWith: z.array(uuid).max(50).optional(),
  })
  .strict() satisfies z.ZodType<UpdateMeetingRequest>;

export const START_RECORDING = z
  .object({
    consent: z
      .object({
        confirmed: z.literal(true),
        method: enumOf(CONSENT_METHODS),
        noticeText: z.string().max(2000).nullable().optional(),
      })
      .strict(),
    captureSource: enumOf(CAPTURE_SOURCES),
    kind: enumOf(MEETING_KINDS).optional(),
  })
  .strict() satisfies z.ZodType<StartRecordingRequest>;

export const PAUSE_RECORDING = z
  .object({ paused: z.boolean() })
  .strict() satisfies z.ZodType<PauseRecordingRequest>;

export const STOP_RECORDING = z
  .object({
    reason: enumOf(STOP_REASONS).optional(),
    recordedMs: ms.optional(),
  })
  .strict() satisfies z.ZodType<StopRecordingRequest>;

export const STT_TOKEN = z
  .object({
    tracks: z
      .array(enumOf(TRANSCRIPT_TRACKS))
      .min(1)
      .max(2)
      .refine((t) => new Set(t).size === t.length, 'Each track once.'),
  })
  .strict() satisfies z.ZodType<SttTokenRequest>;

const SEGMENT = z
  .object({
    seq,
    track: enumOf(TRANSCRIPT_TRACKS),
    clusterKey,
    vendorLabel: z.string().max(80).nullable().optional(),
    startMs: ms,
    endMs: ms,
    text: z.string().trim().min(1).max(NOTES_LIMITS.maxSegmentChars),
    confidence: z.number().min(0).max(1).nullable().optional(),
    isFinal: z.boolean().optional(),
  })
  .strict()
  .refine((s) => s.endMs >= s.startMs, {
    message: 'A line ends after it starts.',
    path: ['endMs'],
  });

export const UPLOAD_SEGMENTS = z
  .object({
    segments: z.array(SEGMENT).min(1).max(NOTES_LIMITS.maxSegmentsPerRequest),
  })
  .strict() satisfies z.ZodType<UploadSegmentsRequest>;

export const EDIT_SEGMENT = z
  .object({ text: z.string().trim().min(1).max(NOTES_LIMITS.maxSegmentChars) })
  .strict() satisfies z.ZodType<EditSegmentRequest>;

const PERSON = z
  .object({
    email: email.nullable().optional(),
    name,
    crmPersonId: uuid.nullable().optional(),
  })
  .strict();

export const RELABEL_SPEAKER = z
  .object({
    person: PERSON.nullable().optional(),
    locked: z.boolean().optional(),
    rememberVoice: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => v.person !== undefined || v.locked !== undefined || v.rememberVoice !== undefined,
    {
      message: 'Nothing to change.',
    },
  ) satisfies z.ZodType<RelabelSpeakerRequest>;

export const SPLIT_SPEAKER = z
  .object({
    clusterKey,
    fromSeq: seq,
    mode: z.enum(['line', 'from_here']),
    person: PERSON.nullable().optional(),
  })
  .strict() satisfies z.ZodType<SplitSpeakerRequest>;

export const MERGE_SPEAKERS = z
  .object({ from: clusterKey, into: clusterKey })
  .strict()
  .refine((v) => v.from !== v.into, {
    message: 'Pick two different voices.',
  }) satisfies z.ZodType<MergeSpeakersRequest>;

export const GENERATE_NOTES = z
  .object({ templateId: templateId.nullable().optional() })
  .strict() satisfies z.ZodType<GenerateNotesRequest>;

export const NOTES_CHAT = z
  .object({
    scope: enumOf(CHAT_SCOPES),
    question: z.string().trim().min(1).max(NOTES_LIMITS.maxChatQuestionChars),
    personEmail: email.nullable().optional(),
    companyDomain: domain.nullable().optional(),
  })
  .strict()
  .refine((v) => v.scope !== 'person' || Boolean(v.personEmail), {
    message: 'Pick a person.',
    path: ['personEmail'],
  })
  .refine((v) => v.scope !== 'company' || Boolean(v.companyDomain), {
    message: 'Pick a company.',
    path: ['companyDomain'],
  }) satisfies z.ZodType<NotesChatRequest>;

export const CREATE_SHARE_LINK = z
  .object({
    includeTranscript: z.boolean().optional(),
    expiresInDays: z
      .number()
      .int()
      .refine((d): d is (typeof SHARE_EXPIRY_DAYS)[number] =>
        (SHARE_EXPIRY_DAYS as readonly number[]).includes(d),
      )
      .optional(),
  })
  .strict() satisfies z.ZodType<CreateShareLinkRequest>;

export const ADD_ACTION_ITEM_TASK = z
  .object({ itemId: z.string().min(1).max(64) })
  .strict() satisfies z.ZodType<AddActionItemTaskRequest>;

export const LOG_CONSENT = z
  .object({ event: z.literal('notice_copied') })
  .strict() satisfies z.ZodType<LogConsentRequest>;

const SECTION = z
  .object({
    heading: z.string().trim().min(1).max(120),
    prompt: z.string().trim().max(1000),
  })
  .strict();

export const CREATE_TEMPLATE = z
  .object({
    name: z.string().trim().min(1).max(120),
    meetingType: enumOf(TEMPLATE_MEETING_TYPES).optional(),
    purpose: z.string().trim().max(2000).optional(),
    length: enumOf(TEMPLATE_LENGTHS).optional(),
    sections: z.array(SECTION).min(1).max(20),
    prompt: z.string().trim().max(8000).optional(),
    autoRule: z
      .object({
        meetingTypes: z.array(enumOf(TEMPLATE_MEETING_TYPES)).max(6).optional(),
        domains: z.array(domain).max(50).optional(),
        titleIncludes: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict() satisfies z.ZodType<CreateTemplateRequest>;

export const CREATE_FOLDER = z
  .object({
    name: z.string().trim().min(1).max(120),
    isPrivate: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<CreateFolderRequest>;

export const CREATE_RECIPE = z
  .object({
    name: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(8000),
    scope: z.enum(['meeting', 'many']).optional(),
  })
  .strict() satisfies z.ZodType<CreateRecipeRequest>;

export const VOICE_CONSENT = z
  .object({
    action: z.enum(['grant', 'revoke']),
    email,
    name: z.string().trim().max(300).nullable().optional(),
    evidence: enumOf(VOICE_CONSENT_EVIDENCE).optional(),
  })
  .strict()
  .refine((v) => v.action !== 'grant' || Boolean(v.evidence), {
    message: 'Say how consent was given.',
    path: ['evidence'],
  }) satisfies z.ZodType<VoiceConsentRequest>;

/** GET /api/notes/meetings query string. */
export const LIST_MEETINGS_QUERY = z.object({
  q: z.string().trim().max(200).optional(),
  person: email.optional(),
  company: domain.optional(),
  folder: uuid.optional(),
  source: z.enum(['copilot', 'granola', 'all']).optional(),
  hasActionItems: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  eventId: z
    .string()
    .regex(/^[\w-]{3,200}$/)
    .optional(),
  cursor: z.string().max(200).optional(),
});

/** GET /api/notes/meetings/[id]/segments query string. */
export const LIST_SEGMENTS_QUERY = z.object({
  after: z.coerce.number().int().min(-1).max(10_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(NOTES_LIMITS.maxSegmentsPerPage).optional(),
});

/** POST /api/notes/recording-rules: a never-record rule of the team's own. */
export const CREATE_RECORDING_RULE = z
  .object({
    kind: enumOf(RECORDING_RULE_KINDS),
    pattern: z.string().trim().min(2).max(200),
    label: z.string().trim().min(1).max(60),
  })
  .strict() satisfies z.ZodType<CreateRecordingRuleRequest>;

/** PATCH /api/notes/recording-rules/[id] */
export const UPDATE_RECORDING_RULE = z
  .object({ enabled: z.boolean() })
  .strict() satisfies z.ZodType<UpdateRecordingRuleRequest>;
