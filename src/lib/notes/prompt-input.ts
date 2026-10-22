import type { UntrustedBlock } from '@/lib/security/injection';
import type { EnhancedBlock, TranscriptSegment } from '@/lib/types/notes';
import { formatOffset } from './api';

/**
 * How a meeting reaches the model (D-076): the transcript as numbered lines
 * ("L12 [3:04] Dana Reyes: …") and the typed notes as numbered lines ("T0
 * …"), each inside an <untrusted-content> fence (lib/security/injection.ts)
 * so spoken or typed words are read as data. The numbers are what the model
 * cites and what the app checks its citations against.
 *
 * Pure: the notes, cue and chat calls and the offline model share it.
 */

/** About 100,000 tokens of transcript; a longer meeting keeps its start and its end. */
export const MAX_TRANSCRIPT_CHARS = 400_000;

type Line = Pick<TranscriptSegment, 'seq' | 'cluster_key' | 'start_ms' | 'text' | 'edited_text'>;

export function transcriptRow(line: Line, name: string, prefix = ''): string {
  const text = (line.edited_text ?? line.text).replace(/\s+/g, ' ').trim();
  return `${prefix}L${line.seq} [${formatOffset(line.start_ms)}] ${name}: ${text}`;
}

/** Rows within the budget: all of them, or the first and last halves with a marker between. */
export function boundedRows(rows: readonly string[], maxChars = MAX_TRANSCRIPT_CHARS): string[] {
  const total = rows.reduce((n, r) => n + r.length + 1, 0);
  if (total <= maxChars) return [...rows];
  const half = Math.floor(maxChars / 2);
  const head: string[] = [];
  let used = 0;
  for (const r of rows) {
    if (used + r.length + 1 > half) break;
    head.push(r);
    used += r.length + 1;
  }
  const tail: string[] = [];
  used = 0;
  for (let i = rows.length - 1; i >= head.length; i -= 1) {
    const r = rows[i] as string;
    if (used + r.length + 1 > half) break;
    tail.unshift(r);
    used += r.length + 1;
  }
  const left = rows.length - head.length - tail.length;
  return [...head, `[… ${left} lines from the middle of the meeting are left out here …]`, ...tail];
}

/** The transcript as one fenced block. */
export function transcriptBlock(
  lines: readonly Line[],
  names: ReadonlyMap<string, string>,
  options: { prefix?: string; label?: string; sourceId?: string; maxChars?: number } = {},
): UntrustedBlock {
  const rows = [...lines]
    .sort((a, b) => a.seq - b.seq)
    .map((l) => transcriptRow(l, names.get(l.cluster_key) ?? 'Guest', options.prefix ?? ''));
  return {
    sourceId: options.sourceId ?? 'transcript',
    sourceKind: 'transcript',
    label: options.label ?? 'Meeting transcript',
    text: boundedRows(rows, options.maxChars).join('\n') || '(no transcript)',
  };
}

/** The typed notes as one fenced block of numbered lines, or null when nothing was typed. */
export function typedNotesBlock(typed: readonly EnhancedBlock[]): UntrustedBlock | null {
  if (typed.length === 0) return null;
  const rows = typed.map((b, i) => {
    const kind = b.kind === 'heading' ? '(heading) ' : b.kind === 'checkbox' ? '(to-do) ' : '';
    return `T${i} ${kind}${b.text}`;
  });
  return {
    sourceId: 'typed_notes',
    sourceKind: 'typed_notes',
    label: 'Notes typed during the meeting',
    text: rows.join('\n'),
  };
}
