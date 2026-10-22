import type { ActionItem, EnhancedBlock, TranscriptSegment } from '@/lib/types/notes';
import { addDaysToKey } from '@/lib/util/time';

/**
 * Notes built by rules, with no model (D-076): the typed notes word for word,
 * the lines that carry numbers or decisions, and the promises ("I'll…",
 * "we'll…", "let's…") as action items with their speaker as owner. Every
 * point links to the line it came from and nothing is invented.
 *
 * Two uses: the notes Copilot keeps when no model is available (production
 * without ANTHROPIC_API_KEY, a model failure, the daily budget spent), saved
 * with model 'none'; and the offline model's answer in demo mode
 * (lib/notes/mock-ai.ts), which goes through the same assembly as a real
 * answer. Pure and client-safe.
 */

export const DRAFT_PROMPT_VERSION = 'meeting-notes-draft@0.1.0';
export const DRAFT_MODEL = 'none';

/* ============================================================ typed == */

/** The notepad's markdown as blocks, kept word for word. Ids are `typed-<line index>`. */
export function parseTypedNotes(markdown: string | null | undefined): EnhancedBlock[] {
  if (!markdown) return [];
  const blocks: EnhancedBlock[] = [];
  markdown.split(/\r?\n/).forEach((raw, index) => {
    if (!raw.trim()) return;
    const indent = raw.match(/^\s*/)?.[0].replace(/\t/g, '  ').length ?? 0;
    const depth = Math.min(2, Math.floor(indent / 2)) as 0 | 1 | 2;
    const line = raw.trim();
    const id = `typed-${index}`;
    const heading = line.match(/^#{1,3}\s+(.*)$/);
    const box = line.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/);
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (heading?.[1]) {
      blocks.push({
        id,
        kind: 'heading',
        text: heading[1],
        depth: 0,
        source: 'typed',
        sources: [],
      });
    } else if (box?.[2]) {
      blocks.push({
        id,
        kind: 'checkbox',
        text: box[2],
        depth,
        source: 'typed',
        sources: [],
        checked: box[1] !== ' ',
      });
    } else if (bullet?.[1]) {
      blocks.push({ id, kind: 'bullet', text: bullet[1], depth, source: 'typed', sources: [] });
    } else {
      blocks.push({ id, kind: 'paragraph', text: line, depth, source: 'typed', sources: [] });
    }
  });
  return blocks;
}

/* ============================================================ draft == */

export interface DraftSpeaker {
  name: string;
  email: string | null;
  /** The principal's (Nick's) own voice: their promises are flagged. */
  isPrincipal: boolean;
}

export const KEY_POINT_RE =
  /(\d|\bmillion\b|\bthousand\b|\bpercent\b|\braising\b|\bround\b|\bcap\b|\bclose\b|\bdecid|\bagreed?\b|\brevenue\b|\bretention\b)/i;
export const PROMISE_RE = /\b(i'll|i will|we'll|we will|let's|let us)\b/i;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** A due date said in a line, as YYYY-MM-DD, relative to the meeting's day. */
export function dueFromText(text: string, meetingDay: string): string | null {
  const t = text.toLowerCase();
  if (/\btoday\b|\btonight\b|\bend of (the )?day\b/.test(t)) return meetingDay;
  if (/\btomorrow\b/.test(t)) return addDaysToKey(meetingDay, 1);
  if (/\bweek after next\b/.test(t)) return addDaysToKey(meetingDay, 14);
  if (/\bnext week\b/.test(t)) return addDaysToKey(meetingDay, 7);
  const day = WEEKDAYS.findIndex((d) => new RegExp(`\\b(by|on|this|next)?\\s*${d}\\b`).test(t));
  if (day >= 0) {
    const today = new Date(`${meetingDay}T12:00:00Z`).getUTCDay();
    const ahead = (day - today + 7) % 7 || 7;
    return addDaysToKey(meetingDay, ahead);
  }
  return null;
}

export function clip(text: string, max = 220): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

type DraftLine = Pick<TranscriptSegment, 'seq' | 'cluster_key' | 'text' | 'edited_text'>;

/** The lines a rules draft lifts as key points, and the promises it lifts as action items. */
export function draftPicks(segments: readonly DraftLine[]): {
  keyPoints: { seq: number; key: string; text: string }[];
  promises: { seq: number; key: string; text: string }[];
} {
  const lines = segments.map((s) => ({
    seq: s.seq,
    key: s.cluster_key,
    text: (s.edited_text ?? s.text).trim(),
  }));
  return {
    keyPoints: lines
      .filter((l) => KEY_POINT_RE.test(l.text) && !PROMISE_RE.test(l.text))
      .slice(0, 8),
    promises: lines.filter((l) => PROMISE_RE.test(l.text)).slice(0, 20),
  };
}

/**
 * Draft notes from the typed notes and the transcript. Pure: the caller
 * passes the lines (final ones, in order), the voices' names and the
 * meeting's day.
 */
export function draftNotes(input: {
  userNotes: string | null;
  segments: readonly DraftLine[];
  speakers: ReadonlyMap<string, DraftSpeaker>;
  meetingDay: string;
  previous?: readonly ActionItem[];
}): { blocks: EnhancedBlock[]; actionItems: ActionItem[] } {
  const blocks: EnhancedBlock[] = [...parseTypedNotes(input.userNotes)];
  const who = (key: string): DraftSpeaker =>
    input.speakers.get(key) ?? { name: 'Guest', email: null, isPrincipal: false };
  const { keyPoints, promises } = draftPicks(input.segments);

  if (keyPoints.length) {
    blocks.push({
      id: 'ai-key-points',
      kind: 'heading',
      text: 'Key points',
      depth: 0,
      source: 'ai',
      sources: [],
    });
    for (const l of keyPoints) {
      blocks.push({
        id: `ai-point-${l.seq}`,
        kind: 'bullet',
        text: `${who(l.key).name}: ${clip(l.text)}`,
        depth: 0,
        source: 'ai',
        sources: [{ fromSeq: l.seq, toSeq: l.seq }],
      });
    }
  }

  const previous = input.previous ?? [];
  const actionItems: ActionItem[] = promises.map((l) => {
    const owner = who(l.key);
    const id = `ai-action-${l.seq}`;
    const text = clip(l.text, 300);
    return {
      id,
      text,
      ownerEmail: owner.email,
      ownerName: owner.name,
      ownerClusterKey: l.key,
      due: dueFromText(l.text, input.meetingDay),
      isPrincipalPromise: owner.isPrincipal,
      taskId: carriedTaskId(previous, id, text),
      sources: [{ fromSeq: l.seq, toSeq: l.seq }],
    };
  });
  if (actionItems.length) {
    blocks.push({
      id: 'ai-actions',
      kind: 'heading',
      text: 'Action items',
      depth: 0,
      source: 'ai',
      sources: [],
    });
    for (const a of actionItems) {
      blocks.push({
        id: `ai-box-${a.id}`,
        kind: 'checkbox',
        text: `${a.ownerName ?? 'Someone'}: ${a.text}`,
        depth: 0,
        source: 'ai',
        sources: a.sources,
        checked: false,
      });
    }
  }
  return { blocks, actionItems };
}

const normalized = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The task already made from this action item before the notes were
 * regenerated: same id, else same words. "Add to Tasks" stays done.
 */
export function carriedTaskId(
  previous: readonly ActionItem[],
  id: string,
  text: string,
): string | null {
  const byId = previous.find((p) => p.id === id && p.taskId);
  if (byId) return byId.taskId;
  const want = normalized(text);
  return previous.find((p) => p.taskId && normalized(p.text) === want)?.taskId ?? null;
}

/** The notes as plain text, for the readers that show `meeting_notes.content`. */
export function notesAsText(
  blocks: readonly EnhancedBlock[],
  actionItems: readonly ActionItem[] = [],
): string {
  const body = blocks
    .map((b) => {
      const pad = '  '.repeat(b.depth);
      if (b.kind === 'heading') return `\n${b.text}`;
      if (b.kind === 'bullet') return `${pad}- ${b.text}`;
      if (b.kind === 'checkbox') return `${pad}[${b.checked ? 'x' : ' '}] ${b.text}`;
      return `${pad}${b.text}`;
    })
    .join('\n')
    .trim();
  // Action items the blocks do not already list as checkboxes.
  const listed = new Set(blocks.filter((b) => b.kind === 'checkbox').map((b) => b.id));
  const extra = actionItems.filter((a) => !listed.has(`ai-box-${a.id}`));
  if (extra.length === 0) return body;
  const items = extra
    .map(
      (a) => `- ${a.ownerName ? `${a.ownerName}: ` : ''}${a.text}${a.due ? ` (by ${a.due})` : ''}`,
    )
    .join('\n');
  return `${body}${body ? '\n\n' : ''}Action items\n${items}`.trim();
}
