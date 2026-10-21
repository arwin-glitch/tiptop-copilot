'use client';

import * as React from 'react';
import {
  dayNumber,
  monthStartOf,
  packItemOf,
  packWeek,
  shortTime,
  weekdayShort,
} from '@/lib/calendar/grid';
import type { CalendarInfo, RangeEvent } from '@/lib/calendar/range-types';
import { cn } from '@/lib/util/cn';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { chipLabel, chipStyle, HOLD_TAG_CLASS, swatchStyle } from './event-style';

/**
 * The Month view: whole weeks, each day with as many events as fit and a
 * "+N more" that lists the rest, packed the way Google Calendar packs them
 * (lib/calendar/grid.ts, packWeek). Events that run over several days are
 * bars; a timed event on one day is a dot, its time and its title. With
 * editing on, drag an event to another day to move it, or click an empty
 * part of a day to add an all-day event there.
 */

const LANE_PX = 20;

const longDay = (dateKey: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${dateKey}T12:00:00Z`));
const DRAG_THRESHOLD_PX = 4;

export function MonthGrid({
  weeks,
  monthOf,
  events,
  timeZone,
  today,
  calendars,
  canEdit,
  compact,
  onOpen,
  onPickDay,
  onCreateAllDay,
  onShiftDays,
}: {
  weeks: string[][];
  /** Any day of the month shown: days outside it are drawn quieter. */
  monthOf: string;
  events: RangeEvent[];
  timeZone: string;
  today: string;
  calendars: ReadonlyMap<string, CalendarInfo>;
  canEdit: boolean;
  /** A phone: fewer lanes per day, and titles rather than times. */
  compact: boolean;
  onOpen: (event: RangeEvent) => void;
  onPickDay: (day: string) => void;
  onCreateAllDay: (day: string) => void;
  onShiftDays: (event: RangeEvent, days: number) => void;
}) {
  // As many events a day as fit without the page scrolling: a six-week month
  // has shorter days. The rest are behind "+N more", as in Google Calendar.
  const maxLanes = compact ? 2 : weeks.length > 5 ? 3 : 4;
  const month = monthStartOf(monthOf).slice(0, 7);
  const byKey = React.useMemo(() => new Map(events.map((e) => [e.key, e])), [events]);
  const items = React.useMemo(
    () =>
      events
        .map((e) => packItemOf(e, timeZone))
        .filter((i): i is NonNullable<typeof i> => i !== null),
    [events, timeZone],
  );
  const gridRef = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{
    event: RangeEvent;
    from: string;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const [hover, setHover] = React.useState<{ key: string; day: string } | null>(null);

  const dayAt = (clientX: number, clientY: number): string | null => {
    const el = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-date]');
    return el?.dataset.date ?? null;
  };

  return (
    <div
      ref={gridRef}
      className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] select-none"
      data-tour="calendar-entries"
      data-calendar-view="month"
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD_PX) return;
        if (!d.moved) gridRef.current?.setPointerCapture(e.pointerId);
        d.moved = true;
        const day = dayAt(e.clientX, e.clientY);
        if (day) setHover({ key: d.event.key, day });
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (gridRef.current?.hasPointerCapture(e.pointerId)) {
          gridRef.current.releasePointerCapture(e.pointerId);
        }
        const target = hover?.day;
        setHover(null);
        if (d?.moved && target && target !== d.from) {
          const delta = Math.round((Date.parse(target) - Date.parse(d.from)) / 86_400_000);
          if (delta) onShiftDays(d.event, delta);
        }
      }}
      onPointerCancel={() => {
        drag.current = null;
        setHover(null);
      }}
    >
      <div className="grid grid-cols-7 border-b border-[var(--border)]" aria-hidden>
        {weeks[0]?.map((d) => (
          <div
            key={d}
            className="text-micro py-1.5 text-center font-medium tracking-wide text-[var(--fg-muted)] uppercase"
          >
            {weekdayShort(d)}
          </div>
        ))}
      </div>
      {weeks.map((week) => {
        const packed = packWeek(items, week, maxLanes);
        return (
          <div
            key={week[0]}
            className="relative grid grid-cols-7 border-b border-[var(--border)] last:border-b-0"
            style={{ height: 26 + maxLanes * LANE_PX + 6 }}
          >
            {week.map((d) => (
              <div
                key={d}
                data-date={d}
                onClick={(e) => {
                  if (canEdit && e.target === e.currentTarget) onCreateAllDay(d);
                }}
                className={cn(
                  'border-l border-[var(--border)] first:border-l-0',
                  d.slice(0, 7) !== month && 'bg-[var(--bg-sunken)]/40',
                  hover?.day === d && 'bg-[var(--accent-soft)]',
                  canEdit && 'cursor-cell',
                )}
              >
                <button
                  type="button"
                  onClick={() => onPickDay(d)}
                  aria-label={`${new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${d}T12:00:00Z`))}${d === today ? ', today' : ''}`}
                  aria-current={d === today ? 'date' : undefined}
                  className={cn(
                    'mx-auto mt-1 flex size-6 items-center justify-center rounded-full text-xs tabular-nums hover:bg-[var(--bg-hover)]',
                    d.slice(0, 7) !== month && 'text-[var(--fg-subtle)]',
                    d === today &&
                      'bg-[var(--primary)] font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover)]',
                  )}
                >
                  {dayNumber(d)}
                </button>
              </div>
            ))}

            {packed.segments.map((s) => {
              const event = byKey.get(s.key);
              if (!event) return null;
              const bar =
                s.endCol > s.startCol ||
                event.allDay ||
                !event.startsAt ||
                s.continuesBefore ||
                s.continuesAfter;
              const editable = canEdit && event.canModify;
              const when =
                event.allDay || !event.startsAt ? 'all day' : shortTime(event.startsAt, timeZone);
              return (
                <button
                  key={`${s.key}-${s.startCol}`}
                  type="button"
                  data-event-chip
                  onPointerDown={(e) => {
                    if (!editable || e.button !== 0 || e.pointerType === 'touch') return;
                    drag.current = {
                      event,
                      from: week[s.startCol]!,
                      x: e.clientX,
                      y: e.clientY,
                      moved: false,
                    };
                  }}
                  onClick={() => onOpen(event)}
                  aria-label={chipLabel(event, when, calendars.get(event.calendarId)?.name ?? null)}
                  className={cn(
                    'absolute flex items-center gap-1 truncate rounded-[4px] px-1 text-left text-[11.5px] leading-[18px] focus-visible:outline-2 focus-visible:outline-[var(--focus)]',
                    bar
                      ? 'border font-medium'
                      : 'border border-transparent hover:bg-[var(--bg-hover)]',
                    editable && 'cursor-grab',
                    s.continuesBefore && 'rounded-l-none',
                    s.continuesAfter && 'rounded-r-none',
                    hover?.key === s.key && 'opacity-60',
                  )}
                  style={{
                    top: 28 + s.lane * LANE_PX,
                    left: `calc(${(s.startCol / 7) * 100}% + 2px)`,
                    width: `calc(${((s.endCol - s.startCol + 1) / 7) * 100}% - 4px)`,
                    ...(bar ? chipStyle(event) : {}),
                  }}
                >
                  {!bar ? (
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full border"
                      style={swatchStyle(event.color.background, !event.verdict.meeting)}
                    />
                  ) : null}
                  {!bar && !compact ? (
                    <span className="shrink-0 text-[var(--fg-muted)] tabular-nums">{when}</span>
                  ) : null}
                  <span
                    className={cn(
                      'min-w-0 truncate',
                      !bar &&
                        (event.verdict.meeting
                          ? 'font-medium text-[var(--fg)]'
                          : 'text-[var(--fg-muted)]'),
                    )}
                  >
                    {event.title}
                  </span>
                  {event.hold && !compact ? <span className={HOLD_TAG_CLASS}>Hold</span> : null}
                </button>
              );
            })}

            {packed.more.map((m) => {
              const day = week[m.col]!;
              const all = events
                .filter((e) => {
                  const item = packItemOf(e, timeZone);
                  return item && item.startKey <= day && day < item.endKey;
                })
                .sort((a, b) => (a.startsAt ?? '').localeCompare(b.startsAt ?? ''));
              return (
                <Popover key={`more-${m.col}`}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label={`${m.count} more on ${longDay(day)}`}
                      className="text-micro absolute truncate rounded px-1 text-left font-medium text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
                      style={{
                        top: 28 + (maxLanes - 1) * LANE_PX,
                        left: `calc(${(m.col / 7) * 100}% + 2px)`,
                        width: `calc(${100 / 7}% - 4px)`,
                      }}
                    >
                      +{m.count} more
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-64">
                    <p className="mb-1.5 px-1 text-sm font-medium">
                      {new Intl.DateTimeFormat('en-US', {
                        timeZone: 'UTC',
                        weekday: 'long',
                        month: 'short',
                        day: 'numeric',
                      }).format(new Date(`${day}T12:00:00Z`))}
                    </p>
                    <ul className="space-y-0.5">
                      {all.map((e) => (
                        <li key={e.key}>
                          <button
                            type="button"
                            onClick={() => onOpen(e)}
                            className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-sm hover:bg-[var(--bg-hover)]"
                          >
                            <span
                              aria-hidden
                              className="size-2 shrink-0 rounded-full border"
                              style={swatchStyle(e.color.background, !e.verdict.meeting)}
                            />
                            <span className="shrink-0 text-xs text-[var(--fg-muted)] tabular-nums">
                              {e.allDay || !e.startsAt
                                ? 'All day'
                                : shortTime(e.startsAt, timeZone)}
                            </span>
                            <span className="min-w-0 truncate">{e.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </PopoverContent>
                </Popover>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
