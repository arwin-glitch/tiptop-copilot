import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowUpRight } from 'lucide-react';
import { hasRole, requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { statusFieldOf } from '@/lib/crm/fields';
import {
  CRM_LIST_PAGE_SIZE,
  crmListHref,
  parseCrmListParams,
  sortStatusOptions,
} from '@/lib/crm/view';
import {
  CRM_MIGRATION_FILE,
  countEntriesByStatus,
  getCrmList,
  isCrmNotSetUp,
  listBoard,
  listEntries,
} from '@/lib/services/crm';
import { CRM_DESTINATION_INFO } from '@/lib/crm/destinations';
import { destinationForList } from '@/lib/services/crm-destinations';
import { CrmBreadcrumb } from '@/components/lists/crm-breadcrumb';
import { ListArchiveButton } from '@/components/lists/list-archive-button';
import { ListView, type ListBoardData, type ListTableData } from '@/components/lists/list-view';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { ErrorState } from '@/components/ui/feedback';
import { NotConfigured } from '@/components/ui/not-configured';
import type { CrmEntityType } from '@/lib/types/domain';
import type { CrmListDestination } from '@/lib/crm/destinations';
import { AFFINITY_LISTS_HREF } from '@/lib/records-tabs';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<CrmEntityType, string> = {
  deal: 'Deal list',
  company: 'Company list',
  person: 'Person list',
};

/** Cards per board column; the rest are a link to the table filtered to that status. */
const BOARD_PER_COLUMN = 25;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const auth = await requireAuth();
  const list = await getCrmList(getStore(), auth.organizationId, id);
  return { title: list.ok ? list.value.name : 'List' };
}

/**
 * One list, Affinity-grade: a table of every field with sort, search, status
 * chips and pages of 100, or a board of status columns. Everything that
 * narrows or orders the list is URL state run in the database — a list can
 * hold thousands of entries — and the client view (ListView) handles the
 * rest: hidden columns, the side panel, status changes, adding an entry.
 */
export default async function ListPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, raw] = await Promise.all([params, searchParams]);
  const view = parseCrmListParams(raw);
  const auth = await requireAuth();
  const store = getStore();
  const org = auth.organizationId;

  const found = await getCrmList(store, org, id);
  if (isCrmNotSetUp(found)) {
    return (
      <PageShell>
        <CrmBreadcrumb />
        <PageHeader title="List" />
        <NotConfigured
          title="Affinity lists are not set up yet"
          description={`The CRM tables have not been created in the database. Run ${CRM_MIGRATION_FILE} in the Supabase SQL editor, then reload this page.`}
          stillWorks="Everything else in Copilot works as before."
          action={null}
        />
      </PageShell>
    );
  }
  if (!found.ok && found.error.code === 'not_found') notFound();
  if (!found.ok) {
    return (
      <PageShell>
        <CrmBreadcrumb />
        <PageHeader title="List" />
        <ErrorState
          title="This list could not be loaded"
          message={found.error.message}
          stillUsable="The other Affinity lists, and everything else in Copilot."
        />
      </PageShell>
    );
  }

  const list = found.value;
  const canWrite = hasRole(auth, 'member');
  const statusField = statusFieldOf(list);
  const statusOptions = statusField ? sortStatusOptions(statusField.options ?? []) : [];
  const query = {
    query: view.q || null,
    sortKey: view.sort || null,
    sortDir: view.dir,
    statusIn: view.statuses,
  };

  const [destination, counts, entries, board] = await Promise.all([
    destinationForList(store, org, list),
    statusField ? countEntriesByStatus(store, org, list.id, { query: view.q || null }) : null,
    view.view === 'table'
      ? listEntries(store, org, list.id, {
          ...query,
          offset: (view.page - 1) * CRM_LIST_PAGE_SIZE,
          limit: CRM_LIST_PAGE_SIZE,
        })
      : null,
    view.view === 'board' && statusField
      ? listBoard(store, org, list.id, { ...query, perColumn: BOARD_PER_COLUMN })
      : null,
  ]);

  // Past the last page — a bookmark from before entries were removed, or a
  // hand-edited URL — goes to the last page there is.
  if (entries?.ok && entries.value.total > 0 && entries.value.entries.length === 0) {
    const last = Math.ceil(entries.value.total / CRM_LIST_PAGE_SIZE);
    redirect(crmListHref(list.id, view, { page: last }));
  }

  const problem = [entries, board].find((r) => r && !r.ok);
  const table: ListTableData | null = entries?.ok
    ? {
        entries: entries.value.entries,
        total: entries.value.total,
        offset: entries.value.offset,
        limit: entries.value.limit,
        sort: entries.value.sort,
        records: entries.value.records,
      }
    : null;
  const boardData: ListBoardData | null = board?.ok
    ? {
        columns: board.value.columns,
        unplaced: board.value.unplaced,
        perColumn: board.value.perColumn,
        records: board.value.records,
      }
    : null;

  return (
    <PageShell className="max-w-7xl">
      <CrmBreadcrumb />
      <PageHeader
        eyebrow={`${KIND_LABEL[list.entity_type]} · ${list.source === 'affinity' ? 'from Affinity' : 'made in Copilot'}${list.archived ? ' · archived' : ''}`}
        title={list.name}
        subtitle={`${list.entry_count.toLocaleString('en-US')} ${list.entry_count === 1 ? 'entry' : 'entries'}${
          list.fields.length
            ? ` · ${list.fields.length} ${list.fields.length === 1 ? 'field' : 'fields'}`
            : ''
        }`}
        meta={<FeedsLine destination={destination} />}
        actions={
          canWrite ? (
            <ListArchiveButton listId={list.id} listName={list.name} archived={list.archived} />
          ) : null
        }
      />

      {problem && !problem.ok ? (
        <ErrorState
          className="mb-4"
          title="The entries could not be loaded"
          message={problem.error.message}
          stillUsable="The other Affinity lists, and everything else in Copilot."
        />
      ) : null}

      <ListView
        list={{
          id: list.id,
          name: list.name,
          entity_type: list.entity_type,
          fields: list.fields,
        }}
        params={view}
        statusField={statusField}
        statusOptions={statusOptions}
        counts={counts?.ok ? counts.value.counts : null}
        table={table}
        board={boardData}
        boardProblem={
          !statusField
            ? `${list.name} has no status field, so there is nothing to lay out as a board.`
            : null
        }
        timezone={auth.profile.timezone}
        canWrite={canWrite}
      />
    </PageShell>
  );
}

/** Where the list's rows show up in the app, as a link to that page. */
function FeedsLine({ destination }: { destination: CrmListDestination }) {
  const info = CRM_DESTINATION_INFO[destination.destination];
  return (
    <p className="text-sm text-[var(--fg-muted)]">
      {destination.destination === 'archive' ? (
        <>Kept under Knowledge for reference; it feeds no other page.</>
      ) : (
        <>
          Feeds{' '}
          <Link
            href={info.href}
            className="inline-flex items-center gap-0.5 font-medium text-[var(--accent)] underline-offset-2 hover:underline"
          >
            {info.page}
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </Link>{' '}
          as {info.label.toLowerCase()}
          {destination.source === 'override' ? ', moved there by hand' : ''}.
        </>
      )}{' '}
      <Link href={AFFINITY_LISTS_HREF} className="underline-offset-2 hover:underline">
        Change
      </Link>
    </p>
  );
}
