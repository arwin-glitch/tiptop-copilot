'use client';

import { LiveSearch } from '@/components/ui/live-search';
import { SHOW_PARAM } from '@/lib/util/page-tabs';

/**
 * The subtab the box lives on (see records-tabs.ts), so clearing a search
 * stays there. A module constant, so it is the same object on every render.
 */
const KEEP = { tab: 'notes' } as const;
/** A new search starts again from the first page of notes. */
const RESET = [SHOW_PARAM] as const;

/**
 * Search across meeting notes.
 *
 * Searches the note body as well as its title, because the useful question
 * here is usually "what did we say about X", and X is rarely in the meeting's
 * title.
 */
export function MeetingsFilterBar({ q }: { q: string }) {
  return (
    <LiveSearch
      path="/meetings"
      keep={KEEP}
      reset={RESET}
      value={q}
      placeholder="Search notes, people or companies"
      label="Search meetings"
      className="max-w-sm"
    />
  );
}
