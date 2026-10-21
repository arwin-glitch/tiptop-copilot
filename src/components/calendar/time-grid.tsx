'use client';

import * as React from 'react';
import { Bell } from 'lucide-react';
import {
  dayNumber,
  hourLabel,
  inAllDayRow,
  instantAt,
  layoutColumns,
  MINUTES_PER_DAY,
  packItemOf,
  packWeek,
  segmentOnDay,
  shortTime,
  snap,
  SNAP_MINUTES,
  weekdayShort,
} from '@/lib/calendar/grid';
import type { CalendarInfo, RangeEvent } from '@/lib/calendar/range-types';
import { cn } from '@/lib/util/cn';
import { localClock, localDateKey } from '@/lib/util/time';
import { chipLabel, chipStyle } from './event-style';

/**
 * The Day and Week views: an hour gutter, one column per day, an all-day row
 * on top and a line at the current time. Overlapping events share their
 * column side by side (lib/calendar/grid.ts, layoutColumns). With editing on,
 * as in Google Calendar: drag across empty time to create, drag an event to
 * move it (to another day too, in Week), drag its bottom edge to change its
 * length, all on a 15-minute snap. A plain click opens the event; on a touch
 * screen a tap does, and dragging is left to scrolling.
 */

export const HOUR_PX = 48;
const GUTTER_PX = 52;
const MIN_CHIP_PX = 18;
const DRAG_THRESHOLD_PX = 4;
const ALL_DAY_LANE_PX = 22;

export interface GridChange {
  start: Date;
  end: Date;
}

type Pending =
  | {
      mode: 'create';
      pointerId: number;
      x: number;
      y: number;
      day: string;
      anchor: number;
      touch: boolean;
    }
  | {
      mode: 'move';
      pointerId: number;
      x: number;
      y: number;
      event: RangeEvent;
      grab: number;
      durationMs: number;
    }
  | { mode: 'resize'; pointerId: number; x: number; y: number; event: RangeEvent };

type Drag =
  | { mode: 'create'; day: string; anchor: number; current: number }
  | {
      mode: 'move';
      event: RangeEvent;
      day: string;
      start: number;
      durationMs: number;
      grab: number;
    }
  | { mode: 'resize'; event: RangeEvent; end: Date };

export function TimeGrid({
  days,
  events,
  timeZone,
  today,
  nowMs,
  calendars,
  canEdit,
  onOpen,
  onCreate,
  onCreateAllDay,
  onChange,
  onShiftDays,
  onPickDay,
}: {
  days: string[];
  events: RangeEvent[];
  timeZone: string;
  today: string;
  /** Null until the page is in the browser, so the server and browser draw the same. */
  nowMs: number | null;
  calendars: ReadonlyMap<string, CalendarInfo>;
  canEdit: boolean;
  onOpen: (event: RangeEvent) => void;
  onCreate: (range: GridChange) => void;
  onCreateAllDay: (day: string) => void;
  onChange: (event: RangeEvent, next: GridChange) => void;
  onShiftDays: (event: RangeEvent, days: number) => void;
  onPickDay: (day: string) => void;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const pending = React.useRef<Pending | null>(null);
  const [drag, setDragState] = React.useState<Drag | null>(null);
  // The handlers read the drag from the ref (no stale closure); the render reads the state.
  const dragRef = React.useRef<Drag | null>(null);
  const setDrag = (next: Drag | null) => {
    dragRef.current = next;
    setDragState(next);
  };

  const editable = (e: RangeEvent) => canEdit && e.canModify;
  const single = days.length === 1;

  // Open on the working day: an hour before now on today, else 7am.
  const firstDay = days[0];
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const hour =
      nowMs !== null && days.includes(today)
        ? Math.max(0, Math.floor(minutesNow(nowMs, timeZone) / 60) - 1)
        : 7;
    el.scrollTop = hour * HOUR_PX;
    // Only when the days shown change, not every minute the clock moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstDay, days.length, nowMs === null]);

  const locate = React.useCallback(
    (clientX: number, clientY: number) => {
      const el = contentRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const minutes = Math.max(0, Math.min(MINUTES_PER_DAY, ((clientY - rect.top) / HOUR_PX) * 60));
      const width = (rect.width - GUTTER_PX) / days.length;
      const index = Math.max(
        0,
        Math.min(days.length - 1, Math.floor((clientX - rect.left - GUTTER_PX) / width)),
      );
      return { day: days[index]!, minutes };
    },
    [days],
  );

  const timed = events.filter((e) => !inAllDayRow(e) && e.startsAt);
  const allDay = events.filter((e) => inAllDayRow(e));

  // While dragging, the event is drawn where it would land, and the rest reflow round it.
  const shown = timed.map((e) => {
    if (!drag || drag.mode === 'create' || drag.event.key !== e.key) return e;
    if (drag.mode === 'resize') return { ...e, endsAt: drag.end.toISOString() };
    const start = instantAt(drag.day, drag.start, timeZone);
    return {
      ...e,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + drag.durationMs).toISOString(),
    };
  });

  function onPointerDownEmpty(e: React.PointerEvent<HTMLDivElement>) {
    if (!canEdit || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-event-chip]')) return;
    const at = locate(e.clientX, e.clientY);
    if (!at) return;
    pending.current = {
      mode: 'create',
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      day: at.day,
      anchor: at.minutes,
      touch: e.pointerType === 'touch',
    };
  }

  function onChipPointerDown(e: React.PointerEvent, event: RangeEvent) {
    if (!editable(event) || e.button !== 0 || e.pointerType === 'touch') return;
    e.stopPropagation();
    const at = locate(e.clientX, e.clientY);
    if (!at || !event.startsAt || !event.endsAt) return;
    const seg = segmentOnDay(event, at.day, timeZone);
    pending.current = {
      mode: 'move',
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      event,
      grab: seg ? at.minutes - seg.start : 0,
      durationMs: Date.parse(event.endsAt) - Date.parse(event.startsAt),
    };
  }

  function onHandlePointerDown(e: React.PointerEvent, event: RangeEvent) {
    if (!editable(event) || e.button !== 0 || e.pointerType === 'touch') return;
    e.stopPropagation();
    pending.current = { mode: 'resize', pointerId: e.pointerId, x: e.clientX, y: e.clientY, event };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const p = pending.current;
    const current = dragRef.current;
    if (p && !current) {
      if (p.mode === 'create' && p.touch) return;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD_PX) return;
      contentRef.current?.setPointerCapture(p.pointerId);
      const at = locate(e.clientX, e.clientY);
      if (!at) return;
      if (p.mode === 'create') {
        setDrag({ mode: 'create', day: p.day, anchor: p.anchor, current: at.minutes });
      } else if (p.mode === 'move') {
        setDrag({
          mode: 'move',
          event: p.event,
          day: at.day,
          start: snap(at.minutes - p.grab),
          durationMs: p.durationMs,
          grab: p.grab,
        });
      } else {
        setDrag({ mode: 'resize', event: p.event, end: new Date(Date.parse(p.event.endsAt!)) });
      }
      return;
    }
    if (!current) return;
    const at = locate(e.clientX, e.clientY);
    if (!at) return;
    if (current.mode === 'create') {
      setDrag({ ...current, current: at.minutes });
    } else if (current.mode === 'move') {
      const start = Math.max(
        0,
        Math.min(MINUTES_PER_DAY - SNAP_MINUTES, snap(at.minutes - current.grab)),
      );
      setDrag({ ...current, day: single ? current.day : at.day, start });
    } else {
      const startMs = Date.parse(current.event.startsAt!);
      const end = instantAt(at.day, snap(at.minutes), timeZone);
      const min = startMs + SNAP_MINUTES * 60_000;
      setDrag({ ...current, end: new Date(Math.max(min, end.getTime())) });
    }
  }

  function finish(e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) {
    const p = pending.current;
    const current = dragRef.current;
    pending.current = null;
    setDrag(null);
    if (contentRef.current?.hasPointerCapture(e.pointerId)) {
      contentRef.current.releasePointerCapture(e.pointerId);
    }
    if (cancelled) return;
    if (!current) {
      // A click (or a tap) on empty time: a one-hour event on the half hour.
      if (p?.mode === 'create') {
        const startMin = Math.min(MINUTES_PER_DAY - 60, Math.floor(p.anchor / 30) * 30);
        onCreate({
          start: instantAt(p.day, startMin, timeZone),
          end: instantAt(p.day, startMin + 60, timeZone),
        });
      }
      return;
    }
    if (current.mode === 'create') {
      const a = snap(Math.min(current.anchor, current.current));
      let b = snap(Math.max(current.anchor, current.current));
      if (b - a < SNAP_MINUTES) b = a + SNAP_MINUTES;
      onCreate({
        start: instantAt(current.day, a, timeZone),
        end: instantAt(current.day, b, timeZone),
      });
    } else if (current.mode === 'move') {
      const start = instantAt(current.day, current.start, timeZone);
      const end = new Date(start.getTime() + current.durationMs);
      if (start.getTime() !== Date.parse(current.event.startsAt!)) {
        onChange(current.event, { start, end });
      }
    } else if (current.end.getTime() !== Date.parse(current.event.endsAt!)) {
      onChange(current.event, {
        start: new Date(Date.parse(current.event.startsAt!)),
        end: current.end,
      });
    }
  }

  const columns = `${GUTTER_PX}px repeat(${days.length}, minmax(0, 1fr))`;
  const nowMin = nowMs !== null && days.includes(today) ? minutesNow(nowMs, timeZone) : null;

  return (
    <div
      className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]"
      data-tour="calendar-entries"
      data-calendar-view={single ? 'day' : 'week'}
    >
      {/* Day headings */}
      <div
        className="grid border-b border-[var(--border)]"
        style={{ gridTemplateColumns: columns }}
      >
        <div
          className="text-micro self-end px-1 pb-1 text-right text-[var(--fg-subtle)]"
          aria-hidden
        >
          {zoneShort(timeZone, nowMs)}
        </div>
        {days.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => onPickDay(d)}
            aria-label={`${new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${d}T12:00:00Z`))}${d === today ? ', today' : ''}`}
            aria-current={d === today ? 'date' : undefined}
            className="flex min-w-0 flex-col items-center gap-0.5 border-l border-[var(--border)] py-1.5 hover:bg-[var(--bg-hover)]"
          >
            <span
              className={cn(
                'text-micro font-medium tracking-wide uppercase',
                d === today ? 'text-[var(--accent)]' : 'text-[var(--fg-muted)]',
              )}
            >
              {weekdayShort(d)}
            </span>
            <span
              className={cn(
                'flex size-8 items-center justify-center rounded-full text-lg tabular-nums',
                d === today && 'bg-[var(--primary)] font-semibold text-[var(--primary-fg)]',
              )}
            >
              {dayNumber(d)}
            </span>
          </button>
        ))}
      </div>

      <AllDayRow
        days={days}
        events={allDay}
        timeZone={timeZone}
        columns={columns}
        calendars={calendars}
        canEdit={canEdit}
        maxLanes={single ? 6 : 3}
        onOpen={onOpen}
        onCreateAllDay={onCreateAllDay}
        onShiftDays={onShiftDays}
        onPickDay={onPickDay}
      />

      <div
        ref={scrollRef}
        className="relative h-[min(62dvh,40rem)] scrollbar-thin overflow-y-auto overscroll-contain sm:h-[min(68dvh,46rem)]"
      >
        <div
          ref={contentRef}
          className={cn('relative grid select-none', canEdit && 'cursor-cell')}
          style={{ gridTemplateColumns: columns, height: 24 * HOUR_PX }}
          onPointerDown={onPointerDownEmpty}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => finish(e, false)}
          onPointerCancel={(e) => finish(e, true)}
        >
          {/* Hour gutter */}
          <div className="relative" aria-hidden>
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              <span
                key={h}
                className="text-micro absolute right-1.5 -translate-y-1/2 text-[var(--fg-subtle)] tabular-nums"
                style={{ top: h * HOUR_PX }}
              >
                {hourLabel(h)}
              </span>
            ))}
          </div>

          {days.map((d) => {
            const segments = shown
              .map((event) => ({ event, seg: segmentOnDay(event, d, timeZone) }))
              .filter((s): s is { event: RangeEvent; seg: { start: number; end: number } } =>
                Boolean(s.seg),
              );
            const placements = layoutColumns(
              segments.map((s) => ({ key: s.event.key, start: s.seg.start, end: s.seg.end })),
            );
            const creating = drag?.mode === 'create' && drag.day === d ? drag : null;
            return (
              <div
                key={d}
                data-date={d}
                className={cn(
                  'relative border-l border-[var(--border)]',
                  d === today && 'bg-[var(--accent-soft)]/30',
                )}
                style={{
                  backgroundImage: 'linear-gradient(to bottom, var(--border) 1px, transparent 1px)',
                  backgroundSize: `100% ${HOUR_PX}px`,
                }}
              >
                {segments.map(({ event, seg }) => {
                  const place = placements.get(event.key)!;
                  const top = (seg.start / 60) * HOUR_PX;
                  const height = Math.max(MIN_CHIP_PX, ((seg.end - seg.start) / 60) * HOUR_PX - 1);
                  // The bottom edge to drag is on the day the event really ends.
                  const endsHere =
                    event.endsAt !== null &&
                    localDateKey(new Date(Date.parse(event.endsAt) - 1), timeZone) === d;
                  const dragging = drag && drag.mode !== 'create' && drag.event.key === event.key;
                  const when = `${shortTime(event.startsAt!, timeZone)} – ${shortTime(event.endsAt ?? event.startsAt!, timeZone)}`;
                  const past =
                    nowMs !== null && event.endsAt !== null && Date.parse(event.endsAt) < nowMs;
                  const compact = height < 34;
                  return (
                    <button
                      key={event.key}
                      type="button"
                      data-event-chip
                      onPointerDown={(e) => onChipPointerDown(e, event)}
                      onClick={() => onOpen(event)}
                      aria-label={chipLabel(
                        event,
                        when,
                        calendars.get(event.calendarId)?.name ?? null,
                      )}
                      className={cn(
                        'absolute overflow-hidden rounded-[5px] border px-1.5 text-left text-[12px] leading-tight transition-shadow focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]',
                        compact ? 'py-0' : 'py-0.5',
                        editable(event) && 'cursor-grab active:cursor-grabbing',
                        past && !dragging && 'opacity-75',
                      )}
                      style={{
                        top,
                        height,
                        left: `calc(${(place.col / place.cols) * 100}% + 1px)`,
                        width: `calc(${(place.span / place.cols) * 100}% - 3px)`,
                        ...chipStyle(event, { dragging: Boolean(dragging) }),
                      }}
                    >
                      <span
                        className={cn('flex min-w-0 items-start gap-1', compact && 'items-center')}
                      >
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate',
                            event.verdict.meeting ? 'font-semibold' : 'font-medium',
                          )}
                        >
                          {event.title}
                          {compact ? (
                            <span className="font-normal opacity-80">
                              , {shortTime(event.startsAt!, timeZone)}
                            </span>
                          ) : null}
                        </span>
                        {event.hold ? (
                          <span className="rounded-sm border border-current px-0.5 text-[10px] leading-none font-medium uppercase opacity-80">
                            Hold
                          </span>
                        ) : null}
                        {event.verdict.meeting ? (
                          <Bell className="mt-0.5 size-3 shrink-0 opacity-80" aria-hidden />
                        ) : null}
                      </span>
                      {!compact ? <span className="block truncate opacity-80">{when}</span> : null}
                      {editable(event) && endsHere ? (
                        <span
                          aria-hidden
                          onPointerDown={(e) => onHandlePointerDown(e, event)}
                          className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
                        />
                      ) : null}
                    </button>
                  );
                })}

                {creating ? (
                  <div
                    className="pointer-events-none absolute inset-x-0.5 rounded-[5px] border border-[var(--primary)] bg-[var(--primary)]/25 px-1.5 py-0.5 text-[12px] font-medium text-[var(--fg)]"
                    style={{
                      top: (snap(Math.min(creating.anchor, creating.current)) / 60) * HOUR_PX,
                      height: Math.max(
                        MIN_CHIP_PX,
                        (Math.max(
                          SNAP_MINUTES,
                          snap(Math.max(creating.anchor, creating.current)) -
                            snap(Math.min(creating.anchor, creating.current)),
                        ) /
                          60) *
                          HOUR_PX,
                      ),
                    }}
                  >
                    New event
                  </div>
                ) : null}

                {nowMin !== null && d === today ? (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 z-[4] h-0.5 bg-[var(--danger)]"
                    style={{ top: (nowMin / 60) * HOUR_PX }}
                  >
                    <span className="absolute -top-[5px] -left-[6px] size-3 rounded-full bg-[var(--danger)]" />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function minutesNow(nowMs: number, timeZone: string): number {
  const { hour, minute } = localClock(new Date(nowMs), timeZone);
  return hour * 60 + minute;
}

/** "CDT", for the gutter's corner: the zone the grid is drawn in. */
function zoneShort(timeZone: string, nowMs: number | null): string {
  if (nowMs === null) return '';
  return (
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(new Date(nowMs))
      .find((p) => p.type === 'timeZoneName')?.value ?? ''
  );
}

/* ------------------------------------------------------- the all-day row */

function AllDayRow({
  days,
  events,
  timeZone,
  columns,
  calendars,
  canEdit,
  maxLanes,
  onOpen,
  onCreateAllDay,
  onShiftDays,
  onPickDay,
}: {
  days: string[];
  events: RangeEvent[];
  timeZone: string;
  columns: string;
  calendars: ReadonlyMap<string, CalendarInfo>;
  canEdit: boolean;
  maxLanes: number;
  onOpen: (event: RangeEvent) => void;
  onCreateAllDay: (day: string) => void;
  onShiftDays: (event: RangeEvent, days: number) => void;
  onPickDay: (day: string) => void;
}) {
  const rowRef = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{ event: RangeEvent; col: number; x: number; moved: boolean } | null>(
    null,
  );
  const [offset, setOffset] = React.useState<{ key: string; days: number } | null>(null);
  const byKey = new Map(events.map((e) => [e.key, e]));
  const packed = packWeek(
    events
      .map((e) => packItemOf(e, timeZone))
      .filter((i): i is NonNullable<typeof i> => i !== null),
    days,
    maxLanes,
  );
  const lanes = Math.max(1, packed.lanes + (packed.more.length ? 1 : 0));
  const colOf = (clientX: number) => {
    const el = rowRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const width = (rect.width - GUTTER_PX) / days.length;
    return Math.max(
      0,
      Math.min(days.length - 1, Math.floor((clientX - rect.left - GUTTER_PX) / width)),
    );
  };

  return (
    <div
      ref={rowRef}
      className="relative grid border-b border-[var(--border)]"
      style={{ gridTemplateColumns: columns, minHeight: lanes * ALL_DAY_LANE_PX + 6 }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (!d.moved && Math.abs(e.clientX - d.x) < DRAG_THRESHOLD_PX) return;
        if (!d.moved) rowRef.current?.setPointerCapture(e.pointerId);
        d.moved = true;
        setOffset({ key: d.event.key, days: colOf(e.clientX) - d.col });
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (rowRef.current?.hasPointerCapture(e.pointerId))
          rowRef.current.releasePointerCapture(e.pointerId);
        const shift = offset?.days ?? 0;
        setOffset(null);
        if (d?.moved && shift !== 0) onShiftDays(d.event, shift);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setOffset(null);
      }}
    >
      <div className="text-micro self-center px-1 text-right text-[var(--fg-subtle)]">All day</div>
      {days.map((d) => (
        <div
          key={d}
          className={cn('border-l border-[var(--border)]', canEdit && 'cursor-cell')}
          onClick={(e) => {
            if (canEdit && e.target === e.currentTarget) onCreateAllDay(d);
          }}
        />
      ))}
      {packed.segments.map((s) => {
        const event = byKey.get(s.key);
        if (!event) return null;
        const shift = offset?.key === s.key ? offset.days : 0;
        const startCol = Math.max(0, Math.min(days.length - 1, s.startCol + shift));
        const endCol = Math.max(startCol, Math.min(days.length - 1, s.endCol + shift));
        const width = endCol - startCol + 1;
        const editable = canEdit && event.canModify;
        return (
          <button
            key={`${s.key}-${s.startCol}`}
            type="button"
            data-event-chip
            onPointerDown={(e) => {
              if (!editable || e.button !== 0 || e.pointerType === 'touch') return;
              drag.current = { event, col: colOf(e.clientX), x: e.clientX, moved: false };
            }}
            onClick={() => {
              if (!drag.current?.moved) onOpen(event);
            }}
            aria-label={chipLabel(event, 'all day', calendars.get(event.calendarId)?.name ?? null)}
            className={cn(
              'absolute truncate rounded-[5px] border px-1.5 text-left text-[12px] leading-[18px] font-medium focus-visible:outline-2 focus-visible:outline-[var(--focus)]',
              editable && 'cursor-grab',
              s.continuesBefore && 'rounded-l-none',
              s.continuesAfter && 'rounded-r-none',
            )}
            style={{
              top: 3 + s.lane * ALL_DAY_LANE_PX,
              left: `calc(${GUTTER_PX}px + (100% - ${GUTTER_PX}px) * ${startCol / days.length} + 2px)`,
              width: `calc((100% - ${GUTTER_PX}px) * ${width / days.length} - 4px)`,
              ...chipStyle(event, { dragging: shift !== 0 }),
            }}
          >
            {event.hold ? 'Hold · ' : ''}
            {event.title}
          </button>
        );
      })}
      {packed.more.map((m) => (
        <button
          key={`more-${m.col}`}
          type="button"
          onClick={() => onPickDay(days[m.col]!)}
          aria-label={`${m.count} more on ${new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${days[m.col]}T12:00:00Z`))}`}
          className="text-micro absolute truncate rounded px-1.5 text-left font-medium text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]"
          style={{
            top: 3 + (maxLanes - 1) * ALL_DAY_LANE_PX,
            left: `calc(${GUTTER_PX}px + (100% - ${GUTTER_PX}px) * ${m.col / days.length} + 2px)`,
            width: `calc((100% - ${GUTTER_PX}px) / ${days.length} - 4px)`,
          }}
        >
          +{m.count} more
        </button>
      ))}
    </div>
  );
}
