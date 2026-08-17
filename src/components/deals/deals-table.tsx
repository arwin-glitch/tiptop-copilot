'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
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
import type { DealRow, SortDirection, SortKey } from '@/lib/deals/pipeline-view';
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
 */

export function DealsTable({
  rows,
  sort,
  direction,
}: {
  rows: DealRow[];
  sort: SortKey;
  direction: SortDirection;
}) {
  const router = useRouter();
  const params = useSearchParams();

  /**
   * Sorting lives in the URL rather than in component state: it survives a
   * reload, it is shareable, and it keeps this component from owning a second
   * copy of an ordering the server already applied.
   */
  const toggle = React.useCallback(
    (key: SortKey) => {
      const next = new URLSearchParams(params.toString());
      // Clicking the active column reverses it; clicking a new one starts from
      // that column's natural direction — A–Z for names, highest-first for
      // figures and newest-first for dates.
      const nextDirection: SortDirection =
        sort === key
          ? direction === 'asc'
            ? 'desc'
            : 'asc'
          : key === 'company' || key === 'stage'
            ? 'asc'
            : 'desc';
      next.set('sort', key);
      next.set('dir', nextDirection);
      router.push(`/deals?${next.toString()}`);
    },
    [direction, params, router, sort],
  );

  const sortFor = (key: SortKey) => ({
    direction: sort === key ? direction : null,
    onToggle: () => toggle(key),
  });

  return (
    <>
      <div className="hidden lg:block">
        <Table
          caption="Deals in the pipeline, with their current recommendation and scores"
          stickyHeader
          className="mt-4"
        >
          <TableHead sticky>
            <TableRow>
              <TableHeaderCell sort={sortFor('company')}>Company</TableHeaderCell>
              <TableHeaderCell sort={sortFor('stage')}>Stage</TableHeaderCell>
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
                </TableRowHeader>

                <TableCell>
                  <Badge tone="outline">{row.stageLabel}</Badge>
                  {row.vertical ? (
                    <p className="text-mini mt-1 text-[var(--fg-subtle)]">{row.vertical}</p>
                  ) : null}
                </TableCell>

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

                <TableCell numeric className="text-mini whitespace-nowrap text-[var(--fg-muted)]">
                  {relativeTime(row.receivedAt)}
                </TableCell>
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
                <span className="font-serif text-base font-semibold">{row.companyName}</span>
                {row.recommendation ? (
                  <RecommendationBadge recommendation={row.recommendation} size="sm" />
                ) : (
                  <Badge tone="outline">Not analysed</Badge>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge tone="outline">{row.stageLabel}</Badge>
                {row.vertical ? <Badge tone="neutral">{row.vertical}</Badge> : null}
              </div>
              {row.productSummary ? (
                <p className="mt-1.5 line-clamp-2 text-sm text-[var(--fg-muted)]">
                  {row.productSummary}
                </p>
              ) : null}
              <p className="tabular text-mini mt-1.5 text-[var(--fg-subtle)]">
                {row.qualityScore !== null
                  ? `${row.qualityScore}/100 · ${row.dataCompleteness}% evidence · ${row.confidence}% confidence · `
                  : ''}
                {relativeTime(row.receivedAt)}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </>
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
