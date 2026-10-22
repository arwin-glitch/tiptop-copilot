import 'server-only';
import { recordAudit } from '@/lib/security/audit';
import { planNaming, type NamingProfile } from '@/lib/speakers/naming';
import type { RosterMatch } from '@/lib/speakers/roster';
import type { CueLine } from '@/lib/speakers/transcript-cues';
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
 *   - after Stop.
 * Rules only, never a model (zero spend): the transcript cues it reads
 * ("I'm Dana", "Priya, how does…") are matched by lib/speakers/transcript-
 * cues.ts. It never touches a voice a person named, and it writes names only
 * from the invite or a consented profile.
 */

export interface NamingOptions {
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
  const patches = planNaming({
    speakers,
    lines: cueLines(lines),
    participants,
    voiceProfiles: profiles,
    roster: options.roster,
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
      metadata: { named, changed: patches.length },
    });
  }
  return { changed: patches.length, named };
}
