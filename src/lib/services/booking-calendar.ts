import 'server-only';
import type { EventDraft, GuestChoice } from '@/lib/calendar/edit-rules';
import type { CalendarSource } from '@/lib/calendar/range-reader';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  updateCalendarEvent,
} from '@/lib/calendar/write';
import type { DataStore } from '@/lib/db/store';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * The booking link's only calendar writes (D-074, D-078), each through
 * lib/calendar/write.ts and its gates (calendar editing on, a calendar this
 * account can write to, an event it may change). Every booking change tells
 * the guests through Google itself (sendUpdates 'all'): the invitation when
 * a booking is made, the update when it moves, the cancellation when it
 * goes. Putting its description back tells nobody.
 * Copilot sends no email of its own.
 *
 * Reached from these places only, each time-changing write after the time
 * was checked again against the live calendar and every rule
 * (lib/services/booking.ts and lib/services/booking-manage.ts):
 *   - a person's Approve in the Calendar tab (approve first, an option);
 *   - a visitor booking a free time at once (the default, Arwin's decision);
 *   - a held time placed once calendar editing is on;
 *   - the booking's own page, where the visitor moves or cancels it;
 *   - and, telling nobody, a booking's own description put back after
 *     another tool added its reschedule link (lib/services/booking-sync.ts).
 */

export interface LinkWriteContext {
  store: DataStore;
  organizationId: string;
  source: CalendarSource;
  /** The person who pressed it in Copilot; null for a visitor on the link. */
  actorId: string | null;
}

const write = (ctx: LinkWriteContext) => ({
  store: ctx.store,
  organizationId: ctx.organizationId,
  userId: ctx.actorId,
  source: ctx.source,
});

export interface CreatedLinkEvent {
  eventId: string;
  meetUrl: string | null;
}

/** The booking's event on the host's calendar, everyone on it invited by Google. */
export async function createLinkEvent(
  ctx: LinkWriteContext,
  calendarId: string,
  draft: EventDraft,
): Promise<Result<CreatedLinkEvent>> {
  const created = await createCalendarEvent(write(ctx), { calendarId, draft, notify: 'send' });
  if (!created.ok) return created;
  const eventId = created.value.event?.id ?? '';
  if (!eventId) return err('provider_unavailable', 'Google did not say which event it made.');
  return ok({ eventId, meetUrl: created.value.event?.meetUrl ?? null });
}

/** One change to a booking's event: the only update this module makes. */
async function changeLinkEvent(
  ctx: LinkWriteContext,
  input: { calendarId: string; eventId: string },
  changes: Partial<EventDraft>,
  notify: GuestChoice,
): Promise<Result<true>> {
  const changed = await updateCalendarEvent(write(ctx), {
    calendarId: input.calendarId,
    eventId: input.eventId,
    scope: 'this',
    notify,
    changes,
  });
  return changed.ok ? ok(true) : changed;
}

/** The same event moved to a new time: Google sends everyone the update. */
export async function moveLinkEvent(
  ctx: LinkWriteContext,
  input: { calendarId: string; eventId: string; start: string; end: string; timeZone: string },
): Promise<Result<true>> {
  return changeLinkEvent(
    ctx,
    input,
    { allDay: false, start: input.start, end: input.end, timeZone: input.timeZone },
    'send',
  );
}

/**
 * A booking's own description put back (D-078), after another scheduling
 * tool (Fyxer, Vimcal, Calendly) appended its reschedule link to it: told
 * to nobody (sendUpdates 'none'), so the guests' copies change quietly and
 * nobody gets an email about it. Only ever a booking-link event, found by
 * the event id on its booking (lib/services/booking-sync.ts).
 */
export async function restoreLinkDescription(
  ctx: LinkWriteContext,
  input: { calendarId: string; eventId: string; description: string },
): Promise<Result<true>> {
  return changeLinkEvent(ctx, input, { description: input.description }, 'dont_send');
}

/** The event deleted: Google sends everyone its cancellation. */
export async function deleteLinkEvent(
  ctx: LinkWriteContext,
  input: { calendarId: string; eventId: string },
): Promise<Result<true>> {
  const deleted = await deleteCalendarEvent(write(ctx), {
    calendarId: input.calendarId,
    eventId: input.eventId,
    scope: 'this',
    notify: 'send',
  });
  return deleted.ok ? ok(true) : deleted;
}
