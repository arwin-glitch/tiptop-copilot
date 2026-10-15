/**
 * Keep-in-touch cadences: "check in with this person every month".
 *
 * Pure, so the profile, the Network list, the task sweep and the tests all do
 * the same arithmetic. A cadence is a number of days. When the next check-in
 * is due is counted from the last real contact — an email either way or a
 * meeting that has happened, from the same mail and calendar records the
 * Network page counts — or from the last time a check-in task for them was
 * finished, whichever is later. Someone with no contact on record at all is
 * counted from when the cadence was set, so setting one never makes a task
 * appear out of nowhere. Every figure is a date the person can check.
 */

export const CADENCE_PRESETS = ['biweekly', 'monthly', 'quarterly'] as const;
export type CadencePreset = (typeof CADENCE_PRESETS)[number];
export type CadenceChoice = CadencePreset | 'custom';

export const PRESET_DAYS: Record<CadencePreset, number> = {
  biweekly: 14,
  monthly: 30,
  quarterly: 91,
};

export const PRESET_LABELS: Record<CadencePreset, string> = {
  biweekly: 'Every 2 weeks',
  monthly: 'Every month',
  quarterly: 'Every quarter',
};

/** A custom cadence is a whole number of days in this range. */
export const CADENCE_MIN_DAYS = 1;
export const CADENCE_MAX_DAYS = 365;

const DAY_MS = 86_400_000;

/** A cadence as it is stored: newest wins, and `days: null` means it was turned off. */
export interface Cadence {
  days: number;
  choice: CadenceChoice;
  /** When it was set (ISO). */
  setAt: string;
  setBy: string | null;
  /** The user who set it, so its check-in tasks go to them. */
  setById: string | null;
}

/** The days a choice stands for, or null when a custom number is out of range or not whole. */
export function cadenceDays(choice: CadenceChoice, customDays?: number | null): number | null {
  if (choice !== 'custom') return PRESET_DAYS[choice];
  if (typeof customDays !== 'number' || !Number.isInteger(customDays)) return null;
  if (customDays < CADENCE_MIN_DAYS || customDays > CADENCE_MAX_DAYS) return null;
  return customDays;
}

/** The preset a number of days is, if it is one; a custom cadence otherwise. */
export function choiceForDays(days: number): CadenceChoice {
  return CADENCE_PRESETS.find((p) => PRESET_DAYS[p] === days) ?? 'custom';
}

/** "Every month", "Every 10 days", "Every day". */
export function cadenceLabel(days: number): string {
  const choice = choiceForDays(days);
  if (choice !== 'custom') return PRESET_LABELS[choice];
  return days === 1 ? 'Every day' : `Every ${days} days`;
}

/** How close a check-in is: a week out (less for short cadences) is "due soon". */
export function dueSoonDays(days: number): number {
  return Math.min(7, Math.max(1, Math.ceil(days / 4)));
}

export type CadenceState = 'overdue' | 'due_soon' | 'on_track';

/** What the next check-in is counted from. */
export type CadenceBasis = 'contact' | 'check_in' | 'set';

export interface CadenceStatus {
  days: number;
  /** The date the cadence is counted from (ISO). */
  anchorAt: string;
  basis: CadenceBasis;
  /** When the next check-in is due (ISO). */
  dueAt: string;
  state: CadenceState;
  /** Whole days until due; negative once overdue. */
  daysUntilDue: number;
}

export interface CadenceInputs {
  cadence: Pick<Cadence, 'days' | 'setAt'>;
  /** The last email or past meeting with them (ISO), from the contact evidence. */
  lastContactAt: string | null;
  /** When a check-in task for them was last finished or dismissed (ISO). */
  lastCheckInAt: string | null;
  now: Date;
}

function time(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** When the next check-in is due, from what, and how close it is. */
export function cadenceStatus({
  cadence,
  lastContactAt,
  lastCheckInAt,
  now,
}: CadenceInputs): CadenceStatus {
  const contact = time(lastContactAt);
  const checkIn = time(lastCheckInAt);
  let anchor: number;
  let basis: CadenceBasis;
  if (contact !== null && (checkIn === null || contact >= checkIn)) {
    anchor = contact;
    basis = 'contact';
  } else if (checkIn !== null) {
    anchor = checkIn;
    basis = 'check_in';
  } else {
    anchor = time(cadence.setAt) ?? now.getTime();
    basis = 'set';
  }
  const due = anchor + cadence.days * DAY_MS;
  const until = due - now.getTime();
  // Whole days: a monthly cadence set a moment ago is "due in 30 days", not
  // 29, and any time past due is at least "1 day overdue" rather than "0".
  const daysUntilDue = until >= 0 ? Math.round(until / DAY_MS) : -Math.ceil(-until / DAY_MS);
  const state: CadenceState =
    until <= 0 ? 'overdue' : daysUntilDue < dueSoonDays(cadence.days) ? 'due_soon' : 'on_track';
  return {
    days: cadence.days,
    anchorAt: new Date(anchor).toISOString(),
    basis,
    dueAt: new Date(due).toISOString(),
    state,
    daysUntilDue,
  };
}

/** "Due in 3 days", "Due today", "2 days overdue". */
export function dueLabel(status: Pick<CadenceStatus, 'state' | 'daysUntilDue'>): string {
  if (status.state === 'overdue') {
    const n = Math.max(1, -status.daysUntilDue);
    return `${n} ${n === 1 ? 'day' : 'days'} overdue`;
  }
  if (status.daysUntilDue === 0) return 'Due today';
  return `Due in ${status.daysUntilDue} ${status.daysUntilDue === 1 ? 'day' : 'days'}`;
}

/** Overdue first (most overdue first), then due soon, then on track, soonest first. */
export function compareCadenceStatus(a: CadenceStatus, b: CadenceStatus): number {
  return Date.parse(a.dueAt) - Date.parse(b.dueAt);
}

/* ------------------------------------------------------------ check-in tasks */

/**
 * Case- and whitespace-insensitive, exactly as task-ingest's normalizeTitle
 * matches one task title against another (that module reads server config,
 * so it is not imported into this browser-safe one).
 */
function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The title of a record's check-in task. */
export function checkInTitle(name: string): string {
  return `Check in with ${name.trim().replace(/\s+/g, ' ')}`;
}

/** Where a check-in task points back to; also how one is recognised as that record's. */
export function recordPath(recordId: string): string {
  return `/lists/records/${recordId}`;
}

/** The parts of a task the planning needs. */
export interface TaskLike {
  title: string;
  detail: string | null;
  status: 'open' | 'snoozed' | 'complete' | 'cancelled';
  created_at: string;
  completed_at: string | null;
  updated_at: string;
}

/** A task is a record's check-in when it carries the record's link, or has its check-in title. */
export function isCheckInFor(task: TaskLike, recordId: string, name: string): boolean {
  if (task.detail?.includes(recordPath(recordId))) return true;
  return normalizeTitle(task.title) === normalizeTitle(checkInTitle(name));
}

/**
 * When a check-in for this record was last finished or dismissed: a finished
 * task counts as having checked in (a call leaves no email behind), and a
 * dismissed one as "not this round", so the next one comes a cadence later.
 */
export function lastCheckInAt(
  tasks: readonly TaskLike[],
  recordId: string,
  name: string,
): string | null {
  let latest: number | null = null;
  for (const task of tasks) {
    if (task.status !== 'complete' && task.status !== 'cancelled') continue;
    if (!isCheckInFor(task, recordId, name)) continue;
    const at = time(
      task.status === 'complete' ? (task.completed_at ?? task.updated_at) : task.updated_at,
    );
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export interface CheckInCandidate {
  recordId: string;
  name: string;
  status: CadenceStatus;
  cadenceLabel: string;
  /** A sentence about the last contact, for the task's detail; null when there is none. */
  lastContact: string | null;
}

export interface PlannedCheckIn {
  recordId: string;
  title: string;
  detail: string;
  dueAt: string;
}

export interface CheckInPlan {
  create: PlannedCheckIn[];
  /** Titles left alone because a task for this round already exists. */
  existing: string[];
}

/**
 * Which check-in tasks to add. Add-only, with task-ingest's "never resurrect"
 * rule, made to fit something that comes round again: a due record gets a
 * task unless one for it is already open or snoozed, or one was made since
 * the cadence's current start — finished or not. A finished check-in moves
 * that start (see lastCheckInAt), which is what lets the next round's task
 * be made; nothing finished in this round ever comes back. Matching is by
 * the record's link and, as task-ingest matches, by title.
 */
export function planCheckIns(
  candidates: readonly CheckInCandidate[],
  tasks: readonly TaskLike[],
  now: Date,
): CheckInPlan {
  const plan: CheckInPlan = { create: [], existing: [] };
  const titlesThisRun = new Set<string>();
  for (const c of candidates) {
    if (Date.parse(c.status.dueAt) > now.getTime()) continue;
    const title = checkInTitle(c.name);
    const key = normalizeTitle(title);
    const anchor = Date.parse(c.status.anchorAt);
    const blocked =
      titlesThisRun.has(key) ||
      tasks.some(
        (t) =>
          isCheckInFor(t, c.recordId, c.name) &&
          (t.status === 'open' || t.status === 'snoozed' || Date.parse(t.created_at) >= anchor),
      );
    if (blocked) {
      plan.existing.push(title);
      continue;
    }
    titlesThisRun.add(key);
    plan.create.push({
      recordId: c.recordId,
      title,
      detail: [
        `Keep in touch: ${c.cadenceLabel.toLowerCase()}.`,
        c.lastContact ?? 'No contact on record since the cadence was set.',
        `Profile: ${recordPath(c.recordId)}`,
      ].join(' '),
      dueAt: c.status.dueAt,
    });
  }
  return plan;
}
