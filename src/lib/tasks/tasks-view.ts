import type { Task } from '@/lib/types/domain';
import {
  addDaysToKey,
  formatDate,
  formatDateTime,
  formatTime,
  formatWeekdayTime,
  localDateKey,
  relativeTime,
} from '@/lib/util/time';

/**
 * The Tasks page's tabs, when a snoozed task wakes, and the grouping of the
 * Completed tab.
 *
 * Pure, and outside the components, so the server page and the client tabs
 * share one reading of `?view=` and the grouping can be tested on its own.
 */

export type TasksView = 'todo' | 'snoozed' | 'completed';

/** `?view=snoozed` or `?view=completed` opens that tab; anything else, or nothing, is To do. */
export function readTasksView(value: string | null | undefined): TasksView {
  return value === 'completed' || value === 'snoozed' ? value : 'todo';
}

/** `search` with the view written in; To do is the bare URL. Other keys are kept. */
export function withTasksView(search: string, view: TasksView): URLSearchParams {
  const next = new URLSearchParams(search);
  if (view === 'todo') next.delete('view');
  else next.set('view', view);
  return next;
}

/** Where an Undo puts a task back: open, or snoozed until the same time. */
export type TaskRestore = { status: 'open' } | { status: 'snoozed'; snoozedUntil: string | null };

/**
 * A snoozed task whose wake time has passed. Nothing writes when a snooze
 * ends: the row stays `snoozed` and every list works out that it is due back.
 * A snooze with no wake time never wakes by itself.
 */
export function isAwake(task: Pick<Task, 'status' | 'snoozed_until'>, now: Date): boolean {
  if (task.status !== 'snoozed' || !task.snoozed_until) return false;
  const until = Date.parse(task.snoozed_until);
  return !Number.isNaN(until) && until <= now.getTime();
}

/** On the To do list: open, or snoozed and awake. */
export function isOpenNow(task: Pick<Task, 'status' | 'snoozed_until'>, now: Date): boolean {
  return task.status === 'open' || isAwake(task, now);
}

/** Still asleep: snoozed, and waking later or never. */
export function isAsleep(task: Pick<Task, 'status' | 'snoozed_until'>, now: Date): boolean {
  return task.status === 'snoozed' && !isAwake(task, now);
}

/** Soonest wake first; no wake time last. */
export function sortSnoozed<T extends Pick<Task, 'id' | 'snoozed_until'>>(
  tasks: readonly T[],
): T[] {
  const at = (task: T) => {
    const ms = task.snoozed_until ? Date.parse(task.snoozed_until) : Number.NaN;
    return Number.isNaN(ms) ? Infinity : ms;
  };
  return [...tasks].sort((a, b) => at(a) - at(b) || a.id.localeCompare(b.id));
}

/** "Wakes Sep 29, 9:14 AM · 4d from now", or "No wake date". */
export function wakeLabel(snoozedUntil: string | null, now: Date, timeZone: string): string {
  const ms = snoozedUntil ? Date.parse(snoozedUntil) : Number.NaN;
  if (Number.isNaN(ms)) return 'No wake date';
  const at = new Date(ms);
  return `Wakes ${formatDateTime(at, timeZone)} · ${relativeTime(at, now)}`;
}

/**
 * A snoozed row's due line, "Due 1d from now", with `beforeWake` set when the
 * deadline comes before the task wakes (or it has no wake date). Null
 * without a due date.
 */
export function snoozedDueLabel(
  dueAt: string | null,
  snoozedUntil: string | null,
  now: Date,
): { text: string; beforeWake: boolean } | null {
  const due = dueAt ? Date.parse(dueAt) : Number.NaN;
  if (Number.isNaN(due)) return null;
  const wake = snoozedUntil ? Date.parse(snoozedUntil) : Number.NaN;
  const beforeWake = Number.isNaN(wake) || due < wake;
  const when = relativeTime(new Date(due), now);
  const text = due < now.getTime() ? `Overdue, was due ${when}` : `Due ${when}`;
  return { text: beforeWake ? `${text}, before it wakes` : text, beforeWake };
}

export type CompletedGroupKey = 'today' | 'yesterday' | 'this_week' | 'earlier';

export const COMPLETED_GROUP_LABELS: Record<CompletedGroupKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'Earlier this week',
  earlier: 'Earlier',
};

/** When a completed task was completed: `completed_at`, else its last update. */
export function completedAt(task: Pick<Task, 'completed_at' | 'updated_at'>): string {
  return task.completed_at ?? task.updated_at;
}

/** Newest completed first; a task with no readable date goes last. */
export function sortCompleted<T extends Pick<Task, 'id' | 'completed_at' | 'updated_at'>>(
  tasks: readonly T[],
): T[] {
  const at = (task: T) => {
    const ms = Date.parse(completedAt(task));
    return Number.isNaN(ms) ? -Infinity : ms;
  };
  return [...tasks].sort((a, b) => at(b) - at(a) || a.id.localeCompare(b.id));
}

/**
 * Which heading a completion falls under, by calendar day in `timeZone`.
 * Weeks start on Monday, so on a Monday "Earlier this week" is empty and
 * Sunday is Yesterday. A time after `now` (clock skew) counts as Today.
 */
export function completedGroup(at: string | Date, now: Date, timeZone: string): CompletedGroupKey {
  const instant = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(instant.getTime())) return 'earlier';

  const today = localDateKey(now, timeZone);
  const day = localDateKey(instant, timeZone);
  // YYYY-MM-DD keys compare correctly as strings.
  if (day >= today) return 'today';
  if (day === addDaysToKey(today, -1)) return 'yesterday';

  const [y, m, d] = today.split('-').map(Number);
  const weekday = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  const monday = addDaysToKey(today, -((weekday + 6) % 7));
  return day >= monday ? 'this_week' : 'earlier';
}

/**
 * The "Completed …" line under a row, worded from the same calendar day as its
 * heading: a rounded "2d ago" could sit under Yesterday, or "1d ago" under
 * Earlier.
 */
export function completedLabel(
  at: string | Date,
  group: CompletedGroupKey,
  now: Date,
  timeZone: string,
): string {
  const instant = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(instant.getTime())) return 'Completed';
  switch (group) {
    case 'today': {
      const ago = now.getTime() - instant.getTime();
      // Past a day ("1d ago") only on a 25-hour day; ahead of now only by clock skew.
      return ago > -60_000 && ago < 86_400_000
        ? `Completed ${relativeTime(instant, now)}`
        : `Completed at ${formatTime(instant, timeZone)}`;
    }
    case 'yesterday':
      return `Completed at ${formatTime(instant, timeZone)}`;
    case 'this_week':
      return `Completed ${formatWeekdayTime(instant, timeZone)}`;
    case 'earlier':
      return `Completed ${formatDate(instant, timeZone)}`;
  }
}

/** How many completed tasks show before "Show more". */
export const COMPLETED_PAGE = 100;

export interface CompletedGroup<T> {
  key: CompletedGroupKey;
  label: string;
  items: T[];
}

/**
 * Consecutive runs of items that share a group, in order. Given a list sorted
 * newest first (`sortCompleted`), that is one run per heading, and a list cut
 * short by "Show more" still groups correctly.
 */
export function groupRuns<T extends { group: CompletedGroupKey }>(
  items: readonly T[],
): CompletedGroup<T>[] {
  const out: CompletedGroup<T>[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last && last.key === item.group) last.items.push(item);
    else out.push({ key: item.group, label: COMPLETED_GROUP_LABELS[item.group], items: [item] });
  }
  return out;
}

export interface CompletedSections<T> {
  /** The shown rows under their headings; `total` also counts rows still hidden. */
  sections: (CompletedGroup<T> & { total: number })[];
  hidden: number;
}

/** The first `shown` of a newest-first list, under headings that count the whole group. */
export function completedSections<T extends { group: CompletedGroupKey }>(
  items: readonly T[],
  shown: number,
): CompletedSections<T> {
  const totals = new Map<CompletedGroupKey, number>();
  for (const item of items) totals.set(item.group, (totals.get(item.group) ?? 0) + 1);
  const visible = items.slice(0, Math.max(0, shown));
  return {
    sections: groupRuns(visible).map((group) => ({ ...group, total: totals.get(group.key) ?? 0 })),
    hidden: items.length - visible.length,
  };
}

/** Where a task's title links: its deal, else its portfolio company. */
export function taskHref(task: Pick<Task, 'deal_id' | 'portfolio_company_id'>): string | null {
  if (task.deal_id) return `/deals/${task.deal_id}`;
  if (task.portfolio_company_id) return `/portfolio/${task.portfolio_company_id}`;
  return null;
}
