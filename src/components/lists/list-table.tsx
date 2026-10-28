'use client';

import * as React from 'react';
import Link from 'next/link';
import { CrmValueView } from '@/components/lists/crm-value';
import {
  RelationshipCells,
  RelationshipHeaderCells,
  type RelationshipColumnsState,
} from '@/components/lists/relationship-columns';
import { StatusSelect } from '@/components/lists/status-select';
import type { ListTableData, ListViewList } from '@/components/lists/list-view';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowHeader,
} from '@/components/ui/table';
import { displayCrmValue } from '@/lib/crm/fields';
import {
  summableFields,
  timeInStatusText,
  type CrmTimeInStatus,
  type CrmTotals,
} from '@/lib/crm/saved-views';
import { defaultSortDir } from '@/lib/crm/view';
import type { CrmField, CrmListEntry, CrmValue } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';
import { formatDate } from '@/lib/util/time';

/** Clicks on these inside a row act on themselves, not on the row. */
const INTERACTIVE = 'a, button, select, input, textarea, label, summary';

/** A column of the table: a field of the list, or (field null) the computed time in status. */
export interface TableColumn {
  key: string;
  name: string;
  field: CrmField | null;
}

const isFigure = (field: CrmField | null) => field?.type === 'money' || field?.type === 'number';

/**
 * A page of a list as a table: the entry name, then the view's columns in
 * the view's order. Sorting is a header click that the server applies across
 * the whole list, not just this page. A row opens the side panel; the status
 * column is a control of its own, so changing a stage never needs the panel.
 * Number and money columns are totalled in the footer across every entry the
 * view matches — streamed in after the rows, since that means reading them
 * all — except an LP list's amounts, which are never summed (summableFields).
 *
 * Unlike `/deals` there is no separate phone layout: a list's columns are the
 * user's own and can be a dozen wide, so the table scrolls inside its own
 * container (the Table primitive's rule) instead of guessing which three
 * columns matter.
 */
export function ListTable({
  list,
  data,
  columns,
  relationship,
  statusField,
  statusOptions,
  valuesOf,
  timers,
  totals,
  totalsKey,
  now,
  timezone,
  canWrite,
  savingIds,
  onSort,
  onOpen,
  onStatusChange,
}: {
  list: ListViewList;
  data: ListTableData;
  columns: readonly TableColumn[];
  /** The optional relationship columns, after the list's own. */
  relationship?: RelationshipColumnsState;
  statusField: CrmField | null;
  statusOptions: string[];
  valuesOf: (entry: CrmListEntry) => Record<string, CrmValue>;
  /** Time in current status, by entry id. */
  timers: Record<string, CrmTimeInStatus>;
  /** Totals across the whole view; null when there is nothing to total. */
  totals: Promise<CrmTotals | null> | null;
  /** Changes whenever the view's entries do, so fresh totals stream in rather than holding the page. */
  totalsKey: string;
  /** The time the page was rendered, which time-in-status counts to. */
  now: number;
  timezone: string;
  canWrite: boolean;
  savingIds: ReadonlySet<string>;
  onSort: (key: string, dir: 'asc' | 'desc') => void;
  onOpen: (entry: CrmListEntry) => void;
  onStatusChange: (entry: CrmListEntry, next: string | null) => void;
}) {
  const { sort } = data;

  const sortFor = (key: string, type: CrmField['type'] | 'title') => ({
    direction: sort.key === key ? sort.dir : null,
    onToggle: () =>
      onSort(key, sort.key === key ? (sort.dir === 'asc' ? 'desc' : 'asc') : defaultSortDir(type)),
  });
  // The columns the footer totals: figures, but never an LP list's amounts.
  const summed = new Set(
    summableFields(
      list,
      columns.map((c) => c.field).filter((f): f is CrmField => f !== null),
    ).map((f) => f.key),
  );

  return (
    <Table caption={`${list.name}: entries and their fields`} stickyHeader>
      <TableHead sticky>
        <TableRow>
          <TableHeaderCell sort={sortFor('title', 'title')} className="min-w-48">
            Name
          </TableHeaderCell>
          {columns.map((column) =>
            column.field ? (
              <TableHeaderCell
                key={column.key}
                numeric={isFigure(column.field)}
                sort={sortFor(column.key, column.field.type)}
              >
                {column.name}
              </TableHeaderCell>
            ) : (
              // Sortable headers are buttons, which do not take the header's
              // capitals; this one matches them.
              <TableHeaderCell key={column.key} className="normal-case">
                {column.name}
              </TableHeaderCell>
            ),
          )}
          {relationship ? <RelationshipHeaderCells state={relationship} /> : null}
        </TableRow>
      </TableHead>
      <TableBody>
        {data.entries.map((entry) => {
          const values = valuesOf(entry);
          const record = entry.record_id ? data.records[entry.record_id] : undefined;
          return (
            <TableRow
              key={entry.id}
              interactive
              className="cursor-pointer"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
                onOpen(entry);
              }}
            >
              <TableRowHeader className="max-w-72">
                <button
                  type="button"
                  onClick={() => onOpen(entry)}
                  className="text-left font-medium underline-offset-2 hover:underline"
                >
                  {entry.title}
                </button>
                {record && record.name !== entry.title ? (
                  <Link
                    href={`/lists/records/${record.id}`}
                    className="text-mini mt-0.5 block truncate text-[var(--fg-muted)] underline-offset-2 hover:underline"
                  >
                    {record.name}
                  </Link>
                ) : record?.domain ? (
                  <span className="text-mini mt-0.5 block truncate text-[var(--fg-subtle)]">
                    {record.domain}
                  </span>
                ) : null}
              </TableRowHeader>
              {columns.map((column) => {
                const field = column.field;
                if (!field) {
                  return (
                    <TableCell key={column.key} className="whitespace-nowrap">
                      <TimeInStatus timer={timers[entry.id]} now={now} timezone={timezone} />
                    </TableCell>
                  );
                }
                return (
                  <TableCell
                    key={column.key}
                    numeric={isFigure(field)}
                    className={cn(
                      'max-w-64',
                      field.type !== 'status' && 'truncate',
                      field.type === 'text' && 'whitespace-nowrap',
                    )}
                  >
                    {statusField && field.key === statusField.key && canWrite ? (
                      <StatusSelect
                        label={`${field.name} for ${entry.title}`}
                        value={(values[field.key] as string | undefined) ?? null}
                        options={statusOptions}
                        disabled={savingIds.has(entry.id)}
                        onChange={(next) => onStatusChange(entry, next)}
                      />
                    ) : (
                      <CrmValueView field={field} value={values[field.key]} timezone={timezone} />
                    )}
                  </TableCell>
                );
              })}
              {relationship ? (
                <RelationshipCells
                  state={relationship}
                  recordId={entry.record_id}
                  timezone={timezone}
                />
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
      {totals && summed.size ? (
        <React.Suspense
          key={totalsKey}
          fallback={<TotalsRow columns={columns} summed={summed} totals={null} />}
        >
          <StreamedTotals promise={totals} columns={columns} summed={summed} />
        </React.Suspense>
      ) : null}
    </Table>
  );
}

function StreamedTotals({
  promise,
  columns,
  summed,
}: {
  promise: Promise<CrmTotals | null>;
  columns: readonly TableColumn[];
  summed: ReadonlySet<string>;
}) {
  const totals = React.use(promise);
  if (!totals) return null;
  return <TotalsRow columns={columns} summed={summed} totals={totals} />;
}

const FOOT_CELL =
  'border-t-2 border-[var(--border-strong)] bg-[var(--bg-raised)] px-3 py-2.5 align-top text-sm';

/** The footer: how many entries the view holds, and each figure column's sum with how many entries carry a value. */
function TotalsRow({
  columns,
  summed,
  totals,
}: {
  columns: readonly TableColumn[];
  /** The keys of the columns that are totalled (summableFields). */
  summed: ReadonlySet<string>;
  /** Null while the totals are on their way. */
  totals: CrmTotals | null;
}) {
  const fmt = (n: number) => n.toLocaleString('en-US');
  return (
    <tfoot aria-label="Totals">
      <tr>
        <th scope="row" className={cn(FOOT_CELL, 'text-left font-semibold')}>
          Total
          <span className="text-mini block font-normal text-[var(--fg-muted)]">
            {totals
              ? `${fmt(totals.count)} ${totals.count === 1 ? 'entry' : 'entries'}${totals.complete ? '' : ' (first ones only)'}`
              : 'Adding up…'}
          </span>
        </th>
        {columns.map((column) => {
          if (!summed.has(column.key)) return <td key={column.key} className={FOOT_CELL} />;
          const field = column.field as CrmField;
          const sum = totals?.sums[column.key];
          return (
            <td key={column.key} className={cn(FOOT_CELL, 'tabular text-right font-semibold')}>
              {sum ? (
                <>
                  <span aria-label={`${field.name} total`}>{displayCrmValue(field, sum.sum)}</span>
                  <span className="text-mini block font-normal text-[var(--fg-muted)]">
                    {fmt(sum.count)} {sum.count === 1 ? 'entry' : 'entries'}
                  </span>
                </>
              ) : totals ? (
                <span className="text-[var(--fg-subtle)]">—</span>
              ) : (
                <span className="inline-block h-4 w-16 animate-pulse rounded bg-[var(--bg-sunken)]" />
              )}
            </td>
          );
        })}
      </tr>
    </tfoot>
  );
}

/** How an entry's time in its stage is known, in words. */
export function timeInStatusNote(timer: CrmTimeInStatus | undefined, timezone: string): string {
  if (!timer || timer.source === 'unknown') {
    return 'Not known yet: no stage change has been made in Kraken since the import. Changing the stage here starts the clock.';
  }
  if (timer.source === 'affinity') {
    const at = timer.importedAt ? ` on ${formatDate(timer.importedAt, timezone)}` : '';
    return timer.since
      ? `About this long: Affinity said ${timer.imported} at the import${at}, counted on since then.`
      : `Affinity’s figure at the import${at}, as Affinity wrote it.`;
  }
  const since = timer.since ? formatDate(timer.since, timezone) : null;
  if (timer.source === 'added')
    return `In this stage since it was added${since ? `, ${since}` : ''}.`;
  return `In this stage since ${since ?? 'a change made in Kraken'}.`;
}

/**
 * Time in the current status. How it is known is never hover-only: an
 * estimate from Affinity's figure carries a visible "~", the side panel
 * (`detail`) spells it out, and in a cell an estimate or an unknown is read
 * out to screen readers.
 */
export function TimeInStatus({
  timer,
  now,
  timezone,
  detail = false,
}: {
  timer: CrmTimeInStatus | undefined;
  now: number;
  timezone: string;
  /** Show how it is known as a line of its own (the side panel). */
  detail?: boolean;
}) {
  const text = timeInStatusText(timer, now);
  const note = timeInStatusNote(timer, timezone);
  const value = text ? (
    <span className="tabular" title={note}>
      {text}
    </span>
  ) : (
    <span className="text-[var(--fg-subtle)]" title={note}>
      —
    </span>
  );
  if (detail) {
    return (
      <span className="block">
        {value}
        <span className="text-mini mt-0.5 block text-[var(--fg-muted)]">{note}</span>
      </span>
    );
  }
  // Read out where the visible mark carries meaning: an estimate, or unknown.
  const speak = !timer || timer.source === 'affinity' || timer.source === 'unknown';
  return (
    <>
      {value}
      {speak ? <span className="sr-only">. {note}</span> : null}
    </>
  );
}
