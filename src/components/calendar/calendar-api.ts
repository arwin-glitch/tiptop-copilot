import type { EventDraft, GuestChoice, RecurringScope } from '@/lib/calendar/edit-rules';
import type { RsvpResponse } from '@/lib/calendar/event-actions';
import type { GCalDateTime } from '@/lib/calendar/google-types';
import type { CalendarRangeData, CalendarViewKind, RangeEvent } from '@/lib/calendar/range-types';

/**
 * The Calendar tab's calls to its own routes. Every change names `notify`;
 * the page sends 'send' only after the person chose Send in the guests prompt.
 */

export type ApiResult<T> = { ok: true; value: T } | { ok: false; message: string };

async function call<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const json = (await res.json().catch(() => null)) as
      ({ ok?: boolean; error?: { message?: string } } & Record<string, unknown>) | null;
    if (!res.ok || !json?.ok) {
      return { ok: false, message: json?.error?.message ?? 'Something went wrong. Try again.' };
    }
    return { ok: true, value: json as T };
  } catch {
    return { ok: false, message: 'Copilot could not be reached. Check the connection.' };
  }
}

export async function fetchRange(
  from: string,
  to: string,
  calendarIds: readonly string[],
): Promise<ApiResult<CalendarRangeData>> {
  // No calendars shown is an empty read; the list and the palette still arrive.
  const params = new URLSearchParams({ from, to, calendars: calendarIds.join(',') });
  const res = await call<{ data: CalendarRangeData }>('GET', `/api/calendar/range?${params}`);
  return res.ok ? { ok: true, value: res.value.data } : res;
}

export interface WriteAnswer {
  event: RangeEvent | null;
  reload: boolean;
}

export function createEvent(calendarId: string, draft: EventDraft, notify: GuestChoice) {
  return call<WriteAnswer>('POST', '/api/calendar/events', { calendarId, draft, notify });
}

export function updateEvent(input: {
  calendarId: string;
  eventId: string;
  scope: RecurringScope;
  notify: GuestChoice;
  changes: Partial<EventDraft>;
  destinationCalendarId?: string | null;
}) {
  return call<WriteAnswer>('PATCH', '/api/calendar/events', input);
}

export function deleteEvent(input: {
  calendarId: string;
  eventId: string;
  scope: RecurringScope;
  notify: GuestChoice;
}) {
  return call<WriteAnswer>('DELETE', '/api/calendar/events', input);
}

/** Going? Yes / No / Maybe. `notify` is 'send' only after Send in the organizer question. */
export function respondToEvent(input: {
  calendarId: string;
  eventId: string;
  scope: RecurringScope;
  response: RsvpResponse;
  notify: GuestChoice;
}) {
  return call<WriteAnswer>('PATCH', '/api/calendar/events', { kind: 'respond', ...input });
}

/** An event colour from the card: colorId alone, never an email. */
export function recolorEvent(input: {
  calendarId: string;
  eventId: string;
  scope: RecurringScope;
  colorId: string | null;
}) {
  return call<WriteAnswer>('PATCH', '/api/calendar/events', { kind: 'color', ...input });
}

/** A repeating event's rule, for the card's "Weekly on Monday". */
export function fetchSeries(calendarId: string, eventId: string) {
  const params = new URLSearchParams({ calendarId, eventId });
  return call<{ recurrence: string[]; start: GCalDateTime | null }>(
    'GET',
    `/api/calendar/series?${params}`,
  );
}

export function savePrefs(patch: {
  preview?: boolean;
  view?: CalendarViewKind;
  shown?: Record<string, boolean>;
}) {
  return call<{ prefs: unknown }>('POST', '/api/calendar/prefs', patch);
}

export interface MeetingContext {
  dossier: {
    oneThing: string | null;
    howYouGotHere: string | null;
    worthAsking: string[];
  } | null;
  prep: string | null;
  recent: { id: string; subject: string; at: string | null }[];
}

export function fetchContext(eventId: string, date: string) {
  const params = new URLSearchParams({ eventId, date });
  return call<{ found: boolean; context?: MeetingContext }>(
    'GET',
    `/api/calendar/context?${params}`,
  );
}

export function fetchGuests(q: string) {
  const params = new URLSearchParams({ q });
  return call<{ people: { name: string; email: string; company: string | null }[] }>(
    'GET',
    `/api/calendar/guests?${params}`,
  );
}
