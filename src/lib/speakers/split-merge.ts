import type { MeetingSpeaker, TranscriptSegment } from '@/lib/types/notes';
import { nextSplitKey } from '@/lib/transcribe/cluster';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Split and Merge (D-076), as plans: which lines move to which voice. Pure,
 * so the rules are tested apart from the store; lib/services/notes.ts applies
 * a plan as one speaker write plus one update of the lines.
 *
 * Split: "this line is someone else" (mode 'line') or "from here on it's
 * someone else" (mode 'from_here': that line and every later line of the same
 * voice). The lines move to a new voice, '<key>#2', which starts unresolved.
 * Merge: two voices are one person. Every line of `from` moves to `into`, and
 * `from` stays as a row pointing at `into`, so the merge can be explained.
 */

type SpeakerKey = Pick<MeetingSpeaker, 'cluster_key' | 'merged_into'>;
type SegmentKey = Pick<TranscriptSegment, 'seq' | 'cluster_key'>;

export interface SplitPlan {
  newClusterKey: string;
  moveSeqs: number[];
}

export function planSplit(
  speakers: readonly SpeakerKey[],
  segments: readonly SegmentKey[],
  request: { clusterKey: string; fromSeq: number; mode: 'line' | 'from_here' },
): Result<SplitPlan> {
  const speaker = speakers.find((s) => s.cluster_key === request.clusterKey);
  if (!speaker) return err('not_found', 'That voice is not in this meeting.');
  if (speaker.merged_into) {
    return err('conflict', 'That voice was merged into another; split that one instead.');
  }
  const line = segments.find((s) => s.seq === request.fromSeq);
  if (!line || line.cluster_key !== request.clusterKey) {
    return err('invalid_input', 'That line is not one of this voice’s lines.');
  }
  const moveSeqs =
    request.mode === 'line'
      ? [request.fromSeq]
      : segments
          .filter((s) => s.cluster_key === request.clusterKey && s.seq >= request.fromSeq)
          .map((s) => s.seq)
          .sort((a, b) => a - b);
  const newClusterKey = nextSplitKey(
    request.clusterKey,
    speakers.map((s) => s.cluster_key),
  );
  return ok({ newClusterKey, moveSeqs });
}

export interface MergePlan {
  moveSeqs: number[];
  /** Voices already merged into `from`, to point at `into` instead. */
  repoint: string[];
}

export function planMerge(
  speakers: readonly SpeakerKey[],
  segments: readonly SegmentKey[],
  from: string,
  into: string,
): Result<MergePlan> {
  if (from === into) return err('invalid_input', 'Pick two different voices.');
  const source = speakers.find((s) => s.cluster_key === from);
  const target = speakers.find((s) => s.cluster_key === into);
  if (!source || !target) return err('not_found', 'That voice is not in this meeting.');
  if (source.merged_into || target.merged_into) {
    return err('conflict', 'One of those voices was already merged into another.');
  }
  return ok({
    moveSeqs: segments
      .filter((s) => s.cluster_key === from)
      .map((s) => s.seq)
      .sort((a, b) => a - b),
    repoint: speakers.filter((s) => s.merged_into === from).map((s) => s.cluster_key),
  });
}
