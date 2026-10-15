import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
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
import { ListArchiveButton } from '@/components/lists/list-archive-button';
import { ListView, type ListBoardData, type ListTableData } from '@/components/lists/list-view';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { ErrorState } from '@/components/ui/feedback';
import { NotConfigured } from '@/components/ui/not-configured';
import type { CrmEntityType } from '@/lib/types/domain';

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
        <BackLink />
        <PageHeader title="List" />
        <NotConfigured
          title="Lists are not set up yet"
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
        <BackLink />
        <PageHeader title="List" />
        <ErrorState
          title="This list could not be loaded"
          message={found.error.message}
          stillUsable="The other lists, and everything outside Lists."
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

  const [counts, entries, board] = await Promise.all([
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
      <BackLink />
      <PageHeader
        eyebrow={`${KIND_LABEL[list.entity_type]} · ${list.source === 'affinity' ? 'from Affinity' : 'made in Copilot'}${list.archived ? ' · archived' : ''}`}
        title={list.name}
        subtitle={`${list.entry_count.toLocaleString('en-US')} ${list.entry_count === 1 ? 'entry' : 'entries'}${
          list.fields.length
            ? ` · ${list.fields.length} ${list.fields.length === 1 ? 'field' : 'fields'}`
            : ''
        }`}
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
          stillUsable="The other lists, and everything outside Lists."
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

function BackLink() {
  return (
    <Link
      href="/lists"
      className="mb-2 inline-flex items-center gap-1 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
    >
      <ArrowLeft className="size-4" aria-hidden /> All lists
    </Link>
  );
}
