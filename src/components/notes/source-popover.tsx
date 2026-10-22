'use client';

import { Quote } from 'lucide-react';
import { formatOffset } from '@/lib/notes/api';
import type { SegmentRange, SegmentView, SpeakerView } from '@/lib/types/notes';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { linesInRanges, speakerLookup } from './helpers';

/**
 * The small source mark on a note point: opens the transcript lines it came
 * from (on hover-capable screens and on a tap alike, as a popover), each one
 * a jump into the transcript at that moment.
 */
export function SourcePopover({
  ranges,
  segments,
  speakers,
  onJump,
  label,
}: {
  ranges: readonly SegmentRange[];
  segments: readonly SegmentView[];
  speakers: readonly SpeakerView[];
  onJump: (seq: number) => void;
  label: string;
}) {
  if (ranges.length === 0) return null;
  const lines = linesInRanges(segments, ranges);
  const resolve = speakerLookup(speakers);
  const first = ranges[0]?.fromSeq ?? 0;
  return (
    <Popover>
      <PopoverTrigger
        className="ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-[var(--border)] align-middle text-[var(--fg-subtle)] hover:border-[var(--gold)] hover:text-[var(--fg)]"
        aria-label={`Where this came from: ${label}`}
        title="Show the transcript lines behind this"
        data-source-trigger=""
      >
        <Quote className="size-2.5" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80" data-source-popover="">
        <p className="text-micro px-1 pb-1.5 font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
          From the transcript
        </p>
        {lines.length === 0 ? (
          <button
            type="button"
            onClick={() => onJump(first)}
            className="w-full rounded px-1 py-1 text-left text-sm text-[var(--accent)] hover:bg-[var(--bg-hover)]"
          >
            Those lines are further on. Open the transcript there.
          </button>
        ) : (
          <ul className="space-y-1">
            {lines.map((line) => (
              <li key={line.seq}>
                <button
                  type="button"
                  onClick={() => onJump(line.seq)}
                  className="w-full rounded px-1 py-1 text-left text-sm hover:bg-[var(--bg-hover)]"
                >
                  <span className="tabular font-mono text-[11px] text-[var(--fg-subtle)]">
                    {formatOffset(line.startMs)}
                  </span>{' '}
                  <span className="font-medium">{resolve(line.clusterKey).displayName}</span>
                  <span className="mt-0.5 block text-[var(--fg-muted)]">{line.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
