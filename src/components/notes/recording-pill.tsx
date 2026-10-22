'use client';

import { Pause, Play, Square } from 'lucide-react';
import { formatOffset } from '@/lib/notes/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/util/cn';
import type { RecorderPhase } from './use-recorder';

/**
 * The persistent recording indicator: a red pill with the recorded time
 * (pauses excluded), plus Pause/Resume and Stop for the person recording.
 * Announced as a status, so a screen reader hears it start and stop.
 */
export function RecordingPill({
  phase,
  elapsedMs,
  canControl,
  onPause,
  onResume,
  onStop,
  className,
}: {
  phase: RecorderPhase;
  elapsedMs: number;
  canControl: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  className?: string;
}) {
  const live = phase === 'recording';
  const held = phase === 'paused' || phase === 'interrupted';
  if (!live && !held && phase !== 'stopping') return null;
  const words =
    phase === 'stopping'
      ? 'Stopping…'
      : phase === 'interrupted'
        ? 'Recording interrupted'
        : held
          ? 'Paused'
          : 'Recording';
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <span
        role="status"
        aria-live="polite"
        data-recording-pill={phase}
        className={cn(
          'inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold',
          live
            ? 'bg-[var(--danger)] text-[var(--danger-fg)]'
            : 'border border-[var(--danger)]/40 bg-[var(--danger-soft)] text-[var(--danger)]',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'size-2 rounded-full',
            live ? 'animate-pulse bg-[var(--danger-fg)]' : 'bg-[var(--danger)]',
          )}
        />
        {words}
        <span className="tabular font-mono text-xs">{formatOffset(elapsedMs)}</span>
      </span>
      {canControl && phase !== 'stopping' ? (
        <>
          {live ? (
            <Button size="sm" variant="secondary" onClick={onPause}>
              <Pause aria-hidden /> Pause
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={onResume}>
              <Play aria-hidden /> Resume
            </Button>
          )}
          <Button size="sm" variant="danger" onClick={onStop}>
            <Square aria-hidden /> Stop
          </Button>
        </>
      ) : null}
    </div>
  );
}
