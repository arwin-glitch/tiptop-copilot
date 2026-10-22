import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { buildDemoDb } from '@/lib/demo/fixtures';
import { getAccessToken } from '@/lib/google/oauth';
import { log } from '@/lib/security/redact';
import type { Integration } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import type {
  GCalCalendar,
  GCalColors,
  GCalEvent,
  GCalEventWrite,
  GCalListEntry,
  GCalWriteOptions,
  SendUpdates,
} from './google-types';
import {
  applyPatch,
  fulfilConference,
  locate,
  mockListRange,
  newMockEventId,
  resolveCalendarId,
  sharedMockCalendar,
  type MockCalendarState,
} from './mock-calendar';

/**
 * Calendar provider seam.
 *
 * Reads: `listEvents` (the Today sync, primary calendar only) and the new
 * views' reads: the calendar list, Google's colours, one calendar (for its
 * colour labels), a range of single events on any calendar, one event. The
 * views' reads ask for Google's colour labels (eventLabelVersion=1), so each
 * event comes back with its eventLabelId.
 *
 * Writes: insert, patch, move, delete. They exist only for the Calendar tab's
 * edit routes, through lib/calendar/write.ts, which refuses unless calendar
 * editing is turned on, the calendar is writable and the event is one this
 * account may change. Every write names its sendUpdates; there is no default.
 * A label write also names eventLabelVersion=1 (Google ignores eventLabelId
 * without it, and colorId with it, so a colour write never sends it).
 * The mock answers them in memory and records each one; tests never reach the
 * Google implementation's write endpoints.
 */

export interface RawCalendarEvent {
  providerEventId: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  attendees: { name: string | null; email: string; response: string | null }[];
  organizerEmail: string | null;
  isPrivate: boolean;
}

export interface ListEventsOptions {
  timeMin: string;
  timeMax: string;
  maxResults: number;
  cursor: string | null;
}

export interface ListEventsResult {
  events: RawCalendarEvent[];
  nextCursor: string | null;
}

export interface RangeOptions {
  timeMin: string;
  timeMax: string;
}

export interface CalendarProvider {
  readonly kind: 'google' | 'mock';
  listEvents(options: ListEventsOptions): Promise<Result<ListEventsResult>>;
  /** Every calendar on the account's list, as Google returns it. */
  listCalendars(): Promise<Result<GCalListEntry[]>>;
  /** Google's colour palettes: calendar colours and the event colorId palette. */
  getColors(): Promise<Result<GCalColors>>;
  /** One calendar (calendars.get), with its colour labels. */
  getCalendar(calendarId: string): Promise<Result<GCalCalendar>>;
  /** Every single event overlapping the range on one calendar, all pages, series expanded. */
  listRange(calendarId: string, range: RangeOptions): Promise<Result<GCalEvent[]>>;
  getEvent(calendarId: string, eventId: string): Promise<Result<GCalEvent>>;
  insertEvent(
    calendarId: string,
    body: GCalEventWrite,
    options: GCalWriteOptions,
  ): Promise<Result<GCalEvent>>;
  patchEvent(
    calendarId: string,
    eventId: string,
    body: GCalEventWrite,
    options: GCalWriteOptions,
  ): Promise<Result<GCalEvent>>;
  moveEvent(
    calendarId: string,
    eventId: string,
    destinationId: string,
    options: { sendUpdates: SendUpdates },
  ): Promise<Result<GCalEvent>>;
  deleteEvent(
    calendarId: string,
    eventId: string,
    options: { sendUpdates: SendUpdates },
  ): Promise<Result<true>>;
}

/* ---------------------------------------------------------------- google */

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
/** Pages of 250: enough for a busy month on one calendar without looping for ever. */
const RANGE_PAGE_SIZE = 250;
const RANGE_MAX_PAGES = 8;
/**
 * Google's switch for colour labels: with it, reads carry each event's
 * eventLabelId and a write's eventLabelId is applied (and its colorId
 * ignored). Sent on every read the views make, and on label writes only.
 */
export const EVENT_LABEL_VERSION = '1';

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  visibility?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string }[];
}

const enc = encodeURIComponent;

/** A failed Google answer as an AppError a person can read; never Google's own text. */
async function googleError(response: Response, writing: boolean): Promise<Result<never>> {
  if (response.status === 401) {
    return err('provider_unauthorized', 'Google Calendar rejected the request. Reconnect Google.');
  }
  if (response.status === 429) {
    return err('quota_exceeded', 'Google Calendar is busy. Try again in a minute.', {
      retryable: true,
    });
  }
  if (response.status === 403) {
    let reason = '';
    try {
      const body = (await response.json()) as { error?: { errors?: { reason?: string }[] } };
      reason = body.error?.errors?.[0]?.reason ?? '';
    } catch {
      /* no body */
    }
    if (/rateLimit/i.test(reason)) {
      return err('quota_exceeded', 'Google Calendar is busy. Try again in a minute.', {
        retryable: true,
      });
    }
    return writing
      ? err('forbidden', 'Google Calendar would not allow this change on that event.')
      : err('provider_unauthorized', 'Google Calendar rejected the request.');
  }
  if (response.status === 404 || response.status === 410) {
    return err('not_found', 'That event is no longer on the calendar.');
  }
  if (response.status === 409 || response.status === 412) {
    return err(
      'conflict',
      'The event changed in Google Calendar meanwhile. Refresh and try again.',
    );
  }
  if (response.status === 400) {
    return err('invalid_input', 'Google Calendar could not take that change.');
  }
  log.warn('Calendar request failed', { status: response.status });
  return err('provider_unavailable', 'Google Calendar is unavailable right now.', {
    retryable: true,
  });
}

export class GoogleCalendarProvider implements CalendarProvider {
  readonly kind = 'google' as const;

  constructor(
    private readonly store: DataStore,
    private readonly integration: Integration,
  ) {}

  private async request<T>(
    path: string,
    init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
  ): Promise<Result<T | null>> {
    const token = await getAccessToken(this.store, this.integration);
    if (!token.ok) return token;
    const method = init.method ?? 'GET';
    try {
      const response = await fetch(`${CALENDAR_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token.value}`,
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      if (!response.ok) return googleError(response, method !== 'GET');
      if (response.status === 204) return ok(null);
      return ok((await response.json()) as T);
    } catch {
      return err('provider_unavailable', 'Could not reach Google Calendar.', { retryable: true });
    }
  }

  async listEvents(options: ListEventsOptions): Promise<Result<ListEventsResult>> {
    const token = await getAccessToken(this.store, this.integration);
    if (!token.ok) return token;

    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(Math.min(options.maxResults, 250)),
      timeMin: options.timeMin,
      timeMax: options.timeMax,
    });

    try {
      const response = await fetch(
        `${CALENDAR_BASE}/calendars/primary/events?${params.toString()}`,
        { headers: { Authorization: `Bearer ${token.value}` } },
      );
      if (response.status === 401 || response.status === 403) {
        return err('provider_unauthorized', 'Google Calendar rejected the request.');
      }
      if (response.status === 429) {
        return err('quota_exceeded', 'Google Calendar rate limit reached.', { retryable: true });
      }
      if (!response.ok) {
        log.warn('Calendar request failed', { status: response.status });
        return err('provider_unavailable', 'Google Calendar is unavailable right now.', {
          retryable: true,
        });
      }
      const data = (await response.json()) as { items?: GoogleEvent[]; nextSyncToken?: string };
      const events = (data.items ?? []).filter((e) => e.status !== 'cancelled').map(toRawEvent);
      return ok({ events, nextCursor: data.nextSyncToken ?? null });
    } catch {
      return err('provider_unavailable', 'Could not reach Google Calendar.', { retryable: true });
    }
  }

  async listCalendars(): Promise<Result<GCalListEntry[]>> {
    const out: GCalListEntry[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({ maxResults: '250' });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.request<{ items?: GCalListEntry[]; nextPageToken?: string }>(
        `/users/me/calendarList?${params.toString()}`,
      );
      if (!res.ok) return res;
      out.push(...(res.value?.items ?? []));
      pageToken = res.value?.nextPageToken ?? null;
      if (!pageToken) break;
    }
    return ok(out);
  }

  async getColors(): Promise<Result<GCalColors>> {
    const res = await this.request<GCalColors>('/colors');
    return res.ok ? ok(res.value ?? {}) : res;
  }

  async getCalendar(calendarId: string): Promise<Result<GCalCalendar>> {
    const path = `/calendars/${enc(calendarId)}`;
    const labelled = new URLSearchParams({ eventLabelVersion: EVENT_LABEL_VERSION });
    let res = await this.request<GCalCalendar>(`${path}?${labelled.toString()}`);
    // Should calendars.get ever refuse the label switch as unknown, ask once without it.
    if (!res.ok && res.error.code === 'invalid_input') res = await this.request<GCalCalendar>(path);
    if (!res.ok) return res;
    return res.value ? ok(res.value) : err('not_found', 'That calendar is not on the list.');
  }

  async listRange(calendarId: string, range: RangeOptions): Promise<Result<GCalEvent[]>> {
    const out: GCalEvent[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < RANGE_MAX_PAGES; page++) {
      const params = new URLSearchParams({
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: String(RANGE_PAGE_SIZE),
        timeMin: range.timeMin,
        timeMax: range.timeMax,
        eventLabelVersion: EVENT_LABEL_VERSION,
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.request<{ items?: GCalEvent[]; nextPageToken?: string }>(
        `/calendars/${enc(calendarId)}/events?${params.toString()}`,
      );
      if (!res.ok) return res;
      out.push(...(res.value?.items ?? []));
      pageToken = res.value?.nextPageToken ?? null;
      if (!pageToken) break;
    }
    return ok(out.filter((e) => e.status !== 'cancelled'));
  }

  async getEvent(calendarId: string, eventId: string): Promise<Result<GCalEvent>> {
    const labelled = new URLSearchParams({ eventLabelVersion: EVENT_LABEL_VERSION });
    const res = await this.request<GCalEvent>(
      `/calendars/${enc(calendarId)}/events/${enc(eventId)}?${labelled.toString()}`,
    );
    if (!res.ok) return res;
    return res.value ? ok(res.value) : err('not_found', 'That event is no longer on the calendar.');
  }

  async insertEvent(
    calendarId: string,
    body: GCalEventWrite,
    options: GCalWriteOptions,
  ): Promise<Result<GCalEvent>> {
    const params = writeParams(options);
    const res = await this.request<GCalEvent>(`/calendars/${enc(calendarId)}/events?${params}`, {
      method: 'POST',
      body,
    });
    if (!res.ok) return res;
    return res.value ? ok(res.value) : err('provider_unavailable', 'Google sent no event back.');
  }

  async patchEvent(
    calendarId: string,
    eventId: string,
    body: GCalEventWrite,
    options: GCalWriteOptions,
  ): Promise<Result<GCalEvent>> {
    const params = writeParams(options);
    const res = await this.request<GCalEvent>(
      `/calendars/${enc(calendarId)}/events/${enc(eventId)}?${params}`,
      { method: 'PATCH', body },
    );
    if (!res.ok) return res;
    return res.value ? ok(res.value) : err('provider_unavailable', 'Google sent no event back.');
  }

  async moveEvent(
    calendarId: string,
    eventId: string,
    destinationId: string,
    options: { sendUpdates: SendUpdates },
  ): Promise<Result<GCalEvent>> {
    const params = new URLSearchParams({
      destination: destinationId,
      sendUpdates: options.sendUpdates,
    });
    const res = await this.request<GCalEvent>(
      `/calendars/${enc(calendarId)}/events/${enc(eventId)}/move?${params.toString()}`,
      { method: 'POST' },
    );
    if (!res.ok) return res;
    return res.value ? ok(res.value) : err('provider_unavailable', 'Google sent no event back.');
  }

  async deleteEvent(
    calendarId: string,
    eventId: string,
    options: { sendUpdates: SendUpdates },
  ): Promise<Result<true>> {
    const params = new URLSearchParams({ sendUpdates: options.sendUpdates });
    const res = await this.request<null>(
      `/calendars/${enc(calendarId)}/events/${enc(eventId)}?${params.toString()}`,
      { method: 'DELETE' },
    );
    return res.ok ? ok(true) : res;
  }
}

/**
 * sendUpdates always, conferenceDataVersion only when a Meet link is asked
 * for, eventLabelVersion only on a label write (it would turn a colorId off).
 */
export function writeParams(options: GCalWriteOptions): string {
  const params = new URLSearchParams({ sendUpdates: options.sendUpdates });
  if (options.conferenceDataVersion === 1) params.set('conferenceDataVersion', '1');
  if (options.eventLabelVersion === 1) params.set('eventLabelVersion', EVENT_LABEL_VERSION);
  return params.toString();
}

function toRawEvent(event: GoogleEvent): RawCalendarEvent {
  const allDay = Boolean(event.start?.date && !event.start?.dateTime);
  const startsAt = event.start?.dateTime ?? `${event.start?.date ?? ''}T00:00:00.000Z`;
  const endsAt = event.end?.dateTime ?? `${event.end?.date ?? ''}T00:00:00.000Z`;
  return {
    providerEventId: event.id,
    title: event.summary ?? '(no title)',
    description: event.description ?? null,
    location: event.location ?? null,
    startsAt,
    endsAt,
    allDay,
    attendees: (event.attendees ?? [])
      .filter((a) => a.email)
      .map((a) => ({
        name: a.displayName ?? null,
        email: (a.email ?? '').toLowerCase(),
        response: a.responseStatus ?? null,
      })),
    organizerEmail: event.organizer?.email?.toLowerCase() ?? null,
    isPrivate: event.visibility === 'private',
  };
}

/* ------------------------------------------------------------------ mock */

/**
 * Fixtures for the Today sync, and the in-memory mock calendar for the new
 * views (lib/calendar/mock-calendar.ts): the demo's shared one unless a test
 * hands in its own.
 */
export class MockCalendarProvider implements CalendarProvider {
  readonly kind = 'mock' as const;

  constructor(
    private readonly now: Date = new Date(),
    private readonly state: MockCalendarState = sharedMockCalendar(),
  ) {}

  /** The mock's state: its calendars, events and the record of every write. */
  get calendar(): MockCalendarState {
    return this.state;
  }

  async listEvents(options: ListEventsOptions): Promise<Result<ListEventsResult>> {
    const db = buildDemoDb(this.now);
    const min = Date.parse(options.timeMin);
    const max = Date.parse(options.timeMax);
    const events = db.calendar_events
      .filter((e) => {
        const start = Date.parse(e.starts_at);
        return start >= min && start <= max;
      })
      .map((e) => ({
        providerEventId: e.provider_event_id,
        title: e.title,
        description: e.description,
        location: e.location,
        startsAt: e.starts_at,
        endsAt: e.ends_at,
        allDay: e.all_day,
        attendees: e.attendees,
        organizerEmail: e.organizer_email,
        isPrivate: e.is_private,
      }));
    return ok({ events, nextCursor: 'demo-calendar-cursor' });
  }

  async listCalendars(): Promise<Result<GCalListEntry[]>> {
    this.state.reads.push({ op: 'calendars' });
    return ok(structuredClone(this.state.calendars));
  }

  async getColors(): Promise<Result<GCalColors>> {
    this.state.reads.push({ op: 'colors' });
    return ok(structuredClone(this.state.colors));
  }

  async getCalendar(calendarId: string): Promise<Result<GCalCalendar>> {
    const id = resolveCalendarId(this.state, calendarId);
    this.state.reads.push({ op: 'calendar', calendarId: id ?? calendarId });
    const entry = id ? this.state.calendars.find((c) => c.id === id) : null;
    if (!id || !entry) return err('not_found', 'That calendar is not on the list.');
    const labels = this.state.labels.get(id);
    return ok({
      id,
      summary: entry.summary,
      timeZone: entry.timeZone,
      ...(labels ? { labelProperties: { eventLabels: structuredClone(labels) } } : {}),
    });
  }

  async listRange(calendarId: string, range: RangeOptions): Promise<Result<GCalEvent[]>> {
    const id = resolveCalendarId(this.state, calendarId);
    this.state.reads.push({ op: 'range', calendarId: id ?? calendarId });
    if (!id) return err('not_found', 'That calendar is not on the list.');
    return ok(mockListRange(this.state, id, range.timeMin, range.timeMax));
  }

  async getEvent(calendarId: string, eventId: string): Promise<Result<GCalEvent>> {
    const id = resolveCalendarId(this.state, calendarId);
    this.state.reads.push({ op: 'get', calendarId: id ?? calendarId });
    const found = id ? locate(this.state, id, eventId) : null;
    return found
      ? ok(structuredClone(found.event))
      : err('not_found', 'That event is no longer on the calendar.');
  }

  private record(
    op: 'insert' | 'patch' | 'move' | 'delete',
    calendarId: string,
    eventId: string | null,
    options: { sendUpdates: SendUpdates; conferenceDataVersion?: 0 | 1; eventLabelVersion?: 0 | 1 },
    body: GCalEventWrite | null,
    destinationId?: string,
  ) {
    this.state.writes.push({
      op,
      calendarId,
      eventId,
      ...(destinationId ? { destinationId } : {}),
      sendUpdates: options.sendUpdates,
      conferenceDataVersion: options.conferenceDataVersion ?? 0,
      eventLabelVersion: options.eventLabelVersion ?? 0,
      body: body ? structuredClone(body) : null,
      at: new Date().toISOString(),
    });
  }

  async insertEvent(
    calendarId: string,
    body: GCalEventWrite,
    options: GCalWriteOptions,
  ): Promise<Result<GCalEvent>> {
    const id = resolveCalendarId(this.state, calendarId);
    if (!id) return err('not_found', 'That calendar is not on the list.');
    this.record('insert', id, null, options, body);
    const eventId = newMockEventId(this.state);
    let event = applyPatch(
      {
        id: eventId,
        status: 'confirmed',
        eventType: 'default',
        htmlLink: `https://calendar.google.com/calendar/event?eid=${eventId}`,
        organizer: { email: id, self: true },
        creator: { email: id, self: true },
      },
      asGoogleTakesIt(body, options),
    );
    if (options.conferenceDataVersion !== 1) delete event.conferenceData;
    else event = fulfilConference(event, this.state);
    const list = this.state.events.get(id) ?? [];
    list.push(event);
    this.state.events.set(id, list);
    return ok(structuredClone(event));
  }

  async patchEvent(
    calendarId: string,
    eventId: string,
    body: GCalEventWrite,
    options: GCalWriteOptions,
  ): Promise<Result<GCalEvent>> {
    const id = resolveCalendarId(this.state, calendarId);
    const found = id ? locate(this.state, id, eventId) : null;
    if (!id || !found) return err('not_found', 'That event is no longer on the calendar.');
    this.record('patch', id, eventId, options, body);
    let next = applyPatch(found.event, asGoogleTakesIt(body, options));
    if (options.conferenceDataVersion === 1 && body.conferenceData) {
      next = fulfilConference(next, this.state);
    }
    if (found.kind === 'single') {
      found.list.splice(found.list.indexOf(found.event), 1, next);
    } else if (found.kind === 'series') {
      found.series.master = next;
    } else {
      found.series.exceptions.set(eventId, next);
    }
    return ok(structuredClone(next));
  }

  async moveEvent(
    calendarId: string,
    eventId: string,
    destinationId: string,
    options: { sendUpdates: SendUpdates },
  ): Promise<Result<GCalEvent>> {
    const id = resolveCalendarId(this.state, calendarId);
    const destination = resolveCalendarId(this.state, destinationId);
    const found = id ? locate(this.state, id, eventId) : null;
    if (!id || !destination || !found) {
      return err('not_found', 'That event or calendar is no longer there.');
    }
    if (found.kind === 'instance') {
      return err('invalid_input', 'One event of a series cannot move to another calendar.');
    }
    this.record('move', id, eventId, options, null, destination);
    const moved = { ...found.event, organizer: { email: destination, self: true } };
    if (found.kind === 'single') {
      found.list.splice(found.list.indexOf(found.event), 1);
      const target = this.state.events.get(destination) ?? [];
      target.push(moved);
      this.state.events.set(destination, target);
    } else {
      found.seriesList.splice(found.seriesList.indexOf(found.series), 1);
      const target = this.state.series.get(destination) ?? [];
      target.push({ master: moved, exceptions: found.series.exceptions });
      this.state.series.set(destination, target);
    }
    return ok(structuredClone(moved));
  }

  async deleteEvent(
    calendarId: string,
    eventId: string,
    options: { sendUpdates: SendUpdates },
  ): Promise<Result<true>> {
    const id = resolveCalendarId(this.state, calendarId);
    const found = id ? locate(this.state, id, eventId) : null;
    if (!id || !found) return err('not_found', 'That event is no longer on the calendar.');
    this.record('delete', id, eventId, options, null);
    if (found.kind === 'single') found.list.splice(found.list.indexOf(found.event), 1);
    else if (found.kind === 'series')
      found.seriesList.splice(found.seriesList.indexOf(found.series), 1);
    else found.series.exceptions.set(eventId, 'cancelled');
    return ok(true);
  }
}

/**
 * What Google applies of a write: conference data only with
 * conferenceDataVersion=1; eventLabelId only with eventLabelVersion=1, which
 * makes it ignore colorId instead.
 */
function asGoogleTakesIt(body: GCalEventWrite, options: GCalWriteOptions): GCalEventWrite {
  const out: GCalEventWrite = { ...body };
  if (options.conferenceDataVersion !== 1) out.conferenceData = undefined;
  if (options.eventLabelVersion === 1) out.colorId = undefined;
  else out.eventLabelId = undefined;
  return out;
}

/** A Meet request id: unique per create, as Google asks. */
export function newRequestId(): string {
  return newId();
}
