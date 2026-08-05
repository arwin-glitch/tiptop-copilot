import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { buildDemoDb } from '@/lib/demo/fixtures';
import { getAccessToken } from '@/lib/google/oauth';
import { log } from '@/lib/security/redact';
import type { Integration } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/** Calendar provider seam. Read-only by construction — there is no write method. */

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

export interface CalendarProvider {
  readonly kind: 'google' | 'mock';
  listEvents(options: ListEventsOptions): Promise<Result<ListEventsResult>>;
}

/* ---------------------------------------------------------------- google */

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

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

export class GoogleCalendarProvider implements CalendarProvider {
  readonly kind = 'google' as const;

  constructor(
    private readonly store: DataStore,
    private readonly integration: Integration,
  ) {}

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

export class MockCalendarProvider implements CalendarProvider {
  readonly kind = 'mock' as const;

  constructor(private readonly now: Date = new Date()) {}

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
}
