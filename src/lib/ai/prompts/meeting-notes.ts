import { z } from 'zod';
import { ASK_ARWIN_PERSONA, PROMPTS, PROMPT_VERSIONS, systemPrompt } from './index';
import { MEETING_CHAT_TASK } from './meeting-notes-tasks';

export { MEETING_CHAT_TASK, MEETING_CUES_TASK, MEETING_NOTES_TASK } from './meeting-notes-tasks';

/**
 * Copilot Notes' prompts (D-076): the meeting notes, the speaker-cue pass and
 * the meeting chat. Versioned like every prompt (AI_PROMPTS.md): the version
 * is written onto the note row and every ai_usage row, so a note can always
 * be explained by the prompt that wrote it.
 *
 * What the model sees: a <context> block (the meeting, the template, the
 * invite, the voices and their names, CRM facts about the guests) and the
 * typed notes and transcript inside <untrusted-content> fences. Spoken words
 * are untrusted: someone on a call can say "ignore your instructions", and it
 * is data. What comes back is checked by lib/notes/notes-assembly.ts before
 * anything is stored: typed lines are put back word for word by the app, every
 * point must cite lines that exist, owners must be voices that exist.
 *
 * The notes and cue prompts keep the default identity and the core rules
 * byte for byte (they are in PROMPTS, so the persona test checks that). The
 * chat speaks as Arwin, like Ask, from the one shared persona block.
 */

export const MEETING_NOTES_PROMPT_VERSION = PROMPT_VERSIONS.meetingNotes;
export const MEETING_CUES_PROMPT_VERSION = PROMPT_VERSIONS.meetingSpeakerCues;
/** Not in PROMPTS: it speaks as Arwin, and PROMPTS holds the core-identity prompts. */
export const MEETING_CHAT_PROMPT_VERSION = 'meeting-chat@1.0.0';

export const MEETING_NOTES_PROMPT = PROMPTS.meetingNotes.system;
export const MEETING_CUES_PROMPT = PROMPTS.meetingSpeakerCues.system;
/** The chat speaks as Arwin (D-059), from the shared persona block. */
export const MEETING_CHAT_PROMPT = systemPrompt(
  MEETING_CHAT_TASK,
  `${ASK_ARWIN_PERSONA}\n\nTipTop VC is an early-stage venture fund investing in vertical AI.`,
);

/* ---------------------------------------------------------------- outputs */

const rangeSchema = z.object({
  from_seq: z.number().int(),
  to_seq: z.number().int(),
});

export const meetingNotesOutputSchema = z.object({
  blocks: z.array(
    z.object({
      kind: z.enum(['heading', 'bullet', 'paragraph']),
      text: z.string(),
      depth: z.number().int(),
      /** A typed line placed here: the app fills in the person's own words. */
      typed_index: z.number().int().nullable(),
      sources: z.array(rangeSchema),
    }),
  ),
  action_items: z.array(
    z.object({
      text: z.string(),
      owner_cluster_key: z.string().nullable(),
      due: z.string().nullable(),
      sources: z.array(rangeSchema),
    }),
  ),
  injection_observed: z.boolean(),
});
export type MeetingNotesOutput = z.infer<typeof meetingNotesOutputSchema>;

export const meetingCuesOutputSchema = z.object({
  cues: z.array(
    z.object({
      cluster_key: z.string(),
      candidate_key: z.string(),
      seq: z.number().int(),
      reason: z.string(),
    }),
  ),
});
export type MeetingCuesOutput = z.infer<typeof meetingCuesOutputSchema>;

export const meetingChatOutputSchema = z.object({
  answer: z.string(),
  injection_observed: z.boolean(),
});
export type MeetingChatOutput = z.infer<typeof meetingChatOutputSchema>;

/** The operation names ai_usage rows and the offline model know these calls by. */
export const MEETING_AI_OPERATIONS = {
  notes: 'meeting.notes',
  cues: 'meeting.cues',
  chat: 'meeting.chat',
} as const;
