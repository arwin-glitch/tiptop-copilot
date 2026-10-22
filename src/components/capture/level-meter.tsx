import * as React from 'react';
import { cn } from '@/lib/util/cn';

/**
 * One track's loudness as a bar (D-076). Gold for the person at this
 * computer, emerald for the meeting, as in the transcript. A meter, so a
 * screen reader hears its value too.
 */
export function LevelMeter({
  label,
  level,
  tone = 'meeting',
  live = true,
  hint,
  testId,
}: {
  label: string;
  /** 0..1 */
  level: number;
  tone?: 'mic' | 'meeting';
  live?: boolean;
  hint?: React.ReactNode;
  testId?: string;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, level)) * 100);
  return (
    <div className="min-w-0" data-testid={testId} data-level={pct}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-note font-medium text-[var(--fg)]">{label}</span>
        {hint ? <span className="text-mini truncate text-[var(--fg-muted)]">{hint}</span> : null}
      </div>
      <div
        role="meter"
        aria-label={`${label} level`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className={cn(
          'h-2.5 w-full overflow-hidden rounded-full bg-[var(--chart-track)]',
          !live && 'opacity-50',
        )}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-100 ease-out motion-reduce:transition-none',
            tone === 'mic' ? 'bg-[var(--gold)]' : 'bg-[var(--accent)]',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
