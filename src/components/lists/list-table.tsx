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
import { defaultSortDir } from '@/lib/crm/view';
import type { CrmField, CrmListEntry, CrmValue } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';

/** Clicks on these inside a row act on themselves, not on the row. */
const INTERACTIVE = 'a, button, select, input, textarea, label, summary';

/**
 * A page of a list as a table: the entry name, then one column per field the
 * reader has not hidden. Sorting is a header click that the server applies
 * across the whole list, not just this page. A row opens the side panel; the
 * status column is a control of its own, so changing a stage never needs the
 * panel.
 *
 * Unlike `/deals` there is no separate phone layout: a list's columns are the
 * user's own and can be a dozen wide, so the table scrolls inside its own
 * container (the Table primitive's rule) instead of guessing which three
 * columns matter.
 */
export function ListTable({
  list,
  data,
  hidden,
  relationship,
  statusField,
  statusOptions,
  valuesOf,
  timezone,
  canWrite,
  savingIds,
  onSort,
  onOpen,
  onStatusChange,
}: {
  list: ListViewList;
  data: ListTableData;
  hidden: ReadonlySet<string>;
  /** The optional relationship columns, after the list's own. */
  relationship?: RelationshipColumnsState;
  statusField: CrmField | null;
  statusOptions: string[];
  valuesOf: (entry: CrmListEntry) => Record<string, CrmValue>;
  timezone: string;
  canWrite: boolean;
  savingIds: ReadonlySet<string>;
  onSort: (key: string, dir: 'asc' | 'desc') => void;
  onOpen: (entry: CrmListEntry) => void;
  onStatusChange: (entry: CrmListEntry, next: string | null) => void;
}) {
  const columns = list.fields.filter((f) => !hidden.has(f.key));
  const { sort } = data;

  const sortFor = (key: string, type: CrmField['type'] | 'title') => ({
    direction: sort.key === key ? sort.dir : null,
    onToggle: () =>
      onSort(key, sort.key === key ? (sort.dir === 'asc' ? 'desc' : 'asc') : defaultSortDir(type)),
  });

  return (
    <Table caption={`${list.name}: entries and their fields`} stickyHeader>
      <TableHead sticky>
        <TableRow>
          <TableHeaderCell sort={sortFor('title', 'title')} className="min-w-48">
            Name
          </TableHeaderCell>
          {columns.map((field) => (
            <TableHeaderCell
              key={field.key}
              numeric={field.type === 'money' || field.type === 'number'}
              sort={sortFor(field.key, field.type)}
            >
              {field.name}
            </TableHeaderCell>
          ))}
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
              {columns.map((field) => (
                <TableCell
                  key={field.key}
                  numeric={field.type === 'money' || field.type === 'number'}
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
              ))}
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
    </Table>
  );
}
