import 'server-only';
import { isDemoMode } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { getCalendarProvider } from '@/lib/runtime';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import type { Integration } from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { ok, type Result } from '@/lib/util/result';
import { startOfDayUtc } from '@/lib/util/time';
import { calendarColor, eventColor, eventPalette } from './colors';
import { isWritableRole, meetLinkOf, modifyRule } from './edit-rules';
import { ownAttendeeIndex, respondRule } from './event-actions';
import type { GCalColors, GCalEvent, GCalListEntry } from './google-types';
import { findLabel, toEventLabels } from './labels';
import {
  classifyMeeting,
  HOLD_TITLE,
  isInPerson,
  physicalLocation,
  toMeetingEvent,
} from './meetings';
import type { CalendarProvider } from './provider';
import {
  eventKey,
  visibleCalendarIds,
  type CalendarInfo,
  type CalendarRangeData,
  type EventLabel,
  type RangeEvent,
} from './range-types';

/**
 * The Calendar views' reader: any date range, past or future, on any of
 * the account's calendars, with Google's own names and colours, and the same
 * Meeting/Block verdict Today and the meeting pings give (it runs
 * classifyMeeting on the same mapped event, toMeetingEvent).
 *
 * One events.list per visible calendar per range (all pages, single events,
 * so recurring series arrive as their instances), cancelled events left out
 * as Google leaves them out of the day reader's read. The calendar list and the
 * colours are cached for minutes, a range for a minute, per organization, and
 * a write from the Calendar tab drops what it changed (invalidateCalendarCache).
 *
 * Google's colour labels (D-070): each calendar read also reads that
 * calendar's labels (calendars.get, eventLabelVersion=1), cached for under a
 * minute so a label renamed or added in Google shows here within a minute,
 * and never stored. Events are read with eventLabelVersion=1 too, so each
 * carries its eventLabelId; its colour is then its label's. A calendar whose
 * labels cannot be read just shows none: the range still draws.
 *
 * It never writes. The day reader (calendar-view.ts, for Today and the card's
 * context) and the pings (listMeetingEvents) keep their own reads; the parity
 * check compares them.
 */

const CALENDARS_TTL_MS = 5 * 60_000;
const COLORS_TTL_MS = 6 * 60 * 60_000;
const RANGE_TTL_MS = 60_000;
/** Under a minute: a label renamed or added in Google shows here within one. */
export const LABELS_TTL_MS = 45_000;
const MAX_RANGE_DAYS = 62;

interface Cached<T> {
  at: number;
  value: T;
}

const cache = processWide('calendar-range-cache', () => ({
  calendars: new Map<string, Cached<GCalListEntry[]>>(),
  colors: new Map<string, Cached<GCalColors>>(),
  ranges: new Map<string, Cached<GCalEvent[]>>(),
  labels: new Map<string, Cached<EventLabel[]>>(),
  /**
   * Per organization, bumped by every invalidation: a read that started
   * before one never stores its (older) answer after it.
   */
  generations: new Map<string, number>(),
}));

const generationOf = (key: string) => cache.generations.get(key.split('|')[0] ?? '') ?? 0;

/** Test hook. */
export function resetCalendarRangeCache(): void {
  cache.calendars.clear();
  cache.colors.clear();
  cache.ranges.clear();
  cache.labels.clear();
  cache.generations.clear();
}

/** After a write: the calendar list and every range of the calendars it touched. */
export function invalidateCalendarCache(organizationId: string, calendarIds?: string[]): void {
  cache.generations.set(organizationId, (cache.generations.get(organizationId) ?? 0) + 1);
  cache.calendars.delete(organizationId);
  // Labels are not changed by any write here; they expire on their own within a minute.
  for (const key of [...cache.ranges.keys()]) {
    const [org, calendarId] = key.split('|');
    if (org !== organizationId) continue;
    if (!calendarIds || calendarIds.includes(calendarId ?? '')) cache.ranges.delete(key);
  }
}

/**
 * A read through the cache. `fresh` skips a cached answer (the booking
 * link's check before it books, D-078) but still stores the new one. An
 * answer is never stored once the organization's cache was invalidated
 * after the read began: it may predate the write that invalidated it.
 */
async function cached<T>(
  map: Map<string, Cached<T>>,
  key: string,
  ttl: number,
  use: boolean,
  load: () => Promise<Result<T>>,
  now: number,
  fresh = false,
): Promise<Result<T>> {
  if (use && !fresh) {
    const hit = map.get(key);
    if (hit && now - hit.at < ttl) return ok(hit.value);
  }
  const generation = generationOf(key);
  const loaded = await load();
  if (loaded.ok && use && generationOf(key) === generation) {
    map.set(key, { at: now, value: loaded.value });
  }
  return loaded;
}

/** Google's calendar list as the views show it: primary first, then writable, then the rest. */
export function toCalendarInfos(
  entries: readonly GCalListEntry[],
  colors: GCalColors | null,
): CalendarInfo[] {
  const group = (c: CalendarInfo) => (c.primary ? 0 : c.writable ? 1 : 2);
  return entries
    .filter((e) => !e.hidden && !e.deleted)
    .map((e): CalendarInfo => ({
      id: e.id,
      name: e.summaryOverride?.trim() || e.summary?.trim() || e.id,
      primary: Boolean(e.primary),
      accessRole: e.accessRole ?? 'reader',
      writable: isWritableRole(e.accessRole),
      color: calendarColor(e, colors),
      selectedInGoogle: Boolean(e.selected) || Boolean(e.primary && e.selected !== false),
      timeZone: e.timeZone ?? null,
      // Read with a range, for the calendars shown (readCalendarLabels).
      labels: [],
    }))
    .sort((a, b) => group(a) - group(b) || a.name.localeCompare(b.name));
}

/** One Google event as the views draw it, with Copilot's verdict on it. */
export function toRangeEvent(
  google: GCalEvent,
  calendar: Pick<CalendarInfo, 'id' | 'accessRole' | 'color'> &
    Partial<Pick<CalendarInfo, 'labels'>>,
  colors: GCalColors | null,
  ownEmails: readonly string[],
): RangeEvent {
  const labelId = google.eventLabelId?.trim() || null;
  const label = findLabel(calendar.labels, labelId);
  const meeting = toMeetingEvent(google);
  const verdict = classifyMeeting(meeting, ownEmails);
  const busyOnly = calendar.accessRole === 'freeBusyReader' && !google.summary;
  const title = busyOnly ? 'Busy' : meeting.title;
  const inPerson = isInPerson(meeting);
  const rule = modifyRule(google, calendar.accessRole);
  const answer = respondRule(google, calendar.accessRole, ownEmails);
  const mine = google.attendees?.[ownAttendeeIndex(google.attendees, ownEmails)];
  const allDay = meeting.allDay;
  return {
    key: eventKey(calendar.id, google.id),
    id: google.id,
    calendarId: calendar.id,
    recurringEventId: google.recurringEventId ?? null,
    title,
    allDay,
    startsAt: allDay ? null : (google.start?.dateTime ?? null),
    endsAt: allDay ? null : (google.end?.dateTime ?? null),
    startDate: allDay ? (google.start?.date ?? null) : null,
    endDate: allDay ? (google.end?.date ?? null) : null,
    timeZone: google.start?.timeZone ?? null,
    location: meeting.location,
    place: inPerson ? physicalLocation(meeting) : null,
    description: meeting.description,
    joinUrl: httpsOnly(meeting.joinUrl),
    meetUrl: httpsOnly(meetLinkOf(google)),
    meetPending: google.conferenceData?.createRequest?.status?.statusCode === 'pending',
    colorId: google.colorId ?? null,
    labelId,
    label,
    color: eventColor(google.colorId, calendar.color, colors, label),
    organizer: meeting.organizer
      ? {
          email: meeting.organizer.email,
          name: meeting.organizer.name ?? null,
          self: meeting.organizer.self,
        }
      : null,
    attendees: (google.attendees ?? [])
      .filter((a) => a.email)
      .map((a) => ({
        email: a.email!.toLowerCase(),
        name: a.displayName?.trim() || null,
        response: a.responseStatus ?? null,
        self: Boolean(a.self),
        resource: Boolean(a.resource) || /resource\.calendar\.google\.com$/.test(a.email!),
        organizer: Boolean(a.organizer),
        optional: Boolean(a.optional),
      })),
    guestsCanModify: Boolean(google.guestsCanModify),
    canModify: rule.canModify,
    readOnlyReason: rule.reason,
    canRespond: answer.canRespond,
    myResponse: mine?.responseStatus ?? null,
    attachments: (google.attachments ?? []).flatMap((a) => {
      const url = httpsOnly(a.fileUrl);
      return url
        ? [{ title: a.title?.trim() || 'Attachment', url, mimeType: a.mimeType ?? null }]
        : [];
    }),
    verdict: { meeting: verdict.meeting, reason: verdict.reason, with: verdict.with },
    hold: !verdict.meeting && HOLD_TITLE.test(title),
    inPerson,
    transparent: meeting.transparent,
    eventType: meeting.eventType,
    htmlLink: httpsOnly(google.htmlLink),
  };
}

/** A link the page may open: https only, whatever an invite carried. */
function httpsOnly(url: string | null | undefined): string | null {
  return url && /^https:\/\/[^\s"<>]+$/i.test(url) ? url : null;
}

export interface CalendarSource {
  provider: CalendarProvider;
  integration: Integration | null;
  ownEmails: string[];
  /** Demo mode: the in-memory mock calendar, which nothing outside this server sees. */
  demo: boolean;
}

/**
 * Where the views read from: the demo's mock calendar, or the connected
 * Google account. Null with a state when there is nothing to read.
 */
export async function calendarSource(
  store: DataStore,
  organizationId: string,
  ownEmail: string,
): Promise<{ ok: true; source: CalendarSource } | { ok: false; state: 'not_connected' }> {
  if (isDemoMode()) {
    const provider = getCalendarProvider(null);
    if (!provider) return { ok: false, state: 'not_connected' };
    return {
      ok: true,
      source: { provider, integration: null, ownEmails: [ownEmail], demo: true },
    };
  }
  const integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
  if (!integration || integration.status === 'disconnected') {
    return { ok: false, state: 'not_connected' };
  }
  const provider = getCalendarProvider(integration);
  if (!provider) return { ok: false, state: 'not_connected' };
  return {
    ok: true,
    source: {
      provider,
      integration,
      // The same "Nick" the day reader classifies against.
      ownEmails: [integration.account_email ?? ownEmail].filter(Boolean),
      demo: false,
    },
  };
}

/** The calendar list and colours, through the cache. */
export async function readCalendarList(
  source: CalendarSource,
  organizationId: string,
  now = Date.now(),
  options: { fresh?: boolean } = {},
): Promise<Result<{ calendars: CalendarInfo[]; colors: GCalColors | null }>> {
  const use = source.provider.kind === 'google';
  const [list, colors] = await Promise.all([
    cached(
      cache.calendars,
      organizationId,
      CALENDARS_TTL_MS,
      use,
      () => source.provider.listCalendars(),
      now,
      options.fresh,
    ),
    cached(
      cache.colors,
      organizationId,
      COLORS_TTL_MS,
      use,
      () => source.provider.getColors(),
      now,
    ),
  ]);
  if (!list.ok) return list;
  const palette = colors.ok ? colors.value : null;
  return ok({ calendars: toCalendarInfos(list.value, palette), colors: palette });
}

/**
 * One calendar's colour labels, through a cache of under a minute (never
 * stored). A failed read is no labels: the calendar still draws, in Google's
 * colours.
 */
export async function readCalendarLabels(
  source: CalendarSource,
  organizationId: string,
  calendarId: string,
  now = Date.now(),
): Promise<EventLabel[]> {
  const use = source.provider.kind === 'google';
  const read = await cached(
    cache.labels,
    `${organizationId}|${calendarId}`,
    LABELS_TTL_MS,
    use,
    async () => {
      const calendar = await source.provider.getCalendar(calendarId);
      return calendar.ok ? ok(toEventLabels(calendar.value)) : calendar;
    },
    now,
  ).catch(() => null);
  return read?.ok ? read.value : [];
}

/** The calendars with the labels read for the ones named. */
export function withLabels(
  calendars: readonly CalendarInfo[],
  labels: ReadonlyMap<string, EventLabel[]>,
): CalendarInfo[] {
  return calendars.map((c) => (labels.has(c.id) ? { ...c, labels: labels.get(c.id)! } : c));
}

/** One calendar's events in a range, through the cache. */
export async function readRangeEvents(
  source: CalendarSource,
  organizationId: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
  now = Date.now(),
  options: { fresh?: boolean } = {},
): Promise<Result<GCalEvent[]>> {
  const use = source.provider.kind === 'google';
  return cached(
    cache.ranges,
    `${organizationId}|${calendarId}|${timeMin}|${timeMax}`,
    RANGE_TTL_MS,
    use,
    () => source.provider.listRange(calendarId, { timeMin, timeMax }),
    now,
    options.fresh,
  );
}

export interface ReadRangeOptions {
  /** First day, `YYYY-MM-DD` in the profile's zone. */
  from: string;
  /** The day after the last, exclusive. */
  to: string;
  timeZone: string;
  ownEmail: string;
  /** The person's own toggles; calendars not in it follow Google's tick. */
  shown?: Readonly<Record<string, boolean>>;
  /** Read these calendars rather than the visible ones (still only ones on the list). */
  calendarIds?: readonly string[];
  /** Tests: read from this source instead of the runtime's. */
  source?: CalendarSource;
  now?: number;
  /** Past the cache: Google is asked again (the booking link's check before it books). */
  fresh?: boolean;
}

export async function readCalendarRange(
  store: DataStore,
  organizationId: string,
  options: ReadRangeOptions,
): Promise<CalendarRangeData> {
  const { from, to, timeZone } = options;
  const empty = (state: CalendarRangeData['state'], message?: string): CalendarRangeData => ({
    state,
    ...(message ? { message } : {}),
    from,
    to,
    timeZone,
    calendars: [],
    loaded: [],
    failed: [],
    palette: [],
    events: [],
  });
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (!(days >= 1 && days <= MAX_RANGE_DAYS)) {
    return empty('error', `Pick a range of 1 to ${MAX_RANGE_DAYS} days.`);
  }

  let source = options.source;
  if (!source) {
    const found = await calendarSource(store, organizationId, options.ownEmail);
    if (!found.ok) return empty(found.state);
    source = found.source;
  }

  const now = options.now ?? Date.now();
  const fresh = { fresh: options.fresh === true };
  const list = await readCalendarList(source, organizationId, now, fresh);
  if (!list.ok) return empty('error', list.error.message);
  const { calendars, colors } = list.value;

  const onList = new Set(calendars.map((c) => c.id));
  const ids = options.calendarIds
    ? options.calendarIds.filter((id) => onList.has(id))
    : visibleCalendarIds(calendars, options.shown ?? {});

  const timeMin = startOfDayUtc(from, timeZone).toISOString();
  const timeMax = startOfDayUtc(to, timeZone).toISOString();
  const reads = await Promise.all(
    ids.map(async (calendarId) => {
      const [read, labels] = await Promise.all([
        readRangeEvents(source, organizationId, calendarId, timeMin, timeMax, now, fresh),
        readCalendarLabels(source, organizationId, calendarId, now),
      ]);
      return { calendarId, read, labels };
    }),
  );
  const labelled = withLabels(
    calendars,
    new Map(reads.map((r) => [r.calendarId, r.labels] as const)),
  );
  const byId = new Map(labelled.map((c) => [c.id, c]));

  const events: RangeEvent[] = [];
  const failed: CalendarRangeData['failed'] = [];
  for (const { calendarId, read } of reads) {
    if (!read.ok) {
      failed.push({ calendarId, message: read.error.message });
      continue;
    }
    const calendar = byId.get(calendarId)!;
    for (const google of read.value) {
      if (google.status === 'cancelled' || !google.id) continue;
      events.push(toRangeEvent(google, calendar, colors, source.ownEmails));
    }
  }
  events.sort(
    (a, b) =>
      (a.startsAt ?? `${a.startDate}T00:00:00Z`).localeCompare(
        b.startsAt ?? `${b.startDate}T00:00:00Z`,
      ) || a.key.localeCompare(b.key),
  );

  return {
    state: 'ok',
    from,
    to,
    timeZone,
    calendars: labelled,
    loaded: reads.filter((r) => r.read.ok).map((r) => r.calendarId),
    failed,
    palette: eventPalette(colors),
    events,
  };
}

/** The account's main calendar on the list, for the parity check and the context box. */
export function primaryCalendar(calendars: readonly CalendarInfo[]): CalendarInfo | null {
  return calendars.find((c) => c.primary) ?? null;
}
