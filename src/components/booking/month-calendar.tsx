'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  dayKeyIn,
  dayLabel,
  timeLabel,
  type PublicDay,
  type PublicSlot,
} from '@/lib/booking/public';
import { cn } from '@/lib/util/cn';

/**
 * The booking page's calendar card (D-078), like Calendly's month view: one
 * month at a time for the meeting type picked, its arrows going only to the
 * months open on the link. Each day says what it is, and nothing more:
 *
 * - open: highlighted, with how many times it has; pick it to see them;
 * - booked: a meeting day whose times are all taken (greyed, "Booked");
 * - not offered: anything else (dimmed), never why (no "travel", no titles);
 * - your meeting: the day this device's booking falls on, a link to its page.
 *
 * Days read in the zone the times are shown in. The counts come from the
 * open times themselves, so the card and the time list always agree; the
 * server only adds which empty days are fully booked. A grid for keyboards
 * (arrow keys, Home, End, Page Up and Page Down) and screen readers.
 */

export type CalendarDayState = 'open' | 'booked' | 'off';

export interface CalendarDay {
  key: string;
  state: CalendarDayState;
  count: number;
  mine: boolean;
}

const WEEKDAYS = [
  ['S', 'Sunday'],
  ['M', 'Monday'],
  ['T', 'Tuesday'],
  ['W', 'Wednesday'],
  ['T', 'Thursday'],
  ['F', 'Friday'],
  ['S', 'Saturday'],
] as const;

const monthOf = (key: string) => key.slice(0, 7);

function addDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysIn(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** "Thursday 12 November". */
export function fullDayLabel(key: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${key}T12:00:00Z`));
}

/** "November 2026". */
function monthLabel(month: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${month}-15T12:00:00Z`));
}

/** How many open times each day has, in a zone (a key per day). */
export function countsByDay(slots: readonly PublicSlot[], zone: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of slots) {
    const key = dayKeyIn(s.start, zone);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * The months the card can show: the ones open on the link, and any month a
 * time falls in once read in the visitor's zone (a late call can land on
 * the next day, and so the next month). Sorted, at least today's month.
 */
export function calendarMonths(
  months: readonly string[] | undefined,
  counts: ReadonlyMap<string, number>,
  today: string,
): string[] {
  const out = new Set<string>(months ?? []);
  for (const key of counts.keys()) out.add(monthOf(key));
  const list = [...out].filter((m) => m >= monthOf(today)).sort();
  return list.length ? list : [monthOf(today)];
}

/** Every day of a month as the card shows it. Pure: the unit tests pin it. */
export function monthDays(input: {
  month: string;
  counts: ReadonlyMap<string, number>;
  /** The server's states, by the host's day (only "booked" is read from them). */
  days?: readonly PublicDay[];
  today: string;
  mine?: string | null;
}): CalendarDay[] {
  const server = new Map((input.days ?? []).map((d) => [d.date, d.state] as const));
  const out: CalendarDay[] = [];
  for (let i = 1; i <= daysIn(input.month); i += 1) {
    const key = `${input.month}-${String(i).padStart(2, '0')}`;
    const count = key < input.today ? 0 : (input.counts.get(key) ?? 0);
    const state: CalendarDayState =
      count > 0 ? 'open' : key >= input.today && server.get(key) === 'booked' ? 'booked' : 'off';
    out.push({ key, state, count, mine: input.mine === key });
  }
  return out;
}

/** The words a screen reader hears for a day. */
export function dayAriaLabel(day: CalendarDay): string {
  const date = fullDayLabel(day.key);
  if (day.mine) return `${date}, your meeting: see, reschedule or cancel`;
  if (day.state === 'open') {
    return `${date}, ${day.count} open time${day.count === 1 ? '' : 's'}`;
  }
  return day.state === 'booked' ? `${date}, fully booked` : `${date}, not offered`;
}

export function BookingCalendar({
  slots,
  days,
  months,
  zone,
  today,
  month,
  onMonth,
  selected,
  onSelect,
  yourMeeting = null,
  label,
  className,
}: {
  slots: readonly PublicSlot[];
  days?: readonly PublicDay[];
  months?: readonly string[];
  /** The zone the times are shown in: days are read in it. */
  zone: string;
  /** Today, a key in `zone`. */
  today: string;
  /** The month shown (`YYYY-MM`); null for the first with an open time. */
  month: string | null;
  onMonth: (month: string) => void;
  /** The day picked (a key in `zone`), or null. */
  selected: string | null;
  onSelect: (day: string) => void;
  /** The booking this device made: its start and its own page. */
  yourMeeting?: { startsAt: string; manageUrl: string } | null;
  /** What the grid is for, e.g. "Open days for a 30-min call". */
  label: string;
  className?: string;
}) {
  const counts = React.useMemo(() => countsByDay(slots, zone), [slots, zone]);
  const navMonths = React.useMemo(
    () => calendarMonths(months, counts, today),
    [months, counts, today],
  );
  const firstOpen = React.useMemo(
    () => [...counts.keys()].filter((k) => k >= today).sort()[0] ?? null,
    [counts, today],
  );
  const shown =
    month && navMonths.includes(month)
      ? month
      : ((selected && navMonths.includes(monthOf(selected)) ? monthOf(selected) : null) ??
        (firstOpen ? monthOf(firstOpen) : navMonths[0]!));
  const mine = yourMeeting ? dayKeyIn(yourMeeting.startsAt, zone) : null;
  const grid = React.useMemo(
    () => monthDays({ month: shown, counts, days, today, mine }),
    [shown, counts, days, today, mine],
  );
  const index = navMonths.indexOf(shown);
  const prev = index > 0 ? navMonths[index - 1]! : null;
  const next = index >= 0 && index < navMonths.length - 1 ? navMonths[index + 1]! : null;

  // Roving focus: one day in the grid takes Tab; the arrows move it.
  const [focusKey, setFocusKey] = React.useState<string | null>(null);
  const refs = React.useRef(new Map<string, HTMLElement>());
  const moved = React.useRef(false);
  const tabbable =
    (focusKey && monthOf(focusKey) === shown ? focusKey : null) ??
    (selected && monthOf(selected) === shown ? selected : null) ??
    grid.find((d) => d.state === 'open')?.key ??
    grid[0]!.key;

  React.useEffect(() => {
    if (!moved.current || !focusKey) return;
    moved.current = false;
    refs.current.get(focusKey)?.focus();
  }, [focusKey, shown]);

  const moveTo = (key: string) => {
    const target = monthOf(key);
    if (target !== shown) {
      if (!navMonths.includes(target)) return;
      onMonth(target);
    }
    moved.current = true;
    setFocusKey(key);
  };

  const onKey = (event: React.KeyboardEvent, key: string) => {
    const weekday = new Date(`${key}T12:00:00Z`).getUTCDay();
    const step: Record<string, () => string | null> = {
      ArrowLeft: () => addDays(key, -1),
      ArrowRight: () => addDays(key, 1),
      ArrowUp: () => addDays(key, -7),
      ArrowDown: () => addDays(key, 7),
      Home: () => addDays(key, -weekday),
      End: () => addDays(key, 6 - weekday),
      PageUp: () => (prev ? `${prev}-01` : null),
      PageDown: () => (next ? `${next}-01` : null),
    };
    const go = step[event.key];
    if (!go) return;
    event.preventDefault();
    const target = go();
    if (target) moveTo(target);
  };

  const lead = new Date(`${shown}-01T12:00:00Z`).getUTCDay();
  const cells: (CalendarDay | null)[] = [...Array<null>(lead).fill(null), ...grid];
  while (cells.length % 7) cells.push(null);
  const weeks: (CalendarDay | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const openInMonth = grid.filter((d) => d.state === 'open').length;
  const headingId = React.useId();

  return (
    <div className={cn('min-w-0', className)} data-testid="booking-calendar">
      <div className="mb-2 flex items-center gap-2">
        <h3
          id={headingId}
          className="min-w-0 flex-1 font-serif text-base font-semibold"
          aria-live="polite"
        >
          {monthLabel(shown)}
          <span className="sr-only">
            , {openInMonth} open day{openInMonth === 1 ? '' : 's'}
          </span>
        </h3>
        <button
          type="button"
          onClick={() => prev && onMonth(prev)}
          disabled={!prev}
          aria-label="Previous open month"
          className="flex size-9 items-center justify-center rounded-full border border-[var(--border-strong)] text-[var(--fg)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-35"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => next && onMonth(next)}
          disabled={!next}
          aria-label="Next open month"
          className="flex size-9 items-center justify-center rounded-full border border-[var(--border-strong)] text-[var(--fg)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-35"
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
      </div>
      <table
        role="grid"
        aria-label={label}
        aria-describedby={headingId}
        className="w-full table-fixed border-separate border-spacing-1"
      >
        <thead>
          <tr>
            {WEEKDAYS.map(([short, long]) => (
              <th
                key={long}
                scope="col"
                abbr={long}
                className="pb-1 text-center text-[11px] font-medium text-[var(--fg-subtle)]"
              >
                <span aria-hidden="true">{short}</span>
                <span className="sr-only">{long}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, w) => (
            <tr key={w}>
              {week.map((day, d) =>
                day ? (
                  <DayCell
                    key={day.key}
                    day={day}
                    selected={selected === day.key}
                    tabbable={tabbable === day.key}
                    manageUrl={day.mine ? (yourMeeting?.manageUrl ?? null) : null}
                    onSelect={() => {
                      setFocusKey(day.key);
                      if (day.state === 'open') onSelect(day.key);
                    }}
                    onKey={(event) => onKey(event, day.key)}
                    refFor={(el) => {
                      if (el) refs.current.set(day.key, el);
                      else refs.current.delete(day.key);
                    }}
                  />
                ) : (
                  <td key={`blank-${w}-${d}`} role="gridcell" aria-hidden="true" />
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <ul
        className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--fg-muted)]"
        aria-label="What the days show"
      >
        <li className="inline-flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-full border border-[var(--accent)] bg-[var(--accent-soft)]"
            aria-hidden="true"
          />
          Open
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-full border border-[var(--border-strong)] bg-[var(--bg-sunken)]"
            aria-hidden="true"
          />
          Booked
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-full border border-[var(--border-strong)]"
            aria-hidden="true"
          />
          Not offered
        </li>
        {mine ? (
          <li className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-full ring-2 ring-[var(--gold)]" aria-hidden="true" />
            Your meeting
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function DayCell({
  day,
  selected,
  tabbable,
  manageUrl,
  onSelect,
  onKey,
  refFor,
}: {
  day: CalendarDay;
  selected: boolean;
  tabbable: boolean;
  manageUrl: string | null;
  onSelect: () => void;
  onKey: (event: React.KeyboardEvent) => void;
  refFor: (el: HTMLElement | null) => void;
}) {
  const number = Number(day.key.slice(8));
  const base =
    'relative flex h-11 w-full flex-col items-center justify-center rounded-md text-sm tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]';
  const sub = day.mine ? (
    <span className="text-[9px] leading-none font-semibold text-[var(--label-gold)]">Yours</span>
  ) : day.state === 'open' ? (
    <span
      className={cn(
        'text-[10px] leading-none font-medium',
        selected ? 'text-[var(--primary-fg)]' : 'text-[var(--accent)]',
      )}
      aria-hidden="true"
    >
      {day.count}
    </span>
  ) : day.state === 'booked' ? (
    <span className="text-[9px] leading-none text-[var(--fg-subtle)]" aria-hidden="true">
      Booked
    </span>
  ) : null;
  const look = cn(
    base,
    day.mine && 'ring-2 ring-[var(--gold)]',
    day.state === 'open'
      ? selected
        ? 'bg-[var(--primary)] font-semibold text-[var(--primary-fg)]'
        : 'bg-[var(--accent-soft)] font-semibold text-[var(--fg)] hover:bg-[var(--bg-hover)]'
      : day.state === 'booked'
        ? 'cursor-default bg-[var(--bg-sunken)] text-[var(--fg-subtle)]'
        : 'cursor-default text-[var(--fg-subtle)] opacity-60',
  );
  return (
    <td role="gridcell" aria-selected={day.state === 'open' ? selected : undefined} className="p-0">
      {manageUrl ? (
        <a
          ref={refFor}
          href={manageUrl}
          tabIndex={tabbable ? 0 : -1}
          aria-label={dayAriaLabel(day)}
          onKeyDown={onKey}
          data-day={day.key}
          data-state="mine"
          className={look}
        >
          <span aria-hidden="true">{number}</span>
          {sub}
        </a>
      ) : (
        <button
          ref={refFor}
          type="button"
          tabIndex={tabbable ? 0 : -1}
          aria-label={dayAriaLabel(day)}
          aria-pressed={day.state === 'open' ? selected : undefined}
          aria-disabled={day.state === 'open' ? undefined : true}
          onClick={onSelect}
          onKeyDown={onKey}
          data-day={day.key}
          data-state={day.state}
          className={look}
        >
          <span aria-hidden="true">{number}</span>
          {sub}
        </button>
      )}
    </td>
  );
}

/**
 * The times of the day picked, as a radio group ("Time") in the visitor's
 * zone, under that day's name.
 */
export function TimeGrid({
  slots,
  zone,
  day,
  value,
  onChange,
}: {
  slots: readonly PublicSlot[];
  zone: string;
  /** The day shown, a key in `zone`. */
  day: string | null;
  value: string | null;
  onChange: (start: string) => void;
}) {
  const times = React.useMemo(
    () => (day ? slots.filter((s) => dayKeyIn(s.start, zone) === day) : []),
    [slots, zone, day],
  );
  if (!day || times.length === 0) {
    return (
      <p className="text-sm text-[var(--fg-muted)]">Pick a highlighted day to see its times.</p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium" id={`times-${day}`}>
        {dayLabel(times[0]!.start, zone)}
        <span className="font-normal text-[var(--fg-muted)]">
          {' '}
          · {times.length} open time{times.length === 1 ? '' : 's'}
        </span>
      </p>
      <div role="radiogroup" aria-label="Time" className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {times.map((s) => (
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
    </div>
  );
}

/** The day to show by default: the picked time's, the picked day's, else the first open in the month. */
export function defaultDay(input: {
  slots: readonly PublicSlot[];
  zone: string;
  value: string | null;
  day: string | null;
  month: string | null;
}): string | null {
  const counts = countsByDay(input.slots, input.zone);
  if (input.value) return dayKeyIn(input.value, input.zone);
  if (input.day && counts.has(input.day)) return input.day;
  const keys = [...counts.keys()].sort();
  if (input.month) return keys.find((k) => monthOf(k) === input.month) ?? null;
  return keys[0] ?? null;
}
