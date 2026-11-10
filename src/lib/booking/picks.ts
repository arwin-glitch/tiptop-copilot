import { z } from 'zod';
import { MEETING_KINDS, type MeetingKind, type MeetingType } from './config';
import { SUPPORTED_TIMEZONES } from '@/lib/util/time';

/**
 * "Pick times" (Vimcal-style): the host picks a few open ranges on his
 * Calendar, copies them with a link, and pastes both into an email. The
 * person he sends it to books one start inside those ranges, at
 * /meet/<slug>/p/<token>. Pure and client-safe: the Calendar's pick panel
 * checks the same rules before sending, and the server decides with them.
 *
 * - Ranges snap to 15 minutes, never start in the past, never overlap
 *   (touching or overlapping ones merge into one), at most 20 of them, and
 *   none ends more than 60 days ahead.
 * - Inside each range a start is offered every 15 minutes for a 15-minute
 *   meeting, else every 30, from the range's own start, while the meeting
 *   still ends inside the range.
 * - While a pick is open (and held) its ranges are kept off the public link;
 *   they are not meetings, so they count toward no cap (lib/booking/engine.ts).
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The duration chips the panel offers. The server accepts any quarter hour up to four. */
export const PICK_DURATIONS = [15, 30, 45, 60] as const;
export const DEFAULT_PICK_DURATION = 30;
export const MIN_PICK_MINUTES = 15;
export const MAX_PICK_MINUTES = 240;
/** How long the picked times are held: 24 hours, 48 hours, or a week. */
export const PICK_HOLD_HOURS = [24, 48, 168] as const;
export type PickHoldHours = (typeof PICK_HOLD_HOURS)[number];
export const DEFAULT_PICK_HOLD_HOURS: PickHoldHours = 48;
export const MAX_PICK_RANGES = 20;
export const MAX_PICK_DAYS_AHEAD = 60;
export const PICK_SNAP_MINUTES = 15;
export const PICK_NAME_MAX = 80;
/** In person picks need a kind for the event's title and place flow: coffee unless chosen. */
export const DEFAULT_PICK_KIND: MeetingKind = 'coffee';

/** "HH:MM" of an instant in a zone. */
function clockAt(iso: string, zone: string): string | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
    return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  } catch {
    return null;
  }
}

type KindWindows = Partial<Record<MeetingKind, readonly { from: string; to: string }[]>>;

/**
 * Which meal a picked in-person time is, when the host did not choose one:
 * the kind whose start windows hold the first start, else by time of day
 * (before 11 coffee, 11 to 2 lunch, 2 to 5 coffee, 5 on dinner). So 6 PM is
 * dinner, never coffee.
 */
export function inferPickKind(
  firstStart: string | null | undefined,
  windows: KindWindows,
  zone: string,
): MeetingKind {
  const clock = firstStart ? clockAt(firstStart, zone) : null;
  if (!clock) return DEFAULT_PICK_KIND;
  for (const kind of ['dinner', 'lunch', 'coffee'] as const) {
    if ((windows[kind] ?? []).some((w) => w.from <= clock && clock <= w.to)) return kind;
  }
  if (clock >= '17:00') return 'dinner';
  if (clock >= '11:00' && clock < '14:00') return 'lunch';
  return 'coffee';
}

/**
 * The kind a pick is shown and booked as. A pick saved as coffee (the old
 * default) at a lunch or dinner hour reads as that meal instead.
 */
export function resolvePickKind(
  stored: MeetingKind | null,
  firstStart: string | null | undefined,
  windows: KindWindows,
  zone: string,
): MeetingKind {
  const inferred = inferPickKind(firstStart, windows, zone);
  if (!stored) return inferred;
  if (stored === 'coffee' && inferred !== 'coffee') {
    const clock = firstStart ? clockAt(firstStart, zone) : null;
    const inCoffee =
      clock !== null && (windows.coffee ?? []).some((w) => w.from <= clock && clock <= w.to);
    if (!inCoffee) return inferred;
  }
  return stored;
}

export const PICK_HOLD_LABEL: Record<PickHoldHours, string> = {
  24: '24 hours',
  48: '48 hours',
  168: '1 week',
};

/** What the guest sees when a pick is used, cancelled, past its time or unknown. */
export const PICK_GONE_MESSAGE = 'These times are no longer available.';
/** The answer when another guest took the start a moment ago. */
export const PICK_TAKEN_MESSAGE = 'That time was just taken.';
/** The manage page's line in place of Reschedule for a booking made from picked times. */
export const PICK_MOVE_MESSAGE = 'To move it, reply to the email you got.';
export const PICKS_NOT_SET_UP = 'Pick times needs a database update.';

/** One picked range, RFC 3339 instants. */
export interface PickRange {
  start: string;
  end: string;
}

/** A range as milliseconds. */
interface Span {
  start: number;
  end: number;
}

/** Whether two half-open spans overlap. */
export function spansOverlap(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Ranges sorted, with touching or overlapping ones merged into one. Ranges
 * that cannot be read, or end before they start, are dropped.
 */
export function mergeRanges(ranges: readonly PickRange[]): PickRange[] {
  const spans = ranges
    .map((r) => ({ start: Date.parse(r.start), end: Date.parse(r.end) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else out.push({ ...span });
  }
  return out.map((s) => ({
    start: new Date(s.start).toISOString(),
    end: new Date(s.end).toISOString(),
  }));
}

/** Minutes between starts inside a range: 15 for a 15-minute meeting, else 30. */
export function pickStepMinutes(durationMinutes: number): number {
  return durationMinutes === 15 ? 15 : 30;
}

/**
 * Every start a pick offers before anything is busy, soonest first: from
 * each range's own start, every 15 or 30 minutes (pickStepMinutes), while
 * the meeting ends inside the range and the start is still ahead of `now`.
 */
export function pickCandidateStarts(
  ranges: readonly PickRange[],
  durationMinutes: number,
  now: Date,
): number[] {
  const length = durationMinutes * MINUTE;
  const step = pickStepMinutes(durationMinutes) * MINUTE;
  const out = new Set<number>();
  for (const range of ranges) {
    const start = Date.parse(range.start);
    const end = Date.parse(range.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || length <= 0) continue;
    for (let t = start; t + length <= end; t += step) {
      if (t > now.getTime()) out.add(t);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** What a pick's start must stay clear of: busy time, time-holding bookings, other picks' holds. */
export interface PickClearance {
  /** Busy time on the host's calendars (all-day entries too), as read fresh. */
  busy: readonly Span[];
  /** The link's bookings that hold time (waiting, held, approved or booked). */
  bookings: readonly Span[];
  /** Other open picks' held ranges (never this pick's own). */
  holds: readonly Span[];
}

/** Whether a start (with this length) overlaps anything it must stay clear of. No buffers. */
export function pickStartBlocked(
  start: number,
  durationMinutes: number,
  clear: PickClearance,
): boolean {
  const span = { start, end: start + durationMinutes * MINUTE };
  return (
    clear.busy.some((b) => spansOverlap(span, b)) ||
    clear.bookings.some((b) => spansOverlap(span, b)) ||
    clear.holds.some((h) => spansOverlap(span, h))
  );
}

/** The starts a pick offers now: its candidates, less any that overlap (pickStartBlocked). */
export function pickOfferedStarts(
  pick: { ranges: readonly PickRange[]; durationMinutes: number },
  now: Date,
  clear: PickClearance,
): { start: string; end: string }[] {
  return pickCandidateStarts(pick.ranges, pick.durationMinutes, now)
    .filter((t) => !pickStartBlocked(t, pick.durationMinutes, clear))
    .map((t) => ({
      start: new Date(t).toISOString(),
      end: new Date(t + pick.durationMinutes * MINUTE).toISOString(),
    }));
}

/** When a pick stops holding (and taking bookings): the hold's end, or the last range's end. */
export function pickExpiresAt(now: Date, holdHours: number, ranges: readonly PickRange[]): string {
  const lastEnd = Math.max(...ranges.map((r) => Date.parse(r.end)).filter(Number.isFinite));
  const held = now.getTime() + holdHours * 60 * MINUTE;
  return new Date(Number.isFinite(lastEnd) ? Math.min(held, lastEnd) : held).toISOString();
}

/** Whether a zone is one the panel offers (SUPPORTED_TIMEZONES). */
export function isPickZone(zone: string): boolean {
  return (SUPPORTED_TIMEZONES as readonly string[]).includes(zone);
}

/**
 * The ranges a pick may keep, merged, or the first problem in plain words:
 * each snapped to 15 minutes, ahead of `now`, within 60 days, at least as
 * long as the meeting, and at most 20 once merged.
 */
export function checkPickRanges(
  ranges: readonly PickRange[],
  durationMinutes: number,
  now: Date,
): { ok: true; ranges: PickRange[] } | { ok: false; problem: string } {
  if (ranges.length === 0) return { ok: false, problem: 'Pick at least one time.' };
  const snap = PICK_SNAP_MINUTES * MINUTE;
  const latest = now.getTime() + MAX_PICK_DAYS_AHEAD * DAY;
  for (const r of ranges) {
    const start = Date.parse(r.start);
    const end = Date.parse(r.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return { ok: false, problem: 'One of the times could not be read. Pick it again.' };
    }
    if (start % snap !== 0 || end % snap !== 0) {
      return { ok: false, problem: 'Times go in steps of 15 minutes.' };
    }
    if (start <= now.getTime()) {
      return { ok: false, problem: 'One of the times has already passed. Remove it.' };
    }
    if (end > latest) {
      return {
        ok: false,
        problem: `Pick times within the next ${MAX_PICK_DAYS_AHEAD} days.`,
      };
    }
  }
  const merged = mergeRanges(ranges);
  if (merged.length > MAX_PICK_RANGES) {
    return { ok: false, problem: `Pick at most ${MAX_PICK_RANGES} times.` };
  }
  if (merged.some((r) => Date.parse(r.end) - Date.parse(r.start) < durationMinutes * MINUTE)) {
    return { ok: false, problem: 'Each picked time must be at least as long as the meeting.' };
  }
  return { ok: true, ranges: merged };
}

/** What the Calendar's pick panel sends (POST /api/booking/picks). */
export const PICK_CREATE_INPUT = z
  .object({
    ranges: z
      .array(z.object({ start: z.string().max(40), end: z.string().max(40) }).strict())
      .min(1, 'Pick at least one time.')
      .max(MAX_PICK_RANGES * 2, `Pick at most ${MAX_PICK_RANGES} times.`),
    durationMinutes: z
      .number()
      .int()
      .min(MIN_PICK_MINUTES)
      .max(MAX_PICK_MINUTES)
      .refine((n) => n % PICK_SNAP_MINUTES === 0, 'Pick a length in steps of 15 minutes.'),
    meetingType: z.enum(['call', 'in_person']).default('call'),
    kind: z.enum(MEETING_KINDS).nullable().default(null),
    recipientTimeZone: z.string().max(64).refine(isPickZone, 'Pick one of the time zones listed.'),
    recipientName: z
      .string()
      .trim()
      .max(PICK_NAME_MAX)
      .transform((v) =>
        v
          .replace(/\p{Cf}/gu, '')
          .replace(/[<>\r\n\t]/g, ' ')
          .replace(/ {2,}/g, ' ')
          .trim(),
      )
      .nullable()
      .default(null),
    hold: z.boolean().default(true),
    holdHours: z
      .number()
      .int()
      .refine((n) => (PICK_HOLD_HOURS as readonly number[]).includes(n), 'Pick a hold length.')
      .default(DEFAULT_PICK_HOLD_HOURS),
  })
  .strict();

export type PickCreateInput = z.input<typeof PICK_CREATE_INPUT>;
export type PickCreateParsed = z.output<typeof PICK_CREATE_INPUT>;

/** A pick as the Calendar sees it (GET /api/booking/picks): never its token. */
export interface PickView {
  id: string;
  status: 'open' | 'used' | 'revoked';
  meetingType: MeetingType;
  kind: MeetingKind | null;
  durationMinutes: number;
  ranges: PickRange[];
  recipientName: string | null;
  recipientTimeZone: string;
  hold: boolean;
  expiresAt: string;
  createdAt: string;
  /** "Copy again" can give the same link back (the server kept it sealed). */
  canCopyAgain: boolean;
}

/** What the guest page is told about the pick: never the host's calendar, never other picks. */
export interface PublicPick {
  type: MeetingType;
  kind: MeetingKind | null;
  durationMinutes: number;
  /** The zone the times are shown in first: the one the host chose for them. */
  recipientTimeZone: string;
  recipientName: string | null;
}
