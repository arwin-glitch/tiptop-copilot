'use client';

import * as React from 'react';
import { FilterChipRow, filterChipClassName } from '@/components/ui/toolbar';
import type { UpdateGroup } from '@/lib/updates/types';
import {
  updatesHref,
  viewForGroup,
  type UpdatesFilter,
  type UpdatesView,
} from '@/lib/updates/view';

const VIEWS: { view: UpdatesView; label: string }[] = [
  { view: 'all', label: 'All' },
  { view: 'dealflow', label: 'Dealflow' },
  { view: 'digests', label: 'Digests' },
];

/** A plain click is handled in place; a modified one opens the link as usual. */
function plainClick(event: React.MouseEvent): boolean {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0);
}

/**
 * The view and source chips. Each is a real link, so a new tab or a
 * no-JS load still works, but a plain click switches in place. Clicking the
 * chip that is already on turns it off and goes back to All.
 */
export function UpdatesFilters({
  filter,
  sources,
  onChoose,
}: {
  filter: UpdatesFilter;
  sources: { key: string; label: string; group: UpdateGroup; count: number }[];
  onChoose: (next: UpdatesFilter) => void;
}) {
  const { view, source } = filter;
  const shown = view === 'all' ? sources : sources.filter((s) => viewForGroup(s.group) === view);
  const all: UpdatesFilter = { view: 'all', source: null };

  const chip = (key: string, active: boolean, target: UpdatesFilter, children: React.ReactNode) => {
    const next = active ? all : target;
    return (
      <a
        key={key}
        href={updatesHref(next)}
        aria-current={active ? 'page' : undefined}
        className={filterChipClassName(active)}
        onClick={(event) => {
          if (!plainClick(event)) return;
          event.preventDefault();
          onChoose(next);
        }}
      >
        {children}
      </a>
    );
  };

  return (
    <FilterChipRow aria-label="Filter updates">
      {VIEWS.map((v) =>
        chip(v.view, view === v.view && !source, { view: v.view, source: null }, v.label),
      )}
      <span aria-hidden="true" className="mx-0.5 w-px shrink-0 self-stretch bg-[var(--border)]" />
      {shown.map((s) =>
        chip(
          s.key,
          source === s.key,
          { view: viewForGroup(s.group), source: s.key },
          <>
            {s.label}
            <span className="tabular ml-1.5 text-[var(--fg-subtle)]">{s.count}</span>
          </>,
        ),
      )}
    </FilterChipRow>
  );
}
