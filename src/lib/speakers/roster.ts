/**
 * The meeting-app roster (D-076, rung d of the naming ladder): the meeting
 * app's own "who is speaking" timeline (the Meet extension reads it from the
 * call's speaking indicator) lined up with each voice's lines. A voice whose
 * talk time falls mostly inside one person's speaking turns is that person.
 *
 * Only voices on the meeting-audio track are matched: the mic is the
 * recorder already, and an in-person recording has no meeting app. Pure.
 */

export interface RosterTurn {
  /** The display name the meeting app shows; the invite's spelling wins when they match. */
  name: string;
  email: string | null;
  startMs: number;
  endMs: number;
}

export interface RosterLine {
  clusterKey: string;
  startMs: number;
  endMs: number;
}

export interface RosterMatch {
  clusterKey: string;
  name: string;
  email: string | null;
  /** Share of the voice's talk time inside that person's turns. */
  share: number;
  lines: number;
}

/** A voice needs this share of its talk time in one person's turns, over at least this many lines. */
export const ROSTER_MIN_SHARE = 0.6;
export const ROSTER_MIN_LINES = 2;

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

const personKey = (t: Pick<RosterTurn, 'name' | 'email'>) =>
  t.email ? t.email.toLowerCase() : `name:${t.name.trim().toLowerCase()}`;

export function alignRoster(
  turns: readonly RosterTurn[],
  lines: readonly RosterLine[],
): RosterMatch[] {
  const byVoice = new Map<string, RosterLine[]>();
  for (const line of lines) {
    if (!line.clusterKey.startsWith('sys:')) continue;
    const list = byVoice.get(line.clusterKey) ?? [];
    list.push(line);
    byVoice.set(line.clusterKey, list);
  }
  const people = new Map<string, RosterTurn>();
  for (const t of turns) if (!people.has(personKey(t))) people.set(personKey(t), t);

  const matches: RosterMatch[] = [];
  for (const [clusterKey, voiceLines] of byVoice) {
    const talk = voiceLines.reduce((sum, l) => sum + Math.max(1, l.endMs - l.startMs), 0);
    const shares = new Map<string, number>();
    for (const line of voiceLines) {
      for (const turn of turns) {
        const ms = overlap(line.startMs, line.endMs, turn.startMs, turn.endMs);
        if (ms > 0) shares.set(personKey(turn), (shares.get(personKey(turn)) ?? 0) + ms);
      }
    }
    const best = [...shares.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best) continue;
    const share = Math.round((best[1] / talk) * 100) / 100;
    if (share < ROSTER_MIN_SHARE || voiceLines.length < ROSTER_MIN_LINES) continue;
    const person = people.get(best[0]) as RosterTurn;
    matches.push({
      clusterKey,
      name: person.name,
      email: person.email,
      share,
      lines: voiceLines.length,
    });
  }
  // One person, one voice: when two voices claim the same person, the larger share keeps it.
  const kept = new Map<string, RosterMatch>();
  for (const m of matches.sort((a, b) => b.share - a.share || b.lines - a.lines)) {
    const key = personKey(m);
    if (!kept.has(key)) kept.set(key, m);
  }
  return [...kept.values()];
}
