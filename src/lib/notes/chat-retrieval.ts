import { clipText } from '@/lib/relay/soft-fields';
import type { ChatCitation, NotesLineRef } from '@/lib/types/notes';
import { formatOffset } from './api';
import { noBackticks } from './bridge-protocol';

/**
 * What a meeting chat question sends Arwin's routine (D-076, zero spend):
 * the transcript lines most likely to answer it, picked here with a small
 * BM25 ranking rather than by any model, within a character budget. Each line
 * goes out as [line_id, speaker, "m:ss", text] with an id like "M1.152"
 * (meeting 1 of the scope, line 152); the answer cites those ids in square
 * brackets and the app turns each into "[12:31 Dana Reyes]", a jump to that
 * moment. An id the routine was not sent is dropped, never trusted.
 *
 * Pure and client-safe.
 */

export interface RetrievalLine {
  meetingId: string;
  /** 1-based: M1 is the first meeting of the scope. */
  meetingIndex: number;
  seq: number;
  speaker: string;
  startMs: number;
  text: string;
}

export type ExcerptRow = [string, string, string, string];

const STOPWORDS = new Set(
  (
    'a an and are as at be but by did do does for from had has have he her his how i if in ' +
    'into is it its me my of on or our she so that the their them they this to us was we ' +
    'were what when where which who why will with you your about any can could would should ' +
    'just there then than been being also not no yes say said tell told get got'
  ).split(' '),
);

function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Lowercased words and numbers, stop words out, light stemming. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => !STOPWORDS.has(w) && (w.length > 1 || /\d/.test(w)))
    .map(stem);
}

/** Okapi BM25 of each document against the query's words. */
export function bm25Scores(
  docs: readonly (readonly string[])[],
  query: readonly string[],
  k1 = 1.2,
  b = 0.75,
): number[] {
  const terms = [...new Set(query)];
  if (docs.length === 0 || terms.length === 0) return docs.map(() => 0);
  const avg = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc))
      if (terms.includes(term)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  return docs.map((doc) => {
    if (doc.length === 0) return 0;
    let score = 0;
    for (const term of terms) {
      const n = df.get(term) ?? 0;
      if (n === 0) continue;
      let tf = 0;
      for (const w of doc) if (w === term) tf += 1;
      if (tf === 0) continue;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avg));
    }
    return score;
  });
}

/** Texts ranked against a question, best first; ties keep their order. Zero scores are kept last. */
export function rankTexts<T extends { text: string }>(items: readonly T[], question: string): T[] {
  const scores = bm25Scores(
    items.map((i) => tokenize(i.text)),
    tokenize(question),
  );
  return items
    .map((item, i) => ({ item, i, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.item);
}

export const EXCERPT_BUDGET_CHARS = 12_000;
const EXCERPT_LINE_MAX = 600;
const MAX_EXCERPTS = 80;
/** Fewer matching lines than this and a single meeting is sampled evenly as well. */
const MIN_MATCHES = 6;

export interface PickedExcerpts {
  excerpts: ExcerptRow[];
  lineMap: Record<string, NotesLineRef>;
  /** Lines that matched the question at all. */
  matched: number;
}

export const excerptId = (line: Pick<RetrievalLine, 'meetingIndex' | 'seq'>) =>
  `M${line.meetingIndex}.${line.seq}`;

/**
 * The lines to send: the best matches, each with the line before it for
 * context, then (for one meeting with few matches, as for "summarize this")
 * lines spread evenly across it, all within `budgetChars`, in meeting order.
 */
export function pickExcerpts(
  lines: readonly RetrievalLine[],
  question: string,
  options: { budgetChars?: number; fillEvenly?: boolean } = {},
): PickedExcerpts {
  const budget = options.budgetChars ?? EXCERPT_BUDGET_CHARS;
  const scores = bm25Scores(
    lines.map((l) => tokenize(l.text)),
    tokenize(question),
  );
  const index = new Map(lines.map((l, i) => [excerptId(l), i]));
  const chosen = new Set<number>();
  let used = 0;
  const rowFor = (line: RetrievalLine): ExcerptRow => [
    excerptId(line),
    noBackticks(line.speaker).trim() || 'Guest',
    formatOffset(line.startMs),
    clipText(noBackticks(line.text).replace(/\s+/g, ' ').trim(), EXCERPT_LINE_MAX),
  ];
  const take = (i: number): boolean => {
    if (chosen.has(i)) return true;
    if (chosen.size >= MAX_EXCERPTS) return false;
    const line = lines[i];
    if (!line) return false;
    const cost = JSON.stringify(rowFor(line)).length + 1;
    if (used + cost > budget) return false;
    used += cost;
    chosen.add(i);
    return true;
  };

  const ranked = scores
    .map((score, i) => ({ score, i }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  for (const { i } of ranked) {
    const line = lines[i] as RetrievalLine;
    const before = index.get(excerptId({ meetingIndex: line.meetingIndex, seq: line.seq - 1 }));
    if (!take(i)) break;
    if (before !== undefined) take(before);
  }
  if (options.fillEvenly && ranked.length < MIN_MATCHES && lines.length > 0) {
    const room = Math.max(0, Math.floor((budget - used) / 140));
    const step = Math.max(1, Math.ceil(lines.length / Math.max(1, room)));
    for (let i = 0; i < lines.length; i += step) if (!take(i)) break;
  }

  const picked = [...chosen]
    .map((i) => lines[i] as RetrievalLine)
    .sort((a, b) => a.meetingIndex - b.meetingIndex || a.seq - b.seq);
  const lineMap: Record<string, NotesLineRef> = {};
  for (const line of picked) {
    lineMap[excerptId(line)] = {
      meetingId: line.meetingId,
      fromSeq: line.seq,
      toSeq: line.seq,
      startMs: line.startMs,
      speaker: noBackticks(line.speaker).trim() || 'Guest',
    };
  }
  return { excerpts: picked.map(rowFor), lineMap, matched: ranked.length };
}

/* ========================================================= citations == */

const ID_LIST_RE = /\[\s*(M\d{1,3}\.\d{1,7}(?:\s*[,;]\s*M\d{1,3}\.\d{1,7})*)\s*\]/g;
const LABEL_RE = /\[(\d{1,2}(?::\d{2}){1,2}) ([^\]\n]{1,80})\]/g;

export function citationLabel(ref: NotesLineRef): string {
  return `[${formatOffset(ref.startMs ?? 0)} ${ref.speaker ?? 'Guest'}]`;
}

/**
 * The routine's answer with each cited id ("[M1.152]", "[M1.3, M2.40]")
 * turned into "[12:31 Dana Reyes]" and the citations those labels stand for.
 * Labels already in the text (an answer read before) are recognised too, so
 * reading an answer twice gives the same citations.
 */
export function resolveBridgeCitations(
  answer: string,
  lineMap: Readonly<Record<string, NotesLineRef>>,
): { answer: string; citations: ChatCitation[] } {
  const citations: ChatCitation[] = [];
  const seen = new Set<string>();
  const cite = (id: string, ref: NotesLineRef): string => {
    const label = citationLabel(ref);
    if (!seen.has(id) && ref.meetingId) {
      seen.add(id);
      citations.push({
        meetingId: ref.meetingId,
        seq: ref.fromSeq,
        startMs: ref.startMs ?? 0,
        speaker: ref.speaker ?? 'Guest',
        label,
      });
    }
    return label;
  };
  let text = answer.replace(ID_LIST_RE, (_match, list: string) =>
    list
      .split(/[,;]/)
      .map((id) => id.trim())
      .map((id) => {
        const ref = lineMap[id];
        return ref ? cite(id, ref) : '';
      })
      .filter(Boolean)
      .join(' '),
  );
  // Labels written before: matched back to the line they name.
  const byLabel = new Map<string, [string, NotesLineRef]>();
  for (const [id, ref] of Object.entries(lineMap)) {
    const label = citationLabel(ref);
    if (!byLabel.has(label)) byLabel.set(label, [id, ref]);
  }
  for (const match of text.matchAll(LABEL_RE)) {
    const hit = byLabel.get(match[0]);
    if (hit) cite(hit[0], hit[1]);
  }
  text = text
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  // Citations in the order their labels appear.
  citations.sort((a, b) => text.indexOf(a.label) - text.indexOf(b.label));
  return { answer: text, citations };
}
