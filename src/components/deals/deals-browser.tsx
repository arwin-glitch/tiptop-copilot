'use client';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { ComparePanel, DealsFilterBar } from '@/components/deals/deals-client';
import { DealsTable } from '@/components/deals/deals-table';
import { useRefreshLoading } from '@/components/shell/refresh-status';
import { EmptyState } from '@/components/ui/feedback';
import {
  FIT_FILTERS,
  filterRows,
  fitCounts,
  readPipelineView,
  sameViewParams,
  sortRows,
  stageCounts,
  viewParams,
  withViewParams,
  type ColumnMode,
  type DealRow,
  type ViewParams,
} from '@/lib/deals/pipeline-view';
import type { DealStage } from '@/lib/types/domain';

/**
 * The pipeline list with its stage, fit and sort controls.
 *
 * The server sends every deal that matches the search (or the archived list)
 * once; stage, fit and sort are applied here. A server render of this page
 * pulls the relay and rebuilds hundreds of rows, which made every chip click
 * take a second or two.
 *
 * A click shows its view at once, from state, and then writes it to the URL
 * with `history.pushState`, which Next folds into `useSearchParams` without a
 * server render, so a reload, a shared link and Back keep the view. That write
 * waits while the open-tab watcher's refresh is loading: Next would apply the
 * URL on top of the refresh, and hold every update on the page until it lands.
 */
export function DealsBrowser({
  rows,
  stages,
  q,
  archived,
  archivedCount,
  aiAvailable,
  mode,
  empty,
}: {
  /** Every deal in the searched or archived set, unfiltered and unsorted. */
  rows: DealRow[];
  stages: DealStage[];
  q: string;
  archived: boolean;
  archivedCount: number;
  aiAvailable: boolean;
  mode: ColumnMode;
  /** Shown instead of the list when the set itself is empty. */
  empty: React.ReactNode;
}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const refreshLoading = useRefreshLoading();
  const allStages = React.useRef<HTMLButtonElement>(null);

  const inUrl = viewParams(params);
  // The view last clicked, until the URL holds it.
  const [chosen, setChosen] = React.useState<ViewParams | null>(null);
  if (chosen && sameViewParams(chosen, inUrl)) setChosen(null);
  const { stage, fit, sort, direction } = readPipelineView(withViewParams('', chosen ?? inUrl));

  const counts = React.useMemo(() => stageCounts(rows, fit), [rows, fit]);
  const fits = React.useMemo(() => {
    const byFit = fitCounts(rows, stage);
    return FIT_FILTERS.map((key) => ({ key, count: byFit[key] }));
  }, [rows, stage]);
  const visible = React.useMemo(
    () => sortRows(filterRows(rows, { stage, fit }), sort, direction),
    [rows, stage, fit, sort, direction],
  );

  // Functional, so a second click before a re-render builds on the first.
  const choose = (changes: Partial<ViewParams>) =>
    setChosen((previous) => ({ ...(previous ?? inUrl), ...changes }));

  // Also re-run when the URL moves (a search, the Archived chip), which can
  // replace a URL this has not caught up with yet.
  const query = params.toString();
  React.useEffect(() => {
    if (!chosen || refreshLoading) return;
    const current = new URLSearchParams(window.location.search).toString();
    const next = withViewParams(window.location.search, chosen).toString();
    if (next === current) return;
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
      <DealsFilterBar
        stages={stages}
        counts={counts}
        stage={stage}
        q={q}
        fit={fit}
        fits={fits}
        archived={archived}
        archivedCount={archivedCount}
        onStageChange={(key) => choose({ stage: key })}
        onFitChange={(key) => choose({ fit: key })}
        allStagesRef={allStages}
      />

      {rows.length === 0 ? (
        empty
      ) : visible.length === 0 ? (
        <EmptyState
          className="mt-5"
          title="No deals match"
          description="Clear the filters, or widen the search."
          action={{
            label: 'Clear filters',
            onClick: () => {
              // This button goes away with the empty state; keep keyboard
              // users in place rather than dropping focus to the page.
              allStages.current?.focus();
              choose({ stage: null, fit: null, sort: null, dir: null });
            },
          }}
        />
      ) : (
        <>
          {aiAvailable && !archived ? (
            <ComparePanel
              deals={visible.map((row) => ({ id: row.id, company_name: row.companyName }))}
            />
          ) : null}

          <DealsTable
            rows={visible}
            sort={sort}
            direction={direction}
            mode={mode}
            archived={archived}
            onSort={(key, dir) => choose({ sort: key, dir })}
          />
        </>
      )}
    </>
  );
}
