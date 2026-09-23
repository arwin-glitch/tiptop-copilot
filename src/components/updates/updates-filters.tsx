import Link from 'next/link';
import { FilterChipRow, filterChipClassName } from '@/components/ui/toolbar';
import type { UpdateGroup } from '@/lib/updates/types';

export type UpdatesView = 'all' | 'dealflow' | 'digests';

export function viewForGroup(group: UpdateGroup): UpdatesView {
  return group === 'digest' ? 'digests' : 'dealflow';
}

const VIEWS: { view: UpdatesView; label: string }[] = [
  { view: 'all', label: 'All' },
  { view: 'dealflow', label: 'Dealflow' },
  { view: 'digests', label: 'Digests' },
];

/** Filters are plain links, so the view lives in the URL and works without JS. */
export function UpdatesFilters({
  view,
  selected,
  sources,
}: {
  view: UpdatesView;
  selected: string | null;
  sources: { key: string; label: string; group: UpdateGroup; count: number }[];
}) {
  const shown = view === 'all' ? sources : sources.filter((s) => viewForGroup(s.group) === view);
  return (
    <FilterChipRow aria-label="Filter updates">
      {VIEWS.map((v) => {
        const active = view === v.view && !selected;
        return (
          <Link
            key={v.view}
            href={`/updates?view=${v.view}`}
            aria-current={active ? 'page' : undefined}
            className={filterChipClassName(active)}
          >
            {v.label}
          </Link>
        );
      })}
      <span aria-hidden="true" className="mx-0.5 w-px shrink-0 self-stretch bg-[var(--border)]" />
      {shown.map((s) => {
        const active = selected === s.key;
        return (
          <Link
            key={s.key}
            href={`/updates?view=${viewForGroup(s.group)}&source=${encodeURIComponent(s.key)}`}
            aria-current={active ? 'page' : undefined}
            className={filterChipClassName(active)}
          >
            {s.label}
            <span className="tabular ml-1.5 text-[var(--fg-subtle)]">{s.count}</span>
          </Link>
        );
      })}
    </FilterChipRow>
  );
}
