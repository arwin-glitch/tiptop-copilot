'use client';

import { LiveSearch } from '@/components/ui/live-search';

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
      value={q}
      placeholder="Search notes, people or companies"
      label="Search meetings"
      className="max-w-sm"
    />
  );
}
