import { addDaysToKey, localDateKey } from '@/lib/util/time';

/**
 * The Affinity exit checklist (Knowledge → Affinity import → Exit checklist):
 * the date Affinity needs notice by, whether it has been cancelled, and the
 * outside tools that still read from it.
 *
 * All of it is data the workspace enters on the page and keeps in the
 * database (lib/services/affinity-exit.ts): no date, tool or vendor is ever
 * written into the code. Pure and dependency-free apart from the date
 * helpers, so the page, the server and the tests share one set of rules.
 */

/** One outside tool that still uses Affinity, as someone typed it. */
export interface AffinityExitTool {
  id: string;
  label: string;
  /** Ticked: moved off Affinity, or switched off. */
  done: boolean;
}

export interface AffinityExitSettings {
  /** The last day to give Affinity notice, `YYYY-MM-DD`; null until someone sets it. */
  noticeDate: string | null;
  /** Ticked once the notice is sent: the countdown and the Today line stop. */
  cancelled: boolean;
  /** When the box was ticked; null while it is not. */
  cancelledAt: string | null;
  tools: AffinityExitTool[];
}

/** Tools on the checklist at most: a list to work through, not a database. */
export const AFFINITY_EXIT_TOOLS_MAX = 40;
export const AFFINITY_EXIT_TOOL_LABEL_MAX = 120;
/** Today shows its one line only this many days before the notice date, and on the day. */
export const AFFINITY_EXIT_TODAY_DAYS = 14;

export function emptyAffinityExitSettings(): AffinityExitSettings {
  return { noticeDate: null, cancelled: false, cancelledAt: null, tools: [] };
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day as `YYYY-MM-DD` (not 2026-02-30), within a sane range of years. */
export function isAffinityExitDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_KEY.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  if (year < 2000 || year > 2100) return false;
  return addDaysToKey(value, 0) === value;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A tool label as stored: trimmed, inner whitespace collapsed, capped. */
export function cleanToolLabel(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, AFFINITY_EXIT_TOOL_LABEL_MAX);
}

/** Saved settings, read defensively: anything malformed is dropped, never thrown. */
export function parseAffinityExitSettings(raw: unknown): AffinityExitSettings {
  const out = emptyAffinityExitSettings();
  if (!isObject(raw)) return out;
  out.noticeDate = isAffinityExitDate(raw.noticeDate) ? raw.noticeDate : null;
  out.cancelled = raw.cancelled === true;
  out.cancelledAt =
    out.cancelled &&
    typeof raw.cancelledAt === 'string' &&
    !Number.isNaN(Date.parse(raw.cancelledAt))
      ? raw.cancelledAt
      : null;
  if (Array.isArray(raw.tools)) {
    const seen = new Set<string>();
    for (const t of raw.tools) {
      if (!isObject(t) || typeof t.id !== 'string' || typeof t.label !== 'string') continue;
      const label = cleanToolLabel(t.label);
      if (!t.id || !label || seen.has(t.id)) continue;
      seen.add(t.id);
      out.tools.push({ id: t.id.slice(0, 64), label, done: t.done === true });
      if (out.tools.length >= AFFINITY_EXIT_TOOLS_MAX) break;
    }
  }
  return out;
}

/** One change from the page; the server applies it to the newest saved settings. */
export type AffinityExitChange =
  | { op: 'date'; date: string | null }
  | { op: 'cancelled'; cancelled: boolean }
  | { op: 'add-tool'; label: string }
  | { op: 'tick-tool'; id: string; done: boolean }
  | { op: 'remove-tool'; id: string };

export type AffinityExitApplied =
  { ok: true; settings: AffinityExitSettings } | { ok: false; message: string };

/**
 * Apply one change. Changes rather than whole lists, so two people ticking
 * different tools at once both keep their tick: each is applied to whatever
 * was saved last. `id` names a new tool.
 */
export function applyAffinityExitChange(
  current: AffinityExitSettings,
  change: AffinityExitChange,
  context: { now: Date; id: () => string },
): AffinityExitApplied {
  const next: AffinityExitSettings = { ...current, tools: current.tools.map((t) => ({ ...t })) };
  switch (change.op) {
    case 'date': {
      if (change.date !== null && !isAffinityExitDate(change.date)) {
        return { ok: false, message: 'Pick a real date for the notice deadline.' };
      }
      next.noticeDate = change.date;
      return { ok: true, settings: next };
    }
    case 'cancelled': {
      next.cancelled = change.cancelled;
      next.cancelledAt = change.cancelled
        ? (current.cancelledAt ?? context.now.toISOString())
        : null;
      return { ok: true, settings: next };
    }
    case 'add-tool': {
      const label = cleanToolLabel(change.label);
      if (!label) return { ok: false, message: 'Type the name of the tool first.' };
      if (next.tools.some((t) => t.label.toLowerCase() === label.toLowerCase())) {
        return { ok: false, message: `“${label}” is already on the list.` };
      }
      if (next.tools.length >= AFFINITY_EXIT_TOOLS_MAX) {
        return {
          ok: false,
          message: `The list holds ${AFFINITY_EXIT_TOOLS_MAX} tools at most. Remove one that is done first.`,
        };
      }
      next.tools.push({ id: context.id(), label, done: false });
      return { ok: true, settings: next };
    }
    case 'tick-tool':
    case 'remove-tool': {
      const index = next.tools.findIndex((t) => t.id === change.id);
      // Already gone (someone else removed it): nothing to do, and no error.
      if (index < 0) return { ok: true, settings: next };
      if (change.op === 'remove-tool') next.tools.splice(index, 1);
      else next.tools[index] = { ...(next.tools[index] as AffinityExitTool), done: change.done };
      return { ok: true, settings: next };
    }
  }
}

/** Whole days from today (in `timeZone`) to a `YYYY-MM-DD` date: 0 on the day, negative after. */
export function daysUntil(dateKey: string, now: Date, timeZone: string): number {
  const today = localDateKey(now, timeZone);
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${dateKey}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export interface AffinityExitCountdown {
  dateKey: string;
  daysLeft: number;
}

/** The countdown the page shows; null with no date, or once cancelled. */
export function affinityExitCountdown(
  settings: AffinityExitSettings,
  now: Date,
  timeZone: string,
): AffinityExitCountdown | null {
  if (settings.cancelled || !settings.noticeDate) return null;
  return { dateKey: settings.noticeDate, daysLeft: daysUntil(settings.noticeDate, now, timeZone) };
}

/**
 * The one line Today shows: only in the last `AFFINITY_EXIT_TODAY_DAYS` days
 * before the notice date and on the day itself, never once cancelled, never
 * without a date, and gone the day after (the checklist still has it).
 */
export function affinityExitTodayLine(
  settings: AffinityExitSettings,
  now: Date,
  timeZone: string,
): AffinityExitCountdown | null {
  const countdown = affinityExitCountdown(settings, now, timeZone);
  if (!countdown) return null;
  return countdown.daysLeft >= 0 && countdown.daysLeft <= AFFINITY_EXIT_TODAY_DAYS
    ? countdown
    : null;
}

/** "today", "tomorrow", "in 9 days", "3 days ago". */
export function daysLeftLabel(daysLeft: number): string {
  if (daysLeft === 0) return 'today';
  if (daysLeft === 1) return 'tomorrow';
  if (daysLeft === -1) return 'yesterday';
  return daysLeft > 0 ? `in ${daysLeft} days` : `${-daysLeft} days ago`;
}

/** "Fri, Mar 15" for a `YYYY-MM-DD`, read as the calendar day it is (no time zone shift). */
export function noticeDateLabel(dateKey: string, withYear = false): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  }).format(new Date(`${dateKey}T12:00:00Z`));
}

/** What the daily sync is doing, as the checklist's status row puts it. */
export type AffinityDailySyncState = 'key_missing' | 'stopped' | 'syncing' | 'running';

export function affinityDailySyncState(sync: {
  configured: boolean;
  running: boolean;
  stopped?: unknown;
}): AffinityDailySyncState {
  if (!sync.configured) return 'key_missing';
  if (sync.stopped) return 'stopped';
  return sync.running ? 'syncing' : 'running';
}
