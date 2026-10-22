import type {
  MeetingParticipant,
  MeetingSpeaker,
  SpeakerSource,
  SpeakerSuggestion,
} from '@/lib/types/notes';
import { eliminate } from './calendar-elimination';
import { isResolved, mayOverride, SOURCE_RANK } from './ladder';
import type { RosterMatch } from './roster';
import {
  candidateKey,
  findCues,
  scoreCues,
  type CueCandidate,
  type CueEvidence,
  type CueLine,
} from './transcript-cues';

/**
 * The naming pass (D-076): every rung of the ladder below a person's tap,
 * applied to a meeting's voices at once, as a list of speaker patches.
 *
 *   c) voiceprint  a voice the vendor matched to a consented, enrolled
 *                  profile (its cluster key is 'sys:<profile id>')
 *   d) roster      the meeting app's speaking timeline (roster.ts)
 *   e) calendar    elimination against the invite (calendar-elimination.ts)
 *   f) cues        what was said (transcript-cues.ts, plus the AI cue pass):
 *                  suggestion chips, and a tie-breaker for (e)
 *
 * Rules it keeps:
 * - A locked voice (a person picked its name) is never touched, and evidence
 *   never replaces a name from a stronger rung (ladder.ts mayOverride).
 * - Names are sticky: a voice named by the calendar keeps that name when a
 *   new, unknown voice joins later; it is cleared only when a stronger rung
 *   gives that person to another voice.
 * - One person, one voice: when two voices carry the same person, the one
 *   with the weaker evidence goes back to "Guest N".
 * - Spellings come from the invite (or the profile a person consented with),
 *   never from the transcript.
 *
 * Pure; services/notes-naming.ts reads the rows and writes the patches.
 */

export interface NamingProfile {
  /** The voice profile id: the label the vendor returns for a matched voice. */
  id: string;
  email: string;
  name: string | null;
  crmPersonId: string | null;
  userId: string | null;
}

export interface NamingInput {
  speakers: readonly MeetingSpeaker[];
  /** Final lines in order, with the edited text when there is one. */
  lines: readonly CueLine[];
  participants: readonly Pick<
    MeetingParticipant,
    'email' | 'name' | 'role' | 'crm_person_id' | 'user_id'
  >[];
  /** Profiles with consent on file (granted, not revoked). */
  voiceProfiles?: readonly NamingProfile[];
  roster?: readonly RosterMatch[];
  /** Cues from the AI pass, already checked against the candidates and lines. */
  aiCues?: readonly CueEvidence[];
}

export interface NamingPatch {
  id: string;
  clusterKey: string;
  patch: Partial<MeetingSpeaker>;
}

type Person = {
  email: string | null;
  name: string;
  crmPersonId: string | null;
  userId: string | null;
};

interface Working {
  row: MeetingSpeaker;
  person: Person | null;
  source: SpeakerSource | null;
  confidence: number | null;
  suggestions: SpeakerSuggestion[];
}

const AUTOMATED: ReadonlySet<SpeakerSource> = new Set([
  'voiceprint',
  'roster',
  'calendar',
  'llm_cue',
]);

const keyOf = (p: { email: string | null; name: string | null }) => candidateKey(p);

function personFromRow(row: MeetingSpeaker): Person | null {
  if (!isResolved(row)) return null;
  return {
    email: row.person_email,
    name: row.display_name ?? row.person_email ?? '',
    crmPersonId: row.crm_person_id,
    userId: row.user_id,
  };
}

/** The base of a cluster key with its track prefix removed: 'sys:abc' → 'abc'. */
function vendorLabelOf(clusterKey: string): string | null {
  if (clusterKey.includes('#')) return null;
  const colon = clusterKey.indexOf(':');
  return colon < 0 ? null : clusterKey.slice(colon + 1);
}

export function planNaming(input: NamingInput): NamingPatch[] {
  const participants = input.participants;
  const byEmail = new Map<string, (typeof participants)[number]>();
  const byName = new Map<string, (typeof participants)[number]>();
  for (const p of participants) {
    if (p.email) byEmail.set(p.email.toLowerCase(), p);
    if (p.name) byName.set(p.name.trim().toLowerCase(), p);
  }
  /** The invite's spelling and links for a person, when they are on it. */
  const fromInvite = (email: string | null, name: string | null): Person | null => {
    const hit =
      (email && byEmail.get(email.toLowerCase())) ||
      (name && byName.get(name.trim().toLowerCase()));
    if (hit) {
      return {
        email: hit.email,
        name: hit.name ?? hit.email ?? name ?? '',
        crmPersonId: hit.crm_person_id,
        userId: hit.user_id,
      };
    }
    return null;
  };

  const lineCounts = new Map<string, number>();
  for (const line of input.lines) {
    lineCounts.set(line.clusterKey, (lineCounts.get(line.clusterKey) ?? 0) + 1);
  }

  const working: Working[] = input.speakers
    .filter((s) => !s.merged_into)
    .map((row) => ({
      row,
      person: personFromRow(row),
      source: row.source,
      confidence: row.confidence,
      suggestions: row.suggestions ?? [],
    }));
  const canTake = (w: Working, source: SpeakerSource) =>
    mayOverride({ ...w.row, source: w.person ? w.source : null }, source);
  const set = (w: Working, person: Person, source: SpeakerSource, confidence: number) => {
    w.person = person;
    w.source = source;
    w.confidence = confidence;
  };
  const clear = (w: Working) => {
    w.person = null;
    w.source = null;
    w.confidence = null;
  };

  // c) Voiceprint: the vendor matched a consented, enrolled voice.
  const profiles = new Map((input.voiceProfiles ?? []).map((p) => [p.id, p]));
  for (const w of working) {
    const label = vendorLabelOf(w.row.cluster_key);
    const profile = label ? profiles.get(label) : undefined;
    if (!profile || !canTake(w, 'voiceprint')) continue;
    const invited = fromInvite(profile.email, profile.name);
    set(
      w,
      invited ?? {
        email: profile.email,
        name: profile.name ?? profile.email,
        crmPersonId: profile.crmPersonId,
        userId: profile.userId,
      },
      'voiceprint',
      0.95,
    );
  }

  // d) Roster: the meeting app's own speaking timeline.
  for (const match of input.roster ?? []) {
    const w = working.find((x) => x.row.cluster_key === match.clusterKey);
    if (!w || !canTake(w, 'roster')) continue;
    const invited = fromInvite(match.email, match.name);
    set(
      w,
      invited ?? { email: match.email, name: match.name, crmPersonId: null, userId: null },
      'roster',
      Math.min(0.95, Math.max(0.6, match.share)),
    );
  }

  // One person, one voice: the weaker automated claim gives way.
  const holders = new Map<string, Working[]>();
  for (const w of working) {
    if (!w.person) continue;
    const key = keyOf(w.person);
    holders.set(key, [...(holders.get(key) ?? []), w]);
  }
  for (const list of holders.values()) {
    if (list.length < 2) continue;
    const rank = (w: Working) => (w.row.locked ? 10 : w.source ? SOURCE_RANK[w.source] : 0);
    const [keep, ...rest] = [...list].sort(
      (a, b) => rank(b) - rank(a) || (b.confidence ?? 0) - (a.confidence ?? 0),
    );
    for (const w of rest) {
      if (w === keep || w.row.locked || !w.source || !AUTOMATED.has(w.source)) continue;
      clear(w);
    }
  }

  // e) + f) Calendar elimination, with the cues as a tie-breaker and as chips.
  const mixed = working.some((w) => w.row.track === 'mixed');
  const candidates: CueCandidate[] = [];
  const seen = new Set<string>();
  for (const p of participants) {
    // On a two-track call the recorder is the mic; in person they are a voice too.
    if (p.role === 'self' && !mixed) continue;
    if (!p.email && !p.name) continue;
    const key = keyOf(p);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      key,
      name: p.name ?? p.email ?? '',
      email: p.email,
      crmPersonId: p.crm_person_id,
    });
  }
  const ownerKeys = new Set(
    working.filter((w) => w.source === 'channel').map((w) => w.row.cluster_key),
  );
  // The same cue found by the rules and by the AI pass counts once.
  const evidence = new Map<string, CueEvidence>();
  for (const e of [...findCues(input.lines, candidates, ownerKeys), ...(input.aiCues ?? [])]) {
    if (ownerKeys.has(e.clusterKey)) continue;
    const key = `${e.clusterKey}|${e.candidateKey}|${e.seq}`;
    if (!evidence.has(key)) evidence.set(key, e);
  }
  const cueScores = scoreCues([...evidence.values()]);

  const held = new Set(working.filter((w) => w.person).map((w) => keyOf(w.person as Person)));
  const open = working.filter(
    (w) =>
      !w.person &&
      !w.row.locked &&
      w.row.cluster_key !== 'mic' &&
      (lineCounts.get(w.row.cluster_key) ?? 0) > 0,
  );
  const result = eliminate({
    guests: candidates.filter((c) => !held.has(c.key)),
    voices: open.map((w) => ({
      clusterKey: w.row.cluster_key,
      lineCount: lineCounts.get(w.row.cluster_key) ?? 0,
    })),
    cueScores,
  });
  for (const a of result.assign) {
    const w = working.find((x) => x.row.cluster_key === a.clusterKey);
    if (!w || !canTake(w, 'calendar')) continue;
    const invited = fromInvite(a.candidate.email, a.candidate.name);
    set(
      w,
      invited ?? {
        email: a.candidate.email,
        name: a.candidate.name,
        crmPersonId: a.candidate.crmPersonId,
        userId: null,
      },
      'calendar',
      a.confidence,
    );
  }
  for (const w of working) {
    w.suggestions = w.person ? [] : (result.suggestions.get(w.row.cluster_key) ?? []);
  }

  // The patches: only what changed.
  const patches: NamingPatch[] = [];
  const maxGuest = input.speakers.reduce((m, s) => Math.max(m, s.guest_number ?? 0), 0);
  let nextGuest = maxGuest + 1;
  for (const w of working) {
    const row = w.row;
    const patch: Partial<MeetingSpeaker> = {};
    const person = w.person;
    const wantName = person ? person.name || person.email : null;
    if ((row.display_name ?? null) !== (wantName ?? null)) patch.display_name = wantName ?? null;
    if ((row.person_email ?? null) !== (person?.email ?? null))
      patch.person_email = person?.email ?? null;
    if ((row.crm_person_id ?? null) !== (person?.crmPersonId ?? null)) {
      patch.crm_person_id = person?.crmPersonId ?? null;
    }
    if ((row.user_id ?? null) !== (person?.userId ?? null)) patch.user_id = person?.userId ?? null;
    if ((row.source ?? null) !== (w.source ?? null)) patch.source = w.source;
    if ((row.confidence ?? null) !== (w.confidence ?? null)) patch.confidence = w.confidence;
    if (JSON.stringify(row.suggestions ?? []) !== JSON.stringify(w.suggestions)) {
      patch.suggestions = w.suggestions;
    }
    if (!person && row.guest_number === null) patch.guest_number = Math.min(nextGuest++, 99);
    if (Object.keys(patch).length) patches.push({ id: row.id, clusterKey: row.cluster_key, patch });
  }
  return patches;
}
