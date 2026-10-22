import 'server-only';
import type { EventDraft } from '@/lib/calendar/edit-rules';
import type { CalendarSource } from '@/lib/calendar/range-reader';
import { createCalendarEvent, deleteCalendarEvent, updateCalendarEvent } from '@/lib/calendar/write';
import type { DataStore } from '@/lib/db/store';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * The booking link's only calendar writes (D-074, D-078), each through
 * lib/calendar/write.ts and its gates (calendar editing on, a calendar this
 * account can write to, an event it may change). Every one tells the guests
 * through Google itself (sendUpdates 'all'): the invitation when a booking
 * is made, the update when it moves, the cancellation when it goes.
 * Copilot sends no email of its own.
 *
 * Reached from four places only, each after the time was checked again
 * against the live calendar and every rule (lib/services/booking.ts and
 * lib/services/booking-manage.ts):
 *   - a person's Approve in the Calendar tab (approve first, an option);
 *   - a visitor booking a free time at once (the default, Arwin's decision);
 *   - a held time placed once calendar editing is on;
 *   - the booking's own page, where the visitor moves or cancels it.
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

/** The same event moved to a new time: Google sends everyone the update. */
export async function moveLinkEvent(
  ctx: LinkWriteContext,
  input: { calendarId: string; eventId: string; start: string; end: string; timeZone: string },
): Promise<Result<true>> {
  const moved = await updateCalendarEvent(write(ctx), {
    calendarId: input.calendarId,
    eventId: input.eventId,
    scope: 'this',
    notify: 'send',
    changes: { allDay: false, start: input.start, end: input.end, timeZone: input.timeZone },
  });
  return moved.ok ? ok(true) : moved;
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
