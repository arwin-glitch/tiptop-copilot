import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { emailLinkId } from '@/lib/email/thread-links';
import { listThreadPage, readThreadMeta } from '@/lib/google/gmail-inbox';
import {
  checkedWords,
  inboxSearchFor,
  originLineText,
  originTerms,
  rankOrigins,
  type OriginCandidate,
  type OriginEvent,
  type OriginKind,
  type OriginTerms,
} from '@/lib/calendar/origin';
import { log } from '@/lib/security/redact';
import type { CalendarEvent, EmailMessage, Integration, MeetingNote } from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { localDateKey } from '@/lib/util/time';
import { isTeamVisibleNote } from '@/lib/notes/visibility';

/**
 * "How you got here" for an event the guests say nothing about (no other
 * guests, a list or group invite, a registration, a hold): the email that
 * put it on the calendar, found read-only in what Copilot already syncs (the
 * stored mail, meeting notes, earlier events) and, with Gmail connected, one
 * read-only Gmail search. Ranked by lib/calendar/origin.ts; the best one to
 * three are shown as short lines, each with the thread's Copilot and Gmail
 * links. When nothing turns up, it says what was checked and offers the
 * Inbox search. Used by the event card (the retired day list used it too).
 *
 * Cached per event for ten minutes, so opening a card twice reads once.
 */

export interface OriginLine {
  kind: OriginKind;
  /** "Registration email from Harborlight Events, Oct 17". */
  text: string;
  /** An email's subject, shown beside the line. */
  subject: string | null;
  /** An email's link id, for the two-option links (Copilot and Gmail). */
  threadId: string | null;
  /** A meeting note's page, or the day an earlier event was on. */
  href: string | null;
}

export interface EventOrigin {
  lines: OriginLine[];
  /** What was looked for, in plain words: shown when there are no lines. */
  checked: string;
  /** The Inbox search for the event's distinctive words. */
  search: { query: string; href: string };
}

export interface OriginInput extends OriginEvent {
  /** For the cache: the calendar and the event. */
  calendarId: string;
  id: string;
  /** People other than Nick on it (the guests), for the "checked" words. */
  guests: number;
}

const ORIGIN_TTL_MS = 10 * 60_000;
const PER_QUERY = 8;

const cache = processWide(
  'calendar-origin',
  () => new Map<string, { at: number; value: EventOrigin }>(),
);

/** Test hook. */
export function resetOriginCache(): void {
  cache.clear();
}

async function safe<T>(label: string, run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch {
    log.warn('Event origin source failed', { source: label });
    return [];
  }
}

/** The stored mail matching any of the event's terms, newest first. */
async function storedEmails(
  store: DataStore,
  organizationId: string,
  terms: OriginTerms,
): Promise<OriginCandidate[]> {
  const queries = [
    terms.organizerEmail,
    terms.organizerDomain,
    ...terms.linkDomains,
    // The two longest title words, each on its own: a phrase rarely matches whole.
    ...[...terms.titleWords].sort((a, b) => b.length - a.length).slice(0, 2),
  ].filter((q): q is string => Boolean(q && q.length >= 3));
  const found = await Promise.all(
    [...new Set(queries)].map((query) =>
      safe(
        'stored email',
        () =>
          store.list(
            'email_messages',
            organizationId,
            { textSearch: { columns: ['from_address', 'subject', 'snippet'], query } },
            { limit: PER_QUERY, orderBy: [{ field: 'sent_at', direction: 'desc' }] },
          ) as Promise<EmailMessage[]>,
      ),
    ),
  );
  return found.flat().map((m) => ({
    kind: 'email' as const,
    id: emailLinkId(m),
    title: m.subject ?? '(no subject)',
    from: m.from_name,
    fromAddress: m.from_address,
    at: m.sent_at,
    snippet: m.snippet,
  }));
}

/** One read-only Gmail search for the event's terms, newest threads first. */
async function gmailEmails(
  store: DataStore,
  integration: Integration,
  terms: OriginTerms,
): Promise<OriginCandidate[]> {
  const ors = [
    terms.organizerEmail ? `from:${terms.organizerEmail}` : null,
    terms.organizerDomain ? `from:${terms.organizerDomain}` : null,
    ...terms.linkDomains.map((d) => `"${d}"`),
    terms.titleWords.length ? `subject:(${terms.titleWords.join(' ')})` : null,
  ].filter((q): q is string => q !== null);
  if (ors.length === 0) return [];
  const q = `{${ors.join(' ')}} newer_than:1y`;
  const page = await listThreadPage(store, integration, { q, max: PER_QUERY });
  if (!page.ok) return [];
  const metas = await Promise.all(
    page.value.threads.map((t) => readThreadMeta(store, integration, t.id).catch(() => null)),
  );
  return metas
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .map((m) => ({
      kind: 'email' as const,
      id: m.id,
      title: m.subject,
      from: m.who,
      fromAddress: m.firstFromAddress ?? null,
      at: m.latestAt,
    }));
}

/** Meeting notes and earlier synced events with the same title. */
async function sameTitle(
  store: DataStore,
  organizationId: string,
  terms: OriginTerms,
  event: OriginInput,
): Promise<OriginCandidate[]> {
  const longest = [...terms.titleWords].sort((a, b) => b.length - a.length)[0];
  if (!longest) return [];
  const [notes, events] = await Promise.all([
    safe('meeting notes', () =>
      (
        store.list(
          'meeting_notes',
          organizationId,
          { textSearch: { columns: ['title'], query: longest } },
          { limit: 5, orderBy: [{ field: 'occurred_at', direction: 'desc' }] },
        ) as Promise<MeetingNote[]>
      ).then((rows) => rows.filter((note) => isTeamVisibleNote(note))),
    ),
    safe(
      'earlier events',
      () =>
        store.list(
          'calendar_events',
          organizationId,
          { textSearch: { columns: ['title'], query: longest } },
          { limit: 5, orderBy: [{ field: 'starts_at', direction: 'desc' }] },
        ) as Promise<CalendarEvent[]>,
    ),
  ]);
  return [
    ...notes.map((n) => ({
      kind: 'note' as const,
      id: n.id,
      title: n.title,
      from: null,
      fromAddress: null,
      at: n.occurred_at,
    })),
    ...events
      .filter((e) => e.provider_event_id !== event.id)
      .map((e) => ({
        kind: 'event' as const,
        id: e.id,
        title: e.title,
        from: null,
        fromAddress: null,
        at: e.starts_at,
      })),
  ];
}

/**
 * Where an event came from, as short lines with links, or what was checked
 * and the Inbox search. Never throws: a source that fails is skipped.
 */
export async function findEventOrigin(
  store: DataStore,
  organizationId: string,
  input: {
    event: OriginInput;
    integration: Integration | null;
    ownEmails: readonly string[];
    timeZone: string;
    now?: number;
  },
): Promise<EventOrigin> {
  const { event, integration, ownEmails, timeZone } = input;
  const now = input.now ?? Date.now();
  const key = `${organizationId}|${event.calendarId}|${event.id}|${event.title}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < ORIGIN_TTL_MS) return hit.value;

  const terms = originTerms(event, ownEmails);
  const [stored, gmail, titled] = await Promise.all([
    storedEmails(store, organizationId, terms),
    integration ? gmailEmails(store, integration, terms).catch(() => []) : Promise.resolve([]),
    sameTitle(store, organizationId, terms, event),
  ]);
  const ranked = rankOrigins([...stored, ...gmail, ...titled], terms, event);
  const lines: OriginLine[] = ranked.map((r) => ({
    kind: r.kind,
    text: originLineText(r, timeZone),
    subject: r.candidate.kind === 'email' ? r.candidate.title : null,
    threadId: r.candidate.kind === 'email' ? r.candidate.id : null,
    href:
      r.candidate.kind === 'note'
        ? `/meetings?q=${encodeURIComponent(r.candidate.title)}`
        : r.candidate.kind === 'event' && r.candidate.at
          ? `/calendar?view=day&date=${localDateKey(new Date(r.candidate.at), timeZone)}`
          : null,
  }));
  const value: EventOrigin = {
    lines,
    checked: checkedWords(terms, event.guests),
    search: inboxSearchFor(terms, event.title),
  };
  cache.set(key, { at: now, value });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return value;
}
