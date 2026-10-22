'use client';

import * as React from 'react';
import { Bell } from 'lucide-react';
import {
  dayNumber,
  hourLabel,
  inAllDayRow,
  instantAt,
  layoutOverlaps,
  MIN_CHIP_PX,
  MINUTES_PER_DAY,
  packItemOf,
  packWeek,
  segmentOnDay,
  type ChipPlacement,
  type FoldedChips,
  shortTime,
  snap,
  SNAP_MINUTES,
  weekdayShort,
} from '@/lib/calendar/grid';
import { eventLook, type EventLook } from '@/lib/calendar/event-look';
import { labelText } from '@/lib/calendar/labels';
import type { CalendarInfo, RangeEvent } from '@/lib/calendar/range-types';
import { cn } from '@/lib/util/cn';
import { addDaysToKey, localClock, localDateKey } from '@/lib/util/time';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  ASK_GLYPH_CLASS,
  chipLabel,
  chipStyle,
  dotStyle,
  HOLD_TAG_CLASS,
  titleStyle,
} from './event-style';

/**
 * The Day and Week views: an hour gutter, one column per day, an all-day row
 * on top and a line at the current time. Overlapping events are laid out as
 * Google Calendar does (lib/calendar/grid.ts, layoutOverlaps): events that
 * start together share the width side by side, and one that starts later is
 * drawn over the earlier one, shifted right and nearly full width, with a thin
 * outline in the page's colour. No chip is narrower than MIN_CHIP_PX on a
 * computer; when more than that fit, the rest fold into a "+N" that lists
 * them. With editing on,
 * as in Google Calendar: drag across empty time to create, drag an event to
 * move it (to another day too, in Week), drag its bottom edge to change its
 * length, all on a 15-minute snap; drag across days in the all-day row for an
 * event over several days. The new event's placeholder stays drawn while its
 * quick editor is open beside it. A plain click opens the event's card; on a
 * touch screen a tap does, and dragging is left to scrolling.
 *
 * Titles wrap over as many lines as the event's height allows, with the time
 * below when there is room (and the event's colour label after it). A title
 * never breaks inside a word: a word too long for its chip ends in an
 * ellipsis, a narrow chip shows only the start of its title, and a sliver on
 * a phone only its colour. Each chip is drawn in its look (event-style.ts):
 * faded once over, outlined with a "?" while Nick has not answered, striped
 * for maybe, struck through when declined; a meeting has the bell.
 */

export const HOUR_PX = 48;
const GUTTER_PX = 52;
const MIN_CHIP_HEIGHT_PX = 18;
const DRAG_THRESHOLD_PX = 4;
const ALL_DAY_LANE_PX = 22;
/** One line of a chip's 12px text, for how many lines of title fit. */
const CHIP_LINE_PX = 15;
/** The room between a chip and its neighbour, in px (1px left, 2px right). */
const CHIP_GAP_PX = 3;
/** Narrower than this a chip shows one line of title; narrower still, only its colour. */
const ONE_LINE_CHIP_PX = 52;
const COLOUR_ONLY_CHIP_PX = 16;
/**
 * The least room a title needs to wrap over words (about six letters): with
 * less, most words would end in an ellipsis one under another ("D… S… c…"),
 * so it takes one line instead.
 */
const MIN_WRAP_TITLE_PX = 44;
/** A chip's padding and border either side of its title, and the Hold tag and bell beside it. */
const CHIP_INSET_PX = 14;
const NARROW_CHIP_INSET_PX = 6;
const HOLD_TAG_PX = 32;
const BELL_PX = 16;
const ASK_GLYPH_PX = 18;
/**
 * Chips stack by start (1 up); a chip being dragged goes above them all, under
 * only the new event's placeholder (900) and the time line (910). A focused
 * chip keeps its place in the stack: raised, a long block would cover every
 * meeting drawn over it, as it would whenever its card closed with Esc and
 * gave it focus back. The grid is its own stacking context, so none of this
 * reaches past it.
 */
const Z_DRAGGING = 920;
/** Where a dragged event is drawn: across the column, on top. */
const FULL_WIDTH: ChipPlacement = { left: 0, width: 1, z: Z_DRAGGING, depth: 0, cascaded: false };

/** A title as words, each kept whole: one too long for the chip ends in an ellipsis. */
function TitleWords({ title }: { title: string }) {
  const words = title.split(/\s+/).filter(Boolean);
  return (
    <>
      {words.map((word, i) => (
        <React.Fragment key={i}>
          {i ? ' ' : null}
          <span className="inline-block max-w-full truncate align-top">{word}</span>
        </React.Fragment>
      ))}
    </>
  );
}

export interface GridChange {
  start: Date;
  end: Date;
}

/** The new event being made, drawn while its quick editor is open. */
export interface PendingSlot {
  allDay: boolean;
  /** Timed: instants. All-day: `YYYY-MM-DD`, end exclusive. */
  start: string;
  end: string;
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
      carried: boolean;
    }
  | { mode: 'resize'; pointerId: number; x: number; y: number; event: RangeEvent };

type Drag =
  | { mode: 'create'; day: string; anchor: number; current: number }
  | {
      mode: 'move';
      event: RangeEvent;
      day: string;
      /** Minutes past the day's midnight; below 0 on a piece carried over from the day before. */
      start: number;
      durationMs: number;
      grab: number;
      carried: boolean;
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
  pending: newSlot,
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
  /** The new event whose quick editor is open: its placeholder stays drawn. */
  pending: PendingSlot | null;
  /** A click on an event: its card opens beside the element clicked. */
  onOpen: (event: RangeEvent, element: HTMLElement) => void;
  onCreate: (range: GridChange) => void;
  /** One day, or the days dragged across (`endKey` exclusive). */
  onCreateAllDay: (day: string, endKey?: string) => void;
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

  // A day column's width, for the overlap layout's minimum chip width. Until
  // the page is in the browser a typical width stands in, the same on both
  // sides, so the server's page and the browser's first draw agree.
  const [columnPx, setColumnPx] = React.useState(single ? 640 : 120);
  React.useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    // What a chip's percentages are of: a column's inside, past its 1px left border.
    const measure = () => {
      const width = (el.getBoundingClientRect().width - GUTTER_PX) / days.length - 1;
      if (width > 0) setColumnPx(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [days.length]);
  // At least MIN_CHIP_PX drawn; on a phone's narrow week columns, two to a column.
  const minChipPx = Math.min(MIN_CHIP_PX + CHIP_GAP_PX, Math.floor(columnPx / 2));

  // Esc drops a drag where it started, as in Google Calendar; nothing is saved.
  const dragging = drag !== null;
  React.useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      pending.current = null;
      dragRef.current = null;
      setDragState(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragging]);

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

  /** Where a moved event starts: minutes before 0 fall on the evening before. */
  const moveStart = (day: string, minutes: number) =>
    minutes < 0
      ? instantAt(addDaysToKey(day, -1), MINUTES_PER_DAY + minutes, timeZone)
      : instantAt(day, minutes, timeZone);
  /**
   * A move keeps the event inside the day it is dropped on, as before; an
   * overnight event grabbed by its after-midnight piece may still begin the
   * evening before, so it moves by exactly the distance it was dragged.
   */
  const clampStart = (minutes: number, carried: boolean, durationMs: number) => {
    const lower = carried ? -Math.max(0, durationMs / 60_000 - SNAP_MINUTES) : 0;
    return Math.max(lower, Math.min(MINUTES_PER_DAY - SNAP_MINUTES, snap(minutes)));
  };

  const timed = events.filter((e) => !inAllDayRow(e) && e.startsAt);
  const allDay = events.filter((e) => inAllDayRow(e));
  const lookOf = (e: RangeEvent) => eventLook(e, { nowMs, today });

  // While dragging, the event is drawn where it would land, over the rest,
  // which keep the places they had (the layout below reads `timed`), so none
  // of them moves, and the dragged one never folds into a "+N", mid-drag.
  const draggedKey = drag && drag.mode !== 'create' ? drag.event.key : null;
  const shown = timed.map((e) => {
    if (!drag || drag.mode === 'create' || drag.event.key !== e.key) return e;
    if (drag.mode === 'resize') return { ...e, endsAt: drag.end.toISOString() };
    const start = moveStart(drag.day, drag.start);
    return {
      ...e,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + drag.durationMs).toISOString(),
    };
  });

  function onPointerDownEmpty(e: React.PointerEvent<HTMLDivElement>) {
    if (!canEdit || e.button !== 0) return;
    // A "+N" list is open: a press elsewhere on the grid only closes it, as in
    // Google. Asked of the page, not remembered, so a "+N" that goes away
    // while its list is open (the window resized) cannot leave the grid deaf.
    if (document.querySelector('[data-fold-list]')) return;
    // A press in a "+N" list (drawn elsewhere on the page) is not a press on the grid.
    if (!(e.target instanceof Node) || !contentRef.current?.contains(e.target)) return;
    if ((e.target as HTMLElement).closest('[data-event-chip], [data-event-fold]')) return;
    // The hour labels are not a day: a click there makes nothing.
    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect || e.clientX - rect.left < GUTTER_PX) return;
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
    const startMs = Date.parse(event.startsAt);
    // Grabbed by the piece after midnight of an event that began the day
    // before: measure the grab from its real start, not from midnight.
    const carried = localDateKey(new Date(startMs), timeZone) < at.day;
    pending.current = {
      mode: 'move',
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      event,
      grab: carried
        ? (instantAt(at.day, at.minutes, timeZone).getTime() - startMs) / 60_000
        : seg
          ? at.minutes - seg.start
          : 0,
      durationMs: Date.parse(event.endsAt) - startMs,
      carried,
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
          start: clampStart(at.minutes - p.grab, p.carried, p.durationMs),
          durationMs: p.durationMs,
          grab: p.grab,
          carried: p.carried,
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
      const start = clampStart(at.minutes - current.grab, current.carried, current.durationMs);
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
      const start = moveStart(current.day, current.start);
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
        pending={newSlot?.allDay ? newSlot : null}
        lookOf={lookOf}
        onOpen={onOpen}
        onCreateAllDay={onCreateAllDay}
        onShiftDays={onShiftDays}
        onPickDay={onPickDay}
      />

      {/* On a computer the hours fill the window below the bar and the
          labels row, so the page itself does not scroll as well (a
          900px-tall laptop included). */}
      <div
        ref={scrollRef}
        className="relative h-[min(62dvh,40rem)] scrollbar-thin overflow-y-auto overscroll-contain sm:h-[clamp(22rem,calc(100dvh-26.5rem),46rem)]"
      >
        <div
          ref={contentRef}
          className={cn('relative isolate grid select-none', canEdit && 'cursor-cell')}
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
            const layout = layoutOverlaps(
              timed.flatMap((event) => {
                const seg = segmentOnDay(event, d, timeZone);
                return seg ? [{ key: event.key, start: seg.start, end: seg.end }] : [];
              }),
              { columnPx, minChipPx },
            );
            const byKey = new Map(segments.map((s) => [s.event.key, s.event]));
            // Chips and "+N"s in time order, so Tab reaches a "+N" among the
            // events around it (after those starting with it), not after the day.
            const ordered: (
              { event: RangeEvent; seg: { start: number; end: number } } | { fold: FoldedChips }
            )[] = [...segments, ...layout.folds.map((fold) => ({ fold }))].sort(
              (a, b) =>
                ('fold' in a ? a.fold.start : a.seg.start) -
                  ('fold' in b ? b.fold.start : b.seg.start) ||
                Number('fold' in a) - Number('fold' in b),
            );
            const creating = drag?.mode === 'create' && drag.day === d ? drag : null;
            const held =
              !creating && newSlot && !newSlot.allDay
                ? segmentOnDay({ startsAt: newSlot.start, endsAt: newSlot.end }, d, timeZone)
                : null;
            return (
              <div
                key={d}
                data-date={d}
                data-day-column=""
                className={cn(
                  'relative border-l border-[var(--border)]',
                  d === today && 'bg-[var(--accent-soft)]/30',
                )}
                style={{
                  backgroundImage: 'linear-gradient(to bottom, var(--border) 1px, transparent 1px)',
                  backgroundSize: `100% ${HOUR_PX}px`,
                }}
              >
                {ordered.map((item) => {
                  if ('fold' in item) {
                    const { fold } = item;
                    return (
                      <FoldChip
                        key={fold.key}
                        events={fold.keys
                          .map((k) => byKey.get(k))
                          .filter((e): e is RangeEvent => Boolean(e))}
                        top={(fold.start / 60) * HOUR_PX}
                        height={Math.max(
                          MIN_CHIP_HEIGHT_PX,
                          ((fold.end - fold.start) / 60) * HOUR_PX - 1,
                        )}
                        left={fold.left}
                        width={fold.width}
                        z={fold.z}
                        timeZone={timeZone}
                        lookOf={lookOf}
                        onOpen={onOpen}
                      />
                    );
                  }
                  const { event, seg } = item;
                  // Moved, it is drawn a column wide, as in Google; resized, where it was.
                  const place =
                    event.key === draggedKey && drag?.mode === 'move'
                      ? FULL_WIDTH
                      : (layout.chips.get(event.key) ??
                        (event.key === draggedKey ? FULL_WIDTH : undefined));
                  if (!place) return null; // folded into a "+N"
                  const top = (seg.start / 60) * HOUR_PX;
                  const height = Math.max(
                    MIN_CHIP_HEIGHT_PX,
                    ((seg.end - seg.start) / 60) * HOUR_PX - 1,
                  );
                  // The bottom edge to drag is on the day the event really ends.
                  const endsHere =
                    event.endsAt !== null &&
                    localDateKey(new Date(Date.parse(event.endsAt) - 1), timeZone) === d;
                  const dragging = drag && drag.mode !== 'create' && drag.event.key === event.key;
                  const when = `${shortTime(event.startsAt!, timeZone)} – ${shortTime(event.endsAt ?? event.startsAt!, timeZone)}`;
                  const look = lookOf(event);
                  const asking = look.response === 'needsAction';
                  const compact = height < 34;
                  // How wide it is drawn: a narrow chip gets one line, a sliver only its colour.
                  const widthPx = place.width * columnPx - CHIP_GAP_PX;
                  const narrow = widthPx < ONE_LINE_CHIP_PX;
                  const colourOnly = widthPx < COLOUR_ONLY_CHIP_PX;
                  // The title's own room, beside the Hold tag and the bell: too little to wrap words, one line.
                  const titlePx =
                    widthPx -
                    (narrow ? NARROW_CHIP_INSET_PX : CHIP_INSET_PX) -
                    (event.hold && !narrow ? HOLD_TAG_PX : 0) -
                    (event.verdict.meeting && !narrow ? BELL_PX : 0) -
                    (asking && !narrow ? ASK_GLYPH_PX : 0);
                  const oneLine = compact || narrow || titlePx < MIN_WRAP_TITLE_PX;
                  // As many lines of title as the height allows; the time follows if room is left.
                  const titleLines = Math.max(1, Math.floor((height - 4) / CHIP_LINE_PX));
                  return (
                    <button
                      key={event.key}
                      type="button"
                      data-event-chip
                      data-event-key={event.key}
                      data-cascaded={place.cascaded ? '' : undefined}
                      data-look={lookAttr(look)}
                      onPointerDown={(e) => onChipPointerDown(e, event)}
                      onClick={(e) => onOpen(event, e.currentTarget)}
                      aria-label={chipLabel(
                        event,
                        when,
                        calendars.get(event.calendarId)?.name ?? null,
                        look,
                      )}
                      className={cn(
                        'absolute z-[var(--chip-z)] flex flex-col overflow-hidden rounded-[5px] border text-left text-[12px] leading-tight [overflow-wrap:normal] [word-break:normal] transition-shadow focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]',
                        narrow ? 'px-0.5' : 'px-1.5',
                        compact ? 'py-0' : 'py-0.5',
                        editable(event) && 'cursor-grab active:cursor-grabbing',
                      )}
                      style={chipBoxStyle(event, {
                        top,
                        height,
                        left: place.left,
                        width: place.width,
                        z: dragging ? Z_DRAGGING : place.z,
                        dragging: Boolean(dragging),
                        cascaded: place.cascaded,
                        look,
                      })}
                    >
                      {colourOnly ? null : (
                        <span
                          className={cn(
                            'flex min-w-0 items-start gap-1',
                            oneLine && 'items-center',
                          )}
                        >
                          {asking && !narrow ? (
                            <span aria-hidden className={cn(ASK_GLYPH_CLASS, 'mt-px')}>
                              ?
                            </span>
                          ) : null}
                          <span
                            data-chip-title=""
                            className={cn(
                              'min-w-0 flex-1',
                              oneLine && 'truncate',
                              event.verdict.meeting ? 'font-semibold' : 'font-medium',
                            )}
                            style={{
                              ...titleStyle(look),
                              ...(oneLine
                                ? {}
                                : {
                                    display: '-webkit-box',
                                    WebkitBoxOrient: 'vertical',
                                    WebkitLineClamp: titleLines,
                                    overflow: 'hidden',
                                  }),
                            }}
                          >
                            {oneLine ? event.title : <TitleWords title={event.title} />}
                            {compact && !narrow ? (
                              <span className="font-normal opacity-80">
                                , {shortTime(event.startsAt!, timeZone)}
                              </span>
                            ) : null}
                          </span>
                          {event.hold && !narrow ? (
                            <span className={HOLD_TAG_CLASS}>Hold</span>
                          ) : null}
                          {event.verdict.meeting && !narrow ? (
                            // A phone's week columns are narrow: the title gets the room.
                            <Bell
                              className={cn(
                                'mt-0.5 size-3 shrink-0 opacity-80',
                                !single && 'max-sm:hidden',
                              )}
                              aria-hidden
                            />
                          ) : null}
                        </span>
                      )}
                      {!compact && !narrow ? (
                        <span className="block truncate opacity-80">
                          {when}
                          {event.label ? (
                            <span data-chip-label="">{` · ${labelText(event.label)}`}</span>
                          ) : null}
                        </span>
                      ) : null}
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

                {held ? (
                  <div
                    data-new-event=""
                    className="pointer-events-none absolute inset-x-0.5 z-[900] overflow-hidden rounded-[5px] border border-[var(--primary)] bg-[var(--primary)]/30 px-1.5 py-0.5 text-[12px] leading-tight font-medium text-[var(--fg)] shadow-[var(--elevation-lifted)]"
                    style={{
                      top: (held.start / 60) * HOUR_PX,
                      height: Math.max(
                        MIN_CHIP_HEIGHT_PX,
                        ((held.end - held.start) / 60) * HOUR_PX - 1,
                      ),
                    }}
                  >
                    (No title)
                    <span className="block font-normal opacity-80">
                      {shortTime(newSlot!.start, timeZone)} – {shortTime(newSlot!.end, timeZone)}
                    </span>
                  </div>
                ) : null}

                {creating ? (
                  <div
                    className="pointer-events-none absolute inset-x-0.5 z-[900] rounded-[5px] border border-[var(--primary)] bg-[var(--primary)]/25 px-1.5 py-0.5 text-[12px] font-medium text-[var(--fg)]"
                    style={{
                      top: (snap(Math.min(creating.anchor, creating.current)) / 60) * HOUR_PX,
                      height: Math.max(
                        MIN_CHIP_HEIGHT_PX,
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
                    className="pointer-events-none absolute inset-x-0 z-[910] h-0.5 bg-[var(--danger)]"
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

/**
 * A grid chip's box: where the overlap layout put it, in the event's colours,
 * stacked by `z` (through a variable, so a focused chip can still rise above).
 * One drawn over an earlier event gets a 1px outline in the page's colour.
 */
function chipBoxStyle(
  event: RangeEvent,
  box: {
    top: number;
    height: number;
    left: number;
    width: number;
    z: number;
    dragging: boolean;
    cascaded: boolean;
    look: EventLook;
  },
): React.CSSProperties {
  const { zIndex: _ignored, ...colours } = chipStyle(event, {
    dragging: box.dragging,
    look: box.look,
  });
  return {
    top: box.top,
    height: box.height,
    left: `calc(${box.left * 100}% + 1px)`,
    width: `calc(${box.width * 100}% - ${CHIP_GAP_PX}px)`,
    ['--chip-z' as string]: box.z,
    ...colours,
    ...(box.cascaded && !box.dragging ? { boxShadow: '0 0 0 1px var(--bg-raised)' } : {}),
  };
}

/**
 * The "+N" for events with no room left beside the others: as tall as the
 * time they cover, and a click lists them, each opening its own card.
 */
function FoldChip({
  events,
  top,
  height,
  left,
  width,
  z,
  timeZone,
  lookOf,
  onOpen,
}: {
  events: RangeEvent[];
  top: number;
  height: number;
  left: number;
  width: number;
  z: number;
  timeZone: string;
  lookOf: (event: RangeEvent) => EventLook;
  onOpen: (event: RangeEvent, element: HTMLElement) => void;
}) {
  const trigger = React.useRef<HTMLButtonElement>(null);
  const first = events[0];
  if (!first?.startsAt) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          type="button"
          data-event-fold=""
          aria-label={`${events.length} more events from ${shortTime(first.startsAt, timeZone)}`}
          className="absolute z-[var(--chip-z)] flex flex-col items-center overflow-hidden rounded-[5px] border border-[var(--border-strong)] bg-[var(--bg-hover)] px-0.5 py-0.5 text-center text-[12px] leading-tight font-semibold whitespace-nowrap text-[var(--fg)] hover:bg-[var(--bg-raised)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]"
          style={{
            top,
            height,
            left: `calc(${left * 100}% + 1px)`,
            width: `calc(${width * 100}% - ${CHIP_GAP_PX}px)`,
            ['--chip-z' as string]: z,
            boxShadow: '0 0 0 1px var(--bg-raised)',
          }}
        >
          +{events.length}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64" data-fold-list="">
        <ul className="space-y-0.5">
          {events.map((e) => (
            <li key={e.key}>
              <button
                type="button"
                // The card opens beside the "+N" (the list closes) and gives it focus back.
                onClick={(ev) => onOpen(e, trigger.current ?? ev.currentTarget)}
                className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-sm hover:bg-[var(--bg-hover)]"
              >
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full border"
                  style={dotStyle(e, lookOf(e))}
                />
                <span className="shrink-0 text-xs text-[var(--fg-muted)] tabular-nums">
                  {e.startsAt ? shortTime(e.startsAt, timeZone) : ''}
                </span>
                <span
                  className="min-w-0 truncate"
                  style={{ ...titleStyle(lookOf(e)), opacity: lookOf(e).past ? 0.7 : undefined }}
                >
                  {e.title}
                </span>
                {e.hold ? <span className={HOLD_TAG_CLASS}>Hold</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
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

/** The look as a data attribute, for the tests and the key: "past needsAction". */
export function lookAttr(look: EventLook): string | undefined {
  const parts = [look.past ? 'past' : null, look.response].filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
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
  pending,
  lookOf,
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
  pending: PendingSlot | null;
  lookOf: (event: RangeEvent) => EventLook;
  onOpen: (event: RangeEvent, element: HTMLElement) => void;
  onCreateAllDay: (day: string, endKey?: string) => void;
  onShiftDays: (event: RangeEvent, days: number) => void;
  onPickDay: (day: string) => void;
}) {
  const rowRef = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{ event: RangeEvent; col: number; x: number; moved: boolean } | null>(
    null,
  );
  const [offset, setOffset] = React.useState<{ key: string; days: number } | null>(null);
  // Drag across empty days to make one event over all of them, as in Google Calendar.
  const select = React.useRef<{ col: number; x: number; moved: boolean; touch: boolean } | null>(
    null,
  );
  const [selecting, setSelecting] = React.useState<{ from: number; to: number } | null>(null);
  const byKey = new Map(events.map((e) => [e.key, e]));
  const packed = packWeek(
    events
      .map((e) => packItemOf(e, timeZone))
      .filter((i): i is NonNullable<typeof i> => i !== null),
    days,
    maxLanes,
  );
  const lanes = Math.max(1, packed.lanes);
  // The new event's bar: while dragging across days, then while its quick editor is open.
  const pendingCols = (() => {
    if (selecting) {
      return {
        from: Math.min(selecting.from, selecting.to),
        to: Math.max(selecting.from, selecting.to),
      };
    }
    if (!pending) return null;
    const first = days[0]!;
    const last = days[days.length - 1]!;
    const lastDay = addDaysToKey(pending.end, -1);
    if (pending.start > last || lastDay < first) return null;
    return {
      from: pending.start < first ? 0 : days.indexOf(pending.start),
      to: lastDay > last ? days.length - 1 : days.indexOf(lastDay),
    };
  })();
  // Under the events already there, as Google adds it.
  const barLane = packed.lanes;
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
      style={{
        gridTemplateColumns: columns,
        minHeight: Math.max(lanes, packed.lanes + (pendingCols ? 1 : 0)) * ALL_DAY_LANE_PX + 6,
      }}
      onPointerMove={(e) => {
        const s = select.current;
        if (s && !s.touch) {
          if (!s.moved && Math.abs(e.clientX - s.x) < DRAG_THRESHOLD_PX) return;
          if (!s.moved) rowRef.current?.setPointerCapture(e.pointerId);
          s.moved = true;
          setSelecting({ from: s.col, to: colOf(e.clientX) });
          return;
        }
        const d = drag.current;
        if (!d) return;
        if (!d.moved && Math.abs(e.clientX - d.x) < DRAG_THRESHOLD_PX) return;
        if (!d.moved) rowRef.current?.setPointerCapture(e.pointerId);
        d.moved = true;
        setOffset({ key: d.event.key, days: colOf(e.clientX) - d.col });
      }}
      onPointerUp={(e) => {
        if (rowRef.current?.hasPointerCapture(e.pointerId))
          rowRef.current.releasePointerCapture(e.pointerId);
        const s = select.current;
        if (s) {
          select.current = null;
          const range = selecting;
          setSelecting(null);
          if (s.moved && range) {
            const from = Math.min(range.from, range.to);
            const to = Math.max(range.from, range.to);
            onCreateAllDay(days[from]!, addDaysToKey(days[to]!, 1));
          } else if (!s.moved) {
            onCreateAllDay(days[s.col]!);
          }
          return;
        }
        const d = drag.current;
        drag.current = null;
        const shift = offset?.days ?? 0;
        setOffset(null);
        if (d?.moved && shift !== 0) onShiftDays(d.event, shift);
      }}
      onPointerCancel={() => {
        drag.current = null;
        select.current = null;
        setOffset(null);
        setSelecting(null);
      }}
    >
      <div className="text-micro self-center px-1 text-right text-[var(--fg-subtle)]">All day</div>
      {days.map((d, i) => (
        <div
          key={d}
          data-all-day-date={d}
          className={cn('border-l border-[var(--border)]', canEdit && 'cursor-cell')}
          onPointerDown={(e) => {
            if (!canEdit || e.button !== 0 || e.target !== e.currentTarget) return;
            select.current = {
              col: i,
              x: e.clientX,
              moved: false,
              touch: e.pointerType === 'touch',
            };
          }}
        />
      ))}
      {pendingCols ? (
        <div
          data-new-event=""
          className="pointer-events-none absolute z-[3] truncate rounded-[5px] border border-[var(--primary)] bg-[var(--primary)]/30 px-1.5 text-[12px] leading-[18px] font-medium text-[var(--fg)] shadow-[var(--elevation-lifted)]"
          style={{
            top: 3 + barLane * ALL_DAY_LANE_PX,
            left: `calc(${GUTTER_PX}px + (100% - ${GUTTER_PX}px) * ${pendingCols.from / days.length} + 2px)`,
            width: `calc((100% - ${GUTTER_PX}px) * ${(pendingCols.to - pendingCols.from + 1) / days.length} - 4px)`,
          }}
        >
          (No title)
        </div>
      ) : null}
      {packed.segments.map((s) => {
        const event = byKey.get(s.key);
        if (!event) return null;
        const shift = offset?.key === s.key ? offset.days : 0;
        const startCol = Math.max(0, Math.min(days.length - 1, s.startCol + shift));
        const endCol = Math.max(startCol, Math.min(days.length - 1, s.endCol + shift));
        const width = endCol - startCol + 1;
        const editable = canEdit && event.canModify;
        const look = lookOf(event);
        return (
          <button
            key={`${s.key}-${s.startCol}`}
            type="button"
            data-event-chip
            data-event-key={event.key}
            data-look={lookAttr(look)}
            onPointerDown={(e) => {
              if (!editable || e.button !== 0 || e.pointerType === 'touch') return;
              drag.current = { event, col: colOf(e.clientX), x: e.clientX, moved: false };
            }}
            onClick={(e) => {
              if (!drag.current?.moved) onOpen(event, e.currentTarget);
            }}
            aria-label={chipLabel(
              event,
              'all day',
              calendars.get(event.calendarId)?.name ?? null,
              look,
            )}
            className={cn(
              'absolute flex items-center gap-1 rounded-[5px] border px-1.5 text-left text-[12px] leading-[18px] font-medium focus-visible:outline-2 focus-visible:outline-[var(--focus)]',
              editable && 'cursor-grab',
              s.continuesBefore && 'rounded-l-none',
              s.continuesAfter && 'rounded-r-none',
            )}
            style={{
              top: 3 + s.lane * ALL_DAY_LANE_PX,
              left: `calc(${GUTTER_PX}px + (100% - ${GUTTER_PX}px) * ${startCol / days.length} + 2px)`,
              width: `calc((100% - ${GUTTER_PX}px) * ${width / days.length} - 4px)`,
              ...chipStyle(event, { dragging: shift !== 0, look }),
            }}
          >
            {look.response === 'needsAction' ? (
              <span aria-hidden className={ASK_GLYPH_CLASS}>
                ?
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate">
              <span style={titleStyle(look)}>{event.title}</span>
              {event.label ? (
                <span data-chip-label="" className="font-normal opacity-80">
                  {` · ${labelText(event.label)}`}
                </span>
              ) : null}
            </span>
            {event.hold ? <span className={HOLD_TAG_CLASS}>Hold</span> : null}
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
