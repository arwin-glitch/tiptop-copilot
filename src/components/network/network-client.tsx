'use client';

import { LiveSearch } from '@/components/ui/live-search';

/**
 * The subtab the box lives on (see records-tabs.ts), so clearing a search
 * stays there. A module constant, so it is the same object on every render.
 */
const KEEP = { tab: 'people' } as const;

/**
 * Search over the relationship list.
 *
 * The list is derived from synced mail and calendar on every request, so this
 * is the most expensive of the search boxes to re-run. The debounce in
 * LiveSearch is what keeps that to one query per pause rather than one per
 * keystroke.
 */
export function NetworkFilterBar({ q }: { q: string }) {
  return (
    <LiveSearch
      path="/network"
      keep={KEEP}
      value={q}
      placeholder="Search name, address or company"
      label="Search network"
      className="max-w-sm"
    />
  );
}
