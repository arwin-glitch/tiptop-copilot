'use client';

import Link from 'next/link';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import type { DealRow } from '@/lib/deals/pipeline-view';

const FIT: Record<NonNullable<DealRow['fit']>, { label: string; tone: BadgeProps['tone'] }> = {
  likely: { label: 'Likely fit', tone: 'ok' },
  possible: { label: 'Possible fit', tone: 'info' },
  unlikely: { label: 'Unlikely fit', tone: 'neutral' },
};

/** Cards per column before "and N more"; the table view shows everything. */
const PER_COLUMN = 40;

/**
 * The pipeline as stage columns. The same filtered, sorted rows as the table,
 * grouped by stage in the thesis's stage order. Columns wrap rather than scroll
 * sideways, so the page never scrolls horizontally on a narrow screen.
 */
export function DealsBoard({ rows }: { rows: DealRow[] }) {
  const columns = new Map<string, { label: string; order: number; rows: DealRow[] }>();
  for (const row of rows) {
    const col = columns.get(row.stageKey) ?? {
      label: row.stageLabel,
      order: row.stageOrder,
      rows: [],
    };
    col.rows.push(row);
    columns.set(row.stageKey, col);
  }
  const ordered = [...columns.entries()].sort((a, b) => a[1].order - b[1].order);

  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {ordered.map(([key, col]) => (
        <section key={key} aria-labelledby={`board-${key}`} className="min-w-0">
          <h2 id={`board-${key}`} className="mb-2 flex items-baseline gap-2 text-sm font-semibold">
            {col.label}
            <span className="tabular text-xs font-normal text-[var(--fg-subtle)]">
              {col.rows.length}
            </span>
          </h2>
          <ul className="space-y-2">
            {col.rows.slice(0, PER_COLUMN).map((row) => (
              <li key={row.id}>
                <Link
                  href={`/deals/${row.id}`}
                  className="block rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-3 transition-colors hover:bg-[var(--bg-hover)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium">{row.companyName}</span>
                    {row.fit ? <Badge tone={FIT[row.fit].tone}>{FIT[row.fit].label}</Badge> : null}
                  </div>
                  {row.productSummary ? (
                    <p className="mt-1 line-clamp-2 text-xs text-[var(--fg-muted)]">
                      {row.productSummary}
                    </p>
                  ) : null}
                  {row.nextStep ? (
                    <p className="mt-1 text-xs">
                      <span className="text-[var(--fg-subtle)]">Next: </span>
                      {row.nextStep}
                    </p>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
          {col.rows.length > PER_COLUMN ? (
            <p className="mt-2 text-xs text-[var(--fg-subtle)]">
              and {col.rows.length - PER_COLUMN} more — switch to the table to see them all
            </p>
          ) : null}
        </section>
      ))}
    </div>
  );
}
