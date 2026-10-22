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
import {
  colorRequest,
  colorRule,
  isColorOnly,
  labelRequest,
  respondRule,
  rsvpRequest,
  type RsvpResponse,
} from './event-actions';
import type {
  GCalColors,
  GCalDateTime,
  GCalDateTimeWrite,
  GCalEvent,
  GCalEventWrite,
} from './google-types';
import {
  invalidateCalendarCache,
  readCalendarLabels,
  readCalendarList,
  toRangeEvent,
  type CalendarSource,
} from './range-reader';
import type { CalendarInfo, EventLabel, RangeEvent } from './range-types';

/**
 * The Calendar tab's only way to change a calendar: create, change, move and
 * delete one event at a time, answer an invitation (Going? Yes / No / Maybe)
 * and pick an event's colour or colour label, on a person's tap. Imported by
 * the Calendar tab's edit route alone (a test pins that).
 *
 * Every write is refused here, before Google is asked, unless:
 * - calendar editing is turned on (the opt-in event scope; the demo's
 *   in-memory calendar counts as on, since nothing there reaches Google),
 * - the calendar is one this account can write to (owner or writer), and
 * - for a change or a delete, the event is one this account may change
 *   (its own, or its organizer lets guests change it); for an answer, Nick is
 *   a guest on it and not its organizer; for a colour, either.
 *
 * Guests hear about it only when the person chose Send in the prompt the
 * page shows every time guests are involved: `notify` is required, and only
 * 'send' becomes Google's sendUpdates 'all'. Everything else is 'none'. An
 * answer asks "Send your response to the organizer?" the same way. A colour
 * or label change is always 'none' and is never asked about. A label write
 * names eventLabelVersion=1 (Google applies eventLabelId only then); nothing
 * else does, since with it Google ignores a colorId.
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
  const listed = list.value.calendars.find((c) => c.id === calendarId);
  if (!listed) return err('not_found', 'That calendar is not on your list.');
  if (!listed.writable) return refuse('This calendar is view-only for this account.');
  // Its colour labels, live (cached under a minute): to check a label picked, and to draw it after.
  const labels = await readCalendarLabels(ctx.source, ctx.organizationId, calendarId);
  return ok({ calendar: { ...listed, labels }, colors: list.value.colors });
}

/** A label must be one the calendar has now (null clears it). */
function labelProblem(labelId: string | null | undefined, labels: readonly EventLabel[]) {
  if (labelId === undefined || labelId === null) return null;
  return labels.some((l) => l.id === labelId)
    ? null
    : 'That label is not on this calendar any more. Refresh and pick again.';
}

/** Google applies eventLabelId only with eventLabelVersion=1; nothing else sends it. */
function labelVersion(body: GCalEventWrite): 0 | 1 {
  return body.eventLabelId !== undefined ? 1 : 0;
}

function checkDraft(
  changes: Partial<EventDraft>,
  colors: GCalColors | null,
  /** The calendar's labels; null to leave the label to a later check (a move). */
  labels: readonly EventLabel[] | null,
): string | null {
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
  return labels ? labelProblem(changes.labelId, labels) : null;
}

/** A create sends no nulls: there is nothing to clear yet. */
function withoutNulls(body: GCalEventWrite): GCalEventWrite {
  const strip = (d: GCalDateTimeWrite | undefined) =>
    d ? Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null && v !== undefined)) : d;
  const out: GCalEventWrite = { ...body, start: strip(body.start), end: strip(body.end) };
  if (out.colorId === null) delete out.colorId;
  // No label to clear on a new event.
  if (!out.eventLabelId) delete out.eventLabelId;
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
  const problem = checkDraft(input.draft, colors, calendar.labels);
  if (problem) return err('invalid_input', problem);

  const { body, conferenceDataVersion } = draftToWrite(input.draft, {
    ownEmails: ctx.source.ownEmails,
    requestId: newId(),
  });
  const sendUpdates = sendUpdatesFor(input.notify);
  const insert = withoutNulls(body);
  const created = await ctx.source.provider.insertEvent(calendar.id, insert, {
    sendUpdates,
    conferenceDataVersion,
    eventLabelVersion: labelVersion(insert),
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
  // A label is checked against the calendar the event ends up on.
  const moving = Boolean(
    input.destinationCalendarId && input.destinationCalendarId !== calendar.id,
  );
  const problem = checkDraft(input.changes, colors, moving ? null : calendar.labels);
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

  const destinationId =
    input.destinationCalendarId && input.destinationCalendarId !== calendar.id
      ? input.destinationCalendarId
      : null;
  // A colour is the viewer's own business, as in Google Calendar: a change
  // that only recolours the event tells nobody, whatever was answered.
  const sendUpdates =
    isColorOnly(input.changes) && !destinationId ? 'none' : sendUpdatesFor(input.notify);
  let finalCalendar = calendar;
  let latest: GCalEvent = existing;
  let changed = false;

  if (destinationId) {
    const destination = await writableCalendar(ctx, destinationId);
    if (!destination.ok) return destination;
    const wrong = labelProblem(input.changes.labelId, destination.value.calendar.labels);
    if (wrong) return err('invalid_input', wrong);
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
      eventLabelVersion: labelVersion(body),
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

/* ---------------------------------------------------- the event card */

/** The one-tap writes from an event's card share the same checks as a change. */
async function cardTarget(
  ctx: WriteContext,
  calendar: CalendarInfo,
  eventId: string,
  scope: RecurringScope,
  allowed: (event: GCalEvent) => { ok: boolean; reason: string | null },
): Promise<Result<{ existing: GCalEvent; targetId: string; series: boolean }>> {
  const instance = await ctx.source.provider.getEvent(calendar.id, eventId);
  if (!instance.ok) return instance;
  if (instance.value.recurrence?.length && !instance.value.recurringEventId) {
    return err('invalid_input', 'Open one event of the series to change it.');
  }
  const rule = allowed(instance.value);
  if (!rule.ok) return refuse(rule.reason ?? 'This event is view-only here.');
  const target = scopeTarget(instance.value, scope);
  if (!target.series) {
    return ok({ existing: instance.value, targetId: target.eventId, series: false });
  }
  const series = await ctx.source.provider.getEvent(calendar.id, target.eventId);
  if (!series.ok) return series;
  const seriesRule = allowed(series.value);
  if (!seriesRule.ok) return refuse(seriesRule.reason ?? 'This series is view-only here.');
  return ok({ existing: series.value, targetId: target.eventId, series: true });
}

export interface RespondInput {
  calendarId: string;
  eventId: string;
  scope: RecurringScope;
  response: RsvpResponse;
  /** 'send' only when the person chose Send in "Send your response to the organizer?". */
  notify: GuestChoice;
}

/**
 * Going? Yes / No / Maybe on an event Nick is a guest on: his own answer
 * changes and nothing else. Google tells the organizer only on Send.
 */
export async function respondToCalendarEvent(
  ctx: WriteContext,
  input: RespondInput,
): Promise<Result<WriteResult>> {
  const source = await writableCalendar(ctx, input.calendarId);
  if (!source.ok) return source;
  const { calendar, colors } = source.value;
  const own = ctx.source.ownEmails;
  const found = await cardTarget(ctx, calendar, input.eventId, input.scope, (event) => {
    const rule = respondRule(event, calendar.accessRole, own);
    return { ok: rule.canRespond, reason: rule.reason };
  });
  if (!found.ok) return found;
  const { existing, targetId, series } = found.value;
  const request = rsvpRequest(existing, input.response, input.notify, own);
  if (!request) return refuse('You are not on the guest list.');
  const patched = await ctx.source.provider.patchEvent(calendar.id, targetId, request.body, {
    sendUpdates: request.sendUpdates,
  });
  if (!patched.ok) return patched;
  invalidateCalendarCache(ctx.organizationId, [calendar.id]);
  await audit(ctx, 'calendar.event_updated', targetId, {
    primary: calendar.primary,
    scope: series ? 'all' : 'this',
    kind: 'respond',
    response: input.response,
    notified: request.sendUpdates === 'all',
  });
  return ok({
    event: series ? null : toRangeEvent(patched.value, calendar, colors, own),
    reload: series,
  });
}

export interface RecolorInput {
  calendarId: string;
  eventId: string;
  scope: RecurringScope;
  /** One of Google's event colours, or null for the calendar's colour. */
  colorId: string | null;
}

/** A colour from the event's card: Google's colorId alone, and never an email. */
export async function recolorCalendarEvent(
  ctx: WriteContext,
  input: RecolorInput,
): Promise<Result<WriteResult>> {
  const source = await writableCalendar(ctx, input.calendarId);
  if (!source.ok) return source;
  const { calendar, colors } = source.value;
  const problem = checkDraft({ colorId: input.colorId }, colors, calendar.labels);
  if (problem) return err('invalid_input', problem);
  const own = ctx.source.ownEmails;
  const found = await cardTarget(ctx, calendar, input.eventId, input.scope, (event) => {
    const rule = colorRule(event, calendar.accessRole, own);
    return { ok: rule.canColor, reason: rule.reason };
  });
  if (!found.ok) return found;
  const { targetId, series } = found.value;
  const request = colorRequest(input.colorId);
  const patched = await ctx.source.provider.patchEvent(calendar.id, targetId, request.body, {
    sendUpdates: request.sendUpdates,
    conferenceDataVersion: request.conferenceDataVersion,
  });
  if (!patched.ok) return patched;
  invalidateCalendarCache(ctx.organizationId, [calendar.id]);
  await audit(ctx, 'calendar.event_updated', targetId, {
    primary: calendar.primary,
    scope: series ? 'all' : 'this',
    kind: 'color',
    notified: false,
  });
  return ok({
    event: series ? null : toRangeEvent(patched.value, calendar, colors, own),
    reload: series,
  });
}

export interface RelabelInput {
  calendarId: string;
  eventId: string;
  scope: RecurringScope;
  /** One of the calendar's colour labels, or null for none. */
  labelId: string | null;
}

/**
 * A colour label from the event's card (or its suggested label, tapped):
 * Google's eventLabelId alone, with eventLabelVersion=1, under the colour's
 * rules (calendar editing on, a writable calendar, an event Nick may change
 * or his own copy of an invitation), and never an email.
 */
export async function relabelCalendarEvent(
  ctx: WriteContext,
  input: RelabelInput,
): Promise<Result<WriteResult>> {
  const source = await writableCalendar(ctx, input.calendarId);
  if (!source.ok) return source;
  const { calendar, colors } = source.value;
  if (calendar.labels.length === 0) {
    return err('invalid_input', 'This calendar has no labels. Pick one of Google’s colours.');
  }
  const problem = labelProblem(input.labelId, calendar.labels);
  if (problem) return err('invalid_input', problem);
  const own = ctx.source.ownEmails;
  const found = await cardTarget(ctx, calendar, input.eventId, input.scope, (event) => {
    const rule = colorRule(event, calendar.accessRole, own);
    return { ok: rule.canColor, reason: rule.reason };
  });
  if (!found.ok) return found;
  const { targetId, series } = found.value;
  const request = labelRequest(input.labelId);
  const patched = await ctx.source.provider.patchEvent(calendar.id, targetId, request.body, {
    sendUpdates: request.sendUpdates,
    eventLabelVersion: request.eventLabelVersion,
  });
  if (!patched.ok) return patched;
  invalidateCalendarCache(ctx.organizationId, [calendar.id]);
  await audit(ctx, 'calendar.event_updated', targetId, {
    primary: calendar.primary,
    scope: series ? 'all' : 'this',
    kind: 'label',
    cleared: input.labelId === null,
    notified: false,
  });
  return ok({
    event: series ? null : toRangeEvent(patched.value, calendar, colors, own),
    reload: series,
  });
}
