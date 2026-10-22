import type { MeetingNotesOutput } from '@/lib/ai/prompts/meeting-notes';
import { formatOffset } from '@/lib/notes/api';
import type { ActionItem, ChatCitation, EnhancedBlock, SegmentRange } from '@/lib/types/notes';
import { carriedTaskId, clip } from './draft';

/**
 * What a model's notes may become (D-076). The model writes; the code checks:
 *
 * - Typed lines are the person's words, put back by the app from the notepad
 *   (the model only says where each goes). A typed line the model left out
 *   is kept anyway, at the top, so nothing typed is ever lost.
 * - Every point cites transcript lines that exist. A range is trimmed to the
 *   lines that exist; a bullet or paragraph left with none is dropped.
 * - An action item's owner is a voice of this meeting, named the way the
 *   People tab names it, never the way the transcript spelled it. The
 *   principal's own promises are flagged.
 * - A due date is a real YYYY-MM-DD or nothing.
 * - Lengths are capped; empty headings go.
 *
 * Pure and client-safe, so the same rules are tested without a model.
 */

export interface AssemblySpeaker {
  name: string;
  email: string | null;
  /** The principal's (Nick's) own voice. */
  isPrincipal: boolean;
}

export interface AssemblyInput {
  output: MeetingNotesOutput;
  /** parseTypedNotes(userNotes), in order: typed_index n is typed[n]. */
  typed: readonly EnhancedBlock[];
  /** Every final line's seq. */
  seqs: readonly number[];
  speakers: ReadonlyMap<string, AssemblySpeaker>;
  previous?: readonly ActionItem[];
}

const BLOCK_MAX = 600;
const HEADING_MAX = 120;
const ACTION_MAX = 300;
const MAX_BLOCKS = 120;
const MAX_ACTIONS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A model's ranges, trimmed to lines that exist, merged and sorted. */
export function cleanRanges(
  ranges: readonly { from_seq: number; to_seq: number }[],
  seqs: readonly number[],
): SegmentRange[] {
  const sorted = [...new Set(seqs)].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const out: SegmentRange[] = [];
  for (const r of ranges.slice(0, 20)) {
    const lo = Math.min(r.from_seq, r.to_seq);
    const hi = Math.max(r.from_seq, r.to_seq);
    const inside = sorted.filter((s) => s >= lo && s <= hi);
    if (inside.length === 0) continue;
    out.push({ fromSeq: inside[0] as number, toSeq: inside[inside.length - 1] as number });
  }
  out.sort((a, b) => a.fromSeq - b.fromSeq);
  const merged: SegmentRange[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.fromSeq <= last.toSeq + 1) last.toSeq = Math.max(last.toSeq, r.toSeq);
    else merged.push({ ...r });
  }
  return merged.slice(0, 8);
}

function validDate(value: string | null): string | null {
  if (!value || !DATE_RE.test(value)) return null;
  const at = Date.parse(`${value}T12:00:00Z`);
  return Number.isNaN(at) ? null : value;
}

function depthOf(n: number): 0 | 1 | 2 {
  return n <= 0 ? 0 : n >= 2 ? 2 : 1;
}

export function assembleNotes(input: AssemblyInput): {
  blocks: EnhancedBlock[];
  actionItems: ActionItem[];
} {
  const used = new Set<number>();
  const body: EnhancedBlock[] = [];
  let n = 0;
  for (const raw of input.output.blocks.slice(0, MAX_BLOCKS * 2)) {
    if (raw.typed_index !== null && raw.typed_index !== undefined) {
      const typed = input.typed[raw.typed_index];
      if (typed && !used.has(raw.typed_index)) {
        used.add(raw.typed_index);
        body.push({ ...typed });
      }
      continue;
    }
    const text = raw.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (raw.kind === 'heading') {
      body.push({
        id: `ai-${n++}`,
        kind: 'heading',
        text: clip(text.replace(/^#+\s*/, ''), HEADING_MAX),
        depth: 0,
        source: 'ai',
        sources: [],
      });
      continue;
    }
    const sources = cleanRanges(raw.sources, input.seqs);
    if (sources.length === 0) continue;
    body.push({
      id: `ai-${n++}`,
      kind: raw.kind,
      text: clip(text.replace(/^[-*•]\s+/, ''), BLOCK_MAX),
      depth: depthOf(raw.depth),
      source: 'ai',
      sources,
    });
  }
  // A typed line the model left out is kept, at the top, in the order typed.
  const missing = input.typed.filter((_, index) => !used.has(index));
  const ordered = [...missing.map((b) => ({ ...b })), ...body];
  // Headings with nothing under them go.
  const blocks = ordered
    .filter((b, i) => {
      if (b.kind !== 'heading' || b.source === 'typed') return true;
      const next = ordered[i + 1];
      return Boolean(next && next.kind !== 'heading');
    })
    .slice(0, MAX_BLOCKS);

  const previous = input.previous ?? [];
  const ids = new Map<string, number>();
  const actionItems: ActionItem[] = [];
  for (const raw of input.output.action_items.slice(0, MAX_ACTIONS * 2)) {
    const text = clip(raw.text.replace(/\s+/g, ' ').trim(), ACTION_MAX);
    if (!text) continue;
    const sources = cleanRanges(raw.sources, input.seqs);
    if (sources.length === 0) continue;
    const ownerKey =
      raw.owner_cluster_key && input.speakers.has(raw.owner_cluster_key)
        ? raw.owner_cluster_key
        : null;
    const owner = ownerKey ? input.speakers.get(ownerKey) : undefined;
    const base = `ai-action-${sources[0]?.fromSeq ?? 0}`;
    const count = ids.get(base) ?? 0;
    ids.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    actionItems.push({
      id,
      text,
      ownerEmail: owner?.email ?? null,
      ownerName: owner?.name ?? null,
      ownerClusterKey: ownerKey,
      due: validDate(raw.due),
      isPrincipalPromise: Boolean(owner?.isPrincipal),
      taskId: carriedTaskId(previous, id, text),
      sources,
    });
    if (actionItems.length >= MAX_ACTIONS) break;
  }
  return { blocks, actionItems };
}

/**
 * Action items after a voice was renamed, split or merged: the same items,
 * with each owner read again from the voices as they are now. No model call.
 */
export function reownActionItems(
  items: readonly ActionItem[],
  speakers: ReadonlyMap<string, AssemblySpeaker>,
  moved: ReadonlyMap<string, string> = new Map(),
): ActionItem[] {
  return items.map((item) => {
    const key = item.ownerClusterKey
      ? (moved.get(item.ownerClusterKey) ?? item.ownerClusterKey)
      : null;
    const owner = key ? speakers.get(key) : undefined;
    if (!key || !owner) return item;
    return {
      ...item,
      ownerClusterKey: key,
      ownerName: owner.name,
      ownerEmail: owner.email,
      isPrincipalPromise: owner.isPrincipal,
    };
  });
}

/* ============================================================== chat == */

export interface ChatMeetingRef {
  meetingId: string;
  title: string;
  /** seq → the line's time and speaker. */
  lines: ReadonlyMap<number, { startMs: number; speaker: string }>;
}

const MARKER_RE = /\[\[M(\d{1,3})\.(L(\d{1,7})|N)\]\]/g;

/**
 * The model's [[M0.L12]] and [[M0.N]] markers, turned into "[12:31 Dana
 * Reyes]" and "[notes: <title>]" labels with the lines they cite. A marker
 * for a line or meeting the model was not shown is removed, never trusted.
 */
export function resolveChatCitations(
  answer: string,
  meetings: readonly ChatMeetingRef[],
): { answer: string; citations: ChatCitation[] } {
  const citations: ChatCitation[] = [];
  const seen = new Set<string>();
  const text = answer.replace(MARKER_RE, (_, index: string, _what: string, seqText?: string) => {
    const meeting = meetings[Number(index)];
    if (!meeting) return '';
    if (!seqText) return `[notes: ${meeting.title}]`;
    const seq = Number(seqText);
    const line = meeting.lines.get(seq);
    if (!line) return '';
    const label = `[${formatOffset(line.startMs)} ${line.speaker}]`;
    const key = `${meeting.meetingId}:${seq}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({
        meetingId: meeting.meetingId,
        seq,
        startMs: line.startMs,
        speaker: line.speaker,
        label,
      });
    }
    return label;
  });
  return {
    answer: text
      .replace(/[ \t]+([.,;:!?])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .trim(),
    citations,
  };
}
