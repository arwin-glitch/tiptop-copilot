'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { RestoreDealButton } from '@/components/deals/deal-actions';
import { Badge, RecommendationBadge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowHeader,
} from '@/components/ui/table';
import {
  FIT_LABELS,
  type ColumnMode,
  type DealRow,
  type SortDirection,
  type SortKey,
} from '@/lib/deals/pipeline-view';
import { relativeTime } from '@/lib/util/time';
import { cn } from '@/lib/util/cn';

/**
 * The pipeline, as a table.
 *
 * `/deals` was a list of cards, which is the wrong shape for the question this
 * screen answers. Nobody reads a pipeline top to bottom; they compare rows —
 * which of these scored well, which is thin on evidence, which has been sitting
 * untouched. Comparison needs columns, and columns need alignment.
 *
 * Below `lg` this renders a purpose-built card list instead of a squeezed
 * table. Seven columns on a phone is not a table, it is a horizontal scroll
 * bar, and the useful mobile view answers a different question — what is this
 * and does it need me — with the figures as a single summary line.
 *
 * With no AI provider and no analysis stored (`mode="routine"`), the score
 * columns would be a wall of dashes, so they give way to what the deal-sorter
 * knows: fit, source and last activity.
 */

export function DealsTable({
  rows,
  sort,
  direction,
  mode = 'scores',
  archived = false,
  onSort,
}: {
  rows: DealRow[];
  sort: SortKey;
  direction: SortDirection;
  /** `routine` swaps the score columns for fit, source and last activity. */
  mode?: ColumnMode;
  /** The archived ("Not a deal") list, where each row can be restored. */
  archived?: boolean;
  /** Applies a header click in place; without it the click navigates. */
  onSort?: (sort: SortKey, direction: SortDirection) => void;
}) {
  const router = useRouter();
  const params = useSearchParams();

  /**
   * Sorting lives in the URL rather than in component state: it survives a
   * reload, it is shareable, and Back undoes it.
   */
  const toggle = React.useCallback(
    (key: SortKey) => {
      // Clicking the active column reverses it; clicking a new one starts from
      // that column's natural direction — A–Z for names, pipeline order for
      // stages, highest-first for figures and newest-first for dates.
      const nextDirection: SortDirection =
        sort === key
          ? direction === 'asc'
            ? 'desc'
            : 'asc'
          : key === 'company' || key === 'stage'
            ? 'asc'
            : 'desc';
      if (onSort) {
        onSort(key, nextDirection);
        return;
      }
      const next = new URLSearchParams(params.toString());
      next.set('sort', key);
      next.set('dir', nextDirection);
      router.push(`/deals?${next.toString()}`);
    },
    [direction, onSort, params, router, sort],
  );

  const sortFor = (key: SortKey) => ({
    direction: sort === key ? direction : null,
    onToggle: () => toggle(key),
  });

  return (
    <>
      <div className="hidden lg:block">
        <Table
          caption={
            mode === 'scores'
              ? 'Deals in the pipeline, with their current recommendation and scores'
              : 'Deals in the pipeline, with their fit, source and last activity'
          }
          stickyHeader
          className="mt-4"
        >
          <TableHead sticky>
            <TableRow>
              <TableHeaderCell sort={sortFor('company')}>Company</TableHeaderCell>
              <TableHeaderCell sort={sortFor('stage')}>Stage</TableHeaderCell>
              {mode === 'scores' ? (
                <>
                  <TableHeaderCell>Recommendation</TableHeaderCell>
                  <TableHeaderCell numeric sort={sortFor('score')}>
                    Score
                  </TableHeaderCell>
                  <TableHeaderCell numeric sort={sortFor('evidence')}>
                    Evidence
                  </TableHeaderCell>
                  <TableHeaderCell numeric sort={sortFor('confidence')}>
                    Confidence
                  </TableHeaderCell>
                  <TableHeaderCell numeric sort={sortFor('received')}>
                    Received
                  </TableHeaderCell>
                </>
              ) : (
                <>
                  <TableHeaderCell>Fit</TableHeaderCell>
                  <TableHeaderCell>Source</TableHeaderCell>
                  <TableHeaderCell numeric sort={sortFor('activity')}>
                    Last activity
                  </TableHeaderCell>
                </>
              )}
              {archived ? (
                <TableHeaderCell>
                  <span className="sr-only">Restore</span>
                </TableHeaderCell>
              ) : null}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} interactive>
                <TableRowHeader className="max-w-[24rem]">
                  <Link
                    href={`/deals/${row.id}`}
                    className="font-serif text-[15px] font-semibold underline-offset-2 hover:underline"
                  >
                    {row.companyName}
                  </Link>
                  {row.productSummary ? (
                    <p className="text-mini mt-0.5 line-clamp-1 font-normal text-[var(--fg-muted)]">
                      {row.productSummary}
                    </p>
                  ) : null}
                  {row.facts ? (
                    <p className="text-mini mt-0.5 line-clamp-1 font-normal text-[var(--fg-subtle)]">
                      {row.facts}
                    </p>
                  ) : null}
                  <RoutineMeta row={row} withFit={mode === 'scores'} />
                </TableRowHeader>

                <TableCell>
                  <Badge tone="outline">{row.stageLabel}</Badge>
                  <SuggestionChip row={row} />
                  {row.vertical ? (
                    <p className="text-mini mt-1 text-[var(--fg-subtle)]">{row.vertical}</p>
                  ) : null}
                </TableCell>

                {mode === 'scores' ? (
                  <>
                    <TableCell>
                      {row.recommendation ? (
                        <RecommendationBadge recommendation={row.recommendation} size="sm" />
                      ) : (
                        <Unscored>Not analysed</Unscored>
                      )}
                    </TableCell>

                    <TableCell numeric>
                      <ScoreCell value={row.qualityScore} suffix="/100" emphasis />
                    </TableCell>
                    <TableCell numeric>
                      <ScoreCell value={row.dataCompleteness} suffix="%" />
                    </TableCell>
                    <TableCell numeric>
                      <ScoreCell value={row.confidence} suffix="%" />
                    </TableCell>

                    <TableCell
                      numeric
                      className="text-mini whitespace-nowrap text-[var(--fg-muted)]"
                    >
                      {relativeTime(row.receivedAt)}
                    </TableCell>
                  </>
                ) : (
                  <>
                    <TableCell>{row.fit ? <FitBadge fit={row.fit} /> : <Absent />}</TableCell>
                    <TableCell className="text-mini max-w-[14rem] break-words text-[var(--fg-muted)]">
                      {row.source ?? <Absent />}
                    </TableCell>
                    <TableCell
                      numeric
                      className="text-mini whitespace-nowrap text-[var(--fg-muted)]"
                    >
                      {relativeTime(activityAt(row))}
                    </TableCell>
                  </>
                )}

                {archived ? (
                  <TableCell>
                    <RestoreDealButton dealId={row.id} name={row.companyName} />
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Below lg: the same rows, asked a different question. */}
      <ul className="shadow-raised mt-4 divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] lg:hidden">
        {rows.map((row) => (
          <li key={row.id}>
            <Link
              href={`/deals/${row.id}`}
              className="block px-4 py-3.5 transition-colors duration-[var(--motion-instant)] hover:bg-[var(--bg-hover)]"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 font-serif text-base font-semibold break-words">
                  {row.companyName}
                </span>
                {row.recommendation ? (
                  <RecommendationBadge recommendation={row.recommendation} size="sm" />
                ) : mode === 'scores' ? (
                  <Badge tone="outline">Not analysed</Badge>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge tone="outline">{row.stageLabel}</Badge>
                <SuggestionChip row={row} inline />
                {row.fit ? <FitBadge fit={row.fit} /> : null}
                {row.vertical ? <Badge tone="neutral">{row.vertical}</Badge> : null}
              </div>
              {row.productSummary ? (
                <p className="mt-1.5 line-clamp-2 text-sm break-words text-[var(--fg-muted)]">
                  {row.productSummary}
                </p>
              ) : null}
              {row.source || row.nextStep ? (
                <p className="text-mini mt-1 line-clamp-2 break-words text-[var(--fg-subtle)]">
                  {[row.source, row.nextStep].filter(Boolean).join(' · ')}
                </p>
              ) : null}
              <p className="tabular text-mini mt-1.5 text-[var(--fg-subtle)]">
                {row.qualityScore !== null
                  ? `${row.qualityScore}/100 · ${row.dataCompleteness}% evidence · ${row.confidence}% confidence · `
                  : ''}
                {relativeTime(mode === 'routine' ? activityAt(row) : row.receivedAt)}
              </p>
            </Link>
            {archived ? (
              <div className="px-4 pb-3">
                <RestoreDealButton dealId={row.id} name={row.companyName} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

/** When the deal last moved, as far as anyone knows: the routine's last activity, else arrival. */
function activityAt(row: DealRow): string {
  return row.lastActivity ? `${row.lastActivity}T12:00:00.000Z` : row.receivedAt;
}

const FIT_TONE = { likely: 'ok', possible: 'info', unlikely: 'neutral' } as const;

function FitBadge({ fit }: { fit: NonNullable<DealRow['fit']> }) {
  return <Badge tone={FIT_TONE[fit]}>{FIT_LABELS[fit]}</Badge>;
}

/**
 * The deal-sorter's line under the company name: fit, where the deal came
 * from and the next concrete step. The fit badge is left out when the table
 * already has a Fit column.
 */
function RoutineMeta({ row, withFit }: { row: DealRow; withFit: boolean }) {
  const parts = [row.source, row.nextStep].filter((p): p is string => Boolean(p));
  const fit = withFit ? row.fit : null;
  if (!fit && parts.length === 0) return null;
  return (
    <p className="text-mini mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 font-normal text-[var(--fg-subtle)]">
      {fit ? <FitBadge fit={fit} /> : null}
      {parts.length > 0 ? (
        <span className="line-clamp-1 break-words">{parts.join(' · ')}</span>
      ) : null}
    </p>
  );
}

/** "Suggests: X" when the deal-sorter's view differs from the stage a person set. */
function SuggestionChip({ row, inline = false }: { row: DealRow; inline?: boolean }) {
  if (!row.suggestedStageLabel) return null;
  return (
    <Badge
      tone="warn"
      className={inline ? undefined : 'mt-1 flex w-fit'}
      title={row.evidence ?? undefined}
    >
      Suggests: {row.suggestedStageLabel}
    </Badge>
  );
}

/**
 * A figure that may not exist yet.
 *
 * Invariant 1 in the handover: unknown stays unknown. An unanalysed deal has no
 * score, and the one thing this cell must never do is print `0` — in a column
 * of scores that reads as "scored, and scored badly", which is the opposite of
 * the truth.
 */
function ScoreCell({
  value,
  suffix,
  emphasis = false,
}: {
  value: number | null;
  suffix: string;
  emphasis?: boolean;
}) {
  if (value === null) return <Unscored>—</Unscored>;
  return (
    <span className={cn('tabular', emphasis ? 'text-sm font-semibold' : 'text-sm')}>
      {value}
      <span className="text-mini font-normal text-[var(--fg-subtle)]">{suffix}</span>
    </span>
  );
}

function Unscored({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-mini text-[var(--fg-subtle)] italic" title="No analysis has been run">
      {children}
    </span>
  );
}

function Absent() {
  return <span className="text-mini text-[var(--fg-subtle)] italic">—</span>;
}
