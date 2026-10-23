'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  CalendarOff,
  CalendarPlus,
  CalendarX,
  ChevronLeft,
  ChevronRight,
  Lock,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Notice, Skeleton } from '@/components/ui/feedback';
import { Input, Label, Switch } from '@/components/ui/form';
import { filterChipClassName } from '@/components/ui/toolbar';
import {
  ALLOWED_WEEKDAYS,
  BOOKING_HOURS_HINT,
  CALL_BOUNDS,
  MEETING_KINDS,
  WEEKDAY_NAME,
  type BookingConfig,
  type TimeWindow,
} from '@/lib/booking/config';
import type { PreviewKey } from '@/lib/booking/engine';
import {
  addClosedRange,
  closeAllMonths,
  dateClosed,
  dateLabel,
  hoursFor,
  monthGrid,
  monthLabel,
  monthName,
  monthOf,
  monthOpen,
  monthShort,
  monthStrip,
  openMonthsAhead,
  openNextMonths,
  plannerClosure,
  removeClosedRange,
  setDateHours,
  toggleDate,
  toggleMonth,
  type PlannerConfig,
} from '@/lib/booking/months';
import {
  openCount,
  openMonthsLabel,
  PREVIEW_KEYS,
  PREVIEW_LABEL,
  type PreviewDay,
} from '@/lib/booking/planner-status';
import { zoneName } from '@/lib/booking/public';
import { AVAILABILITY_VIEWS, type AvailabilityView } from '@/lib/booking/tabs';
import { cn } from '@/lib/util/cn';
import { KindWindows, NumberField, WindowRow } from './fields';
import { useMonthCounts, usePreview, useSettingsSave } from './hooks';
import { KIND_ICON, KindLine, ReasonChip } from './reasons';

type RulesConfig = Pick<
  BookingConfig,
  | 'allowGuests'
  | 'maxGuests'
  | 'weekdays'
  | 'callBufferMinutes'
  | 'inPersonBufferMinutes'
  | 'noticeHours'
  | 'maxLinkBookingsPerDay'
  | 'maxMeetingsPerDay'
  | 'stackSize'
  | 'stackGapMinutes'
  | 'stackCooldownMinutes'
  | 'stackLeadMinutes'
>;
type HoursConfig = Pick<BookingConfig, 'callWindow' | 'kindWindows'>;

export interface AvailabilityPanelProps {
  planner: PlannerConfig;
  hours: HoursConfig;
  rules: RulesConfig;
  today: string;
  hostZone: string;
  canEdit: boolean;
  view: AvailabilityView;
  inPersonOffered: boolean;
}

const VIEW_LABEL: Record<AvailabilityView, string> = {
  planner: 'Months & days',
  hours: 'Hours',
  rules: 'Rules',
};

/**
 * Availability: the month planner (which months are open, closed days and
 * runs of days, shorter hours on a day) over a live preview of the times
 * visitors are offered, then the hours and the rules. Rules always win:
 * nothing here opens a time the rules close. Each tap on the planner saves
 * at once; the hours and the rules have a Save.
 */
export function AvailabilityPanel(props: AvailabilityPanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [view, setView] = React.useState<AvailabilityView>(props.view);

  const go = (next: AvailabilityView) => {
    setView(next);
    const params = new URLSearchParams(search.toString());
    params.set('tab', 'availability');
    if (next === 'planner') params.delete('view');
    else params.set('view', next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Availability sections"
        className="flex flex-wrap gap-1.5"
        data-tour="booking-availability-views"
      >
        {AVAILABILITY_VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => go(v)}
            className={cn(
              'h-9 rounded-full border px-3.5 text-sm font-medium transition-colors',
              view === v
                ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-fg)]'
                : 'border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
            )}
          >
            {VIEW_LABEL[v]}
          </button>
        ))}
      </div>
      {!props.canEdit ? (
        <Notice>Only an admin or the owner can change the booking link.</Notice>
      ) : null}
      {view === 'planner' ? <Planner {...props} /> : null}
      {view === 'hours' ? <HoursForm {...props} /> : null}
      {view === 'rules' ? <RulesForm {...props} /> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- planner */

function Planner(props: AvailabilityPanelProps) {
  const { save, saving } = useSettingsSave();
  const [planner, setPlanner] = React.useState<PlannerConfig>(props.planner);
  const strip = monthStrip(props.today);
  const firstOpen = props.planner.openMonths.find((m) => strip.includes(m));
  const [month, setMonth] = React.useState(firstOpen ?? monthOf(props.today));
  const [version, setVersion] = React.useState(0);
  const [selected, setSelected] = React.useState<string | null>(null);
  const dayPanelRef = React.useRef<HTMLDivElement>(null);
  // On a phone the day's panel sits under the month grid: bring it into
  // view when a day is tapped, so the tap visibly does something.
  const selectDay = (day: string | null) => {
    setSelected(day);
    if (!day || typeof window === 'undefined') return;
    if (window.matchMedia('(min-width: 1024px)').matches) return;
    requestAnimationFrame(() =>
      dayPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  };
  const [show, setShow] = React.useState<'all' | PreviewKey>('all');
  const preview = usePreview({ month }, version);
  const counts = useMonthCounts(version);
  const disabled = !props.canEdit || saving;

  const apply = async (changes: Partial<PlannerConfig>, done: string, undoable = true) => {
    const before = planner;
    setPlanner({ ...planner, ...changes });
    // A month or day tap saves at once, so its toast offers Undo.
    const previous = Object.fromEntries(
      Object.keys(changes).map((k) => [k, before[k as keyof PlannerConfig]]),
    ) as Partial<PlannerConfig>;
    const saved = await save(
      { config: changes },
      done,
      undoable ? () => void apply(previous, 'Put back', false) : undefined,
    );
    if (!saved) {
      setPlanner(before);
      return;
    }
    setPlanner({
      openMonths: saved.config.openMonths,
      closedDates: saved.config.closedDates,
      closedRanges: saved.config.closedRanges,
      dateHours: saved.config.dateHours,
    });
    setVersion((v) => v + 1);
  };

  const open = openMonthsAhead(planner, props.today);
  const days = preview.data?.days ?? [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const keys = show === 'all' ? PREVIEW_KEYS : [show];
  const selectedDay = selected ? byDate.get(selected) : undefined;
  const monthIndex = strip.indexOf(month);
  const monthIsOpen = monthOpen(planner, month, props.today);
  const timesIn = (m: string) => counts.data?.months.find((c) => c.month === m)?.times ?? null;

  return (
    <div className="space-y-5">
      {/* Which months are open: each month its own switch. */}
      <section aria-labelledby="booking-months" className="space-y-3" data-tour="booking-months">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="booking-months" className="text-title font-serif font-semibold">
            Which months are open?
          </h2>
          <p className="text-sm text-[var(--fg-muted)]" data-testid="open-months">
            {open.length ? (
              <>
                Open: <span className="font-semibold">{openMonthsLabel(open, props.today)}</span>
              </>
            ) : (
              'No month is open: visitors see no times.'
            )}
          </p>
        </div>
        <p className="text-xs text-[var(--fg-muted)]">
          Tap a month to switch it on or off. Any mix works: only December, or January and March.
        </p>
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-12">
          {strip.map((m) => {
            const on = monthOpen(planner, m, props.today);
            const times = timesIn(m);
            return (
              <li key={m}>
                <button
                  type="button"
                  data-month={m}
                  data-state={on ? 'open' : 'off'}
                  aria-pressed={on}
                  aria-label={`${monthLabel(m)}: ${on ? 'on' : 'off'}. Tap to switch it ${on ? 'off' : 'on'}.`}
                  disabled={disabled}
                  onClick={() => {
                    setMonth(m);
                    setSelected(null);
                    void apply(
                      toggleMonth(planner, m, props.today),
                      on ? `${monthLabel(m)} is off` : `${monthLabel(m)} is on`,
                    );
                  }}
                  className={cn(
                    'flex w-full min-w-0 flex-col items-start gap-0.5 rounded-[var(--radius-panel)] border p-2 text-left transition-colors disabled:cursor-not-allowed',
                    on
                      ? 'border-[var(--ok)]/50 bg-[var(--ok-soft)] hover:brightness-105'
                      : 'border-[var(--border)] bg-[var(--bg-sunken)] hover:bg-[var(--bg-hover)]',
                    m === month && 'shadow-[inset_0_0_0_2px_var(--accent)]',
                  )}
                >
                  <span className="flex w-full items-center justify-between gap-1">
                    <span className="text-sm font-semibold">{monthShort(m)}</span>
                    <span
                      className={cn(
                        'rounded-full px-1.5 text-[10px] font-semibold tracking-wide uppercase',
                        on
                          ? 'bg-[var(--ok)] text-[var(--bg)]'
                          : 'bg-[var(--bg-hover)] text-[var(--fg-muted)]',
                      )}
                    >
                      {on ? 'On' : 'Off'}
                    </span>
                  </span>
                  <span className="text-[11px] text-[var(--fg-muted)]">{m.slice(0, 4)}</span>
                  <span
                    className="tabular text-[11px] font-medium"
                    data-testid={`month-count-${m}`}
                  >
                    {!on
                      ? 'No times'
                      : times === null
                        ? counts.loading
                          ? '…'
                          : '—'
                        : `${times} time${times === 1 ? '' : 's'}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {props.canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled}
              title="This month and the next two"
              onClick={() =>
                void apply(openNextMonths(planner, props.today, 3), 'The next 3 months are on')
              }
            >
              <CalendarPlus aria-hidden="true" />
              Open next 3 months
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || open.length === 0}
              onClick={() => void apply(closeAllMonths(), 'Every month is off')}
            >
              <CalendarOff aria-hidden="true" />
              Close all
            </Button>
          </div>
        ) : null}
        {counts.data?.state === 'unavailable' && counts.data.message ? (
          <p className="text-xs text-[var(--fg-muted)]">{counts.data.message}</p>
        ) : null}
      </section>

      {/* The month, day by day, with the live preview. */}
      <section aria-labelledby="booking-grid" className="space-y-2" data-tour="booking-preview">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Previous month"
              disabled={monthIndex <= 0}
              onClick={() => {
                setMonth(strip[monthIndex - 1]!);
                setSelected(null);
              }}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <h2 id="booking-grid" className="text-title font-serif font-semibold">
              {monthLabel(month)}: what visitors see
            </h2>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Next month"
              disabled={monthIndex < 0 || monthIndex >= strip.length - 1}
              onClick={() => {
                setMonth(strip[monthIndex + 1]!);
                setSelected(null);
              }}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
          <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
            {(['all', ...PREVIEW_KEYS] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={show === k}
                onClick={() => setShow(k)}
                className={filterChipClassName(show === k)}
              >
                {k === 'all' ? 'Everything' : PREVIEW_LABEL[k]}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-[var(--fg-muted)]">
          Live, from the same rules as the public page. Times in {zoneName(props.hostZone)}. Tap a
          day to close it or give it shorter hours.
        </p>
        {!monthIsOpen ? (
          <Notice>
            {monthName(month)} is off, so it offers no times. Tap it above to switch it on.
          </Notice>
        ) : null}
        {preview.error ? <Notice tone="warn">{preview.error}</Notice> : null}
        {preview.data?.state === 'unavailable' && preview.data.message ? (
          <Notice tone="warn">{preview.data.message}</Notice>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <MonthGrid
            month={month}
            today={props.today}
            planner={planner}
            byDate={byDate}
            keys={keys}
            loading={preview.loading}
            selected={selected}
            onSelect={selectDay}
          />
          <div className="min-w-0 scroll-mt-24" ref={dayPanelRef} data-testid="day-panel-slot">
            {selected ? (
              <DayPanel
                key={selected}
                date={selected}
                day={selectedDay}
                planner={planner}
                zone={props.hostZone}
                today={props.today}
                disabled={disabled}
                onClose={() => setSelected(null)}
                onApply={apply}
              />
            ) : (
              <div className="rounded-[var(--radius-panel)] border border-dashed border-[var(--border-strong)] p-4 text-sm text-[var(--fg-muted)]">
                <p className="font-medium text-[var(--fg)]">Tap a day</p>
                <p className="mt-1">
                  See its open times, close it, or give it shorter hours. Nothing can open a time
                  the rules close.
                </p>
                <Legend />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Closed runs of days. */}
      <ClosedRanges planner={planner} today={props.today} disabled={disabled} onApply={apply} />
    </div>
  );
}

function Legend() {
  return (
    <ul className="mt-3 space-y-1.5 text-xs">
      <li className="flex items-center gap-2">
        <span className="size-3 rounded-sm bg-[var(--ok-soft)] ring-1 ring-[var(--ok)]/40" />
        Has open times
      </li>
      <li className="flex items-center gap-2">
        <span className="size-3 rounded-sm bg-[var(--bg-sunken)] ring-1 ring-[var(--border)]" />
        No times (the chip says why)
      </li>
      <li className="flex items-center gap-2">
        <CalendarX className="size-3 text-[var(--fg-muted)]" aria-hidden="true" />
        Closed by you
      </li>
    </ul>
  );
}

const WEEK_HEAD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function MonthGrid({
  month,
  today,
  planner,
  byDate,
  keys,
  loading,
  selected,
  onSelect,
}: {
  month: string;
  today: string;
  planner: PlannerConfig;
  byDate: Map<string, PreviewDay>;
  keys: readonly PreviewKey[];
  loading: boolean;
  selected: string | null;
  onSelect: (date: string) => void;
}) {
  const rows = monthGrid(month);
  return (
    <div className="min-w-0" role="grid" aria-label={`${monthLabel(month)} open times`}>
      <div role="row" className="grid grid-cols-7 gap-1 pb-1">
        {WEEK_HEAD.map((d) => (
          <span
            key={d}
            role="columnheader"
            className="text-center text-[11px] font-medium tracking-wide text-[var(--fg-subtle)] uppercase"
          >
            {d}
          </span>
        ))}
      </div>
      <div className="grid gap-1">
        {rows.map((row, i) => (
          <div key={i} role="row" className="grid grid-cols-7 gap-1">
            {row.map((date, j) =>
              date ? (
                <DayCell
                  key={date}
                  date={date}
                  today={today}
                  planner={planner}
                  day={byDate.get(date)}
                  keys={keys}
                  loading={loading}
                  selected={selected === date}
                  onSelect={onSelect}
                />
              ) : (
                <span key={`e${j}`} role="gridcell" aria-hidden="true" />
              ),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DayCell({
  date,
  today,
  planner,
  day,
  keys,
  loading,
  selected,
  onSelect,
}: {
  date: string;
  today: string;
  planner: PlannerConfig;
  day: PreviewDay | undefined;
  keys: readonly PreviewKey[];
  loading: boolean;
  selected: boolean;
  onSelect: (date: string) => void;
}) {
  const count = day ? openCount(day, keys) : 0;
  const closedByYou = Boolean(plannerClosure(planner, date)) && date >= today;
  const shorter = hoursFor(planner, date);
  // The first closed kind's rule stands for the day.
  const firstPlan = day ? keys.map((k) => day.plans[k]).find((p) => p.code) : undefined;
  const label = `${dateLabel(date)}: ${
    loading && !day
      ? 'loading'
      : count
        ? `${count} open time${count === 1 ? '' : 's'}`
        : (firstPlan?.reason ?? 'no times')
  }`;
  return (
    <button
      type="button"
      role="gridcell"
      aria-selected={selected}
      aria-label={label}
      data-date={date}
      data-open={count > 0 ? 'yes' : 'no'}
      onClick={() => onSelect(date)}
      className={cn(
        'flex min-h-14 min-w-0 flex-col items-start gap-1 rounded-md border p-1 text-left transition-colors sm:min-h-20 sm:p-1.5',
        count > 0
          ? 'border-[var(--ok)]/40 bg-[var(--ok-soft)] hover:brightness-105'
          : 'border-[var(--border)] bg-[var(--bg-sunken)] hover:bg-[var(--bg-hover)]',
        (date < today || firstPlan?.code === 'weekday') && count === 0 && 'opacity-50',
        selected && 'ring-2 ring-[var(--accent)]',
      )}
    >
      <span className="flex w-full items-center justify-between gap-1">
        <span
          className={cn('tabular text-xs font-semibold', date === today && 'text-[var(--accent)]')}
        >
          {Number(date.slice(8))}
        </span>
        {closedByYou ? (
          <CalendarX className="size-3 text-[var(--fg-muted)]" aria-hidden="true" />
        ) : shorter ? (
          <Lock className="size-3 text-[var(--fg-muted)]" aria-hidden="true" />
        ) : null}
      </span>
      {loading && !day ? (
        <Skeleton className="h-3 w-3/4" />
      ) : count > 0 ? (
        <>
          <span className="tabular text-[11px] leading-tight font-semibold text-[var(--ok)] sm:hidden">
            {count}
          </span>
          <span className="hidden flex-wrap gap-x-1.5 gap-y-0.5 sm:flex">
            {keys.map((k) => {
              const n = day!.plans[k].times.length;
              if (!n) return null;
              const Icon = KIND_ICON[k];
              return (
                <span key={k} className="tabular inline-flex items-center gap-0.5 text-[11px]">
                  <Icon className="size-3 text-[var(--accent)]" aria-hidden="true" />
                  {n}
                </span>
              );
            })}
          </span>
        </>
      ) : firstPlan?.code && firstPlan.code !== 'past' && firstPlan.code !== 'weekday' ? (
        // A Monday or a weekend needs no chip: the dim cell says it. Every
        // other rule is named, in full words that wrap inside the cell.
        <ReasonChip
          code={firstPlan.code}
          reason={firstPlan.reason}
          wrap
          className="hidden px-1.5 text-[10px] sm:inline-flex"
        />
      ) : null}
    </button>
  );
}

function DayPanel({
  date,
  day,
  planner,
  zone,
  today,
  disabled,
  onClose,
  onApply,
}: {
  date: string;
  day: PreviewDay | undefined;
  planner: PlannerConfig;
  zone: string;
  today: string;
  disabled: boolean;
  onClose: () => void;
  onApply: (changes: Partial<PlannerConfig>, done: string) => Promise<void>;
}) {
  const closedAlone = dateClosed(planner, date);
  const closure = plannerClosure(planner, date);
  const current = hoursFor(planner, date);
  const [hours, setHours] = React.useState<TimeWindow>(current ?? { from: '09:00', to: '17:00' });
  const past = date < today;
  return (
    <div
      className="space-y-3 rounded-[var(--radius-panel)] border border-[var(--border-strong)] bg-[var(--bg-raised)] p-3"
      role="region"
      aria-label={`Day ${dateLabel(date)}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-serif text-lg leading-tight font-semibold">{dateLabel(date)}</p>
          {closure && !closedAlone ? (
            <p className="text-xs text-[var(--fg-muted)]">{closure.text}</p>
          ) : null}
        </div>
        <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close the day">
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="grid gap-1.5">
        {day ? (
          PREVIEW_KEYS.map((k) => <KindLine key={k} kind={k} day={day} zone={zone} showReason />)
        ) : (
          <Skeleton className="h-16 w-full" />
        )}
      </div>
      {past ? null : (
        <>
          <label className="flex items-center justify-between gap-3 rounded-md border border-[var(--border)] p-2.5 text-sm">
            <span>
              <span className="block font-medium">Close this day</span>
              <span className="block text-xs text-[var(--fg-muted)]">Nobody can book it.</span>
            </span>
            <Switch
              checked={closedAlone}
              disabled={disabled}
              aria-label={`Close ${dateLabel(date)}`}
              onCheckedChange={() =>
                void onApply(
                  toggleDate(planner, date),
                  closedAlone ? `${dateLabel(date)} open again` : `${dateLabel(date)} closed`,
                )
              }
            />
          </label>
          <fieldset className="space-y-2 rounded-md border border-[var(--border)] p-2.5">
            <legend className="px-1 text-sm font-medium">Shorter hours this day</legend>
            <p className="text-xs text-[var(--fg-muted)]">
              Every meeting must fit inside. {BOOKING_HOURS_HINT}
            </p>
            <WindowRow
              label="Between"
              window={hours}
              bounds={{ from: '08:00', to: '19:00' }}
              disabled={disabled}
              onChange={setHours}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={disabled || hours.from >= hours.to}
                onClick={() =>
                  void onApply(
                    setDateHours(planner, date, hours),
                    `Shorter hours set for ${dateLabel(date)}`,
                  )
                }
              >
                {current ? 'Update hours' : 'Set hours'}
              </Button>
              {current ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    void onApply(
                      setDateHours(planner, date, null),
                      `Usual hours on ${dateLabel(date)}`,
                    )
                  }
                >
                  Back to the usual hours
                </Button>
              ) : null}
            </div>
          </fieldset>
        </>
      )}
    </div>
  );
}

function ClosedRanges({
  planner,
  today,
  disabled,
  onApply,
}: {
  planner: PlannerConfig;
  today: string;
  disabled: boolean;
  onApply: (changes: Partial<PlannerConfig>, done: string) => Promise<void>;
}) {
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [label, setLabel] = React.useState('');
  const ready = Boolean(from && to);
  return (
    <section aria-labelledby="booking-ranges" className="space-y-2" data-tour="booking-ranges">
      <h2 id="booking-ranges" className="text-title font-serif font-semibold">
        Close a run of days
      </h2>
      <p className="text-sm text-[var(--fg-muted)]">Holidays, a trip, a busy week.</p>
      {planner.closedRanges.length ? (
        <ul className="flex flex-wrap gap-2">
          {planner.closedRanges.map((r) => (
            <li
              key={`${r.from}-${r.to}`}
              className="inline-flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-[var(--bg-raised)] py-1 pr-1 pl-3 text-sm"
            >
              <CalendarX className="size-3.5 text-[var(--fg-muted)]" aria-hidden="true" />
              <span>
                {dateLabel(r.from)}
                {r.to !== r.from ? ` – ${dateLabel(r.to)}` : ''}
                {r.label ? <span className="text-[var(--fg-muted)]"> · {r.label}</span> : null}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                disabled={disabled}
                aria-label={`Open ${dateLabel(r.from)} to ${dateLabel(r.to)} again`}
                onClick={() =>
                  void onApply(removeClosedRange(planner, r), 'Those days are open again')
                }
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-[var(--fg-subtle)]">None closed.</p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="range-from">First day</Label>
          <Input
            id="range-from"
            type="date"
            min={today}
            value={from}
            disabled={disabled}
            className="w-40"
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="range-to">Last day</Label>
          <Input
            id="range-to"
            type="date"
            min={from || today}
            value={to}
            disabled={disabled}
            className="w-40"
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="range-label">Label (optional)</Label>
          <Input
            id="range-label"
            value={label}
            maxLength={60}
            placeholder="Holidays"
            disabled={disabled}
            className="w-44"
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <Button
          variant="secondary"
          disabled={disabled || !ready}
          onClick={() =>
            void onApply(
              addClosedRange(planner, { from, to, label }),
              'Those days are closed',
            ).then(() => {
              setFrom('');
              setTo('');
              setLabel('');
            })
          }
        >
          <Plus aria-hidden="true" />
          Close these days
        </Button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- hours, rules */

function HoursForm(props: AvailabilityPanelProps) {
  const { save, saving, problem } = useSettingsSave();
  const [hours, setHours] = React.useState<HoursConfig>(props.hours);
  const [dirty, setDirty] = React.useState(false);
  const disabled = !props.canEdit || saving;
  return (
    <div className="space-y-4" data-tour="booking-hours">
      <HoursFields
        hours={hours}
        hostZone={props.hostZone}
        disabled={disabled}
        inPersonOffered={props.inPersonOffered}
        onChange={(next) => {
          setHours(next);
          setDirty(true);
        }}
      />
      <SaveBar
        dirty={dirty}
        saving={saving}
        disabled={disabled}
        problem={problem}
        label="Save hours"
        onSave={async () => {
          const saved = await save({ config: hours }, 'Hours saved');
          if (saved) {
            setHours({
              callWindow: saved.config.callWindow,
              kindWindows: saved.config.kindWindows,
            });
            setDirty(false);
          }
        }}
      />
    </div>
  );
}

/** The hours themselves, held to the hard bounds (8:00 to 18:00 Central, dinner 18:00). */
export function HoursFields({
  hours,
  hostZone,
  disabled,
  inPersonOffered,
  onChange,
}: {
  hours: HoursConfig;
  hostZone: string;
  disabled: boolean;
  inPersonOffered: boolean;
  onChange: (hours: HoursConfig) => void;
}) {
  return (
    <>
      <p className="text-sm text-[var(--fg-muted)]">
        {BOOKING_HOURS_HINT} All in the host&apos;s time zone, {zoneName(hostZone)}.
      </p>
      <WindowRow
        label="Calls (30 minutes) between"
        window={hours.callWindow}
        bounds={CALL_BOUNDS}
        disabled={disabled}
        onChange={(w) => onChange({ ...hours, callWindow: w })}
      />
      {!inPersonOffered ? (
        <Notice>In person is off until the Places tab has a home city and a place.</Notice>
      ) : null}
      <div className="grid gap-3 lg:grid-cols-3">
        {MEETING_KINDS.map((kind) => (
          <KindWindows
            key={kind}
            kind={kind}
            windows={hours.kindWindows[kind]}
            disabled={disabled}
            onChange={(list) =>
              onChange({ ...hours, kindWindows: { ...hours.kindWindows, [kind]: list } })
            }
          />
        ))}
      </div>
    </>
  );
}

function RulesForm(props: AvailabilityPanelProps) {
  const { save, saving, problem } = useSettingsSave();
  const [rules, setRules] = React.useState<RulesConfig>(props.rules);
  const [dirty, setDirty] = React.useState(false);
  const disabled = !props.canEdit || saving;
  const set = <K extends keyof RulesConfig>(key: K, value: RulesConfig[K]) => {
    setRules((r) => ({ ...r, [key]: value }));
    setDirty(true);
  };
  const field = (
    key: keyof Omit<RulesConfig, 'weekdays' | 'allowGuests'>,
    label: string,
    min: number,
    max: number,
  ) => (
    <NumberField
      id={`rule-${key}`}
      label={label}
      min={min}
      max={max}
      value={rules[key]}
      disabled={disabled}
      onChange={(v) => set(key, v)}
    />
  );
  return (
    <div className="space-y-4" data-tour="booking-rules">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Days offered</legend>
        <p className="text-xs text-[var(--fg-muted)]">Never Monday, Friday or the weekend.</p>
        <div className="flex flex-wrap gap-3">
          {ALLOWED_WEEKDAYS.map((d) => (
            <label key={d} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={disabled}
                checked={rules.weekdays.includes(d)}
                onChange={(e) =>
                  set(
                    'weekdays',
                    e.target.checked
                      ? [...new Set([...rules.weekdays, d])].sort()
                      : rules.weekdays.filter((x) => x !== d),
                  )
                }
              />
              {WEEKDAY_NAME[d]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {field('callBufferMinutes', 'Buffer around meetings for a call (min)', 15, 120)}
        {field('inPersonBufferMinutes', 'Buffer for in person, travel (min)', 30, 180)}
        {field('noticeHours', 'Notice (hours)', 24, 336)}
        {field('maxLinkBookingsPerDay', 'Link bookings a day, at most', 0, 10)}
        {field('maxMeetingsPerDay', 'No new times once a day has (meetings)', 1, 15)}
        {field('stackSize', 'Back-to-back run of (meetings)', 2, 8)}
        {field('stackGapMinutes', 'Back to back means gaps under (min)', 0, 60)}
        {field('stackCooldownMinutes', 'Free time after such a run (min)', 0, 240)}
        {field('stackLeadMinutes', 'Free time before such a run (min)', 15, 120)}
      </div>
      <fieldset
        className="space-y-3 rounded-[var(--radius-panel)] border border-[var(--border)] p-3"
        data-tour="booking-guests"
      >
        <legend className="px-1 text-sm font-medium">Guests</legend>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            <span className="block font-medium">Let people add guests</span>
            <span className="block text-xs text-[var(--fg-muted)]">
              Like Calendly: a co-founder or a colleague, invited with them.
            </span>
          </span>
          <Switch
            checked={rules.allowGuests}
            disabled={disabled}
            aria-label="Let people add guests"
            onCheckedChange={(v) => set('allowGuests', v)}
          />
        </label>
        {rules.allowGuests ? field('maxGuests', 'Guests a booking, at most', 0, 10) : null}
      </fieldset>
      <SaveBar
        dirty={dirty}
        saving={saving}
        disabled={disabled}
        problem={problem}
        label="Save rules"
        onSave={async () => {
          const saved = await save({ config: rules }, 'Rules saved');
          if (saved) setDirty(false);
        }}
      />
    </div>
  );
}

export function SaveBar({
  dirty,
  saving,
  disabled,
  problem,
  label,
  onSave,
}: {
  dirty: boolean;
  saving: boolean;
  disabled: boolean;
  problem: string | null;
  label: string;
  onSave: () => void | Promise<void>;
}) {
  return (
    <div className="space-y-3 border-t border-[var(--border)] pt-4">
      {problem ? (
        <div role="alert">
          <Notice tone="warn">{problem}</Notice>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          loading={saving}
          disabled={disabled || !dirty}
          onClick={() => void onSave()}
        >
          {label}
        </Button>
        {dirty ? <Badge tone="warn">Unsaved changes</Badge> : null}
      </div>
    </div>
  );
}
