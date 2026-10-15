'use client';

import * as React from 'react';
import Link from 'next/link';
import { CrmValueView } from '@/components/lists/crm-value';
import { TimeInStatus } from '@/components/lists/list-table';
import { StatusSelect } from '@/components/lists/status-select';
import type { ListBoardData, ListViewList } from '@/components/lists/list-view';
import { Badge } from '@/components/ui/badge';
import { displayCrmValue } from '@/lib/crm/fields';
import type { CrmTimeInStatus, CrmTotals } from '@/lib/crm/saved-views';
import { crmListHref, statusTone, withPendingStatus, type CrmListParams } from '@/lib/crm/view';
import type { CrmField, CrmListEntry, CrmValue } from '@/lib/types/domain';

/**
 * The list as status columns, in pipeline order, the way Affinity's board
 * shows a deal pipeline — grouped by the pipeline field, or by whichever
 * status field the view chose.
 *
 * Each column holds its first cards (the server caps them; a 5,000-entry list
 * is not drawn card by card) and its true count, the sums of the view's
 * number and money columns across all of its entries, and a link to the
 * table filtered to that status for the rest. A status change on a card
 * moves the card to its new column at once — derived from the changes in
 * flight, so a failed save puts it straight back. Columns sit side by side
 * and scroll inside their own container, so the page itself never scrolls
 * sideways.
 */
export function ListBoard({
  list,
  params,
  data,
  cardFields,
  sumFields,
  showTimer,
  groupField,
  groupIsPipeline,
  groupOptions,
  pending,
  valuesOf,
  timers,
  totals,
  totalsKey,
  now,
  timezone,
  canWrite,
  onOpen,
  onStatusChange,
}: {
  list: ListViewList;
  params: CrmListParams;
  data: ListBoardData;
  /** The fields a card shows under its title. */
  cardFields: readonly CrmField[];
  /** The number and money columns to total on each column. */
  sumFields: readonly CrmField[];
  /** Whether cards show their time in status (the column is visible). */
  showTimer: boolean;
  /** The status field the columns are made of. */
  groupField: CrmField;
  /** Whether that is the pipeline field the status chips filter. */
  groupIsPipeline: boolean;
  /** Its options in pipeline order. */
  groupOptions: string[];
  /** Changes in flight to the grouping field, by entry id. */
  pending: Record<string, { value: string | null; saving: boolean }>;
  valuesOf: (entry: CrmListEntry) => Record<string, CrmValue>;
  timers: Record<string, CrmTimeInStatus>;
  totals: Promise<CrmTotals | null> | null;
  totalsKey: string;
  now: number;
  timezone: string;
  canWrite: boolean;
  onOpen: (entry: CrmListEntry) => void;
  onStatusChange: (entry: CrmListEntry, next: string | null) => void;
}) {
  const columns = React.useMemo(
    () => withPendingStatus(data.columns, pending),
    [data.columns, pending],
  );

  return (
    <div
      role="region"
      aria-label={`${list.name} by ${groupField.name.toLowerCase()}`}
      tabIndex={0}
      className="-mx-[var(--gutter)] scrollbar-thin overflow-x-auto px-[var(--gutter)] pb-2 sm:mx-0 sm:px-0"
    >
      <div className="flex items-start gap-3">
        {columns.map((column) => {
          const label = column.status ?? `No ${groupField.name.toLowerCase()}`;
          const headingId = `board-${list.id}-${slug(column.status ?? '__none')}`;
          const more = column.total - column.entries.length;
          return (
            <section
              key={column.status ?? '__none'}
              aria-labelledby={headingId}
              className="flex w-72 shrink-0 flex-col rounded-[var(--radius-card)] bg-[var(--bg-sunken)] p-2"
            >
              <h2
                id={headingId}
                className="flex items-center justify-between gap-2 px-1 pt-0.5 pb-1 font-sans text-sm font-semibold"
              >
                <Badge tone={column.status ? statusTone(column.status) : 'outline'}>{label}</Badge>
                <span className="tabular text-xs font-normal text-[var(--fg-subtle)]">
                  {column.total.toLocaleString('en-US')}
                </span>
              </h2>
              {totals && sumFields.length ? (
                <React.Suspense
                  key={totalsKey}
                  fallback={<div className="h-4" aria-hidden="true" />}
                >
                  <ColumnTotals promise={totals} group={column.status ?? ''} fields={sumFields} />
                </React.Suspense>
              ) : null}
              {column.entries.length === 0 ? (
                <p className="px-1 pt-1 pb-2 text-xs text-[var(--fg-subtle)]">Nothing here.</p>
              ) : (
                <ul className="mt-1 space-y-2" aria-label={label}>
                  {column.entries.map((entry) => {
                    const values = valuesOf(entry);
                    const record = entry.record_id ? data.records[entry.record_id] : undefined;
                    return (
                      <li
                        key={entry.id}
                        className="shadow-raised rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => onOpen(entry)}
                            className="text-left text-sm font-medium underline-offset-2 hover:underline"
                          >
                            {entry.title}
                          </button>
                          {showTimer ? (
                            <span className="text-mini shrink-0 text-[var(--fg-subtle)]">
                              <TimeInStatus
                                timer={timers[entry.id]}
                                now={now}
                                timezone={timezone}
                              />
                            </span>
                          ) : null}
                        </div>
                        {record && record.name !== entry.title ? (
                          <p className="text-mini mt-0.5 truncate text-[var(--fg-muted)]">
                            {record.name}
                          </p>
                        ) : null}
                        {cardFields.length ? (
                          <dl className="mt-2 space-y-1">
                            {cardFields.map((field) => (
                              <div key={field.key} className="flex min-w-0 items-baseline gap-2">
                                <dt className="text-mini w-24 shrink-0 truncate text-[var(--fg-subtle)]">
                                  {field.name}
                                </dt>
                                <dd className="min-w-0 truncate text-xs">
                                  <CrmValueView
                                    field={field}
                                    value={values[field.key]}
                                    timezone={timezone}
                                  />
                                </dd>
                              </div>
                            ))}
                          </dl>
                        ) : null}
                        {canWrite ? (
                          <StatusSelect
                            label={`${groupField.name} for ${entry.title}`}
                            value={(values[groupField.key] as string | undefined) ?? null}
                            options={groupOptions}
                            disabled={pending[entry.id]?.saving}
                            onChange={(next) => onStatusChange(entry, next)}
                            className="mt-2.5 w-full"
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              {more > 0 && column.status ? (
                <Link
                  href={crmListHref(
                    list.id,
                    params,
                    groupIsPipeline
                      ? { view: 'table', statuses: [column.status] }
                      : {
                          view: 'table',
                          conditions: [
                            ...params.conditions.filter(
                              (c) => !(c.key === groupField.key && c.op === 'in'),
                            ),
                            { key: groupField.key, op: 'in', values: [column.status] },
                          ],
                        },
                  )}
                  className="text-mini mt-2 px-1 text-[var(--accent)] underline-offset-2 hover:underline"
                >
                  {more.toLocaleString('en-US')} more in the table
                </Link>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** A column's sums: each figure column across every entry in the column, not just the cards drawn. */
function ColumnTotals({
  promise,
  group,
  fields,
}: {
  promise: Promise<CrmTotals | null>;
  group: string;
  fields: readonly CrmField[];
}) {
  const totals = React.use(promise);
  const sums = totals?.groups[group]?.sums;
  if (!totals || !sums) return null;
  return (
    <dl className="mb-1 space-y-0.5 px-1" aria-label="Column totals">
      {fields.slice(0, 2).map((field) => {
        const sum = sums[field.key];
        return (
          <div key={field.key} className="text-mini flex items-baseline justify-between gap-2">
            <dt className="truncate text-[var(--fg-subtle)]">{field.name}</dt>
            <dd className="tabular font-medium text-[var(--fg)]">
              {sum && sum.count ? displayCrmValue(field, sum.sum) : '—'}
              {sum && sum.count ? (
                <span className="font-normal text-[var(--fg-subtle)]">
                  {' '}
                  · {sum.count.toLocaleString('en-US')} {sum.count === 1 ? 'entry' : 'entries'}
                </span>
              ) : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'x'
  );
}
