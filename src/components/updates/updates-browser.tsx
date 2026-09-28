'use client';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useRefreshLoading } from '@/components/shell/refresh-status';
import { UpdatesFilters } from '@/components/updates/updates-filters';
import type { UpdateGroup } from '@/lib/updates/types';
import { panelKey, readUpdatesFilter, updatesQuery, type UpdatesFilter } from '@/lib/updates/view';

/**
 * The Updates filter chips and the panel each one shows.
 *
 * The server reads Slack once and renders every panel; a chip click only
 * switches between them, so it is instant and never re-reads Slack. As on
 * Deals and Tasks, the chosen filter shows at once from state and is then
 * written to the URL with `history.pushState`, which Next folds into
 * `useSearchParams` without a server render, so a reload, a shared link and
 * Back keep it. That write waits while a refresh is loading: Next would apply
 * the URL on top of it and hold every update until it lands.
 */
export function UpdatesBrowser({
  sources,
  panels,
}: {
  sources: { key: string; label: string; group: UpdateGroup; count: number }[];
  /** Keyed by `panelKey`: 'all', 'dealflow', 'digests' and 'source:<key>'. */
  panels: Record<string, React.ReactNode>;
}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const refreshLoading = useRefreshLoading();

  const inUrl = readUpdatesFilter(params, sources);
  // The filter last clicked, until the URL holds it.
  const [chosen, setChosen] = React.useState<UpdatesFilter | null>(null);
  if (chosen && panelKey(chosen) === panelKey(inUrl)) setChosen(null);
  const filter = chosen ?? inUrl;
  const shown = panelKey(filter);

  const query = params.toString();
  React.useEffect(() => {
    if (!chosen || refreshLoading) return;
    const next = updatesQuery(chosen);
    if (next === new URLSearchParams(window.location.search).toString()) return;
    window.history.pushState(null, '', next ? `${pathname}?${next}` : pathname);
  }, [chosen, refreshLoading, pathname, query]);

  React.useEffect(() => {
    // Back and Forward land on a URL of their own; a click not yet written
    // there must not override it.
    const drop = () => setChosen(null);
    window.addEventListener('popstate', drop);
    return () => window.removeEventListener('popstate', drop);
  }, []);

  return (
    <>
      <UpdatesFilters filter={filter} sources={sources} onChoose={setChosen} />
      {Object.entries(panels).map(([key, panel]) => (
        <div key={key} hidden={key !== shown} data-updates-panel={key} className="space-y-5">
          {panel}
        </div>
      ))}
    </>
  );
}
