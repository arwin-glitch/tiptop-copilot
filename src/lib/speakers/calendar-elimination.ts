import type { SpeakerSuggestion } from '@/lib/types/notes';
import type { CueCandidate, CueScore } from './transcript-cues';

/**
 * Calendar elimination (D-076, rung e of the naming ladder): the invite's
 * guests, minus the people already matched to a voice, against the voices
 * nobody has named yet.
 *
 * - One guest left and one voice left: that guest, at 0.9.
 * - As many guests as voices: pairs that the transcript cues single out in
 *   both directions (this voice's best guest is that guest, and that guest's
 *   best voice is this one, by a clear margin) are matched at 0.8, and the
 *   count is checked again, so the last pair falls to the one-and-one rule.
 * - More voices than guests (someone uninvited is talking) or fewer: nothing
 *   is named; every unnamed voice gets the guests left as ranked suggestions.
 *
 * Spellings are the invite's. Pure: the naming service (services/notes-naming.ts)
 * gathers the inputs and writes the result.
 */

export interface EliminationVoice {
  clusterKey: string;
  /** Lines this voice has; a voice with none (a merged-away one) is left out. */
  lineCount: number;
}

export interface EliminationAssignment {
  clusterKey: string;
  candidate: CueCandidate;
  confidence: number;
  reason: string;
}

export interface EliminationResult {
  assign: EliminationAssignment[];
  /** Ranked chips for each voice still unnamed, at most four. */
  suggestions: Map<string, SpeakerSuggestion[]>;
}

const ONE_LEFT_CONFIDENCE = 0.9;
const MUTUAL_CONFIDENCE = 0.8;
const MUTUAL_MIN_SCORE = 0.5;
const MUTUAL_MARGIN = 0.2;
const MAX_SUGGESTIONS = 4;

type Scores = ReadonlyMap<string, ReadonlyMap<string, CueScore>>;

function cueScore(scores: Scores, clusterKey: string, candidate: string): number {
  return scores.get(clusterKey)?.get(candidate)?.score ?? 0;
}

/** The best and second-best of a list of numbers keyed by id. */
function topTwo(entries: [string, number][]): { best: string | null; gap: number; top: number } {
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  const first = sorted[0];
  if (!first) return { best: null, gap: 0, top: 0 };
  return { best: first[0], top: first[1], gap: first[1] - (sorted[1]?.[1] ?? 0) };
}

export function eliminate(params: {
  /** Invited people still unmatched (the caller removes those bound to a named voice). */
  guests: readonly CueCandidate[];
  /** Voices still unnamed and unlocked. */
  voices: readonly EliminationVoice[];
  cueScores?: Scores;
}): EliminationResult {
  const scores: Scores = params.cueScores ?? new Map();
  let guests = [...params.guests];
  let voices = params.voices.filter((v) => v.lineCount > 0);
  const assign: EliminationAssignment[] = [];

  for (let round = 0; round < 50; round += 1) {
    if (guests.length === 0 || voices.length === 0) break;
    if (guests.length === 1 && voices.length === 1) {
      const [guest] = guests as [CueCandidate];
      const [voice] = voices as [EliminationVoice];
      assign.push({
        clusterKey: voice.clusterKey,
        candidate: guest,
        confidence: ONE_LEFT_CONFIDENCE,
        reason: 'the only invited guest not matched to a voice, and the only voice without a name',
      });
      guests = [];
      voices = [];
      break;
    }
    if (guests.length !== voices.length) break;
    // Mutual best pairs by the transcript's cues.
    const pairs: EliminationAssignment[] = [];
    for (const voice of voices) {
      const mine = topTwo(guests.map((g) => [g.key, cueScore(scores, voice.clusterKey, g.key)]));
      if (!mine.best || mine.top < MUTUAL_MIN_SCORE || mine.gap < MUTUAL_MARGIN) continue;
      const theirs = topTwo(
        voices.map((v) => [v.clusterKey, cueScore(scores, v.clusterKey, mine.best as string)]),
      );
      if (theirs.best !== voice.clusterKey || theirs.gap < MUTUAL_MARGIN) continue;
      const guest = guests.find((g) => g.key === mine.best) as CueCandidate;
      const why = scores.get(voice.clusterKey)?.get(guest.key)?.reasons[0];
      pairs.push({
        clusterKey: voice.clusterKey,
        candidate: guest,
        confidence: MUTUAL_CONFIDENCE,
        reason: `invited, and ${why ?? 'the transcript points at them'}`,
      });
    }
    if (pairs.length === 0) break;
    assign.push(...pairs);
    const taken = new Set(pairs.map((p) => p.candidate.key));
    const named = new Set(pairs.map((p) => p.clusterKey));
    guests = guests.filter((g) => !taken.has(g.key));
    voices = voices.filter((v) => !named.has(v.clusterKey));
  }

  const suggestions = new Map<string, SpeakerSuggestion[]>();
  for (const voice of voices) {
    const ranked = guests
      .map((guest, order) => {
        const cue = scores.get(voice.clusterKey)?.get(guest.key);
        const base = Math.round((0.6 / guests.length) * 100) / 100;
        const suggestion: SpeakerSuggestion = cue
          ? {
              email: guest.email,
              name: guest.name,
              crmPersonId: guest.crmPersonId,
              source: 'llm_cue',
              confidence: Math.min(0.85, Math.round((0.3 + cue.score * 0.6) * 100) / 100),
              reason: `Invited, and ${cue.reasons[0] ?? 'named in the transcript'}`,
            }
          : {
              email: guest.email,
              name: guest.name,
              crmPersonId: guest.crmPersonId,
              source: 'calendar',
              confidence: base,
              reason:
                guests.length === 1
                  ? 'The only invited guest not matched to a voice'
                  : `One of ${guests.length} invited guests not matched to a voice yet`,
            };
        return { suggestion, order };
      })
      .sort((a, b) => b.suggestion.confidence - a.suggestion.confidence || a.order - b.order)
      .slice(0, MAX_SUGGESTIONS)
      .map((r) => r.suggestion);
    suggestions.set(voice.clusterKey, ranked);
  }
  return { assign, suggestions };
}
