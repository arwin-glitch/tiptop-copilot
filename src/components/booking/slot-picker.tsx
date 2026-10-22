'use client';

import * as React from 'react';
import { dayKeyIn, dayLabel, timeLabel, type PublicSlot } from '@/lib/booking/public';
import { cn } from '@/lib/util/cn';

/**
 * The booking link's time picker (D-074, D-078): the days with open times
 * as chips, then that day's times as buttons, both radio groups ("Day",
 * "Time") in the visitor's zone. The booking page and the booking's own page
 * (to move it) share it, so a visitor sees the same picker in both places.
 */
export function SlotPicker({
  slots,
  zone,
  value,
  onChange,
  day,
  onDay,
}: {
  slots: readonly PublicSlot[];
  zone: string;
  /** The start picked, or null. */
  value: string | null;
  onChange: (start: string | null) => void;
  /** The day shown when no time is picked yet (a key in `zone`), or null for the first. */
  day: string | null;
  onDay: (day: string) => void;
}) {
  const days = React.useMemo(() => {
    const groups = new Map<string, PublicSlot[]>();
    for (const s of slots) {
      const k = dayKeyIn(s.start, zone);
      groups.set(k, [...(groups.get(k) ?? []), s]);
    }
    return [...groups.entries()];
  }, [slots, zone]);
  const pickedDay =
    (value ? dayKeyIn(value, zone) : null) ??
    (day && days.some(([k]) => k === day) ? day : null) ??
    days[0]?.[0] ??
    null;
  const dayTimes = days.find(([k]) => k === pickedDay)?.[1] ?? [];

  return (
    <>
      <div role="radiogroup" aria-label="Day" className="flex flex-wrap gap-2">
        {days.map(([k, times]) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={pickedDay === k}
            onClick={() => {
              onDay(k);
              if (value && dayKeyIn(value, zone) !== k) onChange(null);
            }}
            className={cn(
              'min-h-11 rounded-[var(--radius-card)] border px-3 py-1.5 text-left text-sm transition-colors',
              pickedDay === k
                ? 'border-[var(--primary)] bg-[var(--accent-soft)] font-medium text-[var(--fg)]'
                : 'border-[var(--border-strong)] bg-[var(--bg)] hover:bg-[var(--bg-hover)]',
            )}
          >
            <span className="block">{dayLabel(times[0]!.start, zone)}</span>
            <span className="block text-[11px] text-[var(--fg-subtle)]">{times.length} open</span>
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label="Time" className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {dayTimes.map((s) => (
          <button
            key={s.start}
            type="button"
            role="radio"
            aria-checked={value === s.start}
            onClick={() => onChange(s.start)}
            className={cn(
              'h-11 rounded-md border text-sm font-medium tabular-nums transition-colors',
              value === s.start
                ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-fg)]'
                : 'border-[var(--border-strong)] bg-[var(--bg)] hover:bg-[var(--bg-hover)]',
            )}
          >
            {timeLabel(s.start, zone)}
          </button>
        ))}
      </div>
    </>
  );
}
