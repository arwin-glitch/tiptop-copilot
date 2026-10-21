import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { calendarEditAccess, EDITING_OFF_MESSAGE } from './edit-access';
import {
  cleanGuestList,
  draftToWrite,
  guestEmails,
  modifyRule,
  scopeTarget,
  sendUpdatesFor,
  seriesGuestList,
  shiftSeries,
  timesProblem,
  type EventDraft,
  type GuestChoice,
  type RecurringScope,
} from './edit-rules';
import type {
  GCalColors,
  GCalDateTime,
  GCalDateTimeWrite,
  GCalEvent,
  GCalEventWrite,
} from './google-types';
import {
  invalidateCalendarCache,
  readCalendarList,
  toRangeEvent,
  type CalendarSource,
} from './range-reader';
import type { CalendarInfo, RangeEvent } from './range-types';

/**
 * The Calendar tab's only way to change a calendar: create, change, move and
 * delete one event at a time, on a person's tap. Imported by the Calendar
 * tab's edit route alone (a test pins that).
 *
 * Every write is refused here, before Google is asked, unless:
 * - calendar editing is turned on (the opt-in event scope; the demo's
 *   in-memory calendar counts as on, since nothing there reaches Google),
 * - the calendar is one this account can write to (owner or writer), and
 * - for a change or a delete, the event is one this account may change
 *   (its own, or its organizer lets guests change it).
 *
 * Guests hear about it only when the person chose Send in the prompt the
 * page shows every time guests are involved: `notify` is required, and only
 * 'send' becomes Google's sendUpdates 'all'. Everything else is 'none'.
 */

export interface WriteContext {
  store: DataStore;
  organizationId: string;
  userId: string;
  source: CalendarSource;
}

export interface WriteResult {
  /** The event as Google now has it; null after a delete or a series change. */
  event: RangeEvent | null;
  /** Several instances changed (a whole series): reload the range. */
  reload: boolean;
}

const STILL_USABLE = 'The calendar still shows everything; nothing was changed.';

function refuse(message: string) {
  return err('forbidden', message, { stillUsable: STILL_USABLE });
}

async function writableCalendar(
  ctx: WriteContext,
  calendarId: string,
): Promise<Result<{ calendar: CalendarInfo; colors: GCalColors | null }>> {
  const access = calendarEditAccess(ctx.source);
  if (!access.allowed) return refuse(access.reason ?? EDITING_OFF_MESSAGE);
  const list = await readCalendarList(ctx.source, ctx.organizationId);
  if (!list.ok) return list;
  const calendar = list.value.calendars.find((c) => c.id === calendarId);
  if (!calendar) return err('not_found', 'That calendar is not on your list.');
  if (!calendar.writable) return refuse('This calendar is view-only for this account.');
  return ok({ calendar, colors: list.value.colors });
}

function checkDraft(changes: Partial<EventDraft>, colors: GCalColors | null): string | null {
  const times = [changes.start, changes.end, changes.allDay, changes.timeZone];
  if (times.some((t) => t !== undefined)) {
    if (times.some((t) => t === undefined)) return 'Send the start, end and time zone together.';
    const problem = timesProblem({
      allDay: changes.allDay!,
      start: changes.start!,
      end: changes.end!,
    });
    if (problem) return problem;
  }
  if (changes.guests && cleanGuestList(changes.guests).length !== changes.guests.length) {
    return 'Check the guest addresses.';
  }
  if (changes.colorId && colors?.event && !colors.event[changes.colorId]) {
    return 'Pick one of Google’s event colours.';
  }
  return null;
}

/** A create sends no nulls: there is nothing to clear yet. */
function withoutNulls(body: GCalEventWrite): GCalEventWrite {
  const strip = (d: GCalDateTimeWrite | undefined) =>
    d ? Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null && v !== undefined)) : d;
  const out: GCalEventWrite = { ...body, start: strip(body.start), end: strip(body.end) };
  if (out.colorId === null) delete out.colorId;
  return out;
}

const asDateTime = (d: GCalDateTimeWrite | undefined): GCalDateTime => ({
  ...(d?.dateTime ? { dateTime: d.dateTime } : {}),
  ...(d?.date ? { date: d.date } : {}),
  ...(d?.timeZone ? { timeZone: d.timeZone } : {}),
});

async function audit(
  ctx: WriteContext,
  action: 'calendar.event_created' | 'calendar.event_updated' | 'calendar.event_deleted',
  eventId: string | null,
  metadata: Record<string, string | number | boolean | null>,
) {
  // Ids and counts only: no titles, no guest addresses, nothing from the event.
  await recordAudit(ctx.store, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    action,
    entityType: 'calendar_event',
    entityId: eventId,
    metadata: { ...metadata, demo: ctx.source.demo },
  });
}

/* ---------------------------------------------------------------- create */

export async function createCalendarEvent(
  ctx: WriteContext,
  input: { calendarId: string; draft: EventDraft; notify: GuestChoice },
): Promise<Result<WriteResult>> {
  const target = await writableCalendar(ctx, input.calendarId);
  if (!target.ok) return target;
  const { calendar, colors } = target.value;
  const problem = checkDraft(input.draft, colors);
  if (problem) return err('invalid_input', problem);

  const { body, conferenceDataVersion } = draftToWrite(input.draft, {
    ownEmails: ctx.source.ownEmails,
    requestId: newId(),
  });
  const sendUpdates = sendUpdatesFor(input.notify);
  const created = await ctx.source.provider.insertEvent(calendar.id, withoutNulls(body), {
    sendUpdates,
    conferenceDataVersion,
  });
  if (!created.ok) return created;
  invalidateCalendarCache(ctx.organizationId, [calendar.id]);
  await audit(ctx, 'calendar.event_created', created.value.id, {
    primary: calendar.primary,
    notified: sendUpdates === 'all',
    guests: guestEmails(created.value.attendees, ctx.source.ownEmails).length,
    meet: conferenceDataVersion === 1,
  });
  return ok({
    event: toRangeEvent(created.value, calendar, colors, ctx.source.ownEmails),
    reload: false,
  });
}

/* ---------------------------------------------------------------- update */

export interface UpdateInput {
  calendarId: string;
  eventId: string;
  scope: RecurringScope;
  notify: GuestChoice;
  changes: Partial<EventDraft>;
  /** Move it to another of the account's calendars. */
  destinationCalendarId?: string | null;
}

/** The instance (and, for "All events", its series) after the modify checks. */
async function changeableTarget(
  ctx: WriteContext,
  calendar: CalendarInfo,
  eventId: string,
  scope: RecurringScope,
): Promise<
  Result<{ instance: GCalEvent; existing: GCalEvent; targetId: string; series: boolean }>
> {
  const instance = await ctx.source.provider.getEvent(calendar.id, eventId);
  if (!instance.ok) return instance;
  // The views list single events, so a series itself never reaches the page.
  // Named directly, its id would turn "This event" into the whole series.
  if (instance.value.recurrence?.length && !instance.value.recurringEventId) {
    return err('invalid_input', 'Open one event of the series to change it.');
  }
  const rule = modifyRule(instance.value, calendar.accessRole);
  if (!rule.canModify) return refuse(rule.reason ?? 'This event is view-only here.');
  const target = scopeTarget(instance.value, scope);
  if (!target.series) {
    return ok({
      instance: instance.value,
      existing: instance.value,
      targetId: target.eventId,
      series: false,
    });
  }
  const series = await ctx.source.provider.getEvent(calendar.id, target.eventId);
  if (!series.ok) return series;
  const seriesRule = modifyRule(series.value, calendar.accessRole);
  if (!seriesRule.canModify) return refuse(seriesRule.reason ?? 'This series is view-only here.');
  return ok({
    instance: instance.value,
    existing: series.value,
    targetId: target.eventId,
    series: true,
  });
}

export async function updateCalendarEvent(
  ctx: WriteContext,
  input: UpdateInput,
): Promise<Result<WriteResult>> {
  const source = await writableCalendar(ctx, input.calendarId);
  if (!source.ok) return source;
  const { calendar, colors } = source.value;
  const problem = checkDraft(input.changes, colors);
  if (problem) return err('invalid_input', problem);

  const found = await changeableTarget(ctx, calendar, input.eventId, input.scope);
  if (!found.ok) return found;
  const { instance, existing, targetId, series } = found.value;

  // "All events": the series' guests change by who was added and removed on
  // this event (what the guests prompt named), not by this event's whole list.
  const changes: Partial<EventDraft> =
    series && input.changes.guests !== undefined
      ? {
          ...input.changes,
          guests: seriesGuestList(
            existing.attendees,
            instance.attendees,
            input.changes.guests,
            ctx.source.ownEmails,
          ),
        }
      : input.changes;

  const { body, conferenceDataVersion } = draftToWrite(changes, {
    existing,
    ownEmails: ctx.source.ownEmails,
    requestId: newId(),
  });

  // "All events": every event takes this one's new time of day and length.
  if (series && body.start && body.end) {
    const shifted = shiftSeries(
      { start: existing.start ?? {}, end: existing.end ?? {} },
      { start: instance.start ?? {}, end: instance.end ?? {} },
      { start: asDateTime(body.start), end: asDateTime(body.end) },
      input.changes.timeZone ?? null,
    );
    if (!shifted) {
      return err(
        'invalid_input',
        'Move a whole series to another day, or between all-day and timed, in Google Calendar. This event alone can still be changed here.',
      );
    }
    const timed = Boolean(shifted.start.dateTime);
    body.start = timed
      ? { ...shifted.start, date: null }
      : { ...shifted.start, dateTime: null, timeZone: null };
    body.end = timed
      ? { ...shifted.end, date: null }
      : { ...shifted.end, dateTime: null, timeZone: null };
  }

  const sendUpdates = sendUpdatesFor(input.notify);
  const destinationId =
    input.destinationCalendarId && input.destinationCalendarId !== calendar.id
      ? input.destinationCalendarId
      : null;
  let finalCalendar = calendar;
  let latest: GCalEvent = existing;
  let changed = false;

  if (destinationId) {
    const destination = await writableCalendar(ctx, destinationId);
    if (!destination.ok) return destination;
    if (instance.recurringEventId && !series) {
      return err(
        'invalid_input',
        'One event of a series cannot move to another calendar. Choose All events, or move it in Google Calendar.',
      );
    }
    const moved = await ctx.source.provider.moveEvent(calendar.id, targetId, destinationId, {
      sendUpdates,
    });
    if (!moved.ok) return moved;
    finalCalendar = destination.value.calendar;
    latest = moved.value;
    changed = true;
  }

  if (Object.keys(body).length > 0) {
    const patched = await ctx.source.provider.patchEvent(finalCalendar.id, targetId, body, {
      sendUpdates,
      conferenceDataVersion,
    });
    if (!patched.ok) {
      if (changed) invalidateCalendarCache(ctx.organizationId, [calendar.id, finalCalendar.id]);
      return patched;
    }
    latest = patched.value;
    changed = true;
  }

  if (!changed) {
    return ok({
      event: toRangeEvent(instance, calendar, colors, ctx.source.ownEmails),
      reload: false,
    });
  }
  invalidateCalendarCache(ctx.organizationId, [calendar.id, finalCalendar.id]);
  await audit(ctx, 'calendar.event_updated', targetId, {
    primary: finalCalendar.primary,
    scope: series ? 'all' : 'this',
    moved: Boolean(destinationId),
    notified: sendUpdates === 'all',
    guests: guestEmails(latest.attendees, ctx.source.ownEmails).length,
    meet: conferenceDataVersion === 1,
  });
  return ok({
    event: series ? null : toRangeEvent(latest, finalCalendar, colors, ctx.source.ownEmails),
    reload: series,
  });
}

/* ---------------------------------------------------------------- delete */

export async function deleteCalendarEvent(
  ctx: WriteContext,
  input: { calendarId: string; eventId: string; scope: RecurringScope; notify: GuestChoice },
): Promise<Result<WriteResult>> {
  const source = await writableCalendar(ctx, input.calendarId);
  if (!source.ok) return source;
  const { calendar } = source.value;
  const found = await changeableTarget(ctx, calendar, input.eventId, input.scope);
  if (!found.ok) return found;
  const { existing, targetId, series } = found.value;
  const sendUpdates = sendUpdatesFor(input.notify);
  const deleted = await ctx.source.provider.deleteEvent(calendar.id, targetId, { sendUpdates });
  if (!deleted.ok) return deleted;
  invalidateCalendarCache(ctx.organizationId, [calendar.id]);
  await audit(ctx, 'calendar.event_deleted', targetId, {
    primary: calendar.primary,
    scope: series ? 'all' : 'this',
    notified: sendUpdates === 'all',
    guests: guestEmails(existing.attendees, ctx.source.ownEmails).length,
  });
  return ok({ event: null, reload: series });
}
