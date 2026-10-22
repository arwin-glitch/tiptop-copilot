import { formatOffset } from '@/lib/notes/api';

/**
 * Transcript cues (D-076, rung f of the naming ladder): what people say that
 * hints at who a voice is. "I'm Dana", "Dana, go ahead" (the next voice is
 * probably Dana), "Thanks, Priya" (the voice before was probably Priya).
 *
 * Cues only ever become suggestion chips, or a tie-breaker inside calendar
 * elimination (calendar-elimination.ts); they never name a voice on their
 * own. Names are matched against the people we already know (the invite, the
 * CRM), never read out of the transcript: the spelling a suggestion carries
 * is the invite's, so a vendor's "Pria" can still point at "Priya Shah" only
 * when the words match, and a name nobody invited is never suggested.
 *
 * Pure and client-safe. The AI cue pass (lib/ai/prompts/meeting-notes.ts)
 * finds the cues these patterns miss; both land in the same shape.
 */

export interface CueLine {
  seq: number;
  clusterKey: string;
  startMs: number;
  text: string;
}

export interface CueCandidate {
  /** Stable key: the lowercased email, else 'name:<lowercased name>'. */
  key: string;
  name: string;
  email: string | null;
  crmPersonId: string | null;
}

export interface CueEvidence {
  clusterKey: string;
  candidateKey: string;
  /** How strongly this one cue points at the candidate, 0..1. */
  weight: number;
  reason: string;
  seq: number;
}

/** The key a person is matched on everywhere in the ladder. */
export function candidateKey(person: { email: string | null; name: string | null }): string {
  if (person.email) return person.email.trim().toLowerCase();
  return `name:${(person.name ?? '').trim().toLowerCase()}`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The words that name each candidate: the full name always, the first name
 * only when no other candidate shares it (two Danas are told apart by surname
 * or not at all).
 */
function nameForms(candidates: readonly CueCandidate[]): Map<string, string[]> {
  const firstCounts = new Map<string, number>();
  const first = (name: string) => name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  for (const c of candidates) {
    const f = first(c.name);
    if (f) firstCounts.set(f, (firstCounts.get(f) ?? 0) + 1);
  }
  const forms = new Map<string, string[]>();
  for (const c of candidates) {
    const full = c.name.trim().replace(/\s+/g, ' ');
    if (!full) continue;
    const list = [full];
    const f = first(full);
    if (f && f.length >= 2 && (firstCounts.get(f) ?? 0) === 1 && f !== full.toLowerCase()) {
      list.push(full.split(' ')[0] as string);
    }
    forms.set(c.key, list);
  }
  return forms;
}

interface Pattern {
  kind: 'self' | 'addressed' | 'thanked';
  /** `{name}` stands for one of the candidate's name forms. */
  source: string;
  weight: number;
}

const PATTERNS: readonly Pattern[] = [
  {
    kind: 'self',
    source: String.raw`\b(?:i'm|i am|this is|my name is|it's)\s+{name}\b`,
    weight: 0.8,
  },
  { kind: 'self', source: String.raw`^\s*{name}\s+here\b`, weight: 0.7 },
  {
    kind: 'thanked',
    source: String.raw`\b(?:thanks|thank you|thanks so much|cheers)[,!.]?\s+{name}\b`,
    weight: 0.6,
  },
  // "Dana, go ahead." / "Great. Priya, how does…" at the start of a sentence.
  {
    kind: 'addressed',
    source: String.raw`(?:^|[.!?]\s+)(?:so|okay|ok|and|great|right|now)?[,\s]*{name}\s*[,?]`,
    weight: 0.6,
  },
  // "…what do you think, Priya?" at the end of a line.
  { kind: 'addressed', source: String.raw`,\s*{name}\s*[?.!]?\s*$`, weight: 0.5 },
];

/** How far the next or previous voice may be from a cue and still count. */
const TURN_WINDOW_MS = 20_000;

/**
 * Every cue in the transcript, as evidence about a voice. `ownerKeys` are the
 * voices already known to be the recorder (the mic): they can give cues but
 * are never the voice a cue names.
 */
export function findCues(
  lines: readonly CueLine[],
  candidates: readonly CueCandidate[],
  ownerKeys: ReadonlySet<string> = new Set(),
): CueEvidence[] {
  const forms = nameForms(candidates);
  const compiled: { candidate: CueCandidate; pattern: Pattern; re: RegExp; said: string }[] = [];
  for (const candidate of candidates) {
    for (const form of forms.get(candidate.key) ?? []) {
      for (const pattern of PATTERNS) {
        compiled.push({
          candidate,
          pattern,
          said: form,
          re: new RegExp(pattern.source.replace('{name}', escapeRe(form)), 'i'),
        });
      }
    }
  }
  const ordered = [...lines].sort((a, b) => a.seq - b.seq);
  const out: CueEvidence[] = [];
  const seen = new Set<string>();
  const push = (e: CueEvidence) => {
    if (ownerKeys.has(e.clusterKey)) return;
    const key = `${e.clusterKey}|${e.candidateKey}|${e.seq}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };

  ordered.forEach((line, index) => {
    for (const { candidate, pattern, re, said } of compiled) {
      if (!re.test(line.text)) continue;
      const at = formatOffset(line.startMs);
      if (pattern.kind === 'self') {
        push({
          clusterKey: line.clusterKey,
          candidateKey: candidate.key,
          weight: pattern.weight,
          reason: `said "${said}" about themselves at ${at}`,
          seq: line.seq,
        });
      } else if (pattern.kind === 'addressed') {
        // The next line by another voice answers the one addressed.
        const next = ordered.slice(index + 1).find((l) => l.clusterKey !== line.clusterKey);
        if (next && next.startMs - line.startMs <= TURN_WINDOW_MS) {
          push({
            clusterKey: next.clusterKey,
            candidateKey: candidate.key,
            weight: pattern.weight,
            reason: `answered right after "${said}" was asked at ${at}`,
            seq: line.seq,
          });
        }
      } else {
        // The thanks goes to the voice that spoke just before.
        const previous = ordered
          .slice(0, index)
          .reverse()
          .find((l) => l.clusterKey !== line.clusterKey);
        if (previous && line.startMs - previous.startMs <= TURN_WINDOW_MS * 2) {
          push({
            clusterKey: previous.clusterKey,
            candidateKey: candidate.key,
            weight: pattern.weight,
            reason: `was thanked by name ("${said}") at ${at}`,
            seq: line.seq,
          });
        }
      }
    }
  });
  return out;
}

export interface CueScore {
  /** Combined strength: 1 - the product of (1 - weight) over the cues. */
  score: number;
  reasons: string[];
}

/** Evidence folded per voice and candidate. */
export function scoreCues(evidence: readonly CueEvidence[]): Map<string, Map<string, CueScore>> {
  const out = new Map<string, Map<string, CueScore>>();
  for (const e of evidence) {
    const byCandidate = out.get(e.clusterKey) ?? new Map<string, CueScore>();
    const current = byCandidate.get(e.candidateKey) ?? { score: 0, reasons: [] };
    const score = 1 - (1 - current.score) * (1 - Math.min(0.95, Math.max(0, e.weight)));
    byCandidate.set(e.candidateKey, {
      score: Math.round(score * 1000) / 1000,
      reasons: current.reasons.length < 3 ? [...current.reasons, e.reason] : current.reasons,
    });
    out.set(e.clusterKey, byCandidate);
  }
  return out;
}
