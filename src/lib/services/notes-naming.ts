import 'server-only';
import {
  MEETING_AI_OPERATIONS,
  MEETING_CUES_PROMPT,
  MEETING_CUES_PROMPT_VERSION,
  meetingCuesOutputSchema,
} from '@/lib/ai/prompts/meeting-notes';
import { transcriptBlock } from '@/lib/notes/prompt-input';
import { getAI } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { fenceUntrusted } from '@/lib/security/injection';
import { checkAiBudget, recordAiUsage } from '@/lib/security/limits';
import { speakerDisplayName } from '@/lib/speakers/ladder';
import { planNaming, type NamingProfile } from '@/lib/speakers/naming';
import type { RosterMatch } from '@/lib/speakers/roster';
import { candidateKey, type CueEvidence, type CueLine } from '@/lib/speakers/transcript-cues';
import type {
  Meeting,
  MeetingParticipant,
  MeetingSpeaker,
  TranscriptSegment,
  VoiceProfile,
} from '@/lib/types/notes';
import { listAllPages } from '@/lib/db/paging';
import type { NotesContext } from './notes';

/**
 * The naming pass, applied (D-076): reads a meeting's voices, lines, invite
 * and consented voice profiles, runs the ladder (lib/speakers/naming.ts) and
 * writes what changed. It runs
 *   - while recording, after a batch of lines brings a voice nobody has
 *     named (the rules alone: no model call per batch);
 *   - after a person renames, splits or merges a voice, so elimination can
 *     name the last voice left;
 *   - after Stop, with the AI cue pass first (fast tier), when a model is
 *     available and the budget allows.
 * It never touches a voice a person named, and it writes names only from
 * the invite or a consented profile.
 */

export interface NamingOptions {
  /** Run the AI cue pass first (finalize only). */
  ai?: boolean;
  roster?: RosterMatch[];
  /** Already read by the caller; read here when left out. */
  speakers?: MeetingSpeaker[];
  lines?: TranscriptSegment[];
}

async function consentedProfiles(ctx: NotesContext): Promise<NamingProfile[]> {
  const rows = (await ctx.store.list('voice_profiles', ctx.auth.organizationId, {
    eq: { consent_status: 'granted' },
  })) as VoiceProfile[];
  return rows
    .filter((r) => !r.revoked_at)
    .map((r) => ({
      id: r.id,
      email: r.person_email.toLowerCase(),
      name: r.display_name,
      crmPersonId: r.crm_person_id,
      userId: r.user_id,
    }));
}

function cueLines(lines: readonly TranscriptSegment[]): CueLine[] {
  return lines
    .filter((l) => l.is_final)
    .map((l) => ({
      seq: l.seq,
      clusterKey: l.cluster_key,
      startMs: l.start_ms,
      text: l.edited_text ?? l.text,
    }));
}

/**
 * The AI cue pass: what was said that shows who a voice is. Its answers are
 * checked like evidence from anyone else: only voices of this meeting, only
 * people on the invite, only lines that exist.
 */
async function aiCues(
  ctx: NotesContext,
  meeting: Meeting,
  speakers: readonly MeetingSpeaker[],
  lines: readonly TranscriptSegment[],
  participants: readonly MeetingParticipant[],
): Promise<CueEvidence[]> {
  const ai = getAI();
  if (ai.kind === 'none' || !ai.available()) return [];
  const open = speakers.filter(
    (s) => !s.merged_into && !s.locked && !s.display_name && !s.person_email,
  );
  if (open.length === 0 || lines.length === 0) return [];
  const mixed = speakers.some((s) => s.track === 'mixed');
  const candidates = participants
    .filter((p) => (p.email || p.name) && (mixed || p.role !== 'self'))
    .map((p) => ({ key: candidateKey(p), name: p.name ?? p.email ?? '' }));
  if (candidates.length === 0) return [];
  const org = ctx.auth.organizationId;
  const budget = await checkAiBudget(ctx.store, org, ctx.auth.userId, ctx.now);
  if (!budget.ok) return [];

  const names = new Map(speakers.map((s) => [s.cluster_key, speakerDisplayName(s)]));
  const context = {
    meeting: { title: meeting.title },
    candidates,
    voices: speakers
      .filter((s) => !s.merged_into)
      .map((s) => ({
        cluster_key: s.cluster_key,
        name: names.get(s.cluster_key),
        is_recorder: s.source === 'channel',
      })),
  };
  const response = await ai.generateStructured({
    tier: 'fast',
    operation: MEETING_AI_OPERATIONS.cues,
    promptVersion: MEETING_CUES_PROMPT_VERSION,
    system: MEETING_CUES_PROMPT,
    messages: [
      {
        role: 'user',
        content: `<context>${JSON.stringify(context)}</context>\n\n${fenceUntrusted([
          transcriptBlock(lines, names),
        ])}\n\nReturn the cues that show who each voice is.`,
      },
    ],
    schema: meetingCuesOutputSchema,
    maxTokens: 4_000,
  });
  await recordAiUsage(ctx.store, {
    organizationId: org,
    userId: ctx.auth.userId,
    operation: MEETING_AI_OPERATIONS.cues,
    promptVersion: MEETING_CUES_PROMPT_VERSION,
    usage: response.ok ? response.value.usage : null,
    ok: response.ok,
    errorCode: response.ok ? null : response.error.code,
  });
  if (!response.ok) return [];
  const voiceKeys = new Set(open.map((s) => s.cluster_key));
  const candidateKeys = new Set(candidates.map((c) => c.key));
  const seqs = new Set(lines.map((l) => l.seq));
  return response.value.value.cues
    .filter(
      (c) => voiceKeys.has(c.cluster_key) && candidateKeys.has(c.candidate_key) && seqs.has(c.seq),
    )
    .slice(0, 50)
    .map((c) => ({
      clusterKey: c.cluster_key,
      candidateKey: c.candidate_key,
      weight: 0.7,
      reason: c.reason.replace(/\s+/g, ' ').trim().slice(0, 160) || 'named in the transcript',
      seq: c.seq,
    }));
}

/** Run the ladder over one meeting and write the voices it changed. */
export async function applyNamingLadder(
  ctx: NotesContext,
  meeting: Meeting,
  options: NamingOptions = {},
): Promise<{ changed: number; named: number }> {
  const org = ctx.auth.organizationId;
  const [speakers, lines, participants, profiles] = await Promise.all([
    options.speakers
      ? Promise.resolve(options.speakers)
      : (ctx.store.list('meeting_speakers', org, { eq: { meeting_id: meeting.id } }) as Promise<
          MeetingSpeaker[]
        >),
    options.lines
      ? Promise.resolve(options.lines)
      : (listAllPages(
          ctx.store,
          'transcript_segments',
          org,
          { eq: { meeting_id: meeting.id, is_final: true } },
          [{ field: 'seq', direction: 'asc' }],
        ) as Promise<TranscriptSegment[]>),
    ctx.store.list('meeting_participants', org, { eq: { meeting_id: meeting.id } }) as Promise<
      MeetingParticipant[]
    >,
    consentedProfiles(ctx),
  ]);
  const extra = options.ai ? await aiCues(ctx, meeting, speakers, lines, participants) : [];
  const patches = planNaming({
    speakers,
    lines: cueLines(lines),
    participants,
    voiceProfiles: profiles,
    roster: options.roster,
    aiCues: extra,
  });
  let named = 0;
  for (const { id, patch } of patches) {
    if (patch.display_name) named += 1;
    await ctx.store.update('meeting_speakers', org, id, patch);
  }
  if (named > 0 || (options.roster && patches.length)) {
    await recordAudit(ctx.store, {
      organizationId: org,
      userId: ctx.auth.userId,
      action: options.roster ? 'notes.roster_applied' : 'notes.speakers_named',
      entityType: 'meeting',
      entityId: meeting.id,
      metadata: { named, changed: patches.length, ai_cues: extra.length },
    });
  }
  return { changed: patches.length, named };
}
