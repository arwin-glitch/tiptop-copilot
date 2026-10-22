import 'server-only';
import { isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { EMPTY_GUEST_COUNTS, type GuestCounts } from '@/lib/events/contracts';
import {
  nextActions,
  readinessChecklist,
  type NextAction,
  type ReadyItem,
} from '@/lib/events/tab-view';
import { log } from '@/lib/security/redact';
import { eventMessagesSummary, type EventMessagesSummary } from '@/lib/services/event-comms';
import { guestCounts } from '@/lib/services/event-guests';
import { getEventSessions } from '@/lib/services/events';
import type { EventRecord, EventSession } from '@/lib/types/domain';

/**
 * The Events tab's reads beyond the event row (D-075, WS5): an event's
 * Overview (the Ready checklist, next actions, the headcount), the library's
 * activity dots, and Today's one line per event. Reads only, and none of them
 * throws: a fault leaves a quieter page, never a broken one.
 */

/** A light read of the draft page: enough for the checklist, without the full schema. */
export function draftFacts(event: Pick<EventRecord, 'draft_doc'>): {
  sectionCount: number;
  hasRsvpBlock: boolean;
  seoDescription: string;
  sectionTypes: string[];
} {
  const doc = (event.draft_doc ?? {}) as {
    sections?: { type?: unknown }[];
    meta?: { seoDescription?: unknown };
  };
  const sections = Array.isArray(doc.sections) ? doc.sections : [];
  const types = sections.map((s) => (typeof s?.type === 'string' ? s.type : 'unknown'));
  return {
    sectionCount: sections.length,
    hasRsvpBlock: types.includes('rsvp'),
    seoDescription: typeof doc.meta?.seoDescription === 'string' ? doc.meta.seoDescription : '',
    sectionTypes: types,
  };
}

/** Changes outside editors made since the last publish (event_edits by a 'g:' actor). */
export async function outsideEditsSincePublish(
  store: DataStore,
  organizationId: string,
  event: Pick<EventRecord, 'id' | 'published_draft_version'>,
): Promise<number> {
  try {
    const edits = await store.list(
      'event_edits',
      organizationId,
      { eq: { event_id: event.id }, gt: { draft_version: event.published_draft_version } },
      { limit: 2000 },
    );
    return edits.filter((e) => e.actor_key.startsWith('g:')).length;
  } catch (error) {
    if (!isMissingTableError(error)) {
      log.warn('Reading outside edits failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return 0;
  }
}

export interface SessionHeadcount {
  id: string;
  name: string;
  going: number;
  capacity: number | null;
  checkedIn: number;
}

/** Going and checked in per session, for the Overview tiles. */
export async function sessionHeadcounts(
  store: DataStore,
  organizationId: string,
  eventId: string,
  sessions: readonly EventSession[],
): Promise<SessionHeadcount[]> {
  let rows: { session_id: string; status: string; checked_in_at: string | null }[] = [];
  try {
    rows = await store.list('event_guest_sessions', organizationId, { eq: { event_id: eventId } });
  } catch (error) {
    if (!isMissingTableError(error)) {
      log.warn('Reading session headcounts failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return sessions.map((s) => {
    const mine = rows.filter((r) => r.session_id === s.id);
    return {
      id: s.id,
      name: s.name,
      going: mine.filter((r) => r.status === 'going').length,
      capacity: s.capacity,
      checkedIn: mine.filter((r) => r.checked_in_at).length,
    };
  });
}

export interface EventOverview {
  counts: GuestCounts;
  headcounts: SessionHeadcount[];
  checklist: ReadyItem[];
  ready: number;
  actions: NextAction[];
  messages: EventMessagesSummary;
  outsideEdits: number;
  unpublishedChanges: number;
}

/** Everything Overview shows for one event. */
export async function eventOverview(
  store: DataStore,
  organizationId: string,
  event: EventRecord,
  sessions: readonly EventSession[],
  now: Date = new Date(),
): Promise<EventOverview> {
  const [countsByEvent, headcounts, messages, outsideEdits] = await Promise.all([
    guestCounts(store, organizationId, [event.id]),
    sessionHeadcounts(store, organizationId, event.id, sessions),
    eventMessagesSummary(store, organizationId, event, sessions, now),
    outsideEditsSincePublish(store, organizationId, event),
  ]);
  const counts = countsByEvent[event.id] ?? { ...EMPTY_GUEST_COUNTS };
  const facts = draftFacts(event);
  const unpublishedChanges = event.published_at
    ? Math.max(0, event.draft_version - event.published_draft_version)
    : 0;
  const checklist = readinessChecklist({
    status: event.status,
    access: event.access,
    visibility: event.visibility,
    startsAt: event.starts_at ?? sessions.find((s) => s.starts_at)?.starts_at ?? null,
    venueSet: Boolean(event.venue?.name || event.venue?.address || event.venue?.online_url),
    sessions: sessions.length,
    publishedAt: event.published_at,
    unpublishedChanges,
    sectionCount: facts.sectionCount,
    hasRsvpBlock: facts.hasRsvpBlock,
    registrationOpen: event.registration?.open ?? false,
    guests: counts.total,
    invitesSent: messages.invitesSent,
    invitesDrafted: messages.invitesDrafted,
    reminderOffsets: event.comms?.reminder_offsets_minutes?.length ?? 0,
    seoDescription: facts.seoDescription,
  });
  const actions = nextActions({
    eventId: event.id,
    status: event.status,
    pending: counts.pending,
    needsNotifying: messages.needsNotifying,
    remindersReady: messages.remindersReady,
    outsideEdits,
    unpublishedChanges,
    updateFor: messages.updateFor,
    cancellationFor: messages.cancellationFor,
    firstOpenItem: checklist.find((i) => !i.done) ?? null,
  });
  return {
    counts,
    headcounts,
    checklist,
    ready: checklist.filter((i) => i.done).length,
    actions,
    messages,
    outsideEdits,
    unpublishedChanges,
  };
}

/**
 * The latest guest activity per event (a registration or any change to a
 * guest), for the library's unseen-activity dot. The browser keeps when each
 * event was last opened; this is the other half.
 */
export async function latestGuestActivity(
  store: DataStore,
  organizationId: string,
  eventIds: readonly string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const id of eventIds) out[id] = null;
  if (!eventIds.length) return out;
  try {
    const guests = await store.list(
      'event_guests',
      organizationId,
      { in: { event_id: [...eventIds] } },
      { limit: 10_000 },
    );
    for (const g of guests) {
      const at = [g.updated_at, g.registered_at]
        .filter((t): t is string => Boolean(t))
        .sort()
        .at(-1);
      if (at && (!out[g.event_id] || at > (out[g.event_id] as string))) out[g.event_id] = at;
    }
  } catch (error) {
    if (!isMissingTableError(error)) {
      log.warn('Reading guest activity failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- Today */

export interface TodayEventPart {
  text: string;
  href: string;
}

export interface TodayEventLine {
  eventId: string;
  title: string;
  href: string;
  parts: TodayEventPart[];
}

/** How far ahead Today looks for events worth a line. */
const TODAY_HORIZON_DAYS = 120;
const TODAY_MAX_LINES = 3;
const TODAY_MAX_CANDIDATES = 12;

/**
 * Today's line per event that wants something from a person:
 * "Harborview Annual Meeting: 3 pending · 2 new · reminder ready · 2 outside
 * edits to publish". Live (or just cancelled) events in the next four months,
 * plus drafts with outside edits waiting. Nothing to do, no line.
 */
export async function todayEventLines(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<TodayEventLine[]> {
  let events: EventRecord[] = [];
  try {
    events = await store.list('events', organizationId, undefined, {
      orderBy: [{ field: 'starts_at', direction: 'asc' }],
      limit: 200,
    });
  } catch (error) {
    if (!isMissingTableError(error)) {
      log.warn('Today could not read events', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return [];
  }
  const horizon = now.getTime() + TODAY_HORIZON_DAYS * 86_400_000;
  const candidates = events.filter((e) => {
    if (e.is_template || e.status === 'archived') return false;
    const end = Date.parse(e.ends_at ?? e.starts_at ?? '');
    const start = Date.parse(e.starts_at ?? '');
    if (Number.isFinite(end) && end < now.getTime() - 86_400_000) return false;
    if (e.status === 'draft') return true;
    return !Number.isFinite(start) || start <= horizon;
  });
  const lines: TodayEventLine[] = [];
  // Soonest first, and only so many looked at: Today must stay quick.
  for (const event of candidates.slice(0, TODAY_MAX_CANDIDATES)) {
    if (lines.length >= TODAY_MAX_LINES) break;
    try {
      const line = await todayLineFor(store, organizationId, event, now);
      if (line) lines.push(line);
    } catch (error) {
      log.warn('Today event line failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return lines;
}

async function todayLineFor(
  store: DataStore,
  organizationId: string,
  event: EventRecord,
  now: Date,
): Promise<TodayEventLine | null> {
  const base = `/events/${event.id}`;
  const outside = await outsideEditsSincePublish(store, organizationId, event);
  const parts: TodayEventPart[] = [];
  if (event.status !== 'draft') {
    const sessions = await getEventSessions(store, organizationId, event.id);
    const [counts, messages] = await Promise.all([
      guestCounts(store, organizationId, [event.id]),
      eventMessagesSummary(store, organizationId, event, sessions.ok ? sessions.value : [], now),
    ]);
    const pending = counts[event.id]?.pending ?? 0;
    if (messages.cancellationFor !== null) {
      parts.push({ text: 'cancellation notice to draft', href: `${base}?tab=messages` });
    }
    if (messages.updateFor !== null) {
      parts.push({ text: 'update notice to draft', href: `${base}?tab=messages` });
    }
    if (pending) parts.push({ text: `${pending} pending`, href: `${base}?tab=guests` });
    if (messages.newRegistrations) {
      parts.push({
        text: `${messages.newRegistrations} new ${messages.newRegistrations === 1 ? 'registration' : 'registrations'}`,
        href: `${base}?tab=guests`,
      });
    }
    if (messages.needsNotifying) {
      parts.push({ text: `${messages.needsNotifying} to notify`, href: `${base}?tab=messages` });
    }
    if (messages.remindersReady) {
      parts.push({
        text:
          messages.remindersReady === 1
            ? 'reminder ready'
            : `${messages.remindersReady} reminders ready`,
        href: `${base}?tab=messages`,
      });
    }
  }
  if (outside) {
    parts.push({
      text: `${outside} outside ${outside === 1 ? 'edit' : 'edits'} to publish`,
      href: `${base}/studio`,
    });
  }
  if (!parts.length) return null;
  return { eventId: event.id, title: event.title, href: base, parts };
}
