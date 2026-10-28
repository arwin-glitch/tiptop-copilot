/**
 * Is this Granola note the same conversation as this Kraken meeting?
 * (D-076) While both tools run, a meeting recorded in Kraken usually has a
 * Granola note too, and every list should show it once. The two are paired
 * (meetings.granola_external_id) when the note's time is within three hours
 * of the meeting's start, and the titles match once punctuation and case are
 * set aside, or a guest from outside the team is on both. Only an
 * unambiguous pair is made: two candidates is no pair. Pure.
 */

export const PAIR_WINDOW_MS = 3 * 3_600_000;

export interface PairMeeting {
  title: string;
  /** started_at, else scheduled_start, else created_at. */
  at: string;
  /** Lowercased emails of guests from outside the team. */
  externalEmails: readonly string[];
}

export interface PairNote {
  title: string;
  occurredAt: string;
  attendeeEmails: readonly string[];
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isSameConversation(meeting: PairMeeting, note: PairNote): boolean {
  const a = Date.parse(meeting.at);
  const b = Date.parse(note.occurredAt);
  if (Number.isNaN(a) || Number.isNaN(b) || Math.abs(a - b) > PAIR_WINDOW_MS) return false;
  const title = normalizeTitle(meeting.title);
  if (title && title === normalizeTitle(note.title)) return true;
  const guests = new Set(meeting.externalEmails.map((e) => e.toLowerCase()));
  return note.attendeeEmails.some((e) => guests.has(e.toLowerCase()));
}

/** The one candidate that matches, or null when none or more than one does. */
export function uniqueMatch<T>(candidates: readonly T[], test: (c: T) => boolean): T | null {
  const hits = candidates.filter(test);
  return hits.length === 1 ? (hits[0] as T) : null;
}
