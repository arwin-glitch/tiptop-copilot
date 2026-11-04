/**
 * Gmail's "Create event" from a conversation: the Inbox hands the Calendar
 * tab a prefilled new event (title = the subject, guests = the people on the
 * thread, description = a link back to it). It travels in this tab's
 * sessionStorage, not the address bar, so addresses never sit in a URL or a
 * server log; `/calendar?create=inbox` tells the Calendar tab to look. The
 * Calendar's own editor opens with it, and nothing is created or emailed
 * until the person clicks Save there (which asks about emailing guests, as
 * Google Calendar does). Pure and client-safe; the storage calls are guarded.
 */

export const PREFILL_KEY = 'kraken.calendar.inboxPrefill';
export const PREFILL_PARAM = 'create';
export const PREFILL_VALUE = 'inbox';
/** A handoff older than this is ignored (a stale tab, a back button). */
const MAX_AGE_MS = 10 * 60_000;
const MAX_GUESTS = 50;
const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export interface EventPrefill {
  title: string;
  guests: string[];
  description: string;
}

/** The prefill for one conversation; the mailbox itself is never a guest. */
export function eventPrefill(input: {
  subject: string;
  participants: readonly string[];
  mailbox: string | null;
  threadUrl: string;
}): EventPrefill {
  const own = (input.mailbox ?? '').toLowerCase();
  const guests = [
    ...new Set(
      input.participants
        .map((p) => (/<([^<>\s]+@[^<>\s]+)>/.exec(p)?.[1] ?? p).trim().toLowerCase())
        .filter((a) => ADDRESS.test(a) && a !== own),
    ),
  ].slice(0, MAX_GUESTS);
  return {
    title: input.subject
      .replace(/^((re|fwd?):\s*)+/i, '')
      .trim()
      .slice(0, 300),
    guests,
    description: `Email thread: ${input.threadUrl}`,
  };
}

export function storePrefill(prefill: EventPrefill, now = Date.now()): boolean {
  try {
    window.sessionStorage.setItem(PREFILL_KEY, JSON.stringify({ ...prefill, at: now }));
    return true;
  } catch {
    return false;
  }
}

/** The waiting prefill, taken once (removed as it is read). Null when none, stale or bad. */
export function takePrefill(now = Date.now()): EventPrefill | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(PREFILL_KEY);
    window.sessionStorage.removeItem(PREFILL_KEY);
  } catch {
    return null;
  }
  return parsePrefill(raw, now);
}

export function parsePrefill(raw: string | null, now = Date.now()): EventPrefill | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<EventPrefill> & { at?: unknown };
    if (typeof v.at !== 'number' || now - v.at > MAX_AGE_MS || v.at > now + 60_000) return null;
    if (typeof v.title !== 'string' || typeof v.description !== 'string') return null;
    if (!Array.isArray(v.guests)) return null;
    return {
      title: v.title.slice(0, 300),
      description: v.description.slice(0, 2_000),
      guests: v.guests
        .filter((g): g is string => typeof g === 'string' && ADDRESS.test(g))
        .slice(0, MAX_GUESTS),
    };
  } catch {
    return null;
  }
}
