import 'server-only';
import {
  BOOKING_SCOPES,
  bookingScope,
  linkStatus,
  sortBookings,
  toLinkBooking,
  type BookingScope,
  type LinkBooking as LinkBookingView,
  type LinkBookingStatus,
} from '@/lib/booking/bookings';
import {
  inPersonOffered,
  parseBookingConfig,
  SLUG,
  type BookingConfig,
  type MeetingType,
} from '@/lib/booking/config';
import { bookingsBefore, openSlotsAndDays, slotProblem } from '@/lib/booking/engine';
import { openMonthsAhead } from '@/lib/booking/months';
import { BOOKED_LINE } from '@/lib/booking/event';
import { holdDue, holdNextTryAt, holdReasonForError } from '@/lib/booking/holds';
import {
  CLOSED_MESSAGE,
  knownZone,
  slotLabel,
  UNAVAILABLE_MESSAGE,
  zoneName,
  type PublicManagePage,
  type PublicSlots,
  type PublicBookingView,
  type RememberedBooking,
} from '@/lib/booking/public';
import { calendarEditAccess } from '@/lib/calendar/edit-access';
import { meetLinkOf } from '@/lib/calendar/edit-rules';
import type { GCalEvent } from '@/lib/calendar/google-types';
import { calendarSource, readCalendarList, type CalendarSource } from '@/lib/calendar/range-reader';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { soleOrganizationId } from '@/lib/db/tenancy';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type {
  BookingHoldReason,
  BookingRequest,
  BookingSettingsRow,
  Organization,
} from '@/lib/types/domain';
import { sha256 } from '@/lib/util/hash';
import { localDateKey } from '@/lib/util/time';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';
import {
  engineInputFor,
  hostCalendarEmail,
  hostNameFor,
  linkEventDraft,
  manageTokenHash,
  manageUrl,
  MAX_RESCHEDULES,
  oneAtATime,
  photoUrl,
  publicBookingView,
  readHost,
  resolveOpenLink,
  scheduleHeldRetry,
  type ActorContext,
  type BookingDeps,
} from './booking';
import {
  createLinkEvent,
  deleteLinkEvent,
  moveLinkEvent,
  type LinkWriteContext,
} from './booking-calendar';
import { markCancelledInGoogle, markMovedInGoogle, scheduleDescriptionCheck } from './booking-sync';
import { principalTimeZone } from './push-alerts';

/**
 * After a booking is made (D-078): its own page, where the visitor sees when
 * and where, moves it or cancels it; the held times placed once calendar
 * editing is on; and the Booking tab's list. Every change to a time is
 * checked again against the live calendar and every rule, one at a time per
 * organization, exactly as a new booking is (lib/services/booking.ts), and
 * reaches the calendar only through lib/services/booking-calendar.ts, so
 * Google tells everyone invited (the update, or the cancellation). The note
 * a visitor leaves when they cancel reaches the host as a Copilot alert, never
 * as an email.
 *
 * The page is found by its token's SHA-256 alone: the token is in the
 * visitor's link and the event description, and is never stored or logged.
 */

/** Statuses a visitor can still change: booked (or approved), held, or waiting. */
const LIVE = ['booked', 'approved', 'held', 'pending'] as const;
type LiveStatus = (typeof LIVE)[number];
const isLive = (status: BookingRequest['status']): status is LiveStatus =>
  (LIVE as readonly string[]).includes(status);

/** What the visitor sees when the token names nothing (or the link is gone). */
export function notFoundManagePage(slug: string): PublicManagePage {
  return { state: 'not_found', slug, host: null, booking: null };
}

export const NOT_FOUND_MESSAGE = 'This booking link is not one we know.';

interface FoundBooking {
  organizationId: string;
  settings: BookingSettingsRow;
  config: BookingConfig;
  row: BookingRequest;
}

/**
 * The booking a token names on a slug's link: the link need not be on (a
 * visitor can still see and cancel a meeting after the link is turned off),
 * but it must be this organization's link by this slug, and the row must
 * carry the token's hash. Anything else is nothing at all.
 */
async function bookingForToken(
  store: DataStore,
  slug: string,
  token: string,
): Promise<FoundBooking | null> {
  const clean = SLUG.safeParse(slug);
  const hash = manageTokenHash(token);
  if (!clean.success || !hash) return null;
  const organizationId = await soleOrganizationId('booking-link');
  if (!organizationId) return null;
  try {
    const settings = await store.findOne('booking_settings', organizationId, {
      eq: { slug: clean.data },
    });
    if (!settings) return null;
    const row = await store.findOne('booking_requests', organizationId, {
      eq: { manage_token_hash: hash },
    });
    if (!row || row.meeting_type === 'message') return null;
    return { organizationId, settings, config: parseBookingConfig(settings.settings), row };
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) return null;
    throw error;
  }
}

async function hostSource(
  store: DataStore,
  organizationId: string,
  deps: BookingDeps,
): Promise<CalendarSource | null> {
  if (deps.source) return deps.source;
  const host = await readHost(store, organizationId);
  const found = await calendarSource(store, organizationId, host.email ?? '');
  return found.ok ? found.source : null;
}

/* ------------------------------------------------- the calendar, live */

type LiveEvent =
  | { state: 'unknown' }
  | { state: 'gone' }
  | { state: 'there'; startsAt: string | null; endsAt: string | null; meetUrl: string | null };

/** The booking's event as Google has it now: still there, moved, or gone. */
async function liveEvent(source: CalendarSource | null, row: BookingRequest): Promise<LiveEvent> {
  if (!source || !row.event_id || !row.calendar_id) return { state: 'unknown' };
  const found = await source.provider.getEvent(row.calendar_id, row.event_id).catch(() => null);
  if (!found) return { state: 'unknown' };
  if (!found.ok) return found.error.code === 'not_found' ? { state: 'gone' } : { state: 'unknown' };
  const event: GCalEvent = found.value;
  if (event.status === 'cancelled') return { state: 'gone' };
  const instant = (d: GCalEvent['start']) =>
    d?.dateTime && Number.isFinite(Date.parse(d.dateTime))
      ? new Date(d.dateTime).toISOString()
      : null;
  return {
    state: 'there',
    startsAt: instant(event.start),
    endsAt: instant(event.end),
    meetUrl: meetLinkOf(event),
  };
}

/**
 * Bring the row in line with the calendar: an event deleted in Google
 * Calendar is a cancelled booking (by the calendar: no alert, the host did
 * it), and an event moved there moves the booking, so its time is held
 * where it really is. Returns the row as it now stands and a plain notice.
 */
async function syncWithCalendar(
  store: DataStore,
  found: FoundBooking,
  live: LiveEvent,
  now: Date,
): Promise<{ row: BookingRequest; notice: string | null }> {
  const { row, organizationId } = found;
  if (row.status !== 'booked' && row.status !== 'approved') return { row, notice: null };
  if (live.state === 'gone') {
    const next = await markCancelledInGoogle(store, organizationId, row, now).catch(() => ({
      ...row,
      status: 'cancelled' as const,
    }));
    return { row: next, notice: 'This meeting was cancelled.' };
  }
  if (
    live.state === 'there' &&
    live.startsAt &&
    live.endsAt &&
    (live.startsAt !== new Date(row.starts_at ?? 0).toISOString() ||
      live.endsAt !== new Date(row.ends_at ?? 0).toISOString())
  ) {
    const next = await markMovedInGoogle(store, organizationId, row, {
      startsAt: live.startsAt,
      endsAt: live.endsAt,
    });
    return { row: next, notice: 'The time of this meeting changed in the calendar.' };
  }
  return { row, notice: null };
}

/**
 * The booking a visitor's device remembers on a link (its cookie holds the
 * token), while it is still ahead and not cancelled: for "You have a meeting
 * with Nick on ..." on the booking page. Null for anything else.
 */
export async function rememberedBooking(
  store: DataStore,
  slug: string,
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<RememberedBooking | null> {
  if (!token) return null;
  const found = await bookingForToken(store, slug, token).catch(() => null);
  const row = found?.row;
  if (!row || !row.starts_at || !isLive(row.status)) return null;
  if (Date.parse(row.starts_at) <= now.getTime()) return null;
  return {
    manageUrl: `/meet/${found.settings.slug}/b/${token}`,
    startsAt: row.starts_at,
    type: row.meeting_type === 'in_person' ? 'in_person' : 'call',
    kind: row.kind,
    status: row.status === 'pending' ? 'pending' : row.status === 'held' ? 'held' : 'booked',
  };
}

/* ------------------------------------------------------- the page itself */

/**
 * The booking's own page: the host's card and the booking as it stands,
 * after a look at the calendar (an event deleted or moved in Google
 * Calendar shows as it really is). Held times waiting for calendar editing
 * are placed first when they can be.
 */
export async function loadManagePage(
  store: DataStore,
  slug: string,
  token: string,
  deps: BookingDeps = {},
): Promise<PublicManagePage> {
  const now = deps.now ?? new Date();
  const found = await bookingForToken(store, slug, token);
  if (!found) return notFoundManagePage(slug);
  const { organizationId, config, settings } = found;
  if (found.row.status === 'held') {
    await placeHeldBookings(store, organizationId, { ...deps, now }).catch(() => null);
  }
  const fresh = (await store.get('booking_requests', organizationId, found.row.id)) ?? found.row;
  const source = await hostSource(store, organizationId, deps).catch(() => null);
  const live = await liveEvent(source, fresh);
  const synced = await syncWithCalendar(store, { ...found, row: fresh }, live, now);
  const [hostZone, host] = await Promise.all([
    principalTimeZone(store, organizationId),
    readHost(store, organizationId).catch(() => null),
  ]);
  return {
    state: 'ok',
    slug: settings.slug,
    host: {
      displayName: config.displayName || host?.fullName || config.firmName || 'Your meeting',
      title: config.title,
      bio: '',
      firmName: config.firmName,
      photoUrl: settings.enabled ? photoUrl(settings.slug, config) : null,
    },
    booking: publicBookingView(synced.row, {
      config,
      hostZone,
      now,
      meetUrl: live.state === 'there' ? live.meetUrl : null,
      notice: synced.notice,
      linkOpen: settings.enabled,
      withLink: true,
    }),
  };
}

/**
 * Open times to move a booking to: the same rules as the booking page, with
 * the booking itself left out (its own row and its own calendar entry), so
 * the times right next to it are offered too.
 */
export async function manageSlots(
  store: DataStore,
  slug: string,
  token: string,
  deps: BookingDeps = {},
): Promise<PublicSlots | null> {
  const found = await bookingForToken(store, slug, token);
  if (!found || !found.row.starts_at || !found.row.ends_at) return null;
  const { row } = found;
  const startsAt = found.row.starts_at;
  const endsAt = found.row.ends_at;
  const type: MeetingType = row.meeting_type === 'in_person' ? 'in_person' : 'call';
  const base = { type, kind: row.kind };
  const link = await resolveOpenLink(store, slug);
  if (!link.open) {
    return { ...base, slots: [], state: 'closed', hostTimeZone: 'UTC', message: CLOSED_MESSAGE };
  }
  // In person no longer offered (no home city or places): nothing to move to.
  if (type === 'in_person' && !inPersonOffered(link.link.config)) {
    const hostTimeZone = await principalTimeZone(store, found.organizationId);
    return { ...base, slots: [], state: 'ok', hostTimeZone };
  }
  const prepared = await engineInputFor(store, link.link, {
    ...deps,
    ignore: {
      id: row.id,
      start: Date.parse(startsAt),
      end: Date.parse(endsAt),
      onCalendar: ownEventOnCalendar(row),
    },
  }).catch(() => null);
  if (!prepared?.ok) {
    const hostTimeZone = await principalTimeZone(store, found.organizationId);
    return { ...base, slots: [], state: 'unavailable', hostTimeZone, message: UNAVAILABLE_MESSAGE };
  }
  const plan = openSlotsAndDays(prepared.value.input, { type, kind: row.kind });
  const today = localDateKey(prepared.value.input.now, prepared.value.hostZone);
  return {
    ...base,
    slots: plan.slots
      .filter((s) => s.start !== new Date(startsAt).toISOString())
      .map((s) => ({ start: s.start, end: s.end })),
    state: 'ok',
    hostTimeZone: prepared.value.hostZone,
    days: plan.days.map((d) => ({ date: d.date, state: d.state })),
    months: openMonthsAhead(link.link.config, today),
  };
}

/** The booking's own event is on the calendar (so its entry is its own time, not someone else's). */
function ownEventOnCalendar(row: BookingRequest): boolean {
  return (row.status === 'booked' || row.status === 'approved') && Boolean(row.event_id);
}

/** How long an Approve's claim stands (lib/services/booking.ts uses the same two minutes). */
const CLAIM_TIMEOUT_MS = 2 * 60_000;

/** An approve-first request a person is approving right now (its claim is fresh). */
function beingApproved(row: BookingRequest, now: Date): boolean {
  if (row.status !== 'pending' || !row.claimed_at) return false;
  return now.getTime() - Date.parse(row.claimed_at) < CLAIM_TIMEOUT_MS;
}

const BEING_BOOKED = 'This request is being booked right now. Try again in two minutes.';

const NOT_YOURS = 'This booking is not here any more.';
const TOO_LATE = 'This meeting has started, so it cannot be changed here.';

/**
 * Move a booking to a new time from its own page: checked again against the
 * live calendar and every rule (notice too), one at a time, then the SAME
 * Google event is moved (never a new one), so it moves on everyone's
 * calendar with Google's update. A held time or a waiting request moves
 * with no calendar write. At most five moves.
 */
export async function rescheduleByToken(
  store: DataStore,
  slug: string,
  token: string,
  start: string,
  deps: BookingDeps = {},
): Promise<Result<PublicBookingView>> {
  const now = deps.now ?? new Date();
  const found = await bookingForToken(store, slug, token);
  if (!found) return err('not_found', NOT_YOURS);
  const link = await resolveOpenLink(store, slug);
  if (!link.open) {
    return err(
      'forbidden',
      'This booking link is not taking changes right now. You can still cancel.',
    );
  }
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) return err('invalid_input', 'Pick a time.');
  const { organizationId, config } = found;

  let meetUrl: string | null = null;
  const done = await oneAtATime(organizationId, async (): Promise<Result<BookingRequest>> => {
    const row = await store.get('booking_requests', organizationId, found.row.id);
    if (!row || !row.starts_at || !row.ends_at) return err('not_found', NOT_YOURS);
    if (!isLive(row.status)) return err('conflict', `This meeting was ${row.status} already.`);
    if (Date.parse(row.starts_at) <= now.getTime()) return err('conflict', TOO_LATE);
    if (beingApproved(row, now)) return err('conflict', BEING_BOOKED);
    const moves = row.rescheduled_count ?? 0;
    if (moves >= MAX_RESCHEDULES) {
      return err(
        'conflict',
        `This meeting was moved ${MAX_RESCHEDULES} times already. Cancel it and book a new time instead.`,
      );
    }
    const iso = new Date(startMs).toISOString();
    if (iso === new Date(row.starts_at).toISOString()) {
      return err('invalid_input', 'That is the time it has now. Pick another.');
    }
    const type = row.meeting_type === 'in_person' ? 'in_person' : 'call';
    if (type === 'in_person' && !inPersonOffered(link.link.config)) {
      return err(
        'conflict',
        'In-person meetings are not offered any more, so this one cannot be moved here. You can still cancel.',
      );
    }
    const prepared = await engineInputFor(store, link.link, {
      ...deps,
      now,
      fresh: true,
      ignore: {
        id: row.id,
        start: Date.parse(row.starts_at),
        end: Date.parse(row.ends_at),
        onCalendar: ownEventOnCalendar(row),
      },
    });
    if (!prepared.ok) return err('provider_unavailable', UNAVAILABLE_MESSAGE);
    const problem = slotProblem(prepared.value.input, { type, kind: row.kind }, iso);
    if (problem) return err('conflict', 'That time is not open any more. Pick another time.');
    const end = new Date(
      startMs + (Date.parse(row.ends_at) - Date.parse(row.starts_at)),
    ).toISOString();

    if ((row.status === 'booked' || row.status === 'approved') && row.event_id && row.calendar_id) {
      const source = prepared.value.source;
      if (!calendarEditAccess(source).allowed) {
        return err(
          'forbidden',
          'This meeting cannot be moved here right now. Cancel it and book a new time instead.',
        );
      }
      const moved = await moveLinkEvent(writeContext(store, organizationId, source), {
        calendarId: row.calendar_id,
        eventId: row.event_id,
        start: iso,
        end,
        timeZone: prepared.value.hostZone,
      });
      if (!moved.ok) {
        if (moved.error.code === 'not_found') {
          // Deleted in Google meanwhile: cancelled here too, so its time and cap are free.
          await markCancelledInGoogle(store, organizationId, row, now).catch(() => null);
          return err('conflict', 'This meeting was cancelled, so it cannot be moved.');
        }
        return err(
          moved.error.code === 'timeout' ? 'timeout' : 'provider_unavailable',
          'The calendar did not answer. Look at your invitation before trying again: it may have moved already.',
          { retryable: true },
        );
      }
      meetUrl = moved.value.meetUrl;
      // A move is a change: another tool may add its reschedule link again,
      // so one more look later (once for this move).
      scheduleDescriptionCheck(
        { store, organizationId, source, config, hostZone: prepared.value.hostZone, now },
        row.id,
        manageUrl(found.settings.slug, token),
        deps.schedule,
      );
    }
    const patch = {
      starts_at: iso,
      ends_at: end,
      previous_starts_at: row.starts_at,
      rescheduled_count: moves + 1,
      // When it moved, for the alert (the database's trigger keeps it too).
      updated_at: now.toISOString(),
    };
    const changed = await store.updateWhere(
      'booking_requests',
      organizationId,
      { eq: { id: row.id, status: row.status, starts_at: row.starts_at } },
      patch,
    );
    if (changed.length === 0)
      log.warn('A rescheduled booking changed meanwhile', { booking: row.id });
    return ok({ ...row, ...patch });
  });
  if (!done.ok) return done;
  const row = done.value;
  await recordAudit(store, {
    organizationId,
    userId: null,
    action: 'booking.rescheduled',
    entityType: 'booking_request',
    entityId: row.id,
    metadata: { type: row.meeting_type, kind: row.kind, count: row.rescheduled_count ?? 1 },
  });
  const hostZone = await principalTimeZone(store, organizationId);
  return ok(
    publicBookingView(row, { config, hostZone, now, linkOpen: true, meetUrl, withLink: true })!,
  );
}

/**
 * Cancel a booking from its own page: the Google event deleted (Google sends
 * every guest its cancellation), the booking marked cancelled with the
 * visitor's optional note, which reaches the host as a Copilot alert, on the
 * Booking tab and in a Today line. A held time or a waiting request is
 * released. Allowed until the start time.
 */
export async function cancelByToken(
  store: DataStore,
  slug: string,
  token: string,
  note: string,
  deps: BookingDeps = {},
): Promise<Result<PublicBookingView>> {
  const now = deps.now ?? new Date();
  const found = await bookingForToken(store, slug, token);
  if (!found) return err('not_found', NOT_YOURS);
  const result = await cancelRow(store, found, { note, by: 'visitor', actorId: null, now, deps });
  if (!result.ok) return result;
  const hostZone = await principalTimeZone(store, found.organizationId);
  return ok(
    publicBookingView(result.value.row, {
      config: found.config,
      hostZone,
      now,
      linkOpen: found.settings.enabled,
    })!,
  );
}

/**
 * Cancel from Copilot's Booking tab (a member): the same, recorded as the
 * team's. The note stays in Copilot (Google's cancellation carries no
 * text). Says whether an event came off the calendar (Google told everyone)
 * or was left there because calendar editing is off.
 */
export async function cancelBookingFromCopilot(
  ctx: ActorContext,
  id: string,
  note: string,
  deps: BookingDeps = {},
): Promise<Result<{ status: 'cancelled'; removedEvent: boolean; calendarLeft: boolean }>> {
  const now = deps.now ?? new Date();
  let row: BookingRequest | null;
  let settings: BookingSettingsRow | null;
  try {
    [row, settings] = await Promise.all([
      ctx.store.get('booking_requests', ctx.organizationId, id),
      ctx.store.findOne('booking_settings', ctx.organizationId, {}),
    ]);
  } catch (error) {
    if (isMissingTableError(error)) return err('not_found', NOT_YOURS);
    throw error;
  }
  if (!row || !settings || row.meeting_type === 'message') return err('not_found', NOT_YOURS);
  const found: FoundBooking = {
    organizationId: ctx.organizationId,
    settings,
    config: parseBookingConfig(settings.settings),
    row,
  };
  const done = await cancelRow(ctx.store, found, {
    note,
    by: 'team',
    actorId: ctx.userId,
    now,
    deps,
  });
  return done.ok
    ? ok({
        status: 'cancelled',
        removedEvent: done.value.removedEvent,
        calendarLeft: done.value.calendarLeft,
      })
    : done;
}

async function cancelRow(
  store: DataStore,
  found: FoundBooking,
  options: {
    note: string;
    by: 'visitor' | 'team';
    actorId: string | null;
    now: Date;
    deps: BookingDeps;
  },
): Promise<Result<{ row: BookingRequest; calendarLeft: boolean; removedEvent: boolean }>> {
  const { organizationId } = found;
  const { now, deps } = options;
  const done = await oneAtATime(
    organizationId,
    async (): Promise<
      Result<{ row: BookingRequest; calendarLeft: boolean; removedEvent: boolean }>
    > => {
      const row = await store.get('booking_requests', organizationId, found.row.id);
      if (!row || !row.starts_at) return err('not_found', NOT_YOURS);
      if (!isLive(row.status)) {
        return row.status === 'cancelled'
          ? err('conflict', 'This meeting was cancelled already.')
          : err('conflict', `This meeting was ${row.status} already.`);
      }
      if (Date.parse(row.starts_at) <= now.getTime()) return err('conflict', TOO_LATE);
      if (beingApproved(row, now)) return err('conflict', BEING_BOOKED);
      let calendarLeft = false;
      let removedEvent = false;
      // A hold "in doubt", or a booking whose event id was never kept: Google
      // may have made its event, so look for it and cancel that too.
      if (
        !row.event_id &&
        ((row.status === 'held' && row.claimed_at) ||
          row.status === 'booked' ||
          row.status === 'approved')
      ) {
        const source = await hostSource(store, organizationId, deps).catch(() => null);
        if (source && calendarEditAccess(source).allowed) {
          const list = await readCalendarList(source, organizationId).catch(() => null);
          const primary = list?.ok ? list.value.calendars.find((c) => c.primary) : null;
          const existing = primary ? await findLinkEvent(source, primary.id, row) : null;
          if (primary && existing) {
            row.calendar_id = primary.id;
            row.event_id = existing;
          }
        }
      }
      if (
        (row.status === 'booked' || row.status === 'approved' || row.status === 'held') &&
        row.event_id &&
        row.calendar_id
      ) {
        const source = await hostSource(store, organizationId, deps).catch(() => null);
        if (source && calendarEditAccess(source).allowed) {
          const deleted = await deleteLinkEvent(
            writeContext(store, organizationId, source, options.actorId),
            {
              calendarId: row.calendar_id,
              eventId: row.event_id,
            },
          );
          if (!deleted.ok && deleted.error.code !== 'not_found') {
            return err(
              'provider_unavailable',
              'The calendar did not answer. Try again in a minute.',
              { retryable: true },
            );
          }
          removedEvent = true;
        } else {
          // Editing was turned off after it was booked: cancelled here, and
          // the alert says the event is still on the calendar to remove.
          calendarLeft = true;
        }
      }
      const patch = {
        status: 'cancelled' as const,
        cancel_note: options.note.trim() || null,
        cancelled_at: now.toISOString(),
        cancelled_by: options.by,
        claimed_at: null,
        decided_by: options.actorId,
        decided_at: options.actorId ? now.toISOString() : row.decided_at,
      };
      const changed = await store.updateWhere(
        'booking_requests',
        organizationId,
        { eq: { id: row.id, status: row.status } },
        patch,
      );
      if (changed.length === 0)
        return err('conflict', 'This meeting changed just now. Reload the page.');
      return ok({ row: { ...row, ...patch }, calendarLeft, removedEvent });
    },
  );
  if (!done.ok) return done;
  const { row, calendarLeft, removedEvent } = done.value;
  await recordAudit(store, {
    organizationId,
    userId: options.actorId,
    action: 'booking.cancelled',
    entityType: 'booking_request',
    entityId: row.id,
    // Ids and kinds only: whether there was a note, never the note itself.
    metadata: {
      type: row.meeting_type,
      kind: row.kind,
      by: options.by,
      note: Boolean(row.cancel_note),
      calendar_left: calendarLeft,
    },
  });
  return ok({ row, calendarLeft, removedEvent });
}

function writeContext(
  store: DataStore,
  organizationId: string,
  source: CalendarSource,
  actorId: string | null = null,
): LinkWriteContext {
  return { store, organizationId, source, actorId };
}

/* ------------------------------------------------------------- held times */

/** One placing pass per organization a minute at most, from the page, the tab and the job. */
const PLACE_EVERY_MS = 60_000;
const lastPlaced = processWide('booking-place-held', () => new Map<string, number>());
/** Before the hold columns exist: when each held booking may be tried again, in memory. */
const nextTryInMemory = processWide('booking-hold-next-try', () => new Map<string, string>());

export interface PlaceOutcome {
  placed: number;
  released: number;
  /** Held times still waiting (calendar editing off, Google down, or a backoff not over). */
  waiting: number;
}

/**
 * Put held times on the calendar (D-078). Nobody approves them: each is
 * checked again against the live calendar and every rule, first come first
 * served (the held time and anything booked before it), and still at least
 * an hour away, then booked on the host's main calendar with everyone
 * invited by Google.
 *
 * - Waiting for calendar editing: tried on every pass (a pass costs one
 *   read of the grant), so it books the moment editing is on.
 * - After a Google fault: tried again after about 1, 5, 15 and 60 minutes,
 *   then on every pass, until it is booked. `onlyId` with `force` (the tab's
 *   "Try now", the in-process timer) tries one at once.
 * - A time that is truly no longer free is released, with a notice draft
 *   for someone to send (Copilot sends no email).
 * - One held "in doubt" (Google may have made the event before its answer
 *   was lost) is looked for on the calendar first, so it is never made twice.
 */
export async function placeHeldBookings(
  store: DataStore,
  organizationId: string,
  deps: BookingDeps & { force?: boolean; onlyId?: string } = {},
): Promise<PlaceOutcome> {
  const now = deps.now ?? new Date();
  const outcome: PlaceOutcome = { placed: 0, released: 0, waiting: 0 };
  if (!deps.force) {
    const last = lastPlaced.get(organizationId) ?? 0;
    if (Math.abs(now.getTime() - last) < PLACE_EVERY_MS) return outcome;
    lastPlaced.set(organizationId, now.getTime());
  }

  let held: BookingRequest[];
  let settings: BookingSettingsRow | null;
  try {
    [held, settings] = await Promise.all([
      store.list(
        'booking_requests',
        organizationId,
        { eq: deps.onlyId ? { status: 'held', id: deps.onlyId } : { status: 'held' } },
        { orderBy: [{ field: 'created_at', direction: 'asc' }], limit: 50 },
      ),
      store.findOne('booking_settings', organizationId, {}),
    ]);
  } catch (error) {
    if (isMissingTableError(error)) return outcome;
    throw error;
  }
  if (!held.length || !settings) return outcome;
  const config = parseBookingConfig(settings.settings);
  const source = await hostSource(store, organizationId, deps).catch(() => null);
  if (!source || !calendarEditAccess(source).allowed) {
    outcome.waiting = held.length;
    await noteHoldReason(store, organizationId, held, 'calendar_editing_off');
    return outcome;
  }

  // Due now: a Google fault backs off; waiting for editing never does.
  const due = deps.onlyId
    ? held
    : held.filter(
        (r) =>
          r.hold_reason === 'calendar_editing_off' ||
          holdDue({ hold_next_try_at: r.hold_next_try_at ?? nextTryInMemory.get(r.id) }, now),
      );
  outcome.waiting = held.length - due.length;
  if (!due.length) return outcome;

  const list = await readCalendarList(source, organizationId, now.getTime(), { fresh: true }).catch(
    () => null,
  );
  const primary = list?.ok ? list.value.calendars.find((c) => c.primary && c.writable) : null;
  if (!primary) {
    const reason: BookingHoldReason = list?.ok ? 'no_main_calendar' : 'calendar_unreachable';
    for (const row of due) await failedTry(store, organizationId, row, reason, now, false, deps);
    outcome.waiting += due.length;
    return outcome;
  }
  const host = await readHost(store, organizationId);
  const hostName = hostNameFor(config, host);

  for (const first of due) {
    await oneAtATime(organizationId, async () => {
      const row = await store.get('booking_requests', organizationId, first.id);
      if (!row || row.status !== 'held' || !row.starts_at || !row.ends_at) return;
      const type = row.meeting_type === 'in_person' ? 'in_person' : 'call';

      // In doubt: Google may have it already. Look for it before anything else.
      if (row.claimed_at) {
        const existing = await findLinkEvent(source, primary.id, row);
        if (existing) {
          await markPlaced(store, organizationId, row, primary.id, existing);
          outcome.placed += 1;
          return;
        }
      }

      const prepared = await engineInputFor(
        store,
        { organizationId, config },
        { ...deps, source, now, fresh: true },
      );
      if (!prepared.ok) {
        await failedTry(store, organizationId, row, 'calendar_unreachable', now, false, deps);
        outcome.waiting += 1;
        return;
      }
      const { input, hostZone } = prepared.value;

      const problem =
        Date.parse(row.starts_at) < now.getTime()
          ? 'That time has passed.'
          : slotProblem(
              {
                ...input,
                askedAt: new Date(row.created_at),
                linkBookings: bookingsBefore(input.linkBookings, {
                  id: row.id,
                  createdAt: Date.parse(row.created_at),
                }),
              },
              { type, kind: row.kind },
              row.starts_at,
              row.id,
            );
      if (problem) {
        const changed = await store.updateWhere(
          'booking_requests',
          organizationId,
          { eq: { id: row.id, status: 'held' } },
          { status: 'declined', claimed_at: null, decided_by: null, decided_at: now.toISOString() },
        );
        if (changed.length) {
          nextTryInMemory.delete(row.id);
          outcome.released += 1;
          await recordAudit(store, {
            organizationId,
            userId: null,
            action: 'booking.released',
            entityType: 'booking_request',
            entityId: row.id,
            metadata: { type: row.meeting_type, kind: row.kind },
          });
        }
        return;
      }
      let created: Awaited<ReturnType<typeof createLinkEvent>>;
      try {
        created = await createLinkEvent(
          writeContext(store, organizationId, source),
          primary.id,
          // The token itself is not kept, so the event made now cannot carry the
          // booking page's link; the visitor has it from their confirmation.
          linkEventDraft(hostName, row, hostZone, {
            manageUrl: null,
            callLink: config.callLink,
            hostEmail: hostCalendarEmail(source, host, primary.id),
          }),
        );
      } catch (error) {
        log.warn('A held booking’s event could not be confirmed', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
        created = err('timeout', 'The calendar write could not be confirmed.');
      }
      if (!created.ok) {
        const doubt =
          created.error.code === 'timeout' || created.error.code === 'provider_unavailable';
        await failedTry(
          store,
          organizationId,
          row,
          holdReasonForError(created.error.code),
          now,
          doubt,
          deps,
        );
        outcome.waiting += 1;
        return;
      }
      await markPlaced(store, organizationId, row, primary.id, created.value.eventId);
      outcome.placed += 1;
      scheduleDescriptionCheck(
        { store, organizationId, source, config, hostZone, now },
        row.id,
        null,
        deps.schedule,
      );
    });
  }
  return outcome;
}

/** Hold columns written when they exist (20261022200000_booking_v2.sql), else skipped. */
async function patchHold(
  store: DataStore,
  organizationId: string,
  row: BookingRequest,
  patch: Partial<BookingRequest>,
): Promise<void> {
  try {
    await store.updateWhere(
      'booking_requests',
      organizationId,
      { eq: { id: row.id, status: 'held' } },
      patch,
    );
  } catch (error) {
    if (!isMissingColumnError(error)) throw error;
    const { hold_reason: _r, hold_attempts: _a, hold_next_try_at: _n, ...rest } = patch;
    void _r;
    void _a;
    void _n;
    if (Object.keys(rest).length) {
      await store.updateWhere(
        'booking_requests',
        organizationId,
        { eq: { id: row.id, status: 'held' } },
        rest,
      );
    }
  }
}

/** Every held booking says why it waits: written only when the reason changed. */
async function noteHoldReason(
  store: DataStore,
  organizationId: string,
  rows: readonly BookingRequest[],
  reason: BookingHoldReason,
): Promise<void> {
  for (const row of rows) {
    if (row.hold_reason === reason) continue;
    await patchHold(store, organizationId, row, { hold_reason: reason }).catch(() => null);
  }
}

/**
 * A try that did not book it: the reason, one more try counted, the next
 * one due after the backoff (and timed in this process). "In doubt" keeps a
 * claim, so the next try looks for the event first; a later clear failure
 * never drops a claim an earlier lost answer set.
 */
async function failedTry(
  store: DataStore,
  organizationId: string,
  row: BookingRequest,
  reason: BookingHoldReason,
  now: Date,
  doubt: boolean,
  deps: BookingDeps,
): Promise<void> {
  const attempts = (row.hold_attempts ?? 0) + 1;
  const next = holdNextTryAt(attempts, now);
  const patch: Partial<BookingRequest> = {
    hold_reason: reason,
    hold_attempts: attempts,
    hold_next_try_at: next,
    ...(doubt ? { claimed_at: now.toISOString() } : {}),
  };
  await patchHold(store, organizationId, row, patch).catch((error: unknown) => {
    log.warn('A held booking’s next try could not be kept', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
  if (next) nextTryInMemory.set(row.id, next);
  else nextTryInMemory.delete(row.id);
  log.warn('A held booking is still not on the calendar; Copilot tries again', {
    reason,
    attempts,
  });
  scheduleHeldRetry(
    store,
    organizationId,
    { id: row.id, hold_reason: reason, hold_next_try_at: next },
    now,
    deps.schedule,
  );
}

async function markPlaced(
  store: DataStore,
  organizationId: string,
  row: BookingRequest,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const base = {
    status: 'booked' as const,
    claimed_at: null,
    calendar_id: calendarId,
    event_id: eventId,
  };
  let changed: BookingRequest[];
  try {
    changed = await store.updateWhere(
      'booking_requests',
      organizationId,
      { eq: { id: row.id, status: 'held' } },
      { ...base, hold_reason: null, hold_next_try_at: null },
    );
  } catch (error) {
    if (!isMissingColumnError(error)) throw error;
    changed = await store.updateWhere(
      'booking_requests',
      organizationId,
      { eq: { id: row.id, status: 'held' } },
      base,
    );
  }
  nextTryInMemory.delete(row.id);
  if (changed.length) {
    await recordAudit(store, {
      organizationId,
      userId: null,
      action: 'booking.hold_placed',
      entityType: 'booking_request',
      entityId: row.id,
      metadata: { type: row.meeting_type, kind: row.kind, attempts: row.hold_attempts ?? 0 },
    });
  }
}

/**
 * The event a booking already has on the calendar, if Google made it before
 * its answer was lost: an entry at exactly its time that is a booking-link
 * event (its description starts with BOOKED_LINE) and either carries the
 * booking page link whose token hashes to this booking's, or (an event made
 * when a hold was placed has no page link) invites the booker.
 */
async function findLinkEvent(
  source: CalendarSource,
  calendarId: string,
  row: BookingRequest,
): Promise<string | null> {
  if (!row.starts_at || !row.ends_at) return null;
  const found = await source.provider
    .listRange(calendarId, { timeMin: row.starts_at, timeMax: row.ends_at })
    .catch(() => null);
  if (!found?.ok) return null;
  const start = new Date(row.starts_at).toISOString();
  const booker = row.email.trim().toLowerCase();
  for (const event of found.value) {
    if (event.status === 'cancelled') continue;
    if (!event.start?.dateTime || new Date(event.start.dateTime).toISOString() !== start) continue;
    const description = event.description ?? '';
    if (!description.includes(BOOKED_LINE)) continue;
    if (row.manage_token_hash) {
      for (const match of description.matchAll(/\/meet\/[a-z0-9-]+\/b\/([A-Za-z0-9_-]{43})/g)) {
        if (sha256(match[1]!) === row.manage_token_hash) return event.id ?? null;
      }
    }
    if ((event.attendees ?? []).some((a) => a.email?.trim().toLowerCase() === booker)) {
      return event.id ?? null;
    }
  }
  return null;
}

/**
 * "Try now" on the Booking tab (a member): one held booking tried at once,
 * past its backoff. Says what it came to: booked, still held (and why), or
 * released because the time was taken.
 */
export async function retryHeldBooking(
  store: DataStore,
  organizationId: string,
  id: string,
  deps: BookingDeps = {},
): Promise<Result<{ status: LinkBookingStatus; holdReason: BookingHoldReason | null }>> {
  let row: BookingRequest | null;
  try {
    row = await store.get('booking_requests', organizationId, id);
  } catch (error) {
    if (isMissingTableError(error)) return err('not_found', NOT_YOURS);
    throw error;
  }
  if (!row || row.meeting_type === 'message') return err('not_found', NOT_YOURS);
  if (row.status === 'held') {
    await placeHeldBookings(store, organizationId, { ...deps, force: true, onlyId: id });
    row = (await store.get('booking_requests', organizationId, id)) ?? row;
  }
  return ok({
    status: linkStatus(row),
    holdReason: row.status === 'held' ? (row.hold_reason ?? null) : null,
  });
}

/** The job's pass: every organization's held times (the push job calls it). */
export async function placeHeldBookingsForAll(
  store: DataStore,
  now: Date = new Date(),
): Promise<PlaceOutcome> {
  const total: PlaceOutcome = { placed: 0, released: 0, waiting: 0 };
  const organizations = (await store.list('organizations', '', {})) as Organization[];
  for (const org of organizations) {
    const one = await placeHeldBookings(store, org.id, { now }).catch((error: unknown) => {
      log.warn('Placing held bookings failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return null;
    });
    if (!one) continue;
    total.placed += one.placed;
    total.released += one.released;
    total.waiting += one.waiting;
  }
  return total;
}

/**
 * A short notice for a released held time, for someone to read and send
 * from the compose window (Copilot sends nothing itself). It names no person
 * as deciding, and the time is in the visitor's zone.
 */
export function releaseNoticeDraft(
  hostName: string,
  row: Pick<BookingRequest, 'name' | 'email' | 'starts_at' | 'visitor_time_zone' | 'guest_emails'>,
  hostZone: string,
): { to: string; subject: string; body: string } {
  const zone = knownZone(row.visitor_time_zone) ? row.visitor_time_zone : hostZone;
  const first = row.name.trim().split(/\s+/)[0] || 'there';
  const host = hostName.trim().split(/\s+/)[0] ?? '';
  const when = row.starts_at
    ? `${slotLabel(row.starts_at, zone)} (${zoneName(zone)})`
    : 'the time you picked';
  return {
    to: row.email,
    subject: host ? `Your time with ${host}` : 'Your booking',
    body: [
      `Hi ${first},`,
      '',
      `The ${when} time you held${host ? ` with ${host}` : ''} was taken before the invitation could go out, so it is not on the calendar. Sorry about that.`,
      '',
      'Please pick another time on the same booking link.',
      '',
      'Thanks,',
    ].join('\n'),
  };
}

/* --------------------------------------------------------- the Booking tab */

export interface LinkBookingList {
  available: boolean;
  bookings: LinkBookingView[];
  /** Held times wait for calendar editing to be turned on. */
  calendarEditing: boolean;
}

/**
 * The link's bookings for the Booking tab: upcoming (until each ends, a
 * cancelled one too, so a fresh cancellation and its note are seen), past,
 * or messages. Held times are placed first when calendar editing is on.
 */
export async function listLinkBookings(
  store: DataStore,
  organizationId: string,
  scope: BookingScope,
  deps: BookingDeps = {},
): Promise<LinkBookingList> {
  const now = deps.now ?? new Date();
  if (!(BOOKING_SCOPES as readonly string[]).includes(scope)) {
    return { available: true, bookings: [], calendarEditing: true };
  }
  await placeHeldBookings(store, organizationId, { ...deps, now }).catch(() => null);
  let rows: BookingRequest[];
  try {
    rows = await store.list(
      'booking_requests',
      organizationId,
      scope === 'messages'
        ? { eq: { meeting_type: 'message' } }
        : scope === 'upcoming'
          ? { neq: { meeting_type: 'message' }, gte: { ends_at: now.toISOString() } }
          : { neq: { meeting_type: 'message' }, lt: { ends_at: now.toISOString() } },
      {
        orderBy: [
          scope === 'upcoming'
            ? { field: 'starts_at', direction: 'asc' }
            : { field: scope === 'messages' ? 'created_at' : 'starts_at', direction: 'desc' },
        ],
        limit: 200,
      },
    );
  } catch (error) {
    if (isMissingTableError(error))
      return { available: false, bookings: [], calendarEditing: true };
    throw error;
  }
  const source = await hostSource(store, organizationId, deps).catch(() => null);
  const bookings = sortBookings(
    rows.map(toLinkBooking).filter((b) => bookingScope(b, now) === scope),
    scope,
  );
  return {
    available: true,
    bookings,
    calendarEditing: source ? calendarEditAccess(source).allowed : false,
  };
}

/** One booking's row for the tab (a member), for the release notice. */
export async function releaseNoticeFor(
  store: DataStore,
  organizationId: string,
  id: string,
): Promise<Result<{ to: string; subject: string; body: string }>> {
  const row = await store.get('booking_requests', organizationId, id).catch(() => null);
  if (!row || row.status !== 'declined' || row.decided_by !== null || !row.starts_at) {
    return err('not_found', 'There is no notice to send for this booking.');
  }
  const settings = await store.findOne('booking_settings', organizationId, {}).catch(() => null);
  const config = parseBookingConfig(settings?.settings ?? {});
  const [host, zone] = await Promise.all([
    readHost(store, organizationId),
    principalTimeZone(store, organizationId),
  ]);
  return ok(releaseNoticeDraft(hostNameFor(config, host), row, zone));
}
