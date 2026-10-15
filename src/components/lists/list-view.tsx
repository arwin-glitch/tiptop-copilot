'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { setCrmEntryValuesAction } from '@/app/actions/crm';
import { AddEntryDialog } from '@/components/lists/add-entry-dialog';
import {
  ColumnPicker,
  useHiddenColumns,
  type PickerColumn,
} from '@/components/lists/column-picker';
import { EntryDrawer } from '@/components/lists/entry-drawer';
import { ExportMenu } from '@/components/lists/export-menu';
import { ListBoard } from '@/components/lists/list-board';
import { ListTable, type TableColumn } from '@/components/lists/list-table';
import { StageEditor } from '@/components/lists/stage-editor';
import { ConditionChips, FilterMenu } from '@/components/lists/view-filters';
import { ViewTabs } from '@/components/lists/view-tabs';
import { Button } from '@/components/ui/button';
import { EmptyState, Notice } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { LiveSearch } from '@/components/ui/live-search';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FilterChip, FilterChipRow, Toolbar, ToolbarSpacer } from '@/components/ui/toolbar';
import {
  CRM_TIME_IN_STATUS_KEY,
  CRM_TIME_IN_STATUS_LABEL,
  defaultHiddenColumns,
  summableFields,
  viewStateOf,
  visibleColumnKeys,
  type CrmSavedView,
  type CrmTimeInStatus,
  type CrmTotals,
  type CrmViewState,
} from '@/lib/crm/saved-views';
import {
  CRM_EXPORT_EVERYTHING_HREF,
  crmListHref,
  crmViewExportHref,
  sortStatusOptions,
  type CrmListParams,
  type CrmListViewMode,
} from '@/lib/crm/view';
import type { CrmBoardColumn, CrmRecordSummary } from '@/lib/services/crm';
import type {
  CrmEntityType,
  CrmField,
  CrmListEntry,
  CrmSource,
  CrmValue,
} from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';

/** The list itself, as the page needs it. */
export interface ListViewList {
  id: string;
  name: string;
  entity_type: CrmEntityType;
  /** Imported from Affinity or made in Copilot: which columns All hides at first. */
  source: CrmSource;
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
  /** The status field changed: the pipeline, or the field a board is grouped by. */
  key: string;
  value: string | null;
  saving: boolean;
}

const RESET_ON_SEARCH = ['page'] as const;

/**
 * The list page below its header: the view tabs, search, filters, status
 * chips, the table or board, the side panel and "Add entry".
 *
 * The server does the querying — the saved view, search, conditions, status
 * filter, sort and paging are all URL state, read by the page and run in the
 * database, because a list can hold thousands of entries and only a page of
 * them is ever here. This component owns what the URL does not: the All
 * view's hidden columns (per browser), the open entry, and status changes in
 * flight.
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
  views,
  activeView,
  dirty,
  timers,
  totals,
  totalsKey,
  now,
  timezone,
  canWrite,
  canExportAll,
}: {
  list: ListViewList;
  /** The page's state with its saved view applied (resolveListParams). */
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
  /** The list's saved views. */
  views: CrmSavedView[];
  /** The saved view on screen; null for All. */
  activeView: CrmSavedView | null;
  /** The page shows something other than the view as saved. */
  dirty: boolean;
  /** Time in current status for the entries on the page, by id. */
  timers: Record<string, CrmTimeInStatus>;
  /** Totals across every entry the view matches, streamed; null when there is nothing to total. */
  totals: Promise<CrmTotals | null> | null;
  totalsKey: string;
  /** When the page was rendered, which time in status counts to. */
  now: number;
  timezone: string;
  canWrite: boolean;
  /** Owners may export the whole CRM. */
  canExportAll: boolean;
}) {
  const router = useRouter();
  const [navigating, startNavigation] = React.useTransition();
  const [pending, setPending] = React.useState<Record<string, Pending>>({});
  const [openEntry, setOpenEntry] = React.useState<CrmListEntry | null>(null);
  const [announcement, setAnnouncement] = React.useState('');

  // Every column there is, in list order (the computed time in status after
  // the pipeline field), and the ones on screen.
  const pickerColumns = React.useMemo<PickerColumn[]>(() => {
    const byKey = new Map(list.fields.map((f) => [f.key, f]));
    return visibleColumnKeys(list.fields, null).map((key) => {
      const field = byKey.get(key);
      return field
        ? { key, name: field.name, type: field.type }
        : { key, name: CRM_TIME_IN_STATUS_LABEL, type: 'computed' };
    });
  }, [list.fields]);
  // Until this browser chooses, All hides what defaultHiddenColumns says: a
  // frozen imported timer, or a Time in Stage with nothing to count from.
  const defaultHidden = React.useMemo(
    () => defaultHiddenColumns({ source: list.source, fields: list.fields }),
    [list.source, list.fields],
  );
  const [hidden, setHidden] = useHiddenColumns(list.id, pickerColumns, defaultHidden);
  const visible = React.useMemo(
    () =>
      params.columns
        ? visibleColumnKeys(list.fields, params.columns)
        : // This browser's hidden columns belong to All; a saved view with
          // every column shows every column.
          visibleColumnKeys(list.fields, null, params.viewId ? undefined : hidden),
    [list.fields, params.columns, params.viewId, hidden],
  );
  const tableColumns = React.useMemo<TableColumn[]>(() => {
    const byKey = new Map(list.fields.map((f) => [f.key, f]));
    return visible.map((key) => {
      const field = byKey.get(key) ?? null;
      return { key, name: field?.name ?? CRM_TIME_IN_STATUS_LABEL, field };
    });
  }, [list.fields, visible]);

  // The board's columns: the view's grouping, else the pipeline.
  const statusFields = list.fields.filter((f) => f.type === 'status');
  const groupField =
    (params.groupBy ? statusFields.find((f) => f.key === params.groupBy) : null) ?? statusField;
  const groupIsPipeline = groupField?.key === statusField?.key;
  const groupOptions = groupField
    ? groupIsPipeline
      ? statusOptions
      : sortStatusOptions(groupField.options ?? [])
    : [];

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
      if (!change) return entry.values;
      const values = { ...entry.values };
      if (change.value === null) delete values[change.key];
      else values[change.key] = change.value;
      return values;
    },
    [pending],
  );

  const navigate = (changes: Partial<CrmListParams>) =>
    startNavigation(() => router.push(crmListHref(list.id, params, changes), { scroll: false }));

  const changeStatus = async (
    entry: CrmListEntry,
    next: string | null,
    key: string | null = statusKey,
  ) => {
    if (!key) return;
    const field = list.fields.find((f) => f.key === key);
    const before = (valuesOf(entry)[key] as string | undefined) ?? null;
    if (before === next) return;
    setPending((current) => ({ ...current, [entry.id]: { key, value: next, saving: true } }));
    // A dropped connection rejects rather than returning a result; it is the
    // same failure to the reader and must put the old status back too.
    const result = await setCrmEntryValuesAction(entry.id, { [key]: next }).catch(() => ({
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
        const latest = current[entry.id];
        if (latest?.key !== key || latest.value !== next) return current;
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
      current[entry.id]?.key === key && current[entry.id]?.value === next
        ? { ...current, [entry.id]: { key, value: next, saving: false } }
        : current,
    );
    // The open panel keeps a copy of its entry, which may be off this page by
    // the time the re-render lands (a status filter it no longer matches).
    const saved = result.data?.entry;
    if (saved) setOpenEntry((open) => (open?.id === saved.id ? saved : open));
    setAnnouncement(
      key === statusKey
        ? `${entry.title}: status set to ${next ?? 'none'}.`
        : `${entry.title}: ${field?.name ?? key} set to ${next ?? 'none'}.`,
    );
    React.startTransition(() => router.refresh());
  };

  // Columns: on the All view, showing and hiding is remembered in this
  // browser as before; moving a column, or any change on a saved view (or
  // to columns already spelled out), changes the view.
  const changeColumns = (next: string[], how: 'toggle' | 'all' | 'move') => {
    if (!params.columns && !params.viewId && how !== 'move') {
      setHidden(new Set(pickerColumns.map((c) => c.key).filter((k) => !next.includes(k))));
      return;
    }
    navigate({ columns: next });
  };

  // What "Save" stores: the page as it stands, with the All view's columns
  // spelled out only when this browser has hidden some.
  const saveState: CrmViewState = {
    ...viewStateOf(params),
    columns: params.columns ?? (!params.viewId && hidden.size ? visible : null),
  };

  const filtered = params.q !== '' || params.statuses.length > 0 || params.conditions.length > 0;
  const toggleStatus = (status: string) => {
    const has = params.statuses.includes(status);
    navigate({
      statuses: has ? params.statuses.filter((s) => s !== status) : [...params.statuses, status],
    });
  };

  const pendingForGroup = groupField
    ? Object.fromEntries(Object.entries(pending).filter(([, p]) => p.key === groupField.key))
    : {};
  const visibleFields = tableColumns.map((c) => c.field).filter((f): f is CrmField => f !== null);
  const cardFields = visibleFields.filter((f) => f.key !== groupField?.key).slice(0, 3);
  const sumFields = summableFields(list, visibleFields);

  return (
    <div className="space-y-4">
      <ViewTabs
        listId={list.id}
        listName={list.name}
        params={params}
        views={views}
        active={activeView}
        dirty={dirty}
        state={saveState}
        canWrite={canWrite}
      />

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
        <FilterMenu
          fields={list.fields}
          conditions={params.conditions}
          onApply={(conditions) => navigate({ conditions })}
        />
        <ColumnPicker columns={pickerColumns} visible={visible} onChange={changeColumns} />
        {canWrite ? (
          // The export routes serve members and above; a viewer is offered none.
          <ExportMenu
            viewHref={crmViewExportHref(list.id, params, visible)}
            viewLabel={activeView?.name ?? 'This view'}
            everythingHref={canExportAll ? CRM_EXPORT_EVERYTHING_HREF : null}
          />
        ) : null}
        {canWrite && statusField ? (
          <StageEditor
            listId={list.id}
            field={statusField}
            options={statusOptions}
            // Under a search or a filter the counts cover only the matches, too few to judge by.
            counts={params.q || params.conditions.length ? null : counts}
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

      <ConditionChips
        fields={list.fields}
        conditions={params.conditions}
        timezone={timezone}
        onRemove={(index) =>
          navigate({ conditions: params.conditions.filter((_, i) => i !== index) })
        }
      />

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
        <div className="flex flex-wrap items-end justify-between gap-2">
          <TabsList aria-label="Layout" className="min-w-0 flex-1">
            <TabsTrigger value="table">Table</TabsTrigger>
            <TabsTrigger
              value="board"
              disabled={!statusField}
              title={statusField ? undefined : 'A board needs a status field'}
            >
              Board
            </TabsTrigger>
          </TabsList>
          {params.view === 'board' && statusFields.length > 1 && groupField ? (
            <label className="flex items-center gap-2 pb-1 text-sm text-[var(--fg-muted)]">
              Group by
              <Select
                value={groupField.key}
                onChange={(e) =>
                  navigate({ groupBy: e.target.value === statusField?.key ? '' : e.target.value })
                }
                className="h-8 w-44 text-sm"
              >
                {statusFields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
        </div>

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
                    ? 'Clear the search, the filters or the status chips to see more of the list.'
                    : canWrite
                      ? 'Add an entry, or import the list from Affinity to bring its rows across.'
                      : 'Import the list from Affinity to bring its rows across.'
                }
                action={
                  filtered
                    ? {
                        label: 'Clear filters',
                        href: crmListHref(list.id, params, {
                          q: '',
                          statuses: [],
                          conditions: [],
                        }),
                      }
                    : { label: 'Import from Affinity', href: '/lists/import' }
                }
              />
            ) : (
              <>
                <ListTable
                  list={list}
                  data={table}
                  columns={tableColumns}
                  statusField={statusField}
                  statusOptions={statusOptions}
                  valuesOf={valuesOf}
                  timers={timers}
                  totals={totals}
                  totalsKey={totalsKey}
                  now={now}
                  timezone={timezone}
                  canWrite={canWrite}
                  savingIds={savingIds(pending)}
                  onSort={(key, dir) => navigate({ sort: key, dir })}
                  onOpen={setOpenEntry}
                  onStatusChange={(entry, next) => changeStatus(entry, next)}
                />
                <Pagination list={list} params={params} table={table} />
              </>
            )
          ) : null}

          {params.view === 'board' ? (
            board && groupField ? (
              <>
                {board.unplaced > 0 ? (
                  <Notice className="mb-3">
                    {board.unplaced.toLocaleString('en-US')}{' '}
                    {board.unplaced === 1 ? 'entry has' : 'entries have'} a{' '}
                    {groupField.name.toLowerCase()} that is not one of this list’s options, so{' '}
                    {board.unplaced === 1 ? 'it is' : 'they are'} on no column. The table shows{' '}
                    {board.unplaced === 1 ? 'it' : 'them'}.
                  </Notice>
                ) : null}
                <ListBoard
                  list={list}
                  params={params}
                  data={board}
                  cardFields={cardFields}
                  sumFields={sumFields}
                  showTimer={visible.includes(CRM_TIME_IN_STATUS_KEY)}
                  groupField={groupField}
                  groupIsPipeline={groupIsPipeline}
                  groupOptions={groupOptions}
                  pending={pendingForGroup}
                  valuesOf={valuesOf}
                  timers={timers}
                  totals={totals}
                  totalsKey={totalsKey}
                  now={now}
                  timezone={timezone}
                  canWrite={canWrite}
                  onOpen={setOpenEntry}
                  onStatusChange={(entry, next) => changeStatus(entry, next, groupField.key)}
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
        timer={liveEntry ? timers[liveEntry.id] : undefined}
        now={now}
        timezone={timezone}
        canWrite={canWrite}
        onClose={() => setOpenEntry(null)}
        onStatusChange={(entry, next) => changeStatus(entry, next)}
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
