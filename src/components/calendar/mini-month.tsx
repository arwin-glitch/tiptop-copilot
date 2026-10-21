'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  addMonthsToKey,
  dayNumber,
  monthStartOf,
  monthWeeks,
  rangeLabel,
} from '@/lib/calendar/grid';
import { cn } from '@/lib/util/cn';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function longLabel(dateKey: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${dateKey}T12:00:00Z`));
}

/**
 * The little month in the sidebar (and in the date picker): any month, any
 * day, past or future, one tap to go there. The highlighted days are the
 * ones the main view is showing.
 */
export function MiniMonth({
  selected,
  today,
  highlight,
  onPick,
  className,
}: {
  selected: string;
  today: string;
  /** Day keys the main view shows, drawn softly. */
  highlight?: ReadonlySet<string>;
  onPick: (dateKey: string) => void;
  className?: string;
}) {
  const [month, setMonth] = React.useState(() => monthStartOf(selected));
  // Follow the main view when it moves to another month.
  const [lastSelected, setLastSelected] = React.useState(selected);
  if (lastSelected !== selected) {
    setLastSelected(selected);
    setMonth(monthStartOf(selected));
  }
  const weeks = monthWeeks(month);

  return (
    <div className={cn('select-none', className)}>
      <div className="mb-1 flex items-center justify-between gap-1">
        <p className="text-sm font-medium" aria-live="polite">
          {rangeLabel('month', month)}
        </p>
        <div className="flex">
          <button
            type="button"
            onClick={() => setMonth(addMonthsToKey(month, -1))}
            className="rounded-md p-1 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
            aria-label="Previous month"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setMonth(addMonthsToKey(month, 1))}
            className="rounded-md p-1 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
            aria-label="Next month"
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </div>
      </div>
      <table className="w-full table-fixed border-collapse text-center text-xs">
        <thead>
          <tr>
            {WEEKDAYS.map((d, i) => (
              <th key={i} scope="col" className="pb-1 font-normal text-[var(--fg-subtle)]">
                <span aria-hidden>{d}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((d) => {
                const inMonth = d.slice(0, 7) === month.slice(0, 7);
                const isToday = d === today;
                const isSelected = d === selected;
                return (
                  <td key={d} className="p-0">
                    <button
                      type="button"
                      onClick={() => onPick(d)}
                      aria-label={longLabel(d)}
                      aria-pressed={isSelected}
                      aria-current={isToday ? 'date' : undefined}
                      className={cn(
                        'mx-auto flex size-7 items-center justify-center rounded-full tabular-nums transition-colors',
                        inMonth ? 'text-[var(--fg)]' : 'text-[var(--fg-subtle)]',
                        highlight?.has(d) && !isSelected && 'bg-[var(--accent-soft)]',
                        isToday && !isSelected && 'font-semibold text-[var(--accent)]',
                        isSelected
                          ? 'bg-[var(--primary)] font-semibold text-[var(--primary-fg)]'
                          : 'hover:bg-[var(--bg-hover)]',
                      )}
                    >
                      {dayNumber(d)}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
