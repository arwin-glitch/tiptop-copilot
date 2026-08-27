'use client';

import { LiveSearch } from '@/components/ui/live-search';

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
      value={q}
      placeholder="Search name, address or company"
      label="Search network"
      className="max-w-sm"
    />
  );
}
