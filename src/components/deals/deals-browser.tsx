'use client';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { ComparePanel, DealsFilterBar } from '@/components/deals/deals-client';
import { DealsTable } from '@/components/deals/deals-table';
import { EmptyState } from '@/components/ui/feedback';
import {
  FIT_FILTERS,
  filterRows,
  fitCounts,
  readPipelineView,
  sortRows,
  stageCounts,
  type ColumnMode,
  type DealRow,
} from '@/lib/deals/pipeline-view';
import type { DealStage } from '@/lib/types/domain';

/**
 * The pipeline list with its stage, fit and sort controls.
 *
 * The server sends every deal that matches the search (or the archived list)
 * once; stage, fit and sort are applied here. They still live in the URL, so
 * a reload or a shared link shows the same view and Back undoes a click, but
 * the URL is changed with `history.pushState`, which Next folds into
 * `useSearchParams` without a server render. A server render of this page
 * pulls the relay and rebuilds hundreds of rows, which made every chip click
 * take a second or two.
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
  const { stage, fit, sort, direction } = readPipelineView(params);

  const counts = React.useMemo(() => stageCounts(rows, fit), [rows, fit]);
  const fits = React.useMemo(() => {
    const byFit = fitCounts(rows, stage);
    return FIT_FILTERS.map((key) => ({ key, count: byFit[key] }));
  }, [rows, stage]);
  const visible = React.useMemo(
    () => sortRows(filterRows(rows, { stage, fit }), sort, direction),
    [rows, stage, fit, sort, direction],
  );

  const update = React.useCallback(
    (changes: Record<string, string | null>) => {
      // The live URL rather than `params`: a second click can land before the
      // first one has re-rendered.
      const current = new URLSearchParams(window.location.search);
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const query = next.toString();
      if (query === current.toString()) return;
      window.history.pushState(null, '', query ? `${pathname}?${query}` : pathname);
    },
    [pathname],
  );

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
        onStageChange={(key) => update({ stage: key })}
        onFitChange={(key) => update({ fit: key })}
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
            onClick: () => update({ stage: null, fit: null, sort: null, dir: null }),
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
            onSort={(key, dir) => update({ sort: key, dir })}
          />
        </>
      )}
    </>
  );
}
