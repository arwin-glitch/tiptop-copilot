import type { MeetingNote } from '@/lib/types/domain';

/**
 * Whether a meeting_notes row may appear on a page shared across the team
 * (D-076). Granola rows are always the team's. A Kraken row is private to
 * its recorder unless its meeting was shared with the team; the readers that
 * predate Kraken Notes (deal, company and network pages, the meetings list,
 * global search, the calendar's "How you got here") show only team rows, or
 * the viewer's own when they know who is looking.
 *
 * Filtered in memory on purpose: those readers run before the Kraken Notes
 * migration is applied too, when the `visibility` column does not exist yet
 * and a database filter on it would fail the page.
 */
export function isTeamVisibleNote(note: MeetingNote, viewerId?: string | null): boolean {
  if (note.visibility !== 'private') return true;
  return Boolean(viewerId && note.owner_id === viewerId);
}
