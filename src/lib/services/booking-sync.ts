import 'server-only';
import type { SeenRead } from '@/lib/booking/availability';
import type { BookingConfig } from '@/lib/booking/config';
import {
  bookingDescription,
  hasThirdPartyReschedule,
  linkRequestFromRow,
} from '@/lib/booking/event';
import { calendarEditAccess } from '@/lib/calendar/edit-access';
import type { GCalEvent } from '@/lib/calendar/google-types';
import type { CalendarSource } from '@/lib/calendar/range-reader';
import { isMissingColumnError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type { BookingRequest } from '@/lib/types/domain';
import { sha256 } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { localDateKey } from '@/lib/util/time';
import { restoreLinkDescription } from './booking-calendar';

/**
 * The link's bookings kept in line with Google Calendar (D-078), from the
 * calendar read the slot engine makes anyway (lib/booking/availability.ts),
 * so no extra calls pile up:
 *
 * - An event deleted (or cancelled) in Google is a cancelled booking,
 *   "Cancelled in Google": it stops holding its time and stops counting
 *   toward the day's caps at once. A booking whose event is missing from
 *   the read is confirmed with one look at that event (at most a few a
 *   pass, each event at most every few minutes), never assumed.
 * - An event moved in Google moves the booking, so the caps count its real day.
 * - Another scheduling tool's reschedule link (Fyxer edits the events its
 *   user organizes a few seconds after they are made; Vimcal and Calendly
 *   add their own) is taken back out of a booking-link event's description:
 *   Copilot's own text goes back, ending with the booking's own page, told
 *   to nobody. Booking-link events only (by the event id on the booking),
 *   never any other event, and at most once per event per change: if the
 *   other tool adds it again, it stays.
 *
 * Also run once, about 18 seconds after an event is made or moved
 * (scheduleDescriptionCheck: an in-process timer, harmless if the process
 * restarts, since the next read catches it).
 */

export interface SyncContext {
  store: DataStore;
  organizationId: string;
  source: CalendarSource;
  config: Pick<BookingConfig, 'callLink'>;
  hostZone: string;
  now: Date;
}

/** A booking on the host's calendar: booked from the link, or approved. */
const onCalendar = (row: Pick<BookingRequest, 'status'>) =>
  row.status === 'booked' || row.status === 'approved';

/** How long a new or moved event may be missing from a listing before it is looked at. */
export const LISTING_GRACE_MS = 10 * 60_000;
/** At most this many missing events are looked at in one pass. */
export const MAX_LOOKUPS_PER_PASS = 5;
/** One look at a missing event this often at most, per event. */
const LOOKUP_EVERY_MS = 5 * 60_000;
/** Roughly when Fyxer has edited a new event: the one re-read after a write. */
export const DESCRIPTION_CHECK_DELAY_MS = 18_000;

const lookedAt = processWide('booking-sync-looked', () => new Map<string, number>());
/** Per event, the change (its move count) whose description was put back. */
const restoredFor = processWide('booking-sync-restored', () => new Map<string, number>());
const restoring = processWide('booking-sync-restoring', () => new Set<string>());

/* ------------------------------------------------- deleted or moved in Google */

/**
 * The booking cancelled because its event is gone from Google Calendar
 * (deleted there, or cancelled): no alert (the host did it), no calendar
 * write. Before 20261022200000_booking_v2.sql it is marked declined, which
 * frees the time the same way.
 */
export async function markCancelledInGoogle(
  store: DataStore,
  organizationId: string,
  row: BookingRequest,
  now: Date,
): Promise<BookingRequest> {
  const patch = {
    status: 'cancelled' as const,
    cancelled_at: now.toISOString(),
    cancelled_by: 'calendar' as const,
    claimed_at: null,
  };
  const where = { eq: { id: row.id, status: row.status } };
  let changed: BookingRequest[];
  let next: BookingRequest = { ...row, ...patch };
  try {
    changed = await store.updateWhere('booking_requests', organizationId, where, patch);
  } catch (error) {
    if (!v2Missing(error)) throw error;
    const legacy = { status: 'declined' as const, claimed_at: null, decided_at: now.toISOString() };
    changed = await store.updateWhere('booking_requests', organizationId, where, legacy);
    next = { ...row, ...legacy };
  }
  if (changed.length) {
    await recordAudit(store, {
      organizationId,
      userId: null,
      action: 'booking.synced',
      entityType: 'booking_request',
      entityId: row.id,
      metadata: { change: 'deleted' },
    });
  }
  return next;
}

/** The booking moved to where its event really is, after a move in Google Calendar. */
export async function markMovedInGoogle(
  store: DataStore,
  organizationId: string,
  row: BookingRequest,
  times: { startsAt: string; endsAt: string },
): Promise<BookingRequest> {
  const patch = { starts_at: times.startsAt, ends_at: times.endsAt };
  const changed = await store
    .updateWhere(
      'booking_requests',
      organizationId,
      { eq: { id: row.id, status: row.status } },
      patch,
    )
    .catch(() => []);
  if (changed.length) {
    await recordAudit(store, {
      organizationId,
      userId: null,
      action: 'booking.synced',
      entityType: 'booking_request',
      entityId: row.id,
      metadata: { change: 'moved' },
    });
  }
  return { ...row, ...patch };
}

function v2Missing(error: unknown): boolean {
  if (isMissingColumnError(error)) return true;
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return code === '23514' || (typeof message === 'string' && /check constraint/i.test(message));
}

const iso = (value: string | null | undefined): string | null =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** An event's timed start and end as instants, or null for an all-day one. */
function eventTimes(event: Pick<GCalEvent, 'start' | 'end'>) {
  const startsAt = iso(event.start?.dateTime);
  const endsAt = iso(event.end?.dateTime);
  return startsAt && endsAt ? { startsAt, endsAt } : null;
}

export interface ReconcileOutcome {
  /** The rows as they now stand (a cancelled one has status 'cancelled'). */
  rows: BookingRequest[];
  cancelled: number;
  moved: number;
  restored: number;
}

/**
 * The link's rows that hold time, brought in line with what the engine's
 * calendar read saw (see the module comment). Rows the read did not cover
 * (another calendar, a day outside it) are left as they are.
 */
export async function reconcileLinkBookings(
  ctx: SyncContext,
  rows: readonly BookingRequest[],
  seen: SeenRead,
): Promise<ReconcileOutcome> {
  const out: ReconcileOutcome = { rows: [], cancelled: 0, moved: 0, restored: 0 };
  let lookups = 0;
  for (const original of rows) {
    let row = original;
    if (!onCalendar(row) || !row.event_id || !row.calendar_id || !row.starts_at) {
      out.rows.push(row);
      continue;
    }
    const day = localDateKey(new Date(row.starts_at), ctx.hostZone);
    const covered = seen.calendarIds.has(row.calendar_id) && day >= seen.from && day < seen.to;
    if (!covered) {
      out.rows.push(row);
      continue;
    }
    const listed = seen.events.get(row.event_id);
    if (listed) {
      const times =
        listed.startsAt && listed.endsAt
          ? { startsAt: iso(listed.startsAt)!, endsAt: iso(listed.endsAt)! }
          : null;
      if (times && (times.startsAt !== iso(row.starts_at) || times.endsAt !== iso(row.ends_at))) {
        row = await markMovedInGoogle(ctx.store, ctx.organizationId, row, times);
        out.moved += 1;
      }
      const restored = await restoreDescription(ctx, row, listed.description).catch(
        (error: unknown) => {
          log.warn('A booking event’s description could not be put back', {
            reason: error instanceof Error ? error.message : 'unknown',
          });
          return 'failed' as const;
        },
      );
      if (restored === 'restored') out.restored += 1;
      out.rows.push(row);
      continue;
    }
    // Missing from the read. A new or just-moved event may not be listed yet.
    const changedAt = Math.max(Date.parse(row.created_at) || 0, Date.parse(row.updated_at) || 0);
    if (ctx.now.getTime() - changedAt < LISTING_GRACE_MS) {
      out.rows.push(row);
      continue;
    }
    const last = lookedAt.get(row.event_id) ?? 0;
    if (lookups >= MAX_LOOKUPS_PER_PASS || Math.abs(ctx.now.getTime() - last) < LOOKUP_EVERY_MS) {
      out.rows.push(row);
      continue;
    }
    lookups += 1;
    lookedAt.set(row.event_id, ctx.now.getTime());
    const found = await ctx.source.provider
      .getEvent(row.calendar_id, row.event_id)
      .catch(() => null);
    if (
      found &&
      (!found.ok ? found.error.code === 'not_found' : found.value.status === 'cancelled')
    ) {
      row = await markCancelledInGoogle(ctx.store, ctx.organizationId, row, ctx.now);
      out.cancelled += 1;
    } else if (found?.ok) {
      const times = eventTimes(found.value);
      if (times && (times.startsAt !== iso(row.starts_at) || times.endsAt !== iso(row.ends_at))) {
        row = await markMovedInGoogle(ctx.store, ctx.organizationId, row, times);
        out.moved += 1;
      }
    }
    out.rows.push(row);
  }
  return out;
}

/* ------------------------------------------- another tool's reschedule link */

/** The booking page's link in a description whose token is this booking's, or null. */
export function manageUrlIn(
  description: string | null | undefined,
  tokenHash: string | null | undefined,
): string | null {
  if (!description || !tokenHash) return null;
  for (const m of description.matchAll(
    /(https?:\/\/[^\s"'<>]*?\/meet\/[a-z0-9-]+\/b\/([A-Za-z0-9_-]{43}))(?![A-Za-z0-9_-])/g,
  )) {
    if (sha256(m[2]!) === tokenHash) return m[1]!;
  }
  return null;
}

/** Whether this event's description was already put back for its current change. */
function restoredAlready(row: BookingRequest): boolean {
  const change = row.rescheduled_count ?? 0;
  if (restoredFor.get(row.event_id ?? '') === change) return true;
  const stored = row.description_cleaned_rev;
  return typeof stored === 'number' && stored >= change;
}

export type RestoreOutcome = 'restored' | 'clean' | 'skipped' | 'failed';

/**
 * Put a booking event's own description back when another tool appended
 * its reschedule link: Copilot's text, ending with the booking's own page
 * (the link already in the description, or `manageUrl` when the caller has
 * it), told to nobody. Once per event per change.
 */
export async function restoreDescription(
  ctx: SyncContext,
  row: BookingRequest,
  description: string | null | undefined,
  manageUrl: string | null = null,
): Promise<RestoreOutcome> {
  if (!onCalendar(row) || !row.event_id || !row.calendar_id) return 'skipped';
  if (!hasThirdPartyReschedule(description)) return 'clean';
  if (restoredAlready(row) || restoring.has(row.event_id)) return 'skipped';
  if (!calendarEditAccess(ctx.source).allowed) return 'skipped';
  const change = row.rescheduled_count ?? 0;
  const link = manageUrl ?? manageUrlIn(description, row.manage_token_hash);
  const text = bookingDescription(linkRequestFromRow(row, link), ctx.config.callLink);
  restoring.add(row.event_id);
  try {
    const written = await restoreLinkDescription(
      { store: ctx.store, organizationId: ctx.organizationId, source: ctx.source, actorId: null },
      { calendarId: row.calendar_id, eventId: row.event_id, description: text },
    );
    if (!written.ok) {
      log.warn('A booking event’s description could not be put back', {
        code: written.error.code,
      });
      return 'failed';
    }
    restoredFor.set(row.event_id, change);
    await ctx.store
      .updateWhere(
        'booking_requests',
        ctx.organizationId,
        { eq: { id: row.id } },
        { description_cleaned_at: ctx.now.toISOString(), description_cleaned_rev: change },
      )
      .catch((error: unknown) => {
        // Before the migration: this process still remembers it (restoredFor).
        if (!isMissingColumnError(error)) throw error;
      });
    await recordAudit(ctx.store, {
      organizationId: ctx.organizationId,
      userId: null,
      action: 'booking.synced',
      entityType: 'booking_request',
      entityId: row.id,
      metadata: { change: 'description', link: Boolean(link) },
    });
    return 'restored';
  } finally {
    restoring.delete(row.event_id);
  }
}

/**
 * One look at a booking's event after it was made or moved: its row read
 * again, the event read once, and another tool's reschedule link taken out.
 */
export async function checkLinkEventDescription(
  ctx: SyncContext,
  rowId: string,
  manageUrl: string | null,
): Promise<RestoreOutcome> {
  const row = await ctx.store.get('booking_requests', ctx.organizationId, rowId);
  if (!row || !onCalendar(row) || !row.event_id || !row.calendar_id) return 'skipped';
  const found = await ctx.source.provider.getEvent(row.calendar_id, row.event_id);
  if (!found.ok || found.value.status === 'cancelled') return 'skipped';
  return restoreDescription(ctx, row, found.value.description ?? null, manageUrl);
}

/** Runs `work` later; the default is a timer that never keeps the process alive. */
export type Scheduler = (work: () => Promise<unknown>, delayMs: number) => void;

export const timerScheduler: Scheduler = (work, delayMs) => {
  const timer = setTimeout(() => void work(), delayMs);
  (timer as { unref?: () => void }).unref?.();
};

/**
 * The re-read after an event is made or moved, about 18 seconds later
 * (when Fyxer has had its turn). In-process only: a restart loses it, and
 * the next calendar read does the same job.
 */
export function scheduleDescriptionCheck(
  ctx: SyncContext,
  rowId: string,
  manageUrl: string | null,
  schedule: Scheduler = timerScheduler,
): void {
  schedule(() => {
    const later = { ...ctx, now: new Date(ctx.now.getTime() + DESCRIPTION_CHECK_DELAY_MS) };
    return checkLinkEventDescription(later, rowId, manageUrl).catch((error: unknown) => {
      log.warn('A booking event could not be read again', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return 'failed' as const;
    });
  }, DESCRIPTION_CHECK_DELAY_MS);
}
