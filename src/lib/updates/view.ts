import type { UpdateGroup } from '@/lib/updates/types';

/** Which Updates filter is on: a whole group, or one source within it. */
export type UpdatesView = 'all' | 'dealflow' | 'digests';

export interface UpdatesFilter {
  view: UpdatesView;
  source: string | null;
}

export function viewForGroup(group: UpdateGroup): UpdatesView {
  return group === 'digest' ? 'digests' : 'dealflow';
}

/** Reads the filter from the URL; an unknown source falls back to its view. */
export function readUpdatesFilter(
  params: { get(name: string): string | null },
  sources: { key: string; group: UpdateGroup }[],
): UpdatesFilter {
  const rawView = params.get('view');
  const view: UpdatesView = rawView === 'dealflow' || rawView === 'digests' ? rawView : 'all';
  const match = sources.find((s) => s.key === params.get('source'));
  return match ? { view: viewForGroup(match.group), source: match.key } : { view, source: null };
}

export function updatesQuery({ view, source }: UpdatesFilter): string {
  const params = new URLSearchParams();
  if (view !== 'all' || source) params.set('view', view);
  if (source) params.set('source', source);
  return params.toString();
}

export function updatesHref(filter: UpdatesFilter): string {
  const query = updatesQuery(filter);
  return query ? `/updates?${query}` : '/updates';
}

/** The key of the panel a filter shows. */
export function panelKey({ view, source }: UpdatesFilter): string {
  return source ? `source:${source}` : view;
}
