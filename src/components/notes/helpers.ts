import type {
  ChatCitation,
  MeetingPlatform,
  MeetingStatus,
  SegmentRange,
  SegmentView,
  SpeakerCertainty,
  SpeakerView,
} from '@/lib/types/notes';

/**
 * Pure helpers for the Notes screens (D-076): no React, no fetch, so the unit
 * tests read them directly. Names always come from SpeakerView by cluster key;
 * a transcript line never carries one of its own.
 */

/* ============================================================ voices == */

/** Voices by cluster key; a merged voice resolves to the voice it joined. */
export function speakerLookup(speakers: readonly SpeakerView[]): (key: string) => SpeakerView {
  const byKey = new Map(speakers.map((s) => [s.clusterKey, s]));
  return (key: string) => {
    let current = byKey.get(key);
    const seen = new Set<string>();
    while (current?.mergedInto && !seen.has(current.clusterKey)) {
      seen.add(current.clusterKey);
      const next = byKey.get(current.mergedInto);
      if (!next) break;
      current = next;
    }
    return (
      current ?? {
        clusterKey: key,
        track: key === 'mic' ? 'mic' : key.startsWith('mix:') ? 'mixed' : 'system',
        displayName: 'Guest',
        personEmail: null,
        crmPersonId: null,
        resolved: false,
        isOwner: false,
        source: null,
        certainty: 'unknown',
        confidence: null,
        locked: false,
        suggestions: [],
        mergedInto: null,
        lineCount: 0,
        canRememberVoice: false,
      }
    );
  };
}

/** The voices a person can pick between: not merged away, the owner first. */
export function activeSpeakers(speakers: readonly SpeakerView[]): SpeakerView[] {
  return speakers
    .filter((s) => !s.mergedInto)
    .sort((a, b) => Number(b.isOwner) - Number(a.isOwner));
}

const CERTAINTY_WORDS: Record<SpeakerCertainty, string> = {
  channel: 'Their own mic',
  confirmed: 'You confirmed',
  voice: 'Recognised voice',
  roster: 'From the meeting app',
  calendar: 'From the calendar',
  suggested: 'Suggested',
  unknown: 'Not named yet',
};

/** How sure a name is, in the People tab's words. */
export function certaintyWords(certainty: SpeakerCertainty): string {
  return CERTAINTY_WORDS[certainty] ?? 'Not named yet';
}

/** "DR" for Dana Reyes, "?" for nobody. */
export function initials(name: string | null | undefined): string {
  // An address alone: its name part ('dana@…' is "D").
  const words = (name ?? '')
    .replace(/@.*$/, '')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/* ======================================================== transcript == */

/** Lines merged by seq (a newer copy of a line replaces the older), in order. */
export function mergeSegments(
  current: readonly SegmentView[],
  incoming: readonly SegmentView[],
): SegmentView[] {
  if (incoming.length === 0) return current as SegmentView[];
  const bySeq = new Map(current.map((s) => [s.seq, s]));
  for (const s of incoming) bySeq.set(s.seq, s);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The line being said at `ms`: the last one that started at or before it. */
export function segmentAt(segments: readonly SegmentView[], ms: number): SegmentView | null {
  let found: SegmentView | null = null;
  for (const s of segments) {
    if (s.startMs <= ms) found = s;
    else break;
  }
  return found ?? segments[0] ?? null;
}

/** The lines a note point came from. */
export function linesInRanges(
  segments: readonly SegmentView[],
  ranges: readonly SegmentRange[],
): SegmentView[] {
  if (ranges.length === 0) return [];
  return segments.filter((s) => ranges.some((r) => s.seq >= r.fromSeq && s.seq <= r.toSeq));
}

/** Consecutive lines of one voice, shown under one name chip. */
export interface LineGroup {
  clusterKey: string;
  lines: SegmentView[];
}

export function groupLines(
  segments: readonly SegmentView[],
  resolve: (key: string) => SpeakerView,
): LineGroup[] {
  const groups: LineGroup[] = [];
  for (const s of segments) {
    const key = resolve(s.clusterKey).clusterKey;
    const last = groups[groups.length - 1];
    if (last && last.clusterKey === key) last.lines.push(s);
    else groups.push({ clusterKey: key, lines: [s] });
  }
  return groups;
}

/* ============================================================ notepad == */

/** Where a '/' command is being typed: the start of the word and what follows the slash. */
export function slashQuery(text: string, caret: number): { start: number; query: string } | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const before = text.slice(lineStart, caret);
  const match = /(^|\s)\/([a-z]*)$/i.exec(before);
  if (!match) return null;
  const start = lineStart + (match.index ?? 0) + (match[1] ? match[1].length : 0);
  return { start, query: (match[2] ?? '').toLowerCase() };
}

/** Text with `[start, end)` replaced, and where the caret lands. */
export function replaceRange(
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; caret: number } {
  return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length };
}

/**
 * The markdown toolbar: a prefix on every selected line ('# ', '- ',
 * '- [ ] '), toggled off when every line already has it.
 */
export function toggleLinePrefix(
  text: string,
  selStart: number,
  selEnd: number,
  prefix: string,
): { text: string; selStart: number; selEnd: number } {
  const from = text.lastIndexOf('\n', selStart - 1) + 1;
  const nextBreak = text.indexOf('\n', selEnd);
  const to = nextBreak < 0 ? text.length : nextBreak;
  const lines = text.slice(from, to).split('\n');
  const all = lines.every((l) => l.startsWith(prefix));
  const changed = lines.map((l) => (all ? l.slice(prefix.length) : prefix + l)).join('\n');
  const delta = changed.length - (to - from);
  return {
    text: text.slice(0, from) + changed + text.slice(to),
    selStart: Math.max(from, selStart + (all ? -prefix.length : prefix.length)),
    selEnd: Math.max(from, selEnd + delta),
  };
}

/** Bold or italic around the selection (or an empty pair at the caret). */
export function wrapSelection(
  text: string,
  selStart: number,
  selEnd: number,
  marker: string,
): { text: string; selStart: number; selEnd: number } {
  const inner = text.slice(selStart, selEnd);
  return {
    text: text.slice(0, selStart) + marker + inner + marker + text.slice(selEnd),
    selStart: selStart + marker.length,
    selEnd: selEnd + marker.length,
  };
}

/* =============================================================== chat == */

export type AnswerPart = { kind: 'text'; text: string } | { kind: 'cite'; citation: ChatCitation };

/** An answer's text with each "[12:31 Dana Reyes]" it cites made into a part of its own. */
export function splitCitations(answer: string, citations: readonly ChatCitation[]): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let rest = answer;
  const labels = citations.filter((c) => c.label);
  while (rest.length) {
    let at = -1;
    let hit: ChatCitation | null = null;
    for (const c of labels) {
      const i = rest.indexOf(c.label);
      if (i >= 0 && (at < 0 || i < at)) {
        at = i;
        hit = c;
      }
    }
    if (!hit || at < 0) {
      parts.push({ kind: 'text', text: rest });
      break;
    }
    if (at > 0) parts.push({ kind: 'text', text: rest.slice(0, at) });
    parts.push({ kind: 'cite', citation: hit });
    rest = rest.slice(at + hit.label.length);
  }
  return parts;
}

/* ============================================================ meeting == */

/** The meeting page's subtabs, in order; `?tab=` picks one. */
export const WORKSPACE_TABS = ['notes', 'transcript', 'chat', 'people', 'share'] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

const STATUS_WORDS: Record<MeetingStatus, string> = {
  scheduled: 'Not started',
  recording: 'Recording',
  paused: 'Paused',
  processing: 'Writing notes',
  ready: 'Notes ready',
  failed: 'Notes failed',
  discarded: 'Discarded',
};

export function statusWords(status: MeetingStatus | null): string {
  return status ? (STATUS_WORDS[status] ?? status) : 'From Granola';
}

/** The meeting app a join link belongs to. */
export function platformOf(url: string | null | undefined): MeetingPlatform | null {
  if (!url) return null;
  if (/meet\.google\.com/i.test(url)) return 'meet';
  if (/zoom\.us/i.test(url)) return 'zoom';
  if (/teams\.(microsoft|live)\.com/i.test(url)) return 'teams';
  return 'other';
}

/** "4 min" or "1 h 12 min" for a recorded length. */
export function lengthWords(ms: number | null | undefined): string | null {
  if (!ms || ms < 1000) return null;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** The bare domain of an address, lowercased. */
export function domainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  return at < 0 ? null : email.slice(at + 1).toLowerCase();
}
