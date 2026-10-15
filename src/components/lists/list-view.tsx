'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { setCrmEntryValuesAction } from '@/app/actions/crm';
import { AddEntryDialog } from '@/components/lists/add-entry-dialog';
import { ColumnPicker, useHiddenColumns } from '@/components/lists/column-picker';
import { EntryDrawer } from '@/components/lists/entry-drawer';
import { ListBoard } from '@/components/lists/list-board';
import { ListTable } from '@/components/lists/list-table';
import { StageEditor } from '@/components/lists/stage-editor';
import { Button } from '@/components/ui/button';
import { EmptyState, Notice } from '@/components/ui/feedback';
import { LiveSearch } from '@/components/ui/live-search';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FilterChip, FilterChipRow, Toolbar, ToolbarSpacer } from '@/components/ui/toolbar';
import { crmListHref, type CrmListParams, type CrmListViewMode } from '@/lib/crm/view';
import type { CrmBoardColumn, CrmRecordSummary } from '@/lib/services/crm';
import type { CrmEntityType, CrmField, CrmListEntry, CrmValue } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';

/** The list itself, as the page needs it. */
export interface ListViewList {
  id: string;
  name: string;
  entity_type: CrmEntityType;
  fields: CrmField[];
}

export interface ListTableData {
  entries: CrmListEntry[];
  total: number;
  offset: number;
  limit: number;
  /** The sort the server applied; `position` is list order. */
  sort: { key: string; dir: 'asc' | 'desc' };
  records: Record<string, CrmRecordSummary>;
}

export interface ListBoardData {
  columns: CrmBoardColumn[];
  unplaced: number;
  perColumn: number;
  records: Record<string, CrmRecordSummary>;
}

/** A status change not yet confirmed by a fresh render of the page. */
interface Pending {
  value: string | null;
  saving: boolean;
}

const RESET_ON_SEARCH = ['page'] as const;

/**
 * The list page below its header: search, status chips, the table or board,
 * the side panel and "Add entry".
 *
 * The server does the querying — search, status filter, sort and paging are
 * all URL state, read by the page and run in the database, because a list can
 * hold thousands of entries and only a page of them is ever here. This
 * component owns what the URL does not: hidden columns (per browser), the open
 * entry, and status changes in flight.
 *
 * A status change shows at once and is saved behind it; a failed save puts the
 * old status back and says why. Once saved the page re-renders so the chip
 * counts and board columns catch up, and the optimistic value gives way to
 * the stored one — except for a change still saving, which a re-render
 * started by an earlier change must not undo.
 */
export function ListView({
  list,
  params,
  statusField,
  statusOptions,
  counts,
  table,
  board,
  boardProblem,
  timezone,
  canWrite,
}: {
  list: ListViewList;
  params: CrmListParams;
  statusField: CrmField | null;
  /** The status field's options in pipeline order. */
  statusOptions: string[];
  /** Entries per status for the chips, under the current search; null without a status field. */
  counts: Record<string, number> | null;
  table: ListTableData | null;
  board: ListBoardData | null;
  /** Why there is no board, when the board was asked for and cannot be drawn. */
  boardProblem: string | null;
  timezone: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [navigating, startNavigation] = React.useTransition();
  const [hidden, setHidden] = useHiddenColumns(list.id, list.fields);
  const [pending, setPending] = React.useState<Record<string, Pending>>({});
  const [openEntry, setOpenEntry] = React.useState<CrmListEntry | null>(null);
  const [announcement, setAnnouncement] = React.useState('');

  // A fresh render of the page brings stored values; drop the optimistic ones
  // it now covers, keeping any still saving.
  const data = table ?? board;
  const [seen, setSeen] = React.useState(data);
  if (seen !== data) {
    setSeen(data);
    setPending((current) =>
      Object.fromEntries(Object.entries(current).filter(([, p]) => p.saving)),
    );
  }

  const statusKey = statusField?.key ?? null;
  const records = data?.records ?? {};
  // The open entry as this render of the page has it, else as it was opened.
  const liveEntry = openEntry ? (findEntry(table, board, openEntry.id) ?? openEntry) : null;

  const valuesOf = React.useCallback(
    (entry: CrmListEntry): Record<string, CrmValue> => {
      const change = pending[entry.id];
      if (!change || !statusKey) return entry.values;
      const values = { ...entry.values };
      if (change.value === null) delete values[statusKey];
      else values[statusKey] = change.value;
      return values;
    },
    [pending, statusKey],
  );

  const navigate = (changes: Partial<CrmListParams>) =>
    startNavigation(() => router.push(crmListHref(list.id, params, changes), { scroll: false }));

  const changeStatus = async (entry: CrmListEntry, next: string | null) => {
    if (!statusKey) return;
    const before = (valuesOf(entry)[statusKey] as string | undefined) ?? null;
    if (before === next) return;
    setPending((current) => ({ ...current, [entry.id]: { value: next, saving: true } }));
    // A dropped connection rejects rather than returning a result; it is the
    // same failure to the reader and must put the old status back too.
    const result = await setCrmEntryValuesAction(entry.id, { [statusKey]: next }).catch(() => ({
      ok: false as const,
      data: undefined,
      error: {
        code: 'internal',
        message: 'The status could not be saved: no connection.',
        stillUsable: undefined,
      },
    }));
    if (!result.ok) {
      // Only undo this attempt: a later change to the same entry stands.
      setPending((current) => {
        if (current[entry.id]?.value !== next) return current;
        const rest = { ...current };
        delete rest[entry.id];
        return rest;
      });
      toast.error(result.error?.message ?? 'The status could not be changed.', {
        description: result.error?.stillUsable,
      });
      setAnnouncement(`${entry.title}: the status change was not saved.`);
      return;
    }
    setPending((current) =>
      current[entry.id]?.value === next
        ? { ...current, [entry.id]: { value: next, saving: false } }
        : current,
    );
    // The open panel keeps a copy of its entry, which may be off this page by
    // the time the re-render lands (a status filter it no longer matches).
    const saved = result.data?.entry;
    if (saved) setOpenEntry((open) => (open?.id === saved.id ? saved : open));
    setAnnouncement(`${entry.title}: status set to ${next ?? 'none'}.`);
    React.startTransition(() => router.refresh());
  };

  const filtered = params.q !== '' || params.statuses.length > 0;
  const toggleStatus = (status: string) => {
    const has = params.statuses.includes(status);
    navigate({
      statuses: has ? params.statuses.filter((s) => s !== status) : [...params.statuses, status],
    });
  };

  return (
    <div className="space-y-4">
      <Toolbar aria-label="List controls">
        <LiveSearch
          path={`/lists/${list.id}`}
          value={params.q}
          placeholder={`Search ${list.name}`}
          label={`Search ${list.name}`}
          reset={RESET_ON_SEARCH}
          className="w-full max-w-sm"
        />
        <ToolbarSpacer />
        <ColumnPicker fields={list.fields} hidden={hidden} onChange={setHidden} />
        {canWrite && statusField ? (
          <StageEditor
            listId={list.id}
            field={statusField}
            options={statusOptions}
            // Under a search the counts cover only the matches, too few to judge by.
            counts={params.q ? null : counts}
            onSaved={() => React.startTransition(() => router.refresh())}
          />
        ) : null}
        {canWrite ? (
          <AddEntryDialog
            list={list}
            statusField={statusField}
            statusOptions={statusOptions}
            onAdded={(entry) => {
              setOpenEntry(entry);
              React.startTransition(() => router.refresh());
            }}
          />
        ) : null}
      </Toolbar>

      {statusField && counts ? (
        <FilterChipRow aria-label={`Filter by ${statusField.name}`}>
          <FilterChip
            label="All"
            pressed={params.statuses.length === 0}
            onToggle={() => navigate({ statuses: [] })}
          />
          {statusOptions.map((option) => (
            <FilterChip
              key={option}
              label={option}
              count={counts[option] ?? 0}
              pressed={params.statuses.includes(option)}
              onToggle={() => toggleStatus(option)}
            />
          ))}
        </FilterChipRow>
      ) : null}

      <Tabs
        value={params.view}
        onValueChange={(value) => navigate({ view: value as CrmListViewMode, page: 1 })}
      >
        <TabsList aria-label="Layout">
          <TabsTrigger value="table">Table</TabsTrigger>
          <TabsTrigger
            value="board"
            disabled={!statusField}
            title={statusField ? undefined : 'A board needs a status field'}
          >
            Board
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value={params.view}
          className={cn(
            'transition-opacity duration-[var(--motion-fast)]',
            navigating && 'opacity-60',
          )}
          aria-busy={navigating || undefined}
        >
          {params.view === 'table' && table ? (
            table.total === 0 ? (
              <EmptyState
                title={filtered ? 'No entries match' : 'This list is empty'}
                description={
                  filtered
                    ? 'Clear the search or the status filter to see the whole list.'
                    : canWrite
                      ? 'Add an entry, or import the list from Affinity to bring its rows across.'
                      : 'Import the list from Affinity to bring its rows across.'
                }
                action={
                  filtered
                    ? { label: 'Clear filters', href: `/lists/${list.id}` }
                    : { label: 'Import from Affinity', href: '/knowledge?tab=import' }
                }
              />
            ) : (
              <>
                <ListTable
                  list={list}
                  data={table}
                  hidden={hidden}
                  statusField={statusField}
                  statusOptions={statusOptions}
                  valuesOf={valuesOf}
                  timezone={timezone}
                  canWrite={canWrite}
                  savingIds={savingIds(pending)}
                  onSort={(key, dir) => navigate({ sort: key, dir })}
                  onOpen={setOpenEntry}
                  onStatusChange={changeStatus}
                />
                <Pagination list={list} params={params} table={table} />
              </>
            )
          ) : null}

          {params.view === 'board' ? (
            board && statusField ? (
              <>
                {board.unplaced > 0 ? (
                  <Notice className="mb-3">
                    {board.unplaced.toLocaleString('en-US')}{' '}
                    {board.unplaced === 1 ? 'entry has' : 'entries have'} a{' '}
                    {statusField.name.toLowerCase()} that is not one of this list’s options, so{' '}
                    {board.unplaced === 1 ? 'it is' : 'they are'} on no column. The table shows{' '}
                    {board.unplaced === 1 ? 'it' : 'them'}.
                  </Notice>
                ) : null}
                <ListBoard
                  list={list}
                  params={params}
                  data={board}
                  hidden={hidden}
                  statusField={statusField}
                  statusOptions={statusOptions}
                  pending={pending}
                  valuesOf={valuesOf}
                  timezone={timezone}
                  canWrite={canWrite}
                  onOpen={setOpenEntry}
                  onStatusChange={changeStatus}
                />
              </>
            ) : (
              <Notice>
                {boardProblem ?? 'This list has no status field to lay out as a board.'}
              </Notice>
            )
          ) : null}
        </TabsContent>
      </Tabs>

      <EntryDrawer
        list={list}
        entry={liveEntry}
        record={liveEntry?.record_id ? (records[liveEntry.record_id] ?? null) : null}
        saving={liveEntry ? Boolean(pending[liveEntry.id]?.saving) : false}
        statusField={statusField}
        statusOptions={statusOptions}
        valuesOf={valuesOf}
        timezone={timezone}
        canWrite={canWrite}
        onClose={() => setOpenEntry(null)}
        onStatusChange={changeStatus}
      />

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

function findEntry(
  table: ListTableData | null,
  board: ListBoardData | null,
  id: string,
): CrmListEntry | undefined {
  return (
    table?.entries.find((e) => e.id === id) ??
    board?.columns.flatMap((c) => c.entries).find((e) => e.id === id)
  );
}

function savingIds(pending: Record<string, Pending>): ReadonlySet<string> {
  return new Set(
    Object.entries(pending)
      .filter(([, p]) => p.saving)
      .map(([id]) => id),
  );
}

/** "101–200 of 4,712" with previous and next pages, as links so they work before hydration. */
function Pagination({
  list,
  params,
  table,
}: {
  list: ListViewList;
  params: CrmListParams;
  table: ListTableData;
}) {
  const from = table.offset + 1;
  const to = table.offset + table.entries.length;
  const page = Math.floor(table.offset / table.limit) + 1;
  const pages = Math.max(1, Math.ceil(table.total / table.limit));
  const fmt = (n: number) => n.toLocaleString('en-US');
  return (
    <nav
      aria-label="Pages"
      className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--fg-muted)]"
    >
      <p className="tabular">
        {fmt(from)}–{fmt(to)} of {fmt(table.total)}
      </p>
      {pages > 1 ? (
        <div className="flex items-center gap-2">
          <PageLink
            href={page > 1 ? crmListHref(list.id, params, { page: page - 1 }) : null}
            label="Previous page"
          >
            <ChevronLeft aria-hidden="true" />
            Previous
          </PageLink>
          <span className="tabular text-xs">
            Page {fmt(page)} of {fmt(pages)}
          </span>
          <PageLink
            href={page < pages ? crmListHref(list.id, params, { page: page + 1 }) : null}
            label="Next page"
          >
            Next
            <ChevronRight aria-hidden="true" />
          </PageLink>
        </div>
      ) : null}
    </nav>
  );
}

function PageLink({
  href,
  label,
  children,
}: {
  href: string | null;
  label: string;
  children: React.ReactNode;
}) {
  if (!href) {
    return (
      <Button variant="secondary" size="sm" disabled aria-label={label}>
        {children}
      </Button>
    );
  }
  return (
    <Button asChild variant="secondary" size="sm">
      <Link href={href} aria-label={label} scroll={false}>
        {children}
      </Link>
    </Button>
  );
}
